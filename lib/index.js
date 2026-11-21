/**
 * dsh-saynext · 宿主侧
 *
 * 每当一条会话的一轮正常收尾（turn/end，reason = completed），就用这条会话
 * 最近几轮对话向模型要一句"用户紧接着最可能说的话"，存进内存小本子，再经
 * 插件的配置通道（settings 的 `hint` 字段）递给界面。
 *
 * 界面侧只看这份 JSON，不轮询会话、不读日志，两者唯一的耦合就是这段载荷。
 */

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** 诊断日志放在用户目录，文件名固定但只对自己可读可写（0600）。 */
const TRACE = join(homedir(), '.dsh', 'saynext', 'trace.log')
let traceReady = false
let traceWrites = 0

/** 诊断日志：默认写；设 DSH_SAYNEXT_TRACE=0 可关掉。 */
function trace(line) {
  if (process.env.DSH_SAYNEXT_TRACE === '0') return
  try {
    if (!traceReady) {
      mkdirSync(join(homedir(), '.dsh', 'saynext'), { recursive: true, mode: 0o700 })
      // 既有的旧文件不受 mode 影响，单独收紧一次
      try {
        chmodSync(TRACE, 0o600)
      } catch {
        /* 文件还不存在，下一次 append 会按 0600 建出来 */
      }
      traceReady = true
    }
    // 每 200 行查一次大小，超过 512KB 就换成一个 .1，避免长期默认开启写满盘
    traceWrites += 1
    if (traceWrites % 200 === 0) {
      try {
        if (statSync(TRACE).size > 512 * 1024) renameSync(TRACE, `${TRACE}.1`)
      } catch {
        /* 文件还不存在，忽略 */
      }
    }
    appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

trace(`module loaded pid=${process.pid}`)

const NAMESPACE = 'saynext'
const CHANNEL = 'hint'
const MAX_ITEMS = 8
const MAX_TURNS = 4
const MAX_TRANSCRIPT_CHARS = 4000
const MAX_OUTPUT_CHARS = 160
const MAX_TOKENS = 400
const TIMEOUT_MS = 20000
/** 写一次 settings 最多等多久；超时就放弃这次写入，绝不把 busy 卡死。 */
const PUBLISH_TIMEOUT_MS = 3000

const SYSTEM = [
  '你是资深工程师，正在替用户决定「现在这一步该做什么」。读对话，判断此刻最有价值的下一个动作，',
  '写成用户会直接发出去的一句话。判断顺序：',
  '1) AI 在等用户选择 → 直接选一个，并带上选择依据；',
  '2) AI 交了结果 → 指定验证方式与判据（跑什么、看哪个数字、什么算过）；',
  '3) AI 跑偏、含糊或漏了边界 → 指出问题并要求返工；',
  '4) 目标还没完成 → 给最小的下一步动作。',
  '硬性规则：',
  '- 必须是可执行动作，且带具体对象（文件、函数、命令、数字、错误码、接口名）；',
  '- 禁止附和与复述：不写「好的 / 可以 / 继续 / 收到 / 明白 / 谢谢 / 没问题」，不重复 AI 的原话；',
  '- 多个选项时选一个，不要写「都行」「你决定」；',
  '- 不要用「你/您」开头，也不要写「你来……」「你可以……」，那是对用户说话的口吻；',
  '- 不要概括 AI 刚才说了什么（例如「测试已全 PASS」），只写用户下一步要打的那句话；',
  '- 不超过 40 个汉字，一句，动词开头，不加引号、前缀、解释。',
  '例：`用方案 B，改动最小，先跑全量测试`——有选择、有依据、有一个可执行动作。',
  '用对话本身的语言作答（中文会话就写中文），只输出这句话。',
].join('\n')

export const name = 'dsh-saynext'

/**
 * 插件配置。
 * - `hint`：宿主算好的建议，递给界面侧；`.volatile()` 让它可写
 *   （没有它，settings 会以「No configurable plugin entry」拒绝落盘）。
 * - 另外三项是给用户用的闸门：关掉整个插件、同一会话请求的最小间隔、
 *   对话短到什么程度就不值得问模型。
 */
export const Config = z.object({
  hint: z.string().default('').volatile(),
  enabled: z.boolean().default(true),
  cooldownMs: z.number().default(0),
  minTranscriptChars: z.number().default(40),
  timeoutMs: z.number().default(20000),
})
export const inject = ['llm', 'sessions', 'settings']

/**
 * @param {any} ctx 宿主 Cordis 上下文
 */
export function apply(ctx, config) {
  /** 用户可调的三项闸门，允许在 cordis.patch.yml 的 config 里改。 */
  const options = {
    enabled: config?.enabled !== false,
    cooldownMs: Number.isFinite(config?.cooldownMs) ? Math.max(0, config.cooldownMs) : 0,
    minTranscriptChars: Number.isFinite(config?.minTranscriptChars)
      ? Math.max(0, config.minTranscriptChars)
      : 40,
    timeoutMs: Number.isFinite(config?.timeoutMs) ? Math.max(1000, config.timeoutMs) : 20000,
  }

  /** @type {Map<string, {sessionId: string, text: string, turn: number, rev: number, at: number}>} */
  const bank = new Map()
  /** @type {Set<string>} 正在为哪些会话要句子 */
  const busy = new Set()
  /** @type {Map<string, number>} 每条会话上一次问模型的时间，用于冷却 */
  const lastAskAt = new Map()
  /** @type {Map<string, number>} 每条会话最近结束的回合号：迟到的生成据此丢弃 */
  const latestTurn = new Map()
  /** @type {Map<string, string>} 每条会话上一句建议：旧条目会被下线，这里留底用于查重 */
  const lastText = new Map()
  let rev = 0

  trace(`apply pid=${process.pid} enabled=${options.enabled} cooldownMs=${options.cooldownMs} minTranscriptChars=${options.minTranscriptChars} timeoutMs=${options.timeoutMs}`)

  trace(`services sessions.list=${typeof ctx.sessions?.list} sessions.get=${typeof ctx.sessions?.get} llm=${typeof ctx.llm?.stream} settings=${typeof ctx.settings?.update}`)

  /** 前几次事件不论是否感兴趣都记一行：先确认「事件到底来没来、参数顺序是什么」。 */
  let seen = 0

  function onTurnEnd(session, event, via) {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const turn = Number(event?.data?.turn ?? 0)
    if (latestTurn.get(sessionId) === turn) {
      trace(`skip handled session=${sessionId} turn=${turn} via=${via}`)
      return
    }
    trace(`turn/end session=${sessionId} turn=${turn} via=${via}`)

    latestTurn.set(sessionId, turn)

    if (!options.enabled) {
      trace(`skip disabled session=${sessionId}`)
      return
    }
    if (busy.has(sessionId)) {
      trace(`skip busy session=${sessionId}`)
      return
    }
    const last = lastAskAt.get(sessionId) ?? 0
    if (options.cooldownMs > 0 && Date.now() - last < options.cooldownMs) {
      trace(`skip cooldown session=${sessionId} since=${Date.now() - last}ms`)
      return
    }
    busy.add(sessionId)
    lastAskAt.set(sessionId, Date.now())
    void ask(session, sessionId, turn)
      .catch((error) => {
        trace(`ask FAILED ${describe(error)}`)
      })
      .finally(() => { busy.delete(sessionId) })
  }

  function handleEvent(a, b, label) {
    // 参数顺序不能想当然：谁长得像事件就以谁为准（老版本是 (session, event)）。
    const event = b && typeof b.type === 'string' ? b : a && typeof a.type === 'string' ? a : null
    const session = b && typeof b.id === 'string' ? b : a && typeof a.id === 'string' ? a : null
    if (seen < 5) {
      seen += 1
      trace(`event #${seen} bus=${label} a=${a === null ? 'null' : typeof a} b=${b === null ? 'null' : typeof b} type=${event?.type ?? '?'} sid=${session?.id ?? '?'}`)
    }
    if (event?.type !== 'turn/end') return
    if (event?.data?.reason?.kind !== 'completed') return
    onTurnEnd(session, event, `event:${label}`)
  }

  // 事件不是全局广播：dsh-session 派发时用 entry.emitCtx（进入会话时的那个 ctx）
  // 调 ctx.events.dispatch，能被派到的只有它的祖先和同源的子树。插件若被挂在这条
  // 链路之外的旁支上，自己这个 ctx 就一条都收不到——启动时正是这个样子。
  // root 既是所有 ctx 的祖先、又是派发起点，挂上去无论方向都收得到。
  const buses = new WeakSet()
  let attached = 0
  function attachBus(target, label) {
    if (target === null || target === undefined) return false
    if (typeof target.on !== 'function') return false
    if (buses.has(target)) return false
    buses.add(target)
    attached += 1
    target.on('session/event', (a, b) => handleEvent(a, b, label))
    trace(`bus attach ${label}`)
    return true
  }

  attachBus(ctx, 'ctx')
  if (ctx.root !== undefined && ctx.root !== null && ctx.root !== ctx) attachBus(ctx.root, 'root')

  // 启动时序兜底：开机瞬间插件可能比会话早接好，先静一会儿；若一直没事件而
  // 会话已经存在，就在 root 与 store 上再挂一次（重复挂由 latestTurn 去重）。
  const watchdogs = []
  for (const delayMs of [8000, 30000]) {
    const timer = setTimeout(() => {
      if (seen > 0) return
      let hasSessions = false
      try {
        hasSessions = (ctx.sessions?.list?.() ?? []).length > 0
      } catch {
        hasSessions = false
      }
      trace(`bus silent ${delayMs}ms events=0 sessions=${hasSessions} attached=${attached}`)
      if (!hasSessions) return
      if (ctx.root !== undefined && ctx.root !== null && ctx.root !== ctx) attachBus(ctx.root, 'root-retry')
      attachBus(ctx.sessions, 'store')
    }, delayMs)
    timer.unref?.()
    watchdogs.push(timer)
  }

  // 兜底：事件总线若因内核版本变化不再派发，就直接看会话日志。log 是内核的私有
  // 字段，这里只在它确实是数组时才用；拿不到就安静地只靠事件。
  const scanned = new Map()
  const timer = setInterval(() => {
    let list = []
    try {
      list = ctx.sessions?.list?.() ?? []
    } catch {
      return
    }
    for (const session of list) {
      const log = session?.log
      if (!Array.isArray(log)) continue
      // 第一次见到这条会话只记位置，不补算历史回合，免得重启瞬间对所有会话各发一次请求。
      if (!scanned.has(session.id)) {
        scanned.set(session.id, log.length)
        continue
      }
      const from = scanned.get(session.id)
      scanned.set(session.id, log.length)
      for (let i = from; i < log.length; i += 1) {
        const e = log[i]
        if (e?.type === 'turn/end' && e?.data?.reason?.kind === 'completed') onTurnEnd(session, e, 'poll')
      }
    }
  }, 3000)
  if (typeof timer?.unref === 'function') timer.unref()

  ctx.on('dispose', () => {
    for (const watchdog of watchdogs) clearTimeout(watchdog)
    clearInterval(timer)
  })


  /**
   * @param {any} session
   * @param {string} sessionId
   * @param {number} turn
   */
  async function ask(session, sessionId, turn) {
    const resolved = resolveModel(session)
    trace(`ask session=${sessionId} provider=${resolved.provider} model=${resolved.model} source=${resolved.source}`)
    if (resolved.provider === undefined || resolved.model === undefined) {
      // 这一轮没有可用的模型信息：不猜、不硬编码默认值，只留下可诊断的痕迹。
      trace(`skip no provider/model session=${sessionId}（会话未声明模型时可能发生）`)
      return
    }

    const framed = frameTranscript(session)
    if (framed.prompt === '') {
      trace(`skip empty transcript session=${sessionId}`)
      return
    }
    if (framed.chars < options.minTranscriptChars) {
      trace(`skip short transcript session=${sessionId} chars=${framed.chars} < ${options.minTranscriptChars}`)
      return
    }

    // 上一句还挂在界面上时，模型很容易原样再给一遍，用户看到的就是
    // 「答完了建议却没变」。把上一句当作要避开的内容，重复就再要一次。
    const previous = lastText.get(sessionId) ?? ''
    let text = await complete(resolved.provider, resolved.model, framed.prompt, sessionId, previous)
    // 三道闸门：附和/空话、复述 AI 的话、以「你/您」开头（那是 AI 对用户说话的口吻，
    // 不是用户会打出去的话）。命中就带着具体理由重问，最多重问两次；仍不合格整轮不出建议。
    let reject = judgeSuggestion(text, session, previous)
    for (let attempt = 0; attempt < 2 && reject !== null; attempt += 1) {
      if (reject === 'empty') {
        // 超时、上游报错或空白输出：重问也是一次白花，直接放弃本轮。
        trace('suggestion empty, skip retry')
        return
      }
      trace(`suggestion rejected reason=${reject} len=${text.length}`)
      text = await complete(resolved.provider, resolved.model, retryPrompt(framed.prompt, text, reject), sessionId, text)
      reject = judgeSuggestion(text, session, previous)
    }
    if (reject !== null) {
      trace(`drop suggestion reason=${reject}`)
      return
    }
    trace(`text len=${text.length}`)
    if (text === '') return
    // 生成期间又结束了一轮：这条已经过期，别再放回去
    if (latestTurn.get(sessionId) !== turn) {
      trace(`discard stale result session=${sessionId} turn=${turn} now=${latestTurn.get(sessionId)}`)
      return
    }

    // LRU：更新已有会话时先摘掉再放回，让它排到队尾，不被当成最旧的一条淘汰
    lastText.set(sessionId, text)
    bank.delete(sessionId)
    bank.set(sessionId, { sessionId, text, turn, rev: ++rev, at: Date.now() })
    while (bank.size > MAX_ITEMS) {
      const oldest = bank.keys().next()
      if (oldest.done) break
      bank.delete(oldest.value)
      // 顺带把这条会话的旁路状态清掉，避免长期运行时无界增长
      lastAskAt.delete(oldest.value)
      latestTurn.delete(oldest.value)
      lastText.delete(oldest.value)
    }
    await publish()
  }

  /**
   * 这一轮用的是哪个模型。
   * 首选会话请求头里解析出来的 provider/model；请求头没有时退到会话自身的
   * 两个字段（同样要求是字符串）。都拿不到就返回 undefined，由调用方跳过。
   * @returns {{provider?: string, model?: string, source: string}}
   */
  /** 取还活着的 llm 服务：优先当前 ctx，其次 root，最后退回闭包里的 ctx。 */
  function llmService() {
    for (const candidate of [ctx, ctx?.root]) {
      try {
        const service = candidate?.get?.('llm')
        if (service !== null && typeof service?.stream === 'function') return service
      } catch (error) {
        trace(`llm lookup failed ${describe(error)}`)
      }
    }
    return ctx.llm
  }

  function resolveModel(session) {
    const header = safe(() => session?.requestHeader?.()?.config)
    if (isText(header?.provider) && isText(header?.model)) {
      return { provider: header.provider, model: header.model, source: 'header' }
    }
    const provider = safe(() => session?.provider)
    const model = safe(() => session?.model)
    if (isText(provider) && isText(model)) {
      return { provider, model, source: 'session' }
    }
    return { provider: undefined, model: undefined, source: 'none' }
  }

  /**
   * 把最近几轮对话拼成一段纯文本交给模型。
   * @returns {{prompt: string, chars: number}} chars 只算对话正文，不含模板句子。
   */
  function frameTranscript(session) {
    let all
    try {
      all = session?.deriveMessages?.()
    } catch {
      all = undefined
    }
    if (!Array.isArray(all) || all.length === 0) return { prompt: '', chars: 0 }
    const lines = []
    let chars = 0
    let budget = MAX_TRANSCRIPT_CHARS
    const kept = []
    for (let index = all.length - 1; index >= 0 && kept.length < MAX_TURNS * 2; index -= 1) {
      const message = all[index]
      const role = message?.role
      if (role !== 'user' && role !== 'assistant') continue
      const text = textOf(message)
      if (text === '') continue
      const size = text.length + 3
      if (size > budget) {
        // 最新的一条放不下时保留它的尾部（最接近「刚刚发生的事」），
        // 整条丢掉会让长回答的会话完全没有上下文。
        if (kept.length === 0 && budget > 40) {
          const tail = text.slice(-(budget - 3))
          kept.push({ role, text: tail })
          chars += tail.length
          budget = 0
        }
        break
      }
      budget -= size
      chars += text.length
      kept.push({ role, text })
    }
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const item = kept[index]
      lines.push(`${item.role === 'user' ? '用户' : 'AI'}：${item.text}`)
    }
    if (lines.length === 0) return { prompt: '', chars: 0 }
    // 单独把 AI 最后一条的结尾再摘一遍：多数「下一步」取决于它最后在问什么、在等什么。
    let tail = ''
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (kept[index].role === 'assistant') {
        tail = kept[index].text.slice(-400)
        break
      }
    }
    const prompt = [
      '以下是这条会话最近的对话：',
      lines.join('\n'),
      '',
      tail === '' ? '' : `AI 最后一条的结尾（节选）：${tail}`,
      '',
      '判断用户此刻最有价值的下一步，写成他可以直接发送的一句话。',
    ].filter((part) => part !== '').join('\n')
    return { prompt, chars }
  }

  /**
   * 向模型要一句话。
   * @returns {Promise<string>}
   */
  async function complete(provider, model, prompt, sessionId, avoid = '') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let raw = ''
    /** 上游中途报错时置位：已收到的半截话一律丢弃，不写进小本子。 */
    let failed = false
    /** 硬超时定时器：上游若不理 abort，靠它把 busy 放掉。 */
    let deadline
    try {
      const ask = avoid === ''
        ? prompt
        : `${prompt}\n\n上一轮你已经给过「${avoid}」，这次不要重复它，换一句不同的话。`
      const messages = [await userMessage(ask)]
      // 采集放在独立 Promise 里：即使上游不响应 abort、迭代器永不结束，
      // 下面那场竞速也能在 timeoutMs 后返回，不会把这条会话的 busy 卡死。
      const collected = (async () => {
        const stream = llmService().stream({
          provider,
          model,
          messages,
          system: SYSTEM,
          maxTokens: MAX_TOKENS,
          sessionId,
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            raw += chunk.text
            if (raw.length > MAX_OUTPUT_CHARS * 4) {
              // 够用了：主动掐断，别让上游继续烧 token
              controller.abort()
              break
            }
          } else if (chunk?.type === 'error') {
            failed = true
            trace(`stream error ${describe(chunk?.reason ?? chunk)}`)
          } else if (chunk?.type === 'finish') {
            if (chunk?.reason?.kind === 'error') {
              failed = true
              trace(`stream finish error ${describe(chunk.reason)}`)
            }
          }
        }
      })().catch((error) => {
        failed = true
        trace(`stream aborted ${describe(error)}`)
      })

      const outcome = await Promise.race([
        collected.then(() => 'settled'),
        new Promise((resolve) => { deadline = setTimeout(() => resolve('timeout'), options.timeoutMs) }),
      ])
      if (outcome === 'timeout') {
        failed = true
        controller.abort()
        raw = ''
        trace(`hard timeout ${options.timeoutMs}ms session=${sessionId} kept=${raw.length}`)
      }
    } catch (error) {
      failed = true
      trace(`stream aborted ${describe(error)}`)
    } finally {
      clearTimeout(timer)
      clearTimeout(deadline)
    }
    if (failed) return ''
    return tidy(raw)
  }

  /** 把模型输出收拾成一行干净的话。 */
  /**
   * 附和 / 空话检测。用户抱怨过「建议全是对 AI 的肯定答复」，
   * 所以这类句子不写进载荷：先重问一次，仍不合格就整轮不给建议。
   * 返回原因字符串（写进 trace），合格返回 null。
   */
  /** 这条会话里 AI 最后一条说了什么（用来判断建议是不是在复述它）。 */
  function lastAssistantText(session) {
    const all = session?.deriveMessages?.() ?? []
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]?.role !== 'assistant') continue
      const text = textOf(all[index])
      if (text !== '') return text
    }
    return ''
  }

  /** 建议是否是 AI 自己那句话的摘录（去空白后取头尾各 20 字做包含判断）。 */
  /** 用户在本会话里最后说的那句话（用来拦住「把用户的原话再当建议」）。 */
  function lastUserText(session) {
    let all
    try {
      all = session?.deriveMessages?.()
    } catch {
      all = undefined
    }
    if (!Array.isArray(all)) return ''
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]?.role !== 'user') continue
      const text = textOf(all[index])
      if (text !== '') return text
    }
    return ''
  }

  function echoes(text, source) {
    const target = String(text ?? '').replace(/\s+/g, '')
    if (target.length < 10) return false
    const body = String(source ?? '').replace(/\s+/g, '')
    if (body === '') return false
    const head = target.slice(0, Math.min(20, target.length))
    if (body.includes(head)) return true
    return target.length >= 20 && body.includes(target.slice(-20))
  }

  function blandReason(text) {
    if (text === '') return 'empty'
    const flat = text.replace(/\s+/g, '')
    // 锚点只认字母数字：把 . / \\ - 也算锚点会让「好的...」「继续。。。」被当成有对象。
    const anchorOrVerb = /[0-9A-Za-z]|(跑|改|删|加|装|查|写|建|拆|测|验|对比|回滚|合并|提交|确认|打开|读|打印|抓|导出|压测|调|修|替换|冻结|发布|截图|重跑|核对|补|停|看|找|搜|启动|清理|画|列|比|算|对齐|重构|定位|排查|复现|梳理|迁移|升级|回退|推送)/
    // 「好的 / 可以 / 行」打头不一定没价值（「行，那就先跑冒烟测试」是决定），
    // 只有去掉这层壳之后什么都不剩、或剩的没有动作，才算附和。
    // 分隔符必须是真分隔（标点或空白）：否则「对比两版输出」会被剥掉首字「对」，
    // 剩下的「比两版输出」既没动词也没锚点，整句被误判成附和。
    const lead = /^(好的?|好呀|可以|行|嗯+|对|是|没错|收到|明白了?|了解了?|谢谢|多谢|ok|okay|sure)[，,、:：\s]+/i
    if (/^(好的?|好呀|可以|行|嗯+|对|是|没错|收到|明白了?|了解了?|谢谢|多谢)$/i.test(flat)) return 'agreement'
    const stripped = flat.replace(lead, '')
    if (stripped !== flat && (stripped === '' || !anchorOrVerb.test(stripped))) return 'agreement'
    // 「继续」「接着」单独出现同样是空话；带上具体动作就不算（「继续跑冒烟测试」）。
    if (/^(继续|接着|往下)(吧|啊|干|搞|来)?$/.test(flat)) return 'agreement'
    // 英文的纯确认词同样没有信息量。这里先归一化（小写、去空格标点）再比对，
    // 否则 "go ahead" 会因含拉丁字母被 anchorOrVerb 当成「有锚点」而放行。
    const latin = flat.toLowerCase().replace(/[^a-z]/g, '')
    if (/^(ok|okay|okey|sure|yes|yeah|yep|goahead|goon|continue|soundsgood|gotit|alright|allright|agree|agreed|correct|right|nice|cool|great|perfect|thanks|thx)$/.test(latin)) {
      return 'agreement'
    }
    // 「sure, go ahead」这类组合确认词：剥壳后只剩另一个确认词，同样没有信息量。
    if (stripped !== flat && /^(ok|okay|sure|yes|goahead|goon|continue|soundsgood|gotit|alright)$/.test(stripped.toLowerCase().replace(/[^a-z]/g, ''))) {
      return 'agreement'
    }
    // 3 个字以下才当空话：「跑测试」「看日志」这种 3 字动作是合格的。
    if (flat.length < 3) return 'too-short'
    // 既没有数字/拉丁（文件、命令、错误码、接口名），也没有具体动作词，视为空泛。
    if (!anchorOrVerb.test(text)) return 'vague'
    return null
  }

  /** 一句话不合格的原因；合格返回 null。 */
  function judgeSuggestion(text, session, previous) {
    if (text === '') return 'empty'
    const bland = blandReason(text)
    if (bland !== null) return bland
    if (echoes(text, lastAssistantText(session))) return 'echo'
    // 用户刚自己说完的话再端回来，同样没有价值（「打印 rev=6 的载荷」这种）。
    if (echoes(text, lastUserText(session))) return 'repeat-user'
    if (aiVoice(text)) return 'address'
    return null
  }

  /** 带着「哪里不对」重问一次，而不是把原话原样再塞回去。 */
  function retryPrompt(prompt, previousText, reason) {
    const said = {
      agreement: `上一句是「${previousText}」，只是在附和，没有信息量。`,
      vague: `上一句是「${previousText}」，太泛，没有具体对象。`,
      echo: `「${previousText}」是 AI 自己刚才说过的话，不要复述它。`,
      'repeat-user': `「${previousText}」是用户刚刚自己提出来的，他不需要再被提醒一遍；给一个他还没说的下一步。`,
      address: `「${previousText}」是在对用户说话（以「你」开头），不是用户要说的话。`,
    }[reason] ?? `上一句是「${previousText}」，不合格。`
    const want = {
      agreement: '换成一句带判断、带具体对象的动作，不要同意或复述。',
      vague: '换成一句带判断、带具体对象的动作。',
      echo: '给出一句用户此刻该做的、具体的新动作。',
      'repeat-user': '换一件他还没交代过、但现在最该做的事。',
      address: '改成用户自己会打出去的口令：主语省略、动词开头。',
    }[reason] ?? '换成一句具体动作。'
    return [prompt, '', said, want].join('\n')
  }

  /**
   * 判断这句话是不是「AI 在对用户说话」而不是「用户要说的话」。
   * 以「你/您」开头，或含「你来/你可以/你直接」这类呼语，都算跑偏——
   * 典型跑偏结果：「你来重启，测试已全 PASS」。
   */
  function aiVoice(text) {
    const flat = String(text ?? '').replace(/\s+/g, '')
    if (/^[你您]/.test(flat)) return true
    return /你来|您可以|你可以|你需要|你得|你先|你直接|你要是/.test(flat)
  }

  function tidy(raw) {
    let text = String(raw ?? '').replace(/\r/g, '')
    // 整段压成一行：模型偶尔把一句话拆成多行，逐行取首行会丢掉后半句。
    text = text.replace(/\s+/g, ' ').trim()
    text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    text = text.replace(/^[（(【\[]?\s*(建议|下一句|用户|next)[:：]\s*/i, '')
    text = text.replace(/\s+/g, ' ').trim()
    // 模型偶尔给两句，压平后会拼成「跑测试 提交代码」这种双命令。
    // 只在有句末标点时切第一句；纯换行分行的两句不做切分（会把一句话拦腰截断），
    // 靠提示词里的「只输出一句」兜底，这一点在证据 §9 里写明。
    const sentences = text.split(/(?<=[。！？!?])\s*/).filter((part) => part !== '')
    if (sentences.length > 1 && sentences[0].length >= 6) text = sentences[0]
    if (text.length > 60) text = text.slice(0, 60)
    return text
  }

  /**
   * 把最新小本子写到插件配置的 `hint` 字段，界面侧轮询这一格。
   *
   * 同时管住三件事：
   * - 顺序：多条会话可能同时收尾，写入必须按快照顺序落盘，后算出的不能被旧值打回；
   * - 幂等：快照 rev 不大于已写 rev 的直接跳过；
   * - 不卡死：settings 不可用或写入悬挂时超时放弃，绝不把 busy 永久占住。
   */
  let writeChain = Promise.resolve()
  let writtenRev = -1

  function publish() {
    const snapshotRev = rev
    const payload = JSON.stringify({
      rev: snapshotRev,
      items: [...bank.values()].map((entry) => ({
        sessionId: entry.sessionId,
        text: entry.text,
        turn: entry.turn,
        rev: entry.rev,
        at: entry.at,
      })),
    })
    trace(`publish try rev=${snapshotRev} written=${writtenRev}`)
    if (snapshotRev <= writtenRev) return writeChain
    writeChain = writeChain
      .then(async () => {
        if (snapshotRev <= writtenRev) return
        await writeHint(payload)
        writtenRev = snapshotRev
        trace(`publish ok rev=${snapshotRev} bytes=${payload.length}`)
      })
      .catch((error) => {
        trace(`publish FAILED ${describe(error)}`)
      })
    return writeChain
  }

  /** 真正写一次；服务就绪得快就直连，否则走 inject 并带超时。 */
  async function writeHint(payload) {
    const direct = ctx.settings
    if (direct !== undefined && direct !== null && typeof direct.update === 'function') {
      trace('writeHint via direct ctx.settings')
      // 插件热重载期间，宿主正处在一个 HMR 事务里，此时改配置会抛
      // "HMR transactions cannot be nested"。等事务结束再写，别把这一轮丢掉。
      let lastError
      for (const delayMs of [0, 600, 1800]) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        try {
          await direct.update(NAMESPACE, { [CHANNEL]: payload })
          return
        } catch (error) {
          lastError = error
          const message = String(error?.message ?? error)
          if (!message.includes('HMR')) throw error
          trace(`settings update deferred by HMR ${message}`)
        }
      }
      throw lastError
    }
    trace('writeHint via inject fallback')
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve(undefined)
        else reject(error)
      }
      let settled = false
      const timer = setTimeout(() => {
        trace('publish timeout: settings service not ready')
        // 必须按失败上报：否则 publish 会把「没写进去」记成 ok 并推进
        // writtenRev，同一份快照就再也重试不了。
        finish(new Error(`settings service not ready after ${PUBLISH_TIMEOUT_MS}ms`))
      }, PUBLISH_TIMEOUT_MS)
      ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx?.settings
        if (settings === undefined || settings === null || typeof settings.update !== 'function') {
          trace('publish skipped: no settings service')
          finish(new Error('no settings service'))
          return
        }
        Promise.resolve(settings.update(NAMESPACE, { [CHANNEL]: payload })).then(
          () => finish(),
          (error) => finish(error),
        )
      })
    })
  }
}

/**
 * 造一条"用户说了这句话"的消息。内核的 LLM 服务只认自家消息形状，
 * 所以优先用 @deepseek-ai/dsh-llm 的构造器，拿不到时退回最小形状。
 */
let userMessageFactory

async function userMessage(prompt) {
  if (userMessageFactory === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      userMessageFactory = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null
    } catch {
      userMessageFactory = null
    }
  }
  const content = [{ type: 'text', text: prompt }]
  if (userMessageFactory !== null) return userMessageFactory({ content, source: { kind: 'user' } })
  return { role: 'user', content, source: { kind: 'user' } }
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block?.text === 'string') parts.push(block.text)
    else if (typeof block?.content === 'string') parts.push(block.content)
  }
  return parts.join('\n').trim()
}

/** 取一个可能抛错的值，出错就当没有。 */
function safe(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 非空字符串才算拿到了模型信息。 */
function isText(value) {
  return typeof value === 'string' && value !== ''
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

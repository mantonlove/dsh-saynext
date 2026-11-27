/**
 * dsh-saynext · 宿主侧
 *
 * 每当一条会话的一轮正常收尾（turn/end，reason = completed），就用这条会话
 * 最近几轮对话向模型要一句"用户紧接着最可能说的话"，存进内存小本子，再经
 * 插件的配置通道（settings 的 `hint` 字段）递给界面。
 *
 * 界面侧只看这份 JSON，不轮询会话、不读日志，两者唯一的耦合就是这段载荷。
 */

import { appendFileSync, readFileSync, realpathSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { frameTranscript, isDirectUser, textOf } from './context.js'

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
const MAX_OUTPUT_CHARS = 640
const MAX_TOKENS = 900
const TIMEOUT_MS = 20000
/** 写一次 settings 最多等多久；超时就放弃这次写入，绝不把 busy 卡死。 */
const PUBLISH_TIMEOUT_MS = 3000
const words = new Intl.Segmenter('zh', { granularity: 'word' })

const SYSTEM = [
  '预测当前用户读完最新答复后最可能发出的下一条消息。用户最后明确交代的目标、限制和执行人优先；更早的会话摘要只用来解释仍然有效的要求和指代。',
  '先判断最新回复给用户带来了什么变化。哪条新事实影响用户原来的目标或选择？哪项要求仍未完成？也可能任务已结束。助手提出的下一步，只有符合用户当前意图时才值得接着说。用户想了解原因时，不要改成要求执行操作；不替用户授权、换目标、承认结论或承担原本交给助手的工作。',
  '结合用户目标和本轮新事实，把最有依据的反应排第一。即使一个费用、错误码或名称由助手首次提出，只要它影响用户要做的判断，就可以直接使用。若几种方向同样可能、依赖新的用户决定，或已经交付且没有明显需要回应的事，只输出 <skip>。',
  '已选定一项操作、助手只在确认是否开始时，一句简短确认就足够。如果助手同时提出几种选项、添加了新操作或改变了条件，不要推测用户会同意哪一个。需要区分哪个对象或条件时才展开。',
  '涉及选择分支、授权变更、断言用户手上有什么或没有什么时，须找到用户亲自说过的决定性原话。若能找到，该候选单独输出一行 JSON 数组 [建议, 依据]，两项均为字符串；依据是建议和用户原话共有的连续关键短语，须能证明这项决定或事实。只谈到相同话题不算依据。若找不到，就提一个不预设答案的问题，或输出 <skip>。一般追问直接输出文本。',
  '用用户当前使用的语言，表达具体、平实。语气词、情绪和对稿件文风的要求无需模仿。只输出能直接发送的话，每行一个候选，最有依据的放首行，最多三行，每句最多 40 个汉字；一条就足够时只给一条。',
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
  // Desktop 的应用首页由本机宿主提供。分享选择不会经过远程会话或模型。
  ctx.on('webserver/index-inject', table => {
    const desktop = join(resolve(process.env.DSH_HOME || join(homedir(),'.dsh')),'profiles','desktop')
    let receipt
    try {
      if (realpathSync(join(desktop,'node_modules','dsh-saynext','lib','index.js')) !== fileURLToPath(import.meta.url)) return
      receipt = JSON.parse(readFileSync(join(desktop,'.saynext-desktop-choice.json'),'utf8'))
    } catch { return } // 普通安装没有桌面下载选择。
    const json = JSON.stringify(receipt).replaceAll('<','\\u003c')
    table.push({kind:'script',placement:'head',text:
      'if(location.protocol==="dsh-app:"&&location.hostname==="app")window.__saynextDesktopChoice='+json+';'})
  })
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
  if (config?.hint) {
    let cached
    try {
      cached = JSON.parse(config.hint)
    } catch {
      trace('skip invalid cached hint')
    }
    if (Array.isArray(cached?.items)) {
      for (const entry of cached.items.slice(-MAX_ITEMS)) {
        if (typeof entry?.sessionId !== 'string' || !entry.sessionId || typeof entry.text !== 'string'
          || !entry.text || !Number.isSafeInteger(entry.turn) || entry.turn < 0) continue
        bank.set(entry.sessionId, entry)
        lastText.set(entry.sessionId, entry.text)
        latestTurn.set(entry.sessionId, entry.turn)
      }
      if (Number.isSafeInteger(cached.rev) && cached.rev >= 0 && cached.rev < Number.MAX_SAFE_INTEGER - 1) rev = cached.rev
    }
  }

  ctx.inject?.(['commands'], scope => {
    scope?.commands?.register({
      name: 'saynext-goal',
      description: '查看当前会话的建议摘要，或纠正总体目标',
      input: { hint: '[新目标或 clear]' },
      handler: ({agent, rawInput}) => {
        const value = (rawInput ?? '').trim()
        if (!value) return {kind: 'success', text: frameTranscript(agent.session).summary}
        if (value.length > 240) return {kind: 'error', text: '请将目标写在 240 字以内。'}
        return {kind: 'success', text: value === 'clear' ? '已恢复从本会话提取目标。' : '已更新本会话的目标：' + value}
      },
    })
  })

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

    const framed = frameTranscript(session, turn)
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
    const rankSession = {deriveMessages: () => framed.messages}
    const first = await complete(resolved.provider, resolved.model, framed.prompt, sessionId, previous)
    let result = first
    let text
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (result.text.trim() === '' || result.text.trimStart().split('\n', 1)[0].trim() === '<skip>') return
      const ranked = rankCandidates(result.text, rankSession, previous, result.complete, framed.requests)
      const best = ranked[0]
      if (best?.reason === null) {
        text = best.text
        break
      }
      if ((!best && !result.complete) || best?.reason === 'unsupported' || attempt === 2) return
      trace(`retry candidates reason=${best?.reason ?? 'format'}`)
      result = await complete(resolved.provider, resolved.model,
        retryPrompt(framed.prompt, best?.reason), sessionId, previous)
    }
    if (!text) return
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
   * 向模型要一句话。
   * @returns {Promise<{text: string, complete: boolean}>}
   */
  async function complete(provider, model, prompt, sessionId, avoid = '') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let raw = ''
    let normalStop = false
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
            const remaining = MAX_OUTPUT_CHARS - raw.length
            raw += chunk.text.slice(0, remaining)
            if (chunk.text.length > remaining) {
              // 够用了：主动掐断，别让上游继续烧 token
              controller.abort()
              break
            }
          } else if (chunk?.type === 'error') {
            trace(`stream error ${describe(chunk?.reason ?? chunk)}`)
            break
          } else if (chunk?.type === 'finish') {
            normalStop = chunk.reason?.kind === 'stop'
            if (chunk?.reason?.kind === 'error') {
              trace(`stream finish error ${describe(chunk.reason)}`)
            }
            break
          }
        }
      })().catch((error) => {
        normalStop = false
        trace(`stream aborted ${describe(error)}`)
      })

      const outcome = await Promise.race([
        collected.then(() => 'settled'),
        new Promise((resolve) => { deadline = setTimeout(() => resolve('timeout'), options.timeoutMs) }),
      ])
      if (outcome === 'timeout') {
        controller.abort()
        // 已收到的完整行照样可用，末尾半句交给 parseCandidates 判断
        trace(`hard timeout ${options.timeoutMs}ms session=${sessionId} kept=${raw.length}`)
      }
    } catch (error) {
      normalStop = false
      trace(`stream aborted ${describe(error)}`)
    } finally {
      clearTimeout(timer)
      clearTimeout(deadline)
    }
    return { text: raw, complete: normalStop && !controller.signal.aborted }
  }

  /** 去掉编号、项目符号、引号；太长或像解释的行直接丢掉。 */
  function cleanCandidate(line) {
    let one = String(line ?? '').trim()
    // markdown 残留：围栏、行内代码/加粗符号，先剥掉再判断形状
    one = one.replace(/```[a-zA-Z]*/g, '').replace(/\*\*/g, '').replace(/`/g, '')
    one = one.replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)）]\s*/, '')
    one = one.replace(/^[「『"'（(]+/, '').replace(/[」』"'）)]+$/, '')
    one = one.replace(/\s+/g, ' ').trim()
    if (one === '' || /^[-*_=]{3,}$/.test(one)) return ''
    // 提示词要求「每条不超过 40 个汉字」，但命令、路径会把总长度顶上去：
    // 按汉字数限 40、总长度限 80（UTF-16 码元），免得一条好命令被整行丢掉。
    const cjk = (one.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk > 40 || one.length > 80) return ''
    if (/^(例|说明|注意|备注)[：:]/.test(one)) return ''
    return one
  }

  /**
   * 把一次输出拆成最多三条候选（去重、去掉不合格行）。
   * complete=false 表示输出被截断：末尾没有换行的那一段可能只是半句，直接丢掉。
   */
  function parseCandidates(raw, complete = true) {
    const out = []
    const text = String(raw ?? '')
    const lines = text.split('\n')
    if (!complete && !text.endsWith('\n')) lines.pop()
    for (const line of lines) {
      let value = line.trim().replace(/^(?:[-*•·]|\d+[.、)）])\s*/u, ''), support = ''
      if (!value || value.startsWith('```')) continue
      if (value === '<skip>') break
      if (/^[{[]/u.test(value)) {
        let pair
        try { pair = JSON.parse(value) } catch { continue }
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(item => typeof item === 'string')) continue
        value = pair[0]
        support = pair[1]
        if (!support.trim() || /[\r\n]/u.test(value)) continue
      }
      const candidate = cleanCandidate(value)
      if (!candidate || /^[{[]/u.test(candidate) || candidate === '<skip>' || out.some(item => item.text === candidate)) continue
      out.push({text:candidate, support:support.trim()})
      if (out.length === 3) break
    }
    return out
  }

  function rankCandidates(raw, session, previous, complete = true, requests = frameTranscript(session).requests ?? []) {
    // 同一次生成已结合整个上下文排好序，筛选只跳过不可用的候选。
    return parseCandidates(raw, complete)
      .map(({text,support}) => ({text, reason: judgeSuggestion(text, session, previous, requests, support)}))
      .sort((a, b) => Number(a.reason !== null) - Number(b.reason !== null))
  }

  // 仅测试/评测用：设 DSH_SAYNEXT_TEST=1 时把内部判定挂到全局，供 scripts/rank.mjs 复跑。
  if (process.env.DSH_SAYNEXT_TEST === '1') {
    globalThis.__saynextTest = { system: SYSTEM, frameTranscript, judgeSuggestion, rankCandidates, parseCandidates, tidy }
  }

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
      if (!isDirectUser(all[index])) continue
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
    return body.includes(target)
  }

  function shortReplyCore(text) {
    return text.toLowerCase().trim().replace(/[。.!！…]+$/gu, '')
      .replace(/^(?:那就|现在|确认|直接|就|先)(?=.+)/u, '').replace(/吧$/u, '')
  }

  // 只有助手在确认用户已交代的同一项操作时，才放行单独的简短肯定。
  function confirmsRequest(text, session) {
    const reply = shortReplyCore(text)
    const user = lastUserText(session).trim().toLowerCase()
    const answer = lastAssistantText(session).trim().toLowerCase()
    const questions = answer.match(/[？?]/gu) ?? []
    if (questions.length !== 1 || /还是|或者|或是|\bor\b/u.test(answer)) return false
    const tail = answer.split(/[。！!；;\n]|\.(?=\s|$)/u).at(-1).trim()
    const zh = /^(?:是否|要不要|需要我|要我|可以|需要|我来|我|现在|直接|开始|先)*([^，,、？?]+?)(?:吗|么)?[？?]$/u.exec(tail)
    const en = /^(?:shall i|should i|do you want me to) (.+?)\?$/u.exec(tail)
    const action = (en || zh)?.[1]?.trim()
    if (!action || /还是|或者|并且|顺便|然后|以及|\band\b|继续$|^continue$/u.test(action)) return false
    if (/别|暂缓|不要|不(?:要|能|用|准|必)|禁止|如果|是否|还是|或者|或是|我来|我自己|[？?]|\b(?:not|never|unless|if)\b|don't/u.test(user)) return false
    const verb = [...words.segment(action)].find(part => part.isWordLike)?.segment
    if (!verb) return false
    const requested = user.split(/[。！!；;，,\n]|\.(?=\s|$)/u).some(part => {
      const task = part.trim().replace(/^(?:(?:请|帮我|给我|麻烦|直接|你来|先|现在|我决定|我要你)|(?:please|could you|i want you to)\s+)*/u,'')
      if (task === action) return true
      if (action !== verb || !task.startsWith(en ? action+' ' : action)) return false
      // 仅问动作时，用户原话可以更完整；陈述或询价本身并未选择执行。
      return task !== part.trim()
    })
    if (!requested) return false
    if (/^(?:好[的呀]?|可以|行|做|继续|ok(?:ay)?|yes|sure|go ahead)$/u.test(reply)) return true
    return reply === action || verb === reply || (reply.length === 1 && verb.length === 2 && verb.endsWith(reply))
  }

  function blandReason(text) {
    if (text === '') return 'empty'
    const flat = text.replace(/\s+/g, '').replace(/[。.!！?？…]+$/gu, '')
    // 锚点只认字母数字：把 . / \\ - 也算锚点会让「好的...」「继续。。。」被当成有对象。
    const anchorOrVerb = /[0-9A-Za-z]|(跑|改|删|加|装|查|写|建|拆|测|验|对比|回滚|合并|提交|确认|打开|读|打印|抓|导出|压测|调|修|替换|冻结|发布|截图|重跑|核对|补|停|看|找|搜|启动|清理|画|列|比|算|对齐|重构|定位|排查|复现|梳理|迁移|升级|回退|推送)/
    // 「好的 / 可以 / 行」打头不一定没价值（「行，那就先跑冒烟测试」是决定），
    // 只有去掉这层壳之后什么都不剩、或剩的没有动作，才算附和。
    // 分隔符必须是真分隔（标点或空白）：否则「对比两版输出」会被剥掉首字「对」，
    // 剩下的「比两版输出」既没动词也没锚点，整句被误判成附和。
    const lead = /^(好的?|好呀|可以|行|嗯+|对|是|没错|收到|明白了?|了解了?|谢谢|多谢|ok|okay|sure)[，,、:：\s]+/i
    if (/^(好的?|好呀|可以|行|嗯+|对|是|没错|收到|明白了?|了解了?|谢谢|多谢)[。！!….]*$/i.test(flat)) return 'agreement'
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
    const core = shortReplyCore(flat)
    if (!/[\p{L}\p{N}]/u.test(core)) return 'fragment'
    if ([...core].length < 3 && !(/(?:何|谁|哪|几|多久|多大)/u.test(core) && /[？?]$/u.test(text))) return 'short'
    if (/(?:闭环|赋能|抓手|打法|颗粒度|拉齐).*(?:闭环|赋能|抓手|打法|颗粒度|拉齐)/u.test(flat)) return 'jargon'
    if (/^(?:再|先)?(?:看看|检查|处理|优化|推进|验证)(?:一下|一下吧)?[。！!]?$/u.test(flat)) return 'vague'
    if (/^[\w./:\\-]+$/u.test(text) && /[./_]/u.test(text)) return 'fragment'
    return null
  }

  /** 建议是不是在谈这个插件自己（只在用户最近没聊插件时才判）。 */
  function selfTalk(text, context) {
    const flat = String(text ?? '')
    if (!/(插件|灰字|胶囊|saynext|say-next|dsh-saynext)/i.test(flat)) return false
    const recent = context.join('\n')
    return !/(插件|灰字|胶囊|saynext|say-next)/i.test(recent)
  }

  // 决定性的措辞须同时出现在建议及用户本人的肯定陈述中；助手列举的选项不能作证。
  function unsupportedCommitment(text, session, requests, support) {
    const branches = /或者|要么|还是.{1,60}[?？]|\beither\b|\bor\b.{0,90}\?/iu.test(lastAssistantText(session))
    const claim = /我(?:手[上里]|这边|目前|现在|已经|暂时)?(?:没有|没[有拿]|只有|已经选|决定|同意)|\bi (?:do not have|don't have|have no|chose|agreed)\b/iu
    const change = /清掉|清空|清除|删掉|删除|卸载|覆盖|付款|扣款|支付|投放|发布|重启|改成|改为|切换到|替换为|\b(?:delete|uninstall|overwrite|pay|publish|restart|switch to|replace with)\b/iu
    const clauses = text.match(/[^，,；;。！？!?\n]+[？?]?/gu) ?? []
    const question = /[?？]$|(?:吗|么)[。！!]*$/u.test(text)
    const positive = clauses.filter(c => !/[？?]$|[吗么]$/u.test(c) && !/别|不(?:要|用|再|必|能)|暂不|无需|停止|\b(?:not|never)\b|don't/iu.test(c))
    const operations = positive.map(clause => {
      const match = change.exec(clause)
      if (!match) return null
      const after = clause.slice(match.index + match[0].length)
      if (/^(?:前|后|时|记录|状态|日志|失败|次数|费用)/u.test(after)) return null
      const before = clause.slice(0, match.index).trim()
      if (/(?:查明|检查|核实|比较|解释|说明|列出|看看|确认是否|了解)(?:一下)?$|\b(?:explain|compare|investigate)\s*$/iu.test(before)) return null
      return match[0]
    }).filter(Boolean)
    const personal = clauses.find(c => claim.test(c))
    if (!support && !personal && !operations.length) {
      return branches && !question && !confirmsRequest(text, session)
    }
    if (support.length < 2 || !text.includes(support)) return true
    if (operations.some(action => !support.includes(action) || support === action)) return true
    if (personal && (!personal.includes(support) || !claim.test(support) || !support.replace(claim,'').trim())) return true
    return !requests.some(request => request.split(/[，,。；;！!\n]/u).some(clause => {
      if (!clause.includes(support) || /[？?]|是否|能否|为什么|怎么|如果|假如|\b(?:if|whether|why)\b/iu.test(clause)) return false
      if (operations.length && /不要|先别|禁止|不能|别再|暂不|\b(?:not|never)\b|don't/iu.test(clause)) return false
      if (branches && !personal && !question) {
        const choice = clause.trim().replace(/^(?:请你?|帮我|我选(?:择)?|我决定|就用|就按|先|\s)+/u,'')
        return clause.trim() === support || choice.startsWith(support)
      }
      return true
    }))
  }

  function judgeSuggestion(text, session, previous, requests = [lastUserText(session)], support = '') {
    if (text === '') return 'empty'
    if (previous && text === previous) return 'duplicate'
    if (requests.some(request => defersRequest(text, request))) return 'defers-request'
    const bland = blandReason(text)
    if (bland !== null && !(['agreement', 'short'].includes(bland) && confirmsRequest(text, session))) return bland
    if (echoes(text, lastAssistantText(session))) return 'echo'
    // 用户刚自己说完的话再端回来，同样没有价值（「打印 rev=6 的载荷」这种）。
    if (echoes(text, lastUserText(session))) return 'repeat-user'
    if (aiVoice(text)) return 'address'
    if (selfTalk(text, [...requests, lastAssistantText(session)])) return 'selftalk'
    if (unsupportedCommitment(text, session, requests, support)) return 'unsupported'
    return null
  }

  /** 带着「哪里不对」重问一次，而不是把原话原样再塞回去。 */
  function retryPrompt(prompt, reason) {
    const feedback = {
      'defers-request': '这句话擅自暂停了用户交代的任务。围绕当前交付物给一句有依据的建议；没有就输出 <skip>。',
      short: '这句简短回复的对象或依据不明确。如果用户仍需做选择就留空，不要把同意扩写成长句。',
      agreement: '刚才只是在附和。用户以前没有选定当前操作时，不要给确认；有独立且明确的下一步才提出，否则留空。',
      echo: '刚才复述了助手的原话。回到用户交代的事情，还有什么没解决？',
      'repeat-user': '刚才只是重复用户说过的话。结合实际进展，用户现在还需要什么？',
      address: '刚才像是助手在给用户布置任务。请换成用户会直接问或交代的一句话。',
      duplicate: '上一轮已经给过这句话。看看这轮是否真的还有新的需要。',
      selftalk: '用户没在讨论这个插件。回到用户自己的事情。',
      fragment: '刚才只给了名称或地址。请把要问的事说成一句完整的话。',
      jargon: '刚才堆了好几个抽象词。请点明要比较的对象、要核实的信息或要修改的内容，只选当前最相关的一项。',
    }[reason] ?? '把想问或想做的事说清楚，让用户读一遍就明白。'
    return `${prompt}\n${feedback} 如果没有合适的话，单独输出 <skip>。`
  }

  function aiVoice(text) {
    if (/[?？]$/u.test(text)) return /^(?:要我帮你|需要我帮你)/u.test(text)
    return /^(?:你|您)(?:可以先|需要先|不妨|最好先)|^(?:我可以帮你|要我帮你|需要我帮你)/u.test(text)
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
    // 切句不绕过上限：首句本身超过 90 字时同样截断（K37 钉住）。
    return text.length > 90 ? text.slice(0, 90) : text
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

function defersRequest(candidate, request) {
  const pause = /(?:放一放|放放|放在?一边|放到一边|放到以后|搁置|暂缓|推迟|暂停|(?:先|暂时)(?:不|别)(?:写|做|弄|处理)|(?:回头|改天|以后)再(?:写|做)|不用再(?:写|做))/u
  const normalize = value => value.replace(/长贴[子]?|长帖子/gu, '长帖')
  const goal = normalize(request)
  const clauses = normalize(candidate).split(/[，,。；;！？!?\n]/u)
  for (const clause of clauses) {
    const match = pause.exec(clause)
    if (!match || /(?:别|不要|不能|不用|不必|无需)(?:先|再)?$/u.test(clause.slice(0, match.index))) continue
    const target = (clause.slice(0, match.index) + ' ' + clause.slice(match.index + match[0].length))
      .replace(/^(?:我们|我)?(?:还是|那就)?(?:暂时|先)?(?:把|将)?/u, '').replace(/(?:暂时|可以|就|先|了|吧|一下|的话)/gu, '').trim()
    if (target && !goal.includes(target)) continue
    const authorized = goal.split(/[，,。；;！？!?\n]/u).some(part => {
      const requestedPause = pause.exec(part)
      return requestedPause && (!target || part.includes(target)) && !/(?:别|不要|不能|不用|不必|无需)(?:先|再)?$/u.test(part.slice(0, requestedPause.index))
    })
    if (!authorized) return true
  }
  return false
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

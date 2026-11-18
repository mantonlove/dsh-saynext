/**
 * dsh-saynext · 宿主侧
 *
 * 每当一条会话的一轮正常收尾（turn/end，reason = completed），就用这条会话
 * 最近几轮对话向模型要一句"用户紧接着最可能说的话"，存进内存小本子，再经
 * 插件的配置通道（settings 的 `hint` 字段）递给界面。
 *
 * 界面侧只看这份 JSON，不轮询会话、不读日志，两者唯一的耦合就是这段载荷。
 */

import { appendFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

const TRACE = '/tmp/dsh-saynext.log'

/** 临时诊断：把关键节点写进文件，便于确认插件是否真的被加载。 */
function trace(line) {
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

const NAMESPACE = 'saynext'
const CHANNEL = 'hint'
const MAX_ITEMS = 8
const MAX_TURNS = 4
const MAX_TRANSCRIPT_CHARS = 4000
const MAX_OUTPUT_CHARS = 160
const MAX_TOKENS = 400
const TIMEOUT_MS = 20000

const SYSTEM = [
  '你在替一位正在使用 AI 编程助手的人起草他的下一句话。',
  '读最后几轮对话，猜他最可能紧接着要说的那一句，写成可以直接发送的中文指令。',
  '规则：不超过 30 个汉字；动词开头；具体到对象（文件、函数、命令、页面）；',
  '不要称呼、不要引号、不要前缀、不要解释、不要两条；',
  '如果刚刚那件事已经收尾，就写最自然的下一步推进或验收动作。',
  '只输出这一句话本身。',
].join('\n')

export const name = 'dsh-saynext'

/**
 * 插件配置：只有一格 `hint`，用来把宿主算好的建议递给界面侧。
 * `.volatile()` 让这一格可写（没有它，settings 会以
 * 「No configurable plugin entry」拒绝落盘）。
 */
export const Config = z.object({
  hint: z.string().default('').volatile(),
})
export const inject = ['llm', 'sessions']

/**
 * @param {any} ctx 宿主 Cordis 上下文
 */
export function apply(ctx) {
  /** @type {Map<string, {sessionId: string, text: string, turn: number, rev: number, at: number}>} */
  const bank = new Map()
  /** @type {Set<string>} 正在为哪些会话要句子 */
  const busy = new Set()
  let rev = 0

  trace(`apply pid=${process.pid}`)

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (event?.data?.reason?.kind !== 'completed') return
    const sessionId = String(session?.id ?? '')
    trace(`turn/end session=${sessionId} turn=${event?.data?.turn}`)
    if (sessionId === '' || busy.has(sessionId)) return
    busy.add(sessionId)
    void ask(session, sessionId, Number(event?.data?.turn ?? 0))
      .catch((error) => {
        trace(`ask FAILED ${describe(error)}`)
      })
      .finally(() => { busy.delete(sessionId) })
  })

  /**
   * @param {any} session
   * @param {string} sessionId
   * @param {number} turn
   */
  async function ask(session, sessionId, turn) {
    const config = session?.requestHeader?.()?.config
    const provider = config?.provider
    const model = config?.model
    trace(`ask session=${sessionId} provider=${provider} model=${model}`)
    if (typeof provider !== 'string' || typeof model !== 'string') return
    if (provider === '' || model === '') return

    const framed = frameTranscript(session)
    if (framed === '') return

    const text = await complete(provider, model, framed, sessionId)
    trace(`text=${JSON.stringify(text)}`)
    if (text === '') return

    bank.set(sessionId, { sessionId, text, turn, rev: ++rev, at: Date.now() })
    while (bank.size > MAX_ITEMS) {
      const oldest = bank.keys().next()
      if (oldest.done) break
      bank.delete(oldest.value)
    }
    await publish()
  }

  /** 把最近几轮对话拼成一段纯文本交给模型。 */
  function frameTranscript(session) {
    let all
    try {
      all = session?.deriveMessages?.()
    } catch {
      all = undefined
    }
    if (!Array.isArray(all) || all.length === 0) return ''
    const lines = []
    let budget = MAX_TRANSCRIPT_CHARS
    const kept = []
    for (let index = all.length - 1; index >= 0 && kept.length < MAX_TURNS * 2; index -= 1) {
      const message = all[index]
      const role = message?.role
      if (role !== 'user' && role !== 'assistant') continue
      const text = textOf(message)
      if (text === '') continue
      const size = text.length + 3
      if (size > budget) continue
      budget -= size
      kept.push({ role, text })
    }
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const item = kept[index]
      lines.push(`${item.role === 'user' ? '用户' : 'AI'}：${item.text}`)
    }
    if (lines.length === 0) return ''
    return ['这是最近几轮对话：', lines.join('\n'), '', '请写出这位用户紧接着最可能说的那一句话。'].join('\n')
  }

  /**
   * 向模型要一句话。
   * @returns {Promise<string>}
   */
  async function complete(provider, model, prompt, sessionId) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let raw = ''
    try {
      const messages = [await userMessage(prompt)]
      const stream = ctx.llm.stream({
        provider,
        model,
        messages,
        system: SYSTEM,
        maxTokens: MAX_TOKENS,
        sessionId,
        signal: controller.signal,
      })
      let seen = 0
      for await (const chunk of stream) {
        if (seen < 8) {
          seen += 1
          trace(`chunk type=${chunk?.type} len=${typeof chunk?.text === 'string' ? chunk.text.length : 0}`)
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          raw += chunk.text
          if (raw.length > MAX_OUTPUT_CHARS * 4) break
        } else if (chunk?.type === 'error' || chunk?.type === 'finish') {
          if (chunk?.reason?.kind === 'error') trace(`stream finish error ${describe(chunk.reason)}`)
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return tidy(raw)
  }

  /** 把模型输出收拾成一行干净的话。 */
  function tidy(raw) {
    let text = String(raw ?? '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
    text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    text = text.replace(/^[（(【\[]?\s*(建议|下一句|用户|next)[:：]\s*/i, '')
    text = text.replace(/\s+/g, ' ').trim()
    if (text.length > 60) text = text.slice(0, 60)
    return text
  }

  /** 把最新小本子写到插件配置的 `hint` 字段，界面侧轮询这一格。 */
  async function publish() {
    const payload = JSON.stringify({
      rev,
      items: [...bank.values()].map((entry) => ({
        sessionId: entry.sessionId,
        text: entry.text,
        turn: entry.turn,
        rev: entry.rev,
        at: entry.at,
      })),
    })
    await new Promise((resolve) => {
      ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings
        if (settings === undefined || settings === null) {
          trace('publish skipped: no settings service')
          resolve(undefined)
          return
        }
        Promise.resolve(settings.update(NAMESPACE, { [CHANNEL]: payload }))
          .then(() => trace(`publish ok bytes=${payload.length}`))
          .catch((error) => trace(`publish FAILED ${describe(error)}`))
          .then(() => resolve(undefined))
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

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

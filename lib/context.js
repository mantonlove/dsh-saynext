/** 从当前会话已持久化的可见发言重建摘要，回放和宿主共用此入口。 */
export function textOf(message) {
  if (typeof message?.content === 'string') return message.content.trim()
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
}

export function isDirectUser(message) {
  return message?.role === 'user' && (message.source === undefined || message.source?.kind === 'user')
}

function excerpt(text, limit) {
  if (text.length <= limit) return text
  const head = Math.floor((limit - 1) / 2)
  return text.slice(0, head) + '…' + text.slice(-(limit - head - 1))
}

const newTask = /^(?:(?:现在|接下来|这次|今天)[，,\s]*)?(?:我(?:想要|想|要|需要)|请(?:帮我)?|帮我)\s*(?:先|重新|直接)?(?:写|做|整理|起草|生成|制作|准备)(?:一|两)[篇份个封本张段套]/u
const switchTask = /^(?:换个(?:话题|任务)|我改主意了|改一下目标|换个目标|现在改为|switch topics?\b|new task\b)/iu
const continuation = /^(?:继续|接着|好的?|可以|就这样|按这个来|continue|go ahead)[。！!.\s]*$/iu
const pointer = /第[一二三四五六七八九十\d]+[个条项种套版]|(?:前面|之前|刚才|上面)(?:说的|提到的|的)?(?:方案|建议|选项|版本)|(?:the )?(?:first|second|third) option/iu
const numbered = /(?:^|[\n；;。\s])(?:[-*•]|(?:方案|选项|第)?[一二三四五六七八九十\d]+[、.．)）项种：:])/mu
const requirement = /必须|只要|只用|只做|只看|不要|不用|先别|保留|保持|限定|限于|至少|最多|我选|我决定|就用|采用|按.{1,24}(?:来|做)|只写|只需要|要用|must\b|only\b|keep\b|do not\b/iu
const reported = /^已(?=\p{Script=Han})|已(?:经|完成|写|改|做|生成|更新|整理|添加|发布|提交)|完成了|写好了|改好了|做好了|这里是|如下|I(?:’ve|'ve| have)\b|completed\b/iu
const openIssue = /还(?:没|差|缺|需)|尚(?:未|需)|未(?:定|决|完成|确认|解决)|待(?:确认|决定|补充)|要不要|是否需要|需要我|would you like|still (?:need|missing)/iu

function startsTask(text) {
  return switchTask.test(text) || (newTask.test(text) && !/(?:上述|前面|之前|上面|基于此|刚才|提到的|说的那个)/u.test(text))
}

function collect(session, until) {
  const turns = []
  let current
  let manual
  function add(role, text, number) {
    if (!text || (!current && role !== 'user')) return
    if (!current || current.number !== number) {
      current = { number, user: '', assistant: '' }
      turns.push(current)
    }
    current[role] += (current[role] ? '\n' : '') + text
  }
  const log = session?.log
  if (Array.isArray(log) && log.some(e => e.type === 'user/message' || e.type === 'command/run')) {
    let number = 0
    const commands = new Map()
    for (const {type, data} of log) {
      if (type === 'turn/start') {
        number = data.turn
        if (until !== undefined && number > until) break
      }
      if (type === 'turn/end') {
        if (current?.number === data.turn) current.closed = data.reason?.kind
        if (data.turn === until) break
      }
      if (type === 'user/message' && data.source?.kind === 'user') add('user', textOf(data), number)
      if (type === 'assistant/message') add('assistant', textOf(data.message), data.turn ?? number)
      if (type === 'command/run' && data.name === 'saynext-goal' && data.args?.trim()) commands.set(data.commandId, data.args.trim())
      if (type === 'command/done' && commands.has(data.commandId) && data.kind === 'success') {
        const value = commands.get(data.commandId)
        manual = value === 'clear' ? undefined : {number, text: value}
      }
    }
  } else {
    let number = 0
    const messages = session?.deriveMessages?.() ?? []
    for (const msg of messages) {
      if (isDirectUser(msg)) {
        const text = textOf(msg)
        if (text) add('user', text, ++number)
      } else if (msg?.role === 'assistant') add('assistant', textOf(msg), number)
    }
  }
  const start = turns.findLastIndex(t => startsTask(t.user))
  const scoped = turns.slice(Math.max(0, start))
  if (start >= 0 && manual && turns[start].number > manual.number) manual = undefined
  const previousReply = start > 0 && switchTask.test(turns[start].user) ? turns[start - 1] : undefined
  return {turns: scoped, manual, previousReply}
}

function clauses(text) {
  return text.match(/[^。！？!?\n]+[。！？!?]?/gu)?.map(s => s.trim()).filter(Boolean) ?? []
}

function summarize(turns, manual) {
  const lines = []
  const goalTurn = turns.find(t => t.user && !continuation.test(t.user))
  const goal = manual ?? (goalTurn && {number: goalTurn.number, text: goalTurn.user})
  if (goal) lines.push(['总体目标', goal.number, manual ? '用户校正' : '用户原话', excerpt(goal.text, 160)])
  const requirements = []
  let preceding
  for (const turn of turns) {
    for (const clause of clauses(turn.user)) {
      // 询问是否采用某个方案，还不能证明用户选了它。
      if (/[?？]$/u.test(clause) || /^(?:要不要|是否|如果|假如|if |should we )/iu.test(clause)) continue
      const accepts = /(?:就这么做|就这样定|按你说的|按这个方案|go ahead with)/iu.test(clause)
      if (requirement.test(clause) || accepts) {
        const source = accepts && preceding?.assistant
          ? excerpt(clause, 60) + `（所回应的第${preceding.number}轮助手原话：${excerpt(preceding.assistant, 100)}）`
          : excerpt(clause, 100)
        requirements.push(['已确认要求', turn.number, '用户', source])
      }
    }
    preceding = turn
  }
  lines.push(...requirements.slice(-3))
  const latest = turns.at(-1)
  const progress = turns.findLast(t => t.assistant && clauses(t.assistant).some(c => reported.test(c)))
  if (progress) {
    const source = clauses(progress.assistant).findLast(c => reported.test(c))
    lines.push(['最近报告的进展', progress.number, '助手', excerpt(source, 120)])
  }
  const open = clauses(latest?.assistant ?? '').findLast(c => openIssue.test(c))
  if (open) lines.push(['未决或待用户选择', latest.number, '助手', excerpt(open, 120)])
  return lines
}

function renderSummary(lines, recent = []) {
  return ['总体目标','已确认要求','最近报告的进展','未决或待用户选择'].map(field => {
    const entries = lines.filter(row => row[0] === field).map(([,number,source,quote]) => {
      const duplicate = recent.some(r => r.number === number && quote.split('…').every(piece => r[source === '助手' ? 'assistant' : 'user'].includes(piece)))
      return `第${number}轮·${source}${duplicate ? '（见下文）' : '：' + quote}`
    })
    return field + '：' + (entries.join(' / ') || '无明确记录')
  }).join('\n')
}

/** 每轮保留用户和助手两方，各轮最多 1440、900、550 码元。余量优先给本轮另一方。 */
function recentTurn(turn, budget) {
  const reserved = Math.min(turn.user.length, Math.ceil(budget / 2))
  const assistant = excerpt(turn.assistant, budget - reserved)
  return {number: turn.number, user: excerpt(turn.user, budget - assistant.length), assistant}
}

export function frameTranscript(session, until) {
  const {turns, manual, previousReply} = collect(session, until)
  const last = turns.at(-1)
  const lines = summarize(turns, manual)
  const summary = renderSummary(lines)
  if (!last?.user) return {prompt: '', chars: 0, summary, requests: []}
  const eligible = turns.filter(t => t.user && (t === last || (t.assistant && (!t.closed || t.closed === 'completed'))))
  const recent = eligible.slice(-3).reverse().map((turn, index) => recentTurn(turn, [1440, 900, 550][index])).reverse()
  const parts = ['本会话摘要（原话节选，以最新明确要求为准）', renderSummary(lines, recent)]
  let referenced = ''
  if (previousReply?.assistant && turns.length <= 2) {
    referenced = excerpt(previousReply.assistant, 140)
    parts.push(`用户改主意前的答复·第${previousReply.number}轮助手：${referenced}`)
  }
  if (pointer.test(last.user)) {
    const source = turns.slice(0, -1).findLast(t => numbered.test(t.assistant))
    if (source) {
      const choices = source.assistant.split(/\n/u).filter(line => numbered.test(line))
      const quote = excerpt(choices.join('\n') || source.assistant, 320)
      if (!recent.some(r => r.number === source.number && r.assistant.includes(quote))) {
        referenced += quote
        parts.push(`用户指代的候选出处·第${source.number}轮助手：${quote}`)
      }
    }
  }
  if (continuation.test(last.user) || /^(?:你确定吗|真的吗|are you sure)[？?。!！]*$/iu.test(last.user)) {
    const source = turns.slice(0, -1).findLast(t => t.user && !continuation.test(t.user) && !/^(?:你确定吗|真的吗)[？?。!！]*$/u.test(t.user))
    if (source && !recent.some(r => r.number === source.number)) {
      const quote = excerpt(source.user, 100) + ' / ' + excerpt(source.assistant, 180)
      referenced += quote
      parts.push(`简短跟进的最近实质对话·第${source.number}轮（用户 / 助手）：${quote}`)
    }
  }
  for (const turn of recent) {
    const current = turn.number === last.number
    parts.push(`第${turn.number}轮·${current ? '当前用户原话' : '此前用户'}：${turn.user}`)
    if (turn.assistant) parts.push(`第${turn.number}轮·助手：${turn.assistant}`)
  }
  const goal = lines.find(row => row[0] === '总体目标')?.[3]
  const requests = [last.user]
  if (goal && continuation.test(last.user) && goal !== last.user) requests.push(goal)
  const chars = recent.reduce((n, r) => n + r.user.length + r.assistant.length, 0) + referenced.length
  const messages = recent.flatMap(t => [{role: 'user', content: t.user}, {role: 'assistant', content: t.assistant}])
  return {prompt: parts.join('\n'), chars, requests, summary, messages}
}

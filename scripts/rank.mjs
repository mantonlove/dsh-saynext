/**
 * 复跑一次采样的本地排序，打印每组候选的筛选结果和最终选择。
 * 用法：DSH_SAYNEXT_TEST=1 node scripts/rank.mjs samples.txt
 *      samples.txt 每行一条候选，用空行分组（即 scripts/replay.py 输出的样子）。
 * 可选第二参数：对话 JSON（replay.py 的 REPLAY_MESSAGES_OUT 产物）。
 *      不给时按空上下文筛选
 *      （空话、残句等）。
 */
import { readFileSync } from 'node:fs'

process.env.DSH_SAYNEXT_TEST = '1'
const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const ctx = {
  on: () => {},
  sessions: { list: () => [], get: () => undefined },
  settings: { update: async () => {} },
  llm: { stream: () => (async function* () {})() },
  inject: (_n, fn) => fn(),
  root: null,
}
mod.apply(ctx, {})
const t = globalThis.__saynextTest
if (t === undefined) {
  console.error('内部钩子没挂上：确认 DSH_SAYNEXT_TEST=1 与 lib/index.js 能加载')
  process.exit(1)
}

if (process.argv[2] === '--prompt') {
  const messages = JSON.parse(readFileSync(0, 'utf8')).map(({ role, text }) => ({ role, content: text }))
  console.log(JSON.stringify({ system: t.system, ...t.frameTranscript({ deriveMessages: () => messages }) }))
  process.exit(0)
}

const text = readFileSync(process.argv[2], 'utf8')
const groups = text.split(/\n\s*\n/).map((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''))
// 可选的第二个参数：replay.py 用 REPLAY_MESSAGES_OUT 导出的对话，
// 用来复现 echo/selftalk 这类依赖上下文的判定。
const messagesFile = process.argv[3]
const transcript = messagesFile === undefined ? [] : JSON.parse(readFileSync(messagesFile, 'utf8'))
const session = {
  deriveMessages: () => transcript.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.text }] })),
}
let index = 0
for (const group of groups) {
  index += 1
  const ranked = t.rankCandidates(group.join('\n'), session, '')
  console.log(`\n第 ${index} 组`)
  for (const item of ranked) console.log(`  ${item.reason ?? 'ok'}  ${item.text}`)
  console.log(`  选中 → ${ranked.find((item) => item.reason === null)?.text ?? '（无合格候选）'}`)
}

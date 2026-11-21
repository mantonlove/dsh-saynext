/**
 * 复跑一次采样的本地排序，打印每组候选的分数与最终会选中的那条。
 * 用法：DSH_SAYNEXT_TEST=1 node scripts/rank.mjs samples.txt
 *      samples.txt 每行一条候选，用空行分组（即 scripts/replay.py 输出的样子）。
 * 可选第二参数：对话 JSON（replay.py 的 REPLAY_MESSAGES_OUT 产物）。
 *      不给时用空上下文，此时 echo/reuse/selftalk 不会触发，只比确定性项
 *      （具体对象/动词开头/长度/是否附和）。
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

const text = readFileSync(process.argv[2], 'utf8')
const groups = text.split(/\n\s*\n/).map((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''))
// 可选的第二个参数：replay.py 用 REPLAY_MESSAGES_OUT 导出的对话，
// 用来复现 echo/reuse/selftalk 这类依赖上下文的判定。
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
  for (const item of ranked) console.log(`  ${item.score}  ${item.reason ?? 'ok'}  ${item.text}`)
  console.log(`  选中 → ${ranked[0]?.text ?? '（无候选）'}`)
}

import { pathToFileURL } from 'node:url'

const file = new URL('../lib/index.js', import.meta.url).href
const mod = await import(file)

let ok = 0
let bad = 0
const check = (id, cond, detail = '') => {
  if (cond) { ok += 1; console.log(`${id} PASS ${detail}`) } else { bad += 1; console.log(`${id} FAIL ${detail}`) }
}

/** 每调用一次 llm.stream 就从队列里取一句（取完就不说话）。 */
function makeCtx(texts) {
  const calls = { prompts: [], systems: [], n: 0 }
  const writes = []
  const handlers = []
  const session = {
    id: 'session-demo',
    provider: 'prov',
    model: 'model-x',
    requestHeader: () => ({ config: { provider: 'prov', model: 'model-x' } }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '把 README 的中英两版对齐一下，顺手把安装三步补齐，别只改中文那份。' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已经改完中文那份，还差英文里的软链目标检查。要我继续吗？' }] },
    ],
  }
  const ctx = {
    on: (name, fn) => { handlers.push({ name, fn }) },
    sessions: { list: () => [session], get: () => session },
    settings: { update: async (ns, patch) => { writes.push(patch) } },
    llm: {
      stream: (params) => {
        calls.prompts.push(params.messages?.[0]?.content?.[0]?.text ?? '')
        calls.systems.push(params.system)
        const text = texts[Math.min(calls.n, texts.length - 1)]
        calls.n += 1
        return (async function* () {
          if (text !== null) yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    inject: (_names, fn) => fn(),
    root: null,
  }
  return { ctx, calls, writes, fire: (turn = 7) => handlers.forEach((h) => h.name === 'session/event' && h.fn(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })) }
}

async function run(texts) {
  const { ctx, calls, writes, fire } = makeCtx(texts)
  mod.apply(ctx, {})
  fire()
  await new Promise((r) => setTimeout(r, 60))
  return { calls, writes }
}

// K1：提示词结构（含 AI 结尾节选与判断指令）
{
  const { calls } = await run(['跑一遍 smoke-freeze.json 的冒烟测试'])
  const prompt = calls.prompts[0] ?? ''
  check('K1a', prompt.includes('AI 最后一条的结尾'), '提示词带 AI 结尾节选')
  check('K1b', prompt.includes('判断用户此刻最有价值的下一步'), '提示词要求判断下一步')
  check('K1c', (calls.systems[0] ?? '').includes('禁止附和'), 'system 明确禁止附和')
}

// K2：附和句会被重问一次，第二句合格就采用
{
  const { calls, writes } = await run(['好的，继续', '先跑 pnpm pack 核对 8 个文件'])
  const payload = writes.at(-1)?.hint ?? ''
  check('K2a', calls.n === 2, `调用次数=${calls.n}`)
  check('K2b', payload.includes('pnpm pack'), payload.slice(0, 120))
  check('K2c', calls.prompts[1]?.includes('只是在附和'), '重问时点明附和')
}

// K3：两句都附和 → 整轮不写
{
  const { writes } = await run(['好的', '可以，继续'])
  check('K3', writes.length === 0, `写入次数=${writes.length}`)
}

// K4：多行输出压成一行
{
  const { writes } = await run(['拿\n quotes.toscrape.com\n 跑一遍翻页循环验证'])
  const hint = writes.at(-1)?.hint ?? ''
  const items = hint === '' ? [] : JSON.parse(hint).items
  check('K4', items.length === 1 && !items[0].text.includes('\n'), JSON.stringify(items[0]?.text ?? ''))
}

// K5：「继续跑冒烟测试」是具体动作，不该被当成附和而重问
{
  const { calls, writes } = await run(['继续跑一遍冒烟测试，把结果贴给我'])
  check('K5a', calls.n === 1, `调用次数=${calls.n}`)
  check('K5b', (writes.at(-1)?.hint ?? '').includes('冒烟'), '直接采用')
}

// K6：「行，那就先跑 X」是决定，不是空话
{
  const { calls, writes } = await run(['行，那就先跑 pnpm pack 看文件数'])
  check('K6a', calls.n === 1, `调用次数=${calls.n}`)
  check('K6b', (writes.at(-1)?.hint ?? '').includes('pnpm pack'), '直接采用')
}

// K7：只有「继续」→ 判为附和
{
  const { calls, writes } = await run(['继续', '先看 trace.log 最后 5 行'])
  check('K7a', calls.n === 2, `调用次数=${calls.n}`)
  check('K7b', (writes.at(-1)?.hint ?? '').includes('trace.log'), '重问后采用')
}

// K8：7 个字的「继续跑冒烟测试」是合格动作，不该被判 too-short
{
  const { calls, writes } = await run(['继续跑冒烟测试'])
  check('K8a', calls.n === 1, `调用次数=${calls.n}`)
  check('K8b', (writes.at(-1)?.hint ?? '').includes('冒烟'), '直接采用')
}

// K9：两句话压平后只取第一句，不拼成双命令
{
  const { writes } = await run(['跑冒烟测试。\n提交代码'])
  const hint = writes.at(-1)?.hint ?? ''
  const text = hint === '' ? '' : JSON.parse(hint).items[0].text
  check('K9', text.includes('冒烟') && !text.includes('提交代码'), JSON.stringify(text))
}

// K10：英文纯确认词（含 go ahead）要被判为附和并重问
{
  const { calls, writes } = await run(['go ahead', '跑 pytest -q 看失败用例'])
  check('K10a', calls.n === 2, `调用次数=${calls.n}`)
  check('K10b', JSON.parse(writes.at(-1)?.hint ?? '{"items":[{"text":""}]}').items[0].text.includes('pytest'), '重问后采用第二句')
}

// K11：「行，先跑单测」是带动作的短决定，不该被判附和
{
  const { calls } = await run(['行，先跑单测'])
  check('K11', calls.n === 1, `调用次数=${calls.n}`)
}

// K12：「对比两版输出」不能因为首字是「对」被剥掉
{
  const { calls } = await run(['对比两版输出，把差异贴出来'])
  check('K12', calls.n === 1, `调用次数=${calls.n}`)
}

// K13：单独一个「对」仍是附和
{
  const { calls } = await run(['对', '跑 pytest -q 看失败用例'])
  check('K13', calls.n === 2, `调用次数=${calls.n}`)
}

// K14：「sure, go ahead」是组合确认词，仍要重问
{
  const { calls } = await run(['sure, go ahead', '跑 pytest -q 看失败用例'])
  check('K14', calls.n === 2, `调用次数=${calls.n}`)
}

// K15：3 字动作句「跑测试」不该被当成空话
{
  const { calls } = await run(['跑测试'])
  check('K15', calls.n === 1, `调用次数=${calls.n}`)
}

// K16：「好的...」里的点号不算锚点，仍判附和
{
  const { calls } = await run(['好的...', '跑 pytest -q 看失败用例'])
  check('K16', calls.n === 2, `调用次数=${calls.n}`)
}

// K17：「对齐接口命名」靠动词表放行（上一轮靠剥壳误判的反例）
{
  const { calls } = await run(['对齐接口命名'])
  check('K17', calls.n === 1, `调用次数=${calls.n}`)
}

// K18：新一轮算不出建议时，上一轮那条要留着（不能整块空白）
{
  const { ctx, writes, fire } = makeCtx(['跑 pytest -q', ''])
  mod.apply(ctx, {})
  fire(7)
  await new Promise((r) => setTimeout(r, 60))
  const first = writes.at(-1)?.hint ?? ''
  fire(8)
  await new Promise((r) => setTimeout(r, 60))
  const last = writes.at(-1)?.hint ?? ''
  check('K18a', first.includes('pytest'), '第一轮写入了建议')
  check('K18b', last === first, `失败时没有覆盖：${last.slice(0, 40)}`)
}

// K19：复述 AI 上一句 → 重问一次，改用新的一句
{
  const { writes } = await run(['还差英文里的软链目标检查', '跑一遍链接检查脚本再把结果贴出来'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K19', hint.includes('跑一遍链接检查脚本'), `写入=${hint.slice(0, 60)}`)
}

// K20：复述两次 → 整轮不写
{
  const { writes } = await run(['还差英文里的软链目标检查', '还差英文里的软链目标检查'])
  check('K20', writes.length === 0, `写入次数=${writes.length}`)
}

// K23：把用户刚说过的话原样端回来 → 重问，改用新的下一步
{
  const said = '把 README 的中英两版对齐一下，顺手把安装三步补齐，别只改中文那份。'
  const { writes } = await run([said, '跑 pnpm pack 核对 8 个文件'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K23', hint.includes('pnpm pack'), `写入=${hint.slice(0, 60)}`)
}

// K24：两次都只是复述用户的话 → 整轮不写
{
  const said = '把 README 的中英两版对齐一下，顺手把安装三步补齐，别只改中文那份。'
  const { writes } = await run([said, said])
  check('K24', writes.length === 0, `写入次数=${writes.length}`)
}

// K21：以「你」开头（AI 对用户说话的口吻）→ 重问，改用用户的口令
{
  const { writes } = await run(['你来重启，测试已全 PASS，重启后核对载荷', '重启后查一遍 trace.log 里有没有 publish 失败'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K21', hint.includes('重启后查一遍 trace.log'), `写入=${hint.slice(0, 60)}`)
}

// K22：连续两次都是「你来…」→ 整轮不写
{
  const { writes } = await run(['你来重启一下看看', '你可以先跑一遍看看'])
  check('K22', writes.length === 0, `写入次数=${writes.length}`)
}

console.log(`\n${bad === 0 ? 'ALL PASS' : 'FAILED'} pass=${ok} fail=${bad}`)
process.exit(bad === 0 ? 0 : 1)

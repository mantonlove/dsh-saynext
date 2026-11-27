import { pathToFileURL } from 'node:url'

// 打开测试钩子：tidy / judgeSuggestion 等内部函数通过 globalThis.__saynextTest 暴露
process.env.DSH_SAYNEXT_TEST = '1'

const file = new URL('../lib/index.js', import.meta.url).href
const mod = await import(file)

let ok = 0
let bad = 0
const check = (id, cond, detail = '') => {
  if (cond) { ok += 1; console.log(`${id} PASS ${detail}`) } else { bad += 1; console.log(`${id} FAIL ${detail}`) }
}

/** 每调用一次 llm.stream 就从队列里取一句（取完就不说话）。 */
function makeCtx(texts, messages) {
  const calls = { prompts: [], systems: [], n: 0 }
  const writes = []
  const handlers = []
  const session = {
    id: 'session-demo',
    provider: 'prov',
    model: 'model-x',
    requestHeader: () => ({ config: { provider: 'prov', model: 'model-x' } }),
    deriveMessages: () => messages ?? [
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
        const entry = texts[Math.min(calls.n, texts.length - 1)]
        const text = entry !== null && typeof entry === 'object' ? entry.text : entry
        const fail = entry !== null && typeof entry === 'object' && entry.fail === true
        calls.n += 1
        return (async function* () {
          if (text !== null) yield { type: 'text-delta', text }
          if (fail) yield { type: 'error', reason: { kind: 'aborted' } }
          else if (entry?.finish !== null) yield { type: 'finish', reason: { kind: entry?.finish ?? 'stop' } }
        })()
      },
    },
    inject: (_names, fn) => fn(),
    root: null,
  }
  return { ctx, calls, writes, fire: (turn = 7) => handlers.forEach((h) => h.name === 'session/event' && h.fn(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })) }
}

async function run(texts, messages) {
  const { ctx, calls, writes, fire } = makeCtx(texts, messages)
  mod.apply(ctx, {})
  fire()
  await new Promise((r) => setTimeout(r, 60))
  return { calls, writes }
}

{
  const goal = '妈妈晚上睡得浅，两间房哪间安静？'
  const offer = '要不要我先给你比较一下早餐？'
  const { calls } = await run(['哪间房离电梯远一点？'], [
    { role: 'user', content: goal }, { role: 'assistant', content: '酒店介绍'.repeat(1400) + offer },
  ])
  const prompt = calls.prompts[0] ?? ''
  check('K1a', prompt.includes(goal), '长回答仍保留用户原话')
  check('K1b', prompt.split(offer).length === 2, '助手的提议只出现一次')
  check('K1c', prompt.length < 4200, '请求保持在原正文预算内')
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

{
  const { writes } = await run(['还差英文里的软链目标检查', '还差英文里的软链目标检查'])
  check('K20', writes.length === 0, '只会复述助手则留空')
}

// K23：把用户刚说过的话原样端回来 → 重问，改用新的下一步
{
  const said = '把 README 的中英两版对齐一下，顺手把安装三步补齐，别只改中文那份。'
  const { writes } = await run([said, '跑 pnpm pack 核对 8 个文件'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K23', hint.includes('pnpm pack'), `写入=${hint.slice(0, 60)}`)
}

{
  const said = '把 README 的中英两版对齐一下，顺手把安装三步补齐，别只改中文那份。'
  const { writes } = await run([said, said])
  check('K24', writes.length === 0, '只会复述用户则留空')
}

{
  const { writes } = await run(['我可以帮你重启，重启后核对载荷', '重启后查一遍 trace.log 里有没有 publish 失败'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K21', hint.includes('重启后查一遍 trace.log'), `写入=${hint.slice(0, 60)}`)
}

{
  const { writes } = await run(['要我帮你重启吗？', '你可以先跑一遍看看'])
  check('K22', writes.length === 0, '助手的口吻不进入草稿')
}

// 助手首次给出的错误码可以是解决用户问题所需的线索。
{
  const question = 'E_EXPORT_TIMEOUT 发生在哪一步？'
  const {calls, writes} = await run([question], [
    {role:'user',content:'导出一直失败，帮我找出具体原因，别再让我从头重试。'},
    {role:'assistant',content:'日志显示 E_EXPORT_TIMEOUT，导出任务在服务器端超时。'},
  ])
  check('K25', calls.n === 1 && JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === question, '新错误码可直接用于追问')
}

// K26：同一个标识符用户自己也说过 → 放行，不重问
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'tests/quality.test.mjs 里那条 K24 有问吗' }] },
    { role: 'assistant', content: [{ type: 'text', text: '已跑完 tests/quality.test.mjs，publish ok 之后 rev 回到 1。' }] },
  ]
  const { calls, writes } = await run(['把 tests/quality.test.mjs 的 K24 再跑一遍'], messages)
  const hint = writes.at(-1)?.hint ?? ''
  check('K26a', calls.n === 1, `调用次数=${calls.n}`)
  check('K26b', hint.includes('K24'), `写入=${hint.slice(0, 60)}`)
}

// K27：建议在讲插件自己（用户没聊插件）→ 重问
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '把周报第三段补上上周的数据，顺便把第一段里那句结论改得更具体一点，别只写「效果不错」。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '已经补好第三段的两组同比数据，第一段的结论还留着原来的写法。' }] },
  ]
  const { calls, writes } = await run(['把灰字改成两行显示', '把周报第三段的数据补上'], messages)
  const hint = writes.at(-1)?.hint ?? ''
  check('K27a', calls.n === 2, `调用次数=${calls.n}`)
  check('K27b', hint.includes('周报'), `写入=${hint.slice(0, 60)}`)
}

// K28：一次给三条，只有中间那条可用 → 选它，且只调用一次
{
  const { calls, writes } = await run(['好的\n把 `lib/index.js` 的闸门顺序调一下\n继续'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K28', calls.n === 1 && hint.includes('闸门顺序'), `calls=${calls.n} hint=${hint.slice(0, 40)}`)
}

// K29：三条都在谈插件自己（自指）→ 这类不再降级采纳，整轮不出
{
  const { calls, writes } = await run([
    '把灰字调成两行看看效果',
    '把灰字调成两行看看效果',
    '把灰字调成两行看看效果',
  ])
  check('K29', calls.n === 3 && writes.length === 0, `calls=${calls.n} writes=${writes.length}`)
}

// K30：编号、项目符号、超长解释行都要被剥掉，只留可发送的句子
{
  const { calls, writes } = await run(['1. 把 `README.en.md` 里的软链段补上\n- 2）继续\n说明：这一条是解释，不该被当成候选'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K30', calls.n === 1 && hint.includes('软链段'), `calls=${calls.n} hint=${hint.slice(0, 40)}`)
}

// K31：首轮只剩「带毛病但分高」的候选，重问给出「干净但分低」的 → 采用干净的
{
  const { calls, writes } = await run(['把插件的日志调一下', '英文版现在也能按这三步装好吗？'])
  const hint = writes.at(-1)?.hint ?? ''
  check('K31', calls.n === 2 && hint.includes('三步装好吗'), `calls=${calls.n} hint=${hint.slice(0, 60)}`)
}

// K32：输出被截断（末行没有换行结尾）→ 末尾半句丢掉，只用完整行
{
  const { writes } = await run([{ text: '跑一遍全量测试确认零失败\n把日志最后 20 行贴出来\n半句', fail: true }])
  const hint = writes.at(-1)?.hint ?? ''
  check('K32', hint !== '' && !hint.includes('半句'), `hint=${hint.slice(0, 60)}`)
}

// K33：输出被截断且只有一段（没有换行结尾）→ 整段丢弃，不出建议
{
  const { calls, writes } = await run([{ text: '跑一遍全量测试确认零失败', fail: true }])
  check('K33', calls.n === 1 && writes.length === 0, `calls=${calls.n} writes=${writes.length}`)
}

// 即便含有必要术语，逐字照搬助手的答案仍是复述。
{
  const answer = '导出脚本运行后出现 E_EXPORT_TIMEOUT 错误。'
  const {calls, writes} = await run([answer], [
    {role:'user',content:'导出报告一直失败，能查出具体原因吗？'}, {role:'assistant',content:answer},
  ])
  check('K34', calls.n === 3 && writes.length === 0, '仅复述则留空')
}

// K36：95 字且第 30 字是句号 → 先按句号切走第一句（30 字），截断不该把句号连同后半句一起吞掉
{
  const tidy = globalThis.__saynextTest?.tidy
  const first = '甲'.repeat(29) + '。'
  const long = first + '乙'.repeat(65) // 30 + 65 = 95 字
  const cut = typeof tidy === 'function' ? tidy(long) : ''
  check('K36', long.length === 95 && cut.length === 30 && cut === first, `in=${long.length} out=${cut.length} 尾部=${cut.slice(-1)}`)
}

// K37：首句本身超过 90 字（后面还跟一句）→ 仍要被截到 90，切句不能绕过上限
{
  const tidy = globalThis.__saynextTest?.tidy
  const long = '甲'.repeat(95) + '。' + '乙'.repeat(10) // 首句 96 字，总 106
  const cut = typeof tidy === 'function' ? tidy(long) : ''
  check('K37', long.length === 106 && cut.length === 90, `in=${long.length} out=${cut.length}`)
}

// K35：最终句子上限——95 字输入应被切成正好 90 字
{
  const tidy = globalThis.__saynextTest?.tidy
  const long = '跑一遍测试'.repeat(19) // 5 × 19 = 95 字，无标点，不会触发句级切分
  const cut = typeof tidy === 'function' ? tidy(long) : ''
  check('K35', typeof tidy === 'function' && long.length === 95 && cut.length === 90, `in=${long.length} out=${cut.length}`)
}

const partial = '跑一遍文档链接检查并把'
{
  const brief = '现在我想写一篇长帖子介绍我dsh-saynext这个插件'
  const detour = '长帖先放一放，先把我账号该改的几处列出来。'
  const edit = '把长帖开头压短一点，直接说这个插件能帮读者做什么。'
  const history = [
    { role: 'user', source: {kind: 'user'}, content: '看一下我现在的账号，哪些地方需要改进？' },
    { role: 'assistant', content: '账号简介和头像都可以改。' },
    { role: 'user', source: {kind: 'user'}, content: brief },
    { role: 'user', source: {kind: 'tool'}, content: [{type: 'text', text: '工具留下的账号清单'}] },
    { role: 'user', source: {kind: 'runtime-context'}, content: '后台账号检查' },
    { role: 'assistant', content: [{type: 'reasoning', text: '也许应该先改账号'}, {type: 'text', text: '长帖已经写好，开头还可以压短，也可以调第三段的语气。'}] },
  ]
  const { calls, writes } = await run([detour + '\n' + edit], history)
  const prompt = calls.prompts[0]
  check('K47a', prompt.includes(brief) && !prompt.includes('哪些地方需要改进') && !prompt.includes('后台账号检查')
    && !prompt.includes('也许应该先改账号') && !prompt.includes('工具留下'), '明确的新任务只使用本轮可见对话')
  check('K47b', calls.n === 1 && JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === edit, '同批丢弃截图原句，保留长帖修改建议')
  const rejected = await run([detour], history)
  check('K47c', rejected.calls.n === 3 && rejected.writes.length === 0, '三次都擅自搁置长帖时留空')
  const changed = await run(['先看看账号简介该怎么改。'], [...history,
    {role: 'user', content: '我改主意了，长帖先放一放，先改账号简介。'},
    {role: 'assistant', content: '可以，先看看你现在的介绍。'}])
  check('K47d', changed.calls.n === 1 && changed.writes.length === 1, '用户可以亲自把任务切回账号')
  const followup = globalThis.__saynextTest.frameTranscript({deriveMessages: () => [...history, {role:'user', content:'继续'}]})
  check('K47e', followup.prompt.includes(brief), '简短的继续保留上文')
  const sendLater = '先别发布长帖，把开头两句改得更口语一点。'
  const drafted = await run([sendLater], history)
  check('K47f', JSON.parse(drafted.writes[0]?.hint ?? '{}').items?.[0].text === sendLater, '暂缓发布仍可继续修改草稿')
  const continued = await run([detour, edit], [...history, {role:'user', content:'继续'}, {role:'assistant', content:'刚改好了。'}])
  check('K47g', continued.calls.n === 2 && JSON.parse(continued.writes[0]?.hint ?? '{}').items?.[0].text === edit, '简短跟进时继续保护最近明确要求的稿件')
  const report = await run(['报告先放一边，先看还有哪些会议。', '把结论放到报告第一页。'], [
    {role:'user', content:'我想写一份报告，供下周例会讨论，重点是今年的预算和实际开销之间有哪些差别。'},
    {role:'assistant', content:'初稿已完成，预算部分在最后。'}])
  check('K47h', report.calls.n === 2 && JSON.parse(report.writes[0]?.hint ?? '{}').items?.[0].text === '把结论放到报告第一页。', '同一规则覆盖其他交付物')
}
{
  const messages = [
    { role: 'user', content: '两间房哪间安静？我妈晚上容易醒，尤其怕门口有人来来往往。' },
    { role: 'assistant', content: '两家早餐种类都很多，我可以给你做一份对比表格。' },
  ]
  const question = '你知道哪间房离电梯远一点吗？'
  const { calls, writes } = await run([question + '\n列一张早餐表格'], messages)
  check('K42', calls.n === 1 && JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === question, '用户关心安静，优先房间问题')
}
{
  const { calls, writes } = await run(['<skip>'])
  check('K43', calls.n === 1 && writes.length === 0, '没有必要追问时直接留空')
}
{
  const question = '我每个月到底能少花多少钱？'
  const { writes } = await run([question + '\n跑一遍脚本核对12项参数'])
  check('K44', JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === question, '自然问句不会因缺少命令或数字落选')
}
{
  const reply = '用两次扣款记录确认实际付了几笔'
  const { writes } = await run([reply], [
    { role: 'user', content: '我只担心连续点两次付款，钱会不会扣两次。' },
    { role: 'assistant', content: '现在只试过点一次。可以去测试环境连点两次，看最后有几笔扣款。' },
  ])
  check('K45', JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === reply, '切合用户目标的后续操作可以采用')
}
{
  const cached = { sessionId: 'second-session', turn: 12, text: '检查之前保存的报告', rev: 1, at: 123 }
  const { ctx, calls, writes, fire } = makeCtx(['跑一遍文档链接检查'])
  mod.apply(ctx, { hint: JSON.stringify({ rev: 1, items: [cached] }) })
  check('K41a', calls.n === 0 && writes.length === 0, '恢复已有建议时没有模型请求和写入')
  fire(8)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const restored = JSON.parse(writes.at(-1)?.hint ?? '{}')
  check('K41b', restored.rev === 2 && restored.items?.length === 2 && restored.items[0].sessionId === cached.sessionId
    && restored.items[0].text === cached.text && restored.items[0].turn === cached.turn
    && restored.items[1].turn === 8 && calls.n === 1, '首个新回合写入时保留另一会话的缓存')
}

for (const finish of ['max-tokens', 'aborted', null]) {
  const { calls, writes } = await run([{ text: partial, finish }])
  check(`K38-${finish}`, calls.n === 1 && writes.length === 0, '只有半句时放弃本轮')
}

{
  const messages = [
    {role:'user',content:'我明年还要续费，帮我比较这两个方案的总成本。'},
    {role:'assistant',content:'目前只核算了基础报价。乙多一笔迁移费，还没有算进去。要我给表格加个标题吗？'},
  ]
  const preferred = '乙的迁移费算进去后还便宜吗？'
  const {calls,writes} = await run([preferred+'\n表格标题写成「两年总成本」。'], messages)
  check('迁移费', calls.n === 1 && JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === preferred, '保留按上下文生成的首选')
  const skip = await run(['<skip>\n表格标题写成「两年总成本」。'], messages)
  check('首选留空',skip.calls.n===1 && !skip.writes.length)
}
{
  const chosen = '请安装导出组件，开始之前先和我确认。'
  const question = '导出组件已经就绪，版本与依赖也已核对。现在安装吗？'
  const cases = [
    ['短确认',chosen,question,'装吧',true],
    ['句号',chosen,question,'装吧。',true],
    ['不需补字',chosen,question,'好',true],
    ['带时间词',chosen,question,'现在安装。',true],
    ['未选定的确认','只核对组件的兼容性，先别安装。',question,'确认安装。',false],
    ['禁止操作','只核对组件的兼容性，先别安装。',question,'装吧。',false],
    ['新操作','请导出上月的全部报表。',question,'装吧',false],
    ['仅作说明','安装会收费，先看报价。',question,'装吧',false],
    ['疑问','这个导出组件现在能安装了吗？',question,'装吧。',false],
    ['任务结束',chosen,'导出组件已经成功安装，版本和依赖均已核对。','好',false],
    ['多个选项',chosen,'需要安装正式版还是测试版？','装吧',false],
    ['换对象','请删除数据库备份，执行前请确认。','已经准备好了。现在删除数据库吗？','好。',false],
    ['拒绝扩大','请安装导出组件。','已完成兼容性检查。现在安装并且发布吗？','好',false],
    ['英文','Please install the export component. Confirm before starting.','The export component is ready. Shall I install it?','Yes',false],
    ['英文明确','Please install the export component. Confirm before starting.','The export component is ready. Shall I install the export component?','Yes',true],
    ['简短提问',chosen,question,'多久？',true],
  ]
  for (const [name,user,assistant,candidate,allowed] of cases) {
    const {writes,calls}=await run([candidate,'<skip>'],[{role:'user',content:user},{role:'assistant',content:'当前正在检查导出组件的版本和依赖，汇总完成后需要确认处理方式。'+assistant}])
    check('短句-'+name, allowed ? calls.n === 1 && JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === candidate : calls.n >= 1 && writes.length === 0)
  }
}

{
  const cases = [
    ['询问原因', '为什么硬盘占用这么高？', '缓存占用较大，要清理吗？', '清掉吧，其他文件都留着。', null],
    ['授权依据', '请删除测试副本，保留原件。', '已定位测试副本，准备完成。', '["删除测试副本。","删除测试副本"]','删除测试副本。'],
    ['编号内的依据', '请删除测试副本，保留原件。', '已定位测试副本，准备完成。', '1. ["删除测试副本。","删除测试副本"]','删除测试副本。'],
    ['否定被截掉', '不要删除测试副本。', '测试副本还在目录里。', '["删除测试副本。","删除测试副本"]',null],
    ['先执行再提问', '请检查备份目录。', '测试副本还在目录里。', '删除测试副本，再告诉我剩余空间是多少？',null],
    ['副词不代表授权', '请检查备份目录。', '测试副本还在目录里。', '下一步继续清空这份目录。',null],
    ['变更格式需要选择依据','帮我查一下表格打不开的原因。','检查结果是文件头格式不符。','工作表格式改为 CSV。',null],
    ['只引动词', '请删除测试副本。', '两个数据库都已就绪。', '["删除生产库。","删除"]',null],
    ['引文来自助手', '请查明存储占用。', '可以删除测试副本。', '["删除测试副本。","删除测试副本"]',null],
    ['虚构资料', '研究两份报告的评价标准。', '可以先看现有材料，或者收集新材料。', '我手上没有原始报告，请收集材料。',null],
    ['共同名词不证明缺失', '原始报告已经传给你了。', '已经看到了材料。', '["我没有原始报告，请收集材料。","原始报告"]',null],
    ['批准分支', '我选轻量版，保留配置。', '下一步可以用轻量版或者完整版。', '["用轻量版继续。","轻量版"]','用轻量版继续。'],
    ['助手提出新分支', '请调研这个产品的设计。', '可以做轻量版或者完整版。', '先做轻量版。',null],
    ['错误引文格式', '看看交付进度。', '现有材料已经整理完成。', '["我已经确认过"',null],
  ]
  for(const [label,user,assistant,raw,expected] of cases) {
    const {calls,writes}=await run([raw,'<skip>'],[{role:'user',content:user},{role:'assistant',content:'目前已经完成了初步核对，下面是本轮可供确认的具体信息。'+assistant}])
    const actual=writes.length ? JSON.parse(writes[0].hint).items[0].text : null
    check('决定依据-'+label,calls.n>0 && actual===expected)
  }
}

const whole = '跑一遍文档链接检查'
{
  const plain = '哪一步最耽误时间？'
  const { writes } = await run(['拉齐打法颗粒度，闭环剩余抓手\n' + plain])
  check('K46', JSON.parse(writes[0]?.hint ?? '{}').items?.[0].text === plain, '给读得懂的追问留位置')
}
for (const suffix of ['', partial]) {
  const { calls, writes } = await run([{ text: whole + '\n' + suffix, finish: 'max-tokens' }])
  const chosen = JSON.parse(writes.at(-1)?.hint ?? '{}').items?.[0]?.text
  check(`K39-${suffix.length}`, calls.n === 1 && chosen === whole, '保留换行前的候选')
}

{
  const { calls, writes } = await run([' '.repeat(639) + partial])
  check('K40', calls.n === 1 && writes.length === 0, '本地达到接收上限也丢弃末尾半句')
}

console.log(`\n${bad === 0 ? 'ALL PASS' : 'FAILED'} pass=${ok} fail=${bad}`)
process.exit(bad === 0 ? 0 : 1)

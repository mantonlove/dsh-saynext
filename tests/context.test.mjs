import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frameTranscript} from '../lib/context.js'

const user = content => ({role: 'user', content})
const assistant = content => ({role: 'assistant', content})
const pair = (u,a) => [user(u),assistant(a)]
const frame = (...messages) => frameTranscript({deriveMessages: () => messages})
const event = (type, data) => ({type, data})
const round = (turn, request, reply) => [
  event('turn/start', {turn}),
  event('user/message', {source:{kind:'user'}, content:request}),
  event('assistant/message', {turn, message:{content:reply}}),
  event('turn/end', {turn, reason:{kind:'completed'}}),
]
const correction = (id, args, kind = 'success') => [
  event('command/run', {name:'saynext-goal', commandId:id, args}),
  event('command/done', {commandId:id, kind}),
]

test('三个成对回合按距离分配篇幅，长期目标和带出处的旧约束仍在', () => {
  const x = frame(...pair('我要给新员工上一堂课。只用公开资料。','要不要改成给经理上课？'),
    ...pair('先梳理资料','已整理好目录。'), ...pair('甲'.repeat(1100),'A'.repeat(1600)),
    ...pair('乙'.repeat(1100),'B'.repeat(1600)), ...pair('丙'.repeat(1100),'C'.repeat(1600)))
  assert.match(x.summary,/总体目标：第1轮·用户原话：我要给新员工/)
  assert.match(x.summary,/已确认要求：第1轮·用户：只用公开资料/)
  assert.doesNotMatch(x.summary,/给经理/)
  assert.equal(x.messages.length,6)
  const lengths = [0,2,4].map(i => x.messages[i].content.length + x.messages[i+1].content.length)
  assert.deepEqual(lengths,[550,900,1440])
})

test('指代可回到三轮以前，明确换题后不沿用旧选项', () => {
  const history = [...pair('我要定活动场地','1. 小剧场\n2. 阶梯教室'),...pair('预算多少','二百元'),
    ...pair('谁来','学生'),...pair('几个人','三十人')]
  assert.match(frame(...history,...pair('我选第二个','可以')).prompt,/第1轮助手：1. 小剧场\n2. 阶梯教室/)
  assert.doesNotMatch(frame(...history,...pair('换个话题，帮我看看报告','可以')).prompt,/阶梯教室/)
})

test('从同一会话日志还原已成功的人工更正；清除、失败、其他窗口和预测截止点分别处理', () => {
  const log = [...round(7,'订火车票','哪天出发？'), ...correction('1','只比较直达车'),
    ...correction('2','无效目标','error'), ...round(8,'继续','已列出三个车次')]
  assert.match(frameTranscript({log}).summary,/第7轮·用户校正：只比较直达车/)
  assert.doesNotMatch(frameTranscript({log},7).prompt,/直达车|车次/)
  assert.doesNotMatch(frameTranscript({log:[...log,...correction('3','clear')]}).summary,/用户校正/)
  assert.doesNotMatch(frameTranscript({log:round(7,'订机票','去哪里？')}).summary,/直达车/)
  assert.doesNotMatch(frameTranscript({log:[...log,...round(9,'换个话题，看下住宿','稍等')]}).summary,/车票|直达车/)
})

test('摘要仅提取双方可见正文，相同回合的多条回复不占用多个回合', () => {
  const log = [...round(12,'核对账单','已核对三页。还缺四月账单。')]
  log.splice(2,0,event('user/message',{source:{kind:'runtime-context'}, content:'内部串'}))
  log.splice(3,0,event('assistant/message',{turn:12,message:{content:[{type:'reasoning',text:'内部串'},{type:'text',text:'看完第一页。'}]}}))
  const x = frameTranscript({log})
  assert.equal(x.messages.length,2)
  assert.doesNotMatch(x.prompt,/内部串/)
  assert.match(x.summary,/最近报告的进展：第12轮·助手：已核对三页/)
  assert.match(x.summary,/未决或待用户选择：第12轮·助手：还缺四月账单/)
})

test('将确认指回用户回应的原话，不把询问是否采用记成决定', () => {
  const x=frame(...pair('需要采用线上方案吗？','我建议选周五下午。'),...pair('可以，就这么做。','我来安排。'))
  assert.match(x.summary,/已确认要求：第2轮·用户：可以，就这么做。（所回应的第1轮助手原话：我建议选周五下午。/)
  assert.doesNotMatch(x.summary,/已确认要求：第1轮/)
})

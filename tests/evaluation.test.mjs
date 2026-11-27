import {test} from 'node:test'
import assert from 'node:assert/strict'
import {compare, score} from '../scripts/evaluate.mjs'
import {observeFrame} from '../scripts/observe.mjs'

const run = (mode, cases) => ({mode,version:'test',cases:cases.map((c,i) => ({id:String(i),context:'same-' + i,opportunity:true,...c}))})
const shown = {status:'shown',text:'请发我原始表格。'}
test('受控界面评测分别统计显示、命中、严重误判、原样和改写发送', () => {
  const a = run('observed',[shown,shown,shown,shown,{status:'late'},{status:'skip'},{status:'ineligible',opportunity:false}])
  const report = score(a,[
    {id:'0',intent:'hit',errors:[],filled:true,send:shown.text},
    {id:'1',intent:'partial',errors:['wrong-actor','authorization'],filled:true,send:'我想看表格里的原始记录。'},
    {id:'2',intent:'miss',errors:[],filled:true,send:false},
  ])
  assert.deepEqual(report.displayCoverage,{n:4,d:6,percent:66.7})
  assert.deepEqual(report.intent,{n:1,d:3,percent:33.3})
  assert.equal(report.partial,1)
  assert.deepEqual(report.severe,{n:1,d:3,percent:33.3})
  assert.deepEqual(report.directUse,{n:1,d:2,percent:50})
  assert.deepEqual([report.editedAfterFill,report.knownNoSend,report.unknownSend],[1,1,1])
})

test('留空、未知和无分母；不把回放候选当成显示、改写或原样采纳', () => {
  const r = run('replay',[{status:'candidate',text:'请说明。'},{status:'skip'}])
  const result = score(r)
  assert.equal(result.replayOutputRate.percent,50)
  assert.equal(result.displayCoverage,null)
  assert.equal(result.directUse,null)
  assert.equal(result.intent.percent,null)
  assert.throws(() => score(r,[{id:'0',send:'请说明。'}]))
  assert.throws(() => score(r,[{id:'1',intent:'miss'}]))
  const missing = score(run('observed',[shown,{status:'unknown'}]))
  assert.equal(missing.displayCoverage.percent,null)
  assert.deepEqual(missing.coverageBounds.map(x=>x.percent),[50,100])
})

test('对比要求相同的留出上下文，五个百分点覆盖差异为上限', () => {
  const cases = Array.from({length:20},() => ({status:'candidate',text:'再举一个例子。'}))
  const a=run('replay',cases), b=run('replay',cases)
  b.cases[0]={...b.cases[0],status:'skip',text:null}
  assert.equal(compare(a,b).comparableCoverage,true)
  b.cases[1]={...b.cases[1],status:'skip',text:null}
  assert.equal(compare(a,b).comparableCoverage,false)
  b.cases[1].context='不同上下文'
  assert.throws(() => compare(a,b))
  assert.throws(() => score({...a,cases:[a.cases[0],a.cases[0]]}))
})

test('只统计可见卡片里本会话、本轮实际出现的灰字，多次渲染算一次', () => {
  const dataset={saynextSession:'A',saynextTurn:'2'}
  const ghosts=[{dataset:{...dataset,saynextTurn:'1'},textContent:'旧建议'}]
  const card={querySelectorAll:()=>ghosts}
  const doc={visibilityState:'visible',querySelectorAll:()=>[{dataset,closest:()=>card}]}
  const seen=new Map()
  observeFrame(doc,seen,()=>true)
  assert.equal([...seen.values()][0].status,'unknown')
  ghosts.push({dataset,textContent:'新建议'})
  doc.visibilityState='hidden'
  observeFrame(doc,seen,()=>true)
  assert.equal([...seen.values()][0].status,'unknown')
  doc.visibilityState='visible'
  observeFrame(doc,seen,()=>true)
  observeFrame(doc,seen,()=>true)
  assert.equal(seen.size,1)
  assert.equal([...seen.values()][0].text,'新建议')
})

test('从 DSH 确认下一条本人发送的消息；仅填草稿、工具文本、带附件另计', async () => {
  const {followup} = await import('../scripts/observe.mjs')
  const event = (type,data)=>({type,data})
  const log = [event('turn/end',{turn:9}),event('user/message',{source:{kind:'tool'},content:'收到'})]
  assert.equal(followup(log,9),null)
  assert.equal(followup(log,9,true),false)
  log.push(event('user/message',{source:{kind:'user'},content:[{type:'text',text:shown.text}]}))
  assert.equal(followup(log,9),shown.text)
  log.at(-1).data.content.push({type:'file'})
  const report=score(run('observed',[shown]),[{id:'0',filled:true,send:followup(log,9)}])
  assert.deepEqual(report.directUse,{n:0,d:1,percent:0})
})

test('原生展示和回放按同一前缀配对，只有双方可评的项目进入对应分母', async () => {
  const {pairedContent} = await import('../scripts/evaluate.mjs')
  const first = run('observed',[shown,{...shown,id:'1'},{...shown,id:'2',opportunity:null,status:'unknown',text:null}])
  const second = run('replay',first.cases.map(r => ({...r,status:'candidate',opportunity:true,text:'另一句'})))
  const reviewsA = [{id:'0',intent:'hit',errors:null},{id:'1',intent:null,errors:['wrong-actor']}]
  const reviewsB = [{id:'0',intent:'partial',errors:[]},{id:'1',intent:'miss',errors:[]}]
  const comparison = pairedContent(first,reviewsA,second,reviewsB)
  assert.equal(comparison.jointlySuggested,2)
  assert.equal(comparison.statuses['unknown/candidate'],1)
  assert.deepEqual(comparison.intent.map(r=>[r.n,r.d]),[[1,1],[0,1]])
  assert.deepEqual(comparison.partial,[0,1])
  assert.deepEqual(comparison.severe.map(r=>[r.n,r.d]),[[1,1],[0,1]])
  const changed = {...second,cases:second.cases.map(r=>({...r,context:'different'}))}
  assert.throws(()=>pairedContent(first,reviewsA,changed,reviewsB),/前缀/)
})

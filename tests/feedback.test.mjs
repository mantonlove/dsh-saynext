import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {receive} from '../supabase/functions/_shared/receiver.mjs'
import {download} from '../scripts/download.mjs'

const sample={id:randomUUID(),revision:1,policy:'paired-text-v1',version:'0.1.9',day:'2026-11-27',
  suggestion:'续费前再提醒我。',actual:'先看看费用。',previousUser:'查续费费用。',previousAssistant:'续费价格已列出。',
  filled:false,outcome:'different',autoIntent:'miss',autoSevere:null,manualIntent:null,manualSevere:null}
const request = body=>new Request('https://example.invalid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})

test('收件端只接收披露的字段；写入失败保留重试机会',async()=>{
  let stored
  assert.equal((await receive(request(sample),s=>{stored=s})).status,204)
  assert.deepEqual(stored,sample)
  assert.equal((await receive(request({...sample,sessionId:'private'}),assert.fail)).status,422)
  assert.equal((await receive(request({...sample,suggestion:null}),assert.fail)).status,422)
  assert.equal((await receive(request({...sample,id:'other'}),assert.fail)).status,422)
  assert.equal((await receive(request(sample),()=>{throw Error()})).status,503)
  assert.equal((await receive(new Request('https://example.invalid'),assert.fail)).status,405)
  assert.equal((await receive(new Request('https://example.invalid',{method:'OPTIONS'}),assert.fail)).status,204)
})
test('可在下载前拒绝或同意；得到字节相同的安装包和各自选择',async()=>{
  const bytes=Buffer.from('synthetic archive')
  const manifest={version:'0.1.9',sha256:createHash('sha256').update(bytes).digest('hex'),
    target:{url:'https://example.invalid/receive',owner:'测试接收方'}}
  for(const enabled of [false,true]){
    const directory=await mkdtemp(join(tmpdir(),'saynext-download-test-')), events=[]
    try {
      const name=await download({manifest,directory,choose:()=>{events.push('choice');return enabled},
        get:()=>{events.push('download');return bytes}})
      assert.deepEqual(events,['choice','download'])
      assert.deepEqual(await readFile(join(directory,name)),bytes)
      const receipt=JSON.parse(await readFile(join(directory,'saynext-choice-0.1.9.json'),'utf8'))
      assert.equal(receipt.enabled,enabled)
      assert.deepEqual(receipt.target,manifest.target)
    } finally { await rm(directory,{recursive:true,force:true}) }
  }
})

import {githubWriter} from '../feedback/github.mjs'
test('GitHub 写入只允许指定的私有仓库，并按版本去重',async()=>{
  let privateRepo=false, puts=0, stored
  const repository='tester/inbox'
  const response=(data,status=200)=>Response.json(data,{status})
  const write=githubWriter(repository,'test-only',async(url,options)=>{
    if(url.endsWith(repository))return response({full_name:repository,private:privateRepo,visibility:privateRepo?'private':'public'})
    if(options.method==='PUT'){
      const row=JSON.parse(options.body)
      stored=JSON.parse(Buffer.from(row.content,'base64').toString('utf8'));puts++
      return response({},201)
    }
    return stored?response({content:Buffer.from(JSON.stringify(stored)).toString('base64'),encoding:'base64',sha:'prior'}):response({},404)
  })
  await assert.rejects(write(sample),/私有/)
  assert.equal(puts,0)
  privateRepo=true
  await write(sample); await write({...sample,revision:2,manualIntent:'miss'});await write(sample)
  assert.equal(puts,2);assert.equal(stored.manualIntent,'miss')
})

test('同意不会补传旧回合；撤回后离线积压不再送出，纠正保留原文',async()=>{
  const {IDBFactory}=await import('fake-indexeddb')
  const {readFile}=await import('node:fs/promises')
  const {runInNewContext}=await import('node:vm')
  const events=[], target={url:'https://example.invalid/receive',owner:'合成样本接收方'}
  const source=(await readFile(new URL('../lib/client.js',import.meta.url),'utf8')).replace(
    /\/\* saynext-feedback-target \*\/ [^\n]+? \/\* end-saynext-feedback-target \*\//u,JSON.stringify(target))
  const win=new EventTarget()
  win.indexedDB=new IDBFactory()
  win.__SAYNEXT_TEST__=true
  let api, offline=true
  win.__ModuleLoader__={load:({factory})=>{api=factory(()=>({})).__test}}
  runInNewContext(source,{window:win,crypto,Event,AbortController,setTimeout,clearTimeout,
    fetch:async(url,init)=>{
      assert.equal(url,target.url)
      if(offline)throw Error('offline')
      const value=JSON.parse(init.body);events.push(value)
      return receive(request(value),()=>{})
    }})
  await api.updateRound('s',1,'shown','很久以前的建议',Date.now())
  await api.setSharing(false)
  await api.updateRound('s',2,'shown','拒绝期间',Date.now())
  await api.flushSamples()
  const receipt={format:'saynext-download-v1',policy:'paired-text-v1',target,enabled:true,chosenAt:Date.now()}
  const local=new Map([['saynext.download.choice.v1',JSON.stringify(receipt)]])
  win.localStorage={getItem:k=>local.get(k),removeItem:k=>local.delete(k)}
  // 下载选择发生在先前拒绝之后。
  await new Promise(resolve=>setTimeout(resolve,5))
  receipt.chosenAt=Date.now();local.set('saynext.download.choice.v1',JSON.stringify(receipt))
  await api.restoreDownloadChoice()
  assert.equal((await api.preference()).enabled,true);assert.equal(local.size,0)
  await api.updateRound('s',3,'shown','回看历史',Date.now()-1000)
  assert.equal(await api.nextSample(),undefined)
  await api.updateRound('s',4,'shown','查看结果。',Date.now())
  await api.updateRound('s',4,'outcome',{outcome:'different',auto:{intent:'miss',severe:false},follow:{text:'先暂停。'}})
  await api.flushSamples()
  assert.equal(events.length,0);assert.equal((await api.nextSample()).sample.actual,'先暂停。')
  offline=false;await api.flushSamples()
  assert.equal(events.length,1);assert.equal(events[0].actual,'先暂停。')
  await api.updateRound('s',4,'intent','partial');await api.flushSamples()
  assert.equal(events.length,2);assert.equal(events[1].id,events[0].id)
  assert.equal(events[1].actual,'先暂停。');assert.equal(events[1].manualIntent,'partial')
  await api.updateRound('s',5,'shown','离线积压',Date.now())
  await api.setSharing(false);await api.flushSamples()
  await api.setSharing(true);await api.updateRound('s',5,'severe',true);await api.flushSamples()
  assert.equal(events.length,2)
})

test('分享由下载入口确认，聊天输入区始终只提供建议',async()=>{
  const {runInNewContext}=await import('node:vm')
  const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  for (const [receiver,storage] of [[true,true],[false,true],[true,false]]) {
    const target=receiver ? {url:'https://example.invalid/receive',owner:'测试接收方'} : null
    const names=[]
    const win={__ModuleLoader__:{load:({factory})=>factory(()=>({})).apply({
      get(){},slots:{inject:(_name,install)=>install(),register:entry=>names.push(entry.name)},
    })}}
    if (storage) win.indexedDB={}
    runInNewContext(source.replace(/\/\* saynext-feedback-target \*\/ [^\n]+? \/\* end-saynext-feedback-target \*\//u,
      JSON.stringify(target)),{window:win})
    assert.equal(names.includes('conversation.input.dock'),false)
    assert.ok(names.includes('conversation.input.overlay'))
    assert.ok(names.includes('conversation.view'))
  }
})

test('桌面自动采用下载选择，重新启动不会覆盖较新的撤回，网页不会继承桌面授权',async()=>{
  const {IDBFactory}=await import('fake-indexeddb')
  const {runInNewContext}=await import('node:vm')
  const target={url:'https://example.invalid/feedback',owner:'测试作者'}
  const client=(await readFile(new URL('../lib/client.js',import.meta.url),'utf8')).replace(
    /\/\* saynext-feedback-target \*\/ [^\n]+? \/\* end-saynext-feedback-target \*\//u,JSON.stringify(target))
  const receipt={format:'saynext-download-v1',policy:'paired-text-v1',target,enabled:true,chosenAt:Date.now()-1000}
  function boot(db,scheme,choice) {
    const win=new EventTarget()
    Object.assign(win,{indexedDB:db,location:{protocol:scheme,hostname:'app'},__saynextDesktopChoice:choice,__SAYNEXT_TEST__:true})
    let api
    win.__ModuleLoader__={load:({factory})=>{api=factory(()=>({})).__test}}
    runInNewContext(client,{window:win,crypto,Event,AbortController,setTimeout,clearTimeout})
    return api
  }
  const desktop=new IDBFactory()
  const first=boot(desktop,'dsh-app:',receipt)
  await first.restoreDownloadChoice()
  assert.equal((await first.preference()).enabled,true)
  await first.updateRound('test',1,'shown','测试建议',Date.now())
  assert.ok(await first.nextSample())
  await first.setSharing(false)
  const restarted=boot(desktop,'dsh-app:',receipt)
  await restarted.restoreDownloadChoice()
  assert.equal((await restarted.preference()).enabled,false)
  assert.equal(await restarted.nextSample(),undefined)
  const web=boot(new IDBFactory(),'https:',receipt)
  await web.restoreDownloadChoice()
  assert.equal(await web.preference(),null)
  const local=boot(new IDBFactory(),'dsh-app:',{...receipt,enabled:false})
  await local.restoreDownloadChoice()
  await local.updateRound('test',1,'shown','本机建议',Date.now())
  assert.equal((await local.preference()).enabled,false)
  assert.equal(await local.nextSample(),undefined)
})

test('新版下载器返回与选择对应的单条安装命令',async()=>{
  const bytes=Buffer.from('neutral installer')
  const sha256=createHash('sha256').update(bytes).digest('hex')
  const manifest={version:'0.1.9',sha256,target:{url:'https://example.invalid',owner:'测试作者'},
    desktop:{name:'SayNext-0.1.9.mjs',sha256}}
  for(const enabled of [true,false]){
    const directory=await mkdtemp(join(tmpdir(),'saynext-installer-'))
    let command
    try{
      const file=await download({directory,manifest,choose:()=>enabled,
        get:name=>{assert.equal(name,manifest.desktop.name);return bytes},onInstallCommand:value=>{command=value}})
      assert.deepEqual(await readFile(join(directory,file)),bytes)
      const [,path,flag,time]=command.split(' ')
      assert.equal(path,'./'+file)
      assert.equal(flag,enabled?'--share-text':'--local-only')
      assert.ok(Number.isSafeInteger(Number(time)))
    }finally{await rm(directory,{force:true,recursive:true})}
  }
})

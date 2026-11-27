/** GitHub 私有仓库收件端。只向启动时指定的仓库写入，高版本号覆盖同一条样本。 */
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {receive} from '../supabase/functions/_shared/receiver.mjs'

export function githubWriter(repository, token, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw Error('需要专用私有仓库和服务端写入凭据')
  const base='https://api.github.com/repos/'+repository
  const options={Authorization:'Bearer '+token, Accept:'application/vnd.github+json','User-Agent':'dsh-saynext-feedback'}
  const call=(url,init={})=>request(url,{...init,headers:{...options,...init.headers},redirect:'error',signal:AbortSignal.timeout(12000)})
  async function write(sample) {
    const repo=await call(base)
    if (!repo.ok) throw Error('无法核对目的地')
    const meta=await repo.json()
    if (meta.private !== true || meta.visibility !== 'private' || meta.full_name.toLowerCase() !== repository.toLowerCase())
      throw Error('目的地不是指定的私有仓库')
    const file=base+'/contents/samples/'+sample.id.slice(0,2)+'/'+sample.id+'.json'
    for(let i=0;i<3;i++) {
      const current=await call(file)
      let sha
      if(current.ok){
        const row=await current.json()
        // Contents API 对较大的文件仅返回元数据。用同一已授权 API 读取原文。
        let saved
        if (row.encoding === 'base64') saved=JSON.parse(Buffer.from(row.content,'base64').toString('utf8'))
        else {
          const content=await call(file,{headers:{Accept:'application/vnd.github.raw+json'}})
          if(!content.ok) throw Error('无法读取当前版本')
          saved=await content.json()
        }
        if (saved.id!==sample.id || saved.policy!==sample.policy || saved.version!==sample.version || saved.day!==sample.day)
          throw Error('现有记录不匹配')
        if (saved.revision >= sample.revision) return
        sha=row.sha
      } else if(current.status!==404) throw Error('读取仓库失败')
      const reply=await call(file,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        message:'Record SayNext feedback',content:Buffer.from(JSON.stringify(sample)+'\n').toString('base64'),...(sha?{sha}:{})})})
      if (reply.ok) return
      if (![409,422].includes(reply.status)) throw Error('写入仓库失败')
    }
    throw Error('写入冲突，稍后重试')
  }
  // GitHub Contents API 的提交顺序在同一服务进程内串行。
  let tail=Promise.resolve()
  return sample=>{const job=tail.then(()=>write(sample));tail=job.catch(()=>{});return job}
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const write=githubWriter(process.env.SAYNEXT_REPOSITORY,process.env.SAYNEXT_GITHUB_TOKEN)
  let inflight=0
  const server=createServer(async(req,res)=>{
    if(req.url!=='/v1/samples'){res.writeHead(404).end();return}
    if(inflight>=12){res.writeHead(429,{'Retry-After':'30'}).end();return}
    inflight++
    try{
      const body=req.method==='POST'?Readable.toWeb(req):undefined
      const incoming=new Request('http://localhost/v1/samples',{method:req.method,headers:req.headers,...(body?{body,duplex:'half'}:{})})
      const reply=await receive(incoming,write)
      res.writeHead(reply.status,Object.fromEntries(reply.headers)).end()
    }catch{res.writeHead(503).end()}finally{inflight--}
  })
  server.requestTimeout=30000
  server.listen(Number(process.env.PORT ?? 8787),process.env.SAYNEXT_LISTEN ?? '127.0.0.1')
}

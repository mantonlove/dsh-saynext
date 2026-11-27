// 输出中性安装器、npm 安装包、下载页和命令行下载器；任何人转发安装包都不会转移分享选择。
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'

const [output, endpoint, owner] = process.argv.slice(2)
if (!output || (!!endpoint !== !!owner)) throw Error('用法：node scripts/package-feedback.mjs 输出目录 [接收接口地址 接收方名称]')
const root=fileURLToPath(new URL('../',import.meta.url))
const path=resolve(output)
const url=endpoint && new URL(endpoint)
if (url && ((url.protocol !== 'https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))) ||
    url.username || url.password || url.search || url.hash)) throw Error('需要无凭据的 HTTPS 接口；本机测试支持回环地址')
const target=url ? {url:url.href,owner} : null
const meta=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const stage=await mkdtemp(join(tmpdir(),'saynext-package-'))
try {
  await mkdir(path,{recursive:true})
  for (const file of ['package.json',...meta.files]) await cp(join(root,file),join(stage,file),{recursive:true})
  const client=join(stage,'lib/client.js')
  const source=await readFile(client,'utf8')
  const marker=/\/\* saynext-feedback-target \*\/ [^\n]+? \/\* end-saynext-feedback-target \*\//u
  if (source.split(marker).length!==2 || !source.includes("const feedbackVersion = '"+meta.version+"'")) throw Error('插件版本或接收配置不一致')
  await writeFile(client,source.replace(marker,()=>JSON.stringify(target)))
  const result=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',path],{cwd:stage,encoding:'utf8'}))[0]
  const bytes=await readFile(join(path,result.filename))
  const sha256=createHash('sha256').update(bytes).digest('hex')
  const installerName='SayNext-'+meta.version+'.mjs'
  const template=await readFile(join(root,'scripts/desktop-installer.mjs'),'utf8')
  const installer=template.replace('/* DESKTOP_BUNDLE */ null',()=>JSON.stringify({target,sha256,archive:bytes.toString('base64')}))
  await writeFile(join(path,installerName),installer)
  const desktop={name:installerName,sha256:createHash('sha256').update(installer).digest('hex')}
  await writeFile(join(path,'download.json'),JSON.stringify({version:meta.version,target,sha256,desktop},null,2)+'\n')
  await cp(join(root,'scripts/download.mjs'),join(path,'download.mjs'))
  const page=await readFile(join(root,'feedback/download.html'),'utf8')
  const manifest=JSON.stringify({target,version:meta.version,filename:installerName,localInstaller:Buffer.from(installer).toString('base64')}).replaceAll('<','\\u003c')
  await writeFile(join(path,'index.html'),page.replace('/* DOWNLOAD_CONFIG */ null',()=>manifest))
  console.log(join(path,result.filename))
} finally { await rm(stage,{recursive:true,force:true}) }

/** 官方下载器在请求安装包之前收下用户的选择。新分发包把选择带入本次桌面安装命令。 */
import {createHash} from 'node:crypto'
import {createInterface} from 'node:readline/promises'
import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export async function download({manifest, choose, get, directory, onInstallCommand}) {
  const name = 'dsh-saynext-' + manifest.version + '.tgz'
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw Error('无效的安装包清单')
  const choice = await choose(manifest)
  const chosenAt = Date.now()
  if (manifest.desktop) {
    const installer = 'SayNext-'+manifest.version+'.mjs'
    if (manifest.desktop.name !== installer || !/^[0-9a-f]{64}$/.test(manifest.desktop.sha256)) throw Error('无效的桌面安装清单')
    const bytes = await get(installer)
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.desktop.sha256) throw Error('桌面安装器校验失败')
    const filename = 'SayNext-'+manifest.version+'-'+chosenAt+'.mjs'
    await writeFile(resolve(directory,filename),bytes,{flag:'wx',mode:0o600})
    const mode = choice === true && manifest.target ? '--share-text' : '--local-only'
    onInstallCommand?.('node ./'+filename+' '+mode+' '+chosenAt)
    return filename
  }
  const bytes = await get(name)
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('安装包校验失败')
  await writeFile(resolve(directory,name),bytes,{flag:'wx',mode:0o600})
  const receipt = {format:'saynext-download-v1',policy:'paired-text-v1',target:manifest.target,enabled:choice === true,chosenAt}
  await writeFile(resolve(directory, 'saynext-choice-' + manifest.version + '.json'),JSON.stringify(receipt)+'\n',{mode:0o600})
  return name
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const source = new URL(process.argv[2] ?? './download.json', import.meta.url)
  async function read(url) {
    if (url.protocol === 'file:') return readFile(url)
    if (url.protocol !== 'https:') throw Error('远程下载需要 HTTPS')
    const response = await fetch(url, {redirect:'error'})
    if (!response.ok) throw Error('下载失败 ' + response.status)
    return Buffer.from(await response.arrayBuffer())
  }
  const manifest = JSON.parse(await read(source))
  const name = await download({manifest,directory:process.cwd(),get:name=>read(new URL(name,source)),
    onInstallCommand:command=>console.log('退出 DSH，在下载目录运行以下命令后重新打开：\n'+command),
    choose:async m=>{
      if (!m.target || !process.stdin.isTTY) return false
      console.log('愿意帮 SayNext 猜准下一句吗？把建议和你真正发出的下一句放在一起，作者就能找出理解错的地方。')
      console.log('开启后，新回合的建议原文、你实际发送的下一条消息、本轮提问和助手回复各前 1,200 字会自动分享给作者。还包括展示、采纳、自动判定和人工纠正，附件只记录有无。')
      console.log('接收方为 '+m.target.owner+'。可在「建议统计」停止分享，停止后清空本机待传样本，作者保留已收到的记录。')
      console.log('两种选择下载同一个插件，均可使用全部功能。')
      const prompt = createInterface({input:process.stdin,output:process.stdout})
      try {
        for (;;) {
          const answer = (await prompt.question('1 同意分享并下载　 2 仅下载（回车仅下载）　')).trim()
          if (answer === '1' || answer === '同意') return true
          if (answer === '2' || answer === '') return false
          console.log('请输入 1 或 2，也可直接回车仅下载。')
        }
      }
      finally { prompt.close() }
    }})
  console.log('已下载 '+name)
}

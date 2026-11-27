// 分发时填入中性的 npm 安装包；下载者的选择只由本次安装命令传入。
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const bundle = /* DESKTOP_BUNDLE */ null

async function replaceFile(path, data) {
  const temporary = path + '.' + randomUUID()
  try {
    await writeFile(temporary, data, {flag:'wx',mode:0o600})
    await rename(temporary, path)
  } finally {
    await rm(temporary, {force:true})
  }
}

async function install() {
  if (!bundle) throw Error('请使用下载页提供的安装文件。')
  const [mode = '--local-only', rawTime, ...extra] = process.argv.slice(2)
  if (!['--share-text','--local-only'].includes(mode) || extra.length) throw Error('请使用下载页显示的安装命令。')
  const enabled = mode === '--share-text'
  if (enabled && !bundle.target) throw Error('这个版本只支持本机统计。')
  const chosenAt = rawTime === undefined && !enabled ? Date.now() : Number(rawTime)
  if (!Number.isSafeInteger(chosenAt) || chosenAt <= 0 || chosenAt > Date.now()) throw Error('下载选择的时间无效，请重新下载。')
  const bytes = Buffer.from(bundle.archive,'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== bundle.sha256) throw Error('安装包校验失败。')

  const home = resolve(process.env.DSH_HOME || join(homedir(),'.dsh'))
  const profile = join(home,'profiles','desktop')
  const manifest = join(profile,'package.json')
  const readProfile = async () => {
    const data = JSON.parse(await readFile(manifest,'utf8'))
    if (!Array.isArray(data.dsh?.profile?.bundles)) throw Error('请先打开一次 DSH 桌面端，初始化桌面配置。')
    return data
  }
  await readProfile()
  const state = join(home,'desktop')
  await mkdir(state,{recursive:true,mode:0o700})
  const lockPath = join(state,'lock')
  const lock = await open(lockPath,'wx',0o600).catch(e => {
    if (e.code === 'EEXIST') throw Error('DSH 正在处理插件，请稍后重新运行这条安装命令。')
    throw e
  })
  try {
    await lock.writeFile(String(process.pid))
    const archives = join(home,'saynext','packages')
    await mkdir(archives,{recursive:true,mode:0o700})
    const archive = join(archives,'dsh-saynext-'+bundle.sha256+'.tgz')
    await replaceFile(archive,bytes)
    let command = 'pnpm', args = ['add','--save-prod','--ignore-scripts',archive]
    const bundledPnpm = join(home,'dsh-runtimes','dsh-primary-runtime','dependencies','pnpm','bin','pnpm.mjs')
    const bundledNode = join(home,'dsh-runtimes','dsh-primary-runtime','dependencies','node',
      ...(process.platform === 'win32' ? ['node.exe'] : ['bin','node']))
    if (existsSync(bundledPnpm) && existsSync(bundledNode)) {
      command = bundledNode
      args = [bundledPnpm,...args]
    } else if (process.platform === 'win32') {
      const {dirname} = await import('node:path')
      const matches = spawnSync('where.exe',['pnpm'],{encoding:'utf8'}).stdout || ''
      const executables = matches.trim().split(/\r?\n/u).filter(Boolean)
      const standalone = executables.find(path=>path.toLowerCase().endsWith('.exe'))
      if (standalone) command = standalone
      else {
        const script = executables.flatMap(path=>['pnpm/bin/pnpm.cjs','corepack/dist/pnpm.js']
          .map(script=>join(dirname(path),'node_modules',script))).find(existsSync)
        if (!script) throw Error('未找到 pnpm，请安装 pnpm 后再次运行安装命令。')
        command = process.execPath
        args = [script,...args]
      }
    }
    const result = spawnSync(command,args,{cwd:profile,stdio:'inherit'})
    if (result.error) throw result.error
    if (result.status !== 0) throw Error('安装未完成，可用同一条命令重试。')
    const data = await readProfile()
    if (!data.dsh.profile.bundles.includes('dsh-saynext')) {
      data.dsh.profile.bundles.push('dsh-saynext')
      await replaceFile(manifest,JSON.stringify(data,null,2)+'\n')
    }
    const receiptPath = join(profile,'.saynext-desktop-choice.json')
    let previous
    try { previous = JSON.parse(await readFile(receiptPath,'utf8')) }
    catch(e) { if (e.code !== 'ENOENT') throw e }
    if (previous?.target?.url !== bundle.target?.url || previous?.target?.owner !== bundle.target?.owner ||
        !(previous.chosenAt > chosenAt || previous.chosenAt === chosenAt && !previous.enabled)) {
      await replaceFile(receiptPath,JSON.stringify({format:'saynext-download-v1',policy:'paired-text-v1',
        target:bundle.target,enabled,chosenAt})+'\n')
    }
    console.log('安装完成。重新打开 DSH 桌面端即可在「建议统计」查看分享状态。')
  } finally {
    await lock.close()
    await rm(lockPath,{force:true})
  }
}
install().catch(e=>{console.error(e.message);process.exitCode=1})

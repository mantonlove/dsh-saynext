/**
 * dsh-saynext · 界面侧
 *
 * 建议直接写在输入框里：宿主把"你下一句可能说什么"写进插件配置的 hint 格，
 * 这里每秒读一次那一格；输入框为空时，把这句话按宿主占位符的位置画在编辑区
 * 第一行上（灰字、不可点）。按 Enter 只做一件事——把这句话搬进输入框（不发送），
 * 再按一次 Enter 才走正常发送。
 */
window.__ModuleLoader__.load({
  id: 'dsh-saynext',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const module = { exports: {} }
    const exports = module.exports

    const NAMESPACE = 'saynext'
    const CHANNEL = 'hint'
    const POLL_MS = 1000
    const STYLE_ID = 'dsh-saynext-ghost-style'

    /** settings.describe() 的返回可能被 RPC 信封裹过一层，逐层剥到 namespaces。 */
    function unwrap(response) {
      let node = response
      for (let depth = 0; depth < 4; depth += 1) {
        if (typeof node !== 'object' || node === null) return undefined
        if (Array.isArray(node.namespaces)) return node
        if (node.ok === true) { node = node.value; continue }
        // 注意：{result} 信封要取 node.result，不能顺手写 value。
        if ('result' in node) { node = node.result; continue }
        if ('value' in node) { node = node.value; continue }
        return undefined
      }
      return undefined
    }

    /** 从配置的 hint 字段读取各会话的建议。 */
    function readItems(raw) {
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed?.items) ? parsed.items : []
      } catch {
        return []
      }
    }

    /**
     * 灰字的位置就是宿主占位符的位置：编辑区那一层（.grow）是 position:relative，
     * 占位符用 inset: 4px 8px auto 14px 贴在第一行上。我们不猜卡片里工具栏有多高，
     * 直接把节点 portal 进同一层容器、用同一组 inset，行高字体都由它继承。
     */
    const GHOST = {
      position: 'absolute',
      inset: '4px 8px auto 14px',
      color: 'var(--dsw-alias-label-caption, #9aa0a6)',
      opacity: 0.5,
      font: 'inherit',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      pointerEvents: 'none',
      userSelect: 'none',
    }

    /**
     * 灰字显示期间把宿主自带的占位符藏起来，否则两行字叠在一起。
     * 这条规则按「卡片属性」生效，与有几个实例无关，所以整页只注入一次、常驻；
     * 属性没了规则就自然失效，不需要在某个实例卸载时拆掉（拆掉会误伤同页别的会话）。
     */
    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = '[data-saynext-ghost] [data-composer-placeholder] { visibility: hidden !important; }'
      document.head.appendChild(style)
    }

    /**
     * 给卡片打/摘「这里有灰字」的标记；宿主自带的占位符靠这个属性被隐藏。
     * 就地打而不是等下一个渲染周期：属性必须在同一帧里生效。
     */
    function markCard(node, on) {
      const card = typeof node?.closest === 'function' ? node.closest('[data-composer-card]') : null
      if (card === null) return
      if (on) card.setAttribute('data-saynext-ghost', '')
      else card.removeAttribute('data-saynext-ghost')
    }

    /** 承载层是否还挂在文档上；拿不到 isConnected（测试桩）就当它还在。 */
    function stillConnected(node) {
      if (typeof node?.isConnected === 'boolean') return node.isConnected
      return true
    }

    /**
     * 找到可以承载灰字的那一层：占位符的父节点（宿主自己就是这么定位的）。
     * 拿不到就返回 null，界面宁可不画，也不往别处乱塞。
     */
    function findGhostTarget(anchor) {
      if (!anchor || typeof anchor.closest !== 'function') return null
      const card = anchor.closest('[data-composer-card]')
      if (!card || typeof card.querySelector !== 'function') return null
      const placeholder = card.querySelector('[data-composer-placeholder]')
      const target = placeholder?.parentElement ?? null
      // 用 typeof 而不是 instanceof：插件跑在 iframe/沙箱里时，跨 realm 的
      // instanceof Object 会一律为 false，把好端端的容器判成拿不到。
      return typeof target === 'object' && target !== null ? target : null
    }

    /**
     * 只有当焦点真的在这条会话的输入框里时，才允许接管 Enter。
     * 判据：焦点元素必须是可编辑区，且它和锚点之间存在 body 以下的共同祖先
     * （也就是同一个输入区容器）。只要共同祖先退到 body，就当作「别处的输入框」，
     * 一律放行，让 Enter 保持原来的行为。
     */
    function focusInComposer(host, active) {
      if (!host || !active || active.nodeType !== 1) return false
      if (active.isContentEditable !== true) return false
      let node = active.parentElement
      while (node && node !== document.body && node !== document.documentElement) {
        if (typeof node.contains === 'function' && node.contains(host)) return true
        node = node.parentElement
      }
      return false
    }

    /** 输下去的那句话要不要显示：有建议、输入框为空、这条会话没在跑。 */
    /**
     * 从会话视图里读出「最新一轮」及其是否正常收尾。
     * 数据来自 conversation timeline（宿主已算好，事件驱动），不靠 settings 轮询。
     * @param {any} timeline
     * @returns {{ turn: number, completed: boolean } | undefined}
     */
    function turnState(timeline) {
      if (timeline === undefined || timeline === null) return undefined
      const order = Array.isArray(timeline.turnOrder) ? timeline.turnOrder : []
      if (order.length === 0) return undefined
      const turn = order[order.length - 1]
      const location = typeof timeline.turns?.get === 'function' ? timeline.turns.get(turn) : undefined
      const completed = location?.status === 'closed' && location?.end?.data?.reason?.kind === 'completed'
      return { turn, completed: completed === true }
    }

    /**
     * 建议必须属于「当前会话最新一轮」，且那一轮正常结束，才算有效。
     * @param {any} item
     * @param {{ turn: number, completed: boolean } | undefined} state
     */
    function matchesLatest(item, state) {
      if (item === undefined || item === null || state === undefined) return false
      if (item.turn === undefined || item.turn === null) return false
      return Number(item.turn) === Number(state.turn) && state.completed === true
    }

    function ghostVisible(text, draft, running) {
      if (typeof text !== 'string' || text === '') return false
      if (running === true) return false
      const blank = typeof draft === 'string' ? draft.trim() === '' : true
      return blank
    }

    const DB_NAME = 'dsh-saynext-local-stats'
    const statsChanged = 'saynext-stats-changed'
    let dbPromise
    let captureError = false
    // 官方接收方；本地专用包可在打包时将此值设为空。
    const feedbackTarget = /* saynext-feedback-target */ {"url":"https://dlajjkozzyclcgypkxlf.supabase.co/functions/v1/saynext-feedback","owner":"mantonlove · Supabase（日本东京） · github.com/mantonlove/dsh-saynext/issues"} /* end-saynext-feedback-target */
    const feedbackVersion = '0.1.9'
    const policy = 'paired-text-v1'
    const sharingChanged = 'saynext-sharing-changed'
    const targetKey = feedbackTarget && JSON.stringify([policy, feedbackTarget.url, feedbackTarget.owner])
    let sending = false
    let activeUpload
    let feedbackChannel
    let uploadMessage = ''
    let sharingPaused = false
    let startupChoice
    const announce = () => window.dispatchEvent(new Event(sharingChanged))

    async function preference() {
      const db = await statsDb()
      return new Promise((resolve, reject) => {
        const r = db.transaction('sharing').objectStore('sharing').get('choice')
        r.onsuccess = () => resolve(r.result?.target === targetKey ? r.result : null)
        r.onerror = () => reject(r.error)
      })
    }

    async function setSharing(enabled, downloadedAt) {
      if (enabled && !feedbackTarget) throw Error('当前版本尚未配置接收服务')
      activeUpload?.abort()
      const db = await statsDb()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['sharing','samples'], 'readwrite')
        const choices = tx.objectStore('sharing')
        const r = choices.get('choice')
        r.onsuccess = () => {
          const old = r.result?.target === targetKey ? r.result : null
          const at = downloadedAt ?? Date.now()
          const priorTime = old?.decisionAt ?? old?.since
          if (downloadedAt !== undefined && old && (priorTime > at || (priorTime === at && (!old.enabled || old.enabled === enabled)))) return
          if (old?.enabled === enabled) {
            choices.put({...old,decisionAt:at},'choice')
            return
          }
          tx.objectStore('samples').clear()
          choices.put({target:targetKey,enabled,since:Date.now(),decisionAt:at,epoch:crypto.randomUUID()},'choice')
        }
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
      sharingPaused = false
      uploadMessage = ''
      feedbackChannel?.postMessage('changed')
      announce()
    }

    const downloadKey = 'saynext.download.choice.v1'
    function validReceipt(record) {
      return record?.format === 'saynext-download-v1' && record.policy === policy &&
        !!feedbackTarget && record.target?.url === feedbackTarget.url &&
        record.target?.owner === feedbackTarget.owner && typeof record.enabled === 'boolean'
    }
    async function restoreDownloadChoice() {
      try {
        if (window.location?.protocol === 'dsh-app:' && window.location.hostname === 'app') {
          const installed = window.__saynextDesktopChoice
          if (validReceipt(installed) && Number.isSafeInteger(installed.chosenAt) &&
              installed.chosenAt > 0 && installed.chosenAt <= Date.now()) {
            try { await setSharing(installed.enabled,installed.chosenAt) }
            catch {
              sharingPaused = true
              uploadMessage = '未能保存桌面安装选择，已暂停同步。'
              announce()
            }
            return
          }
        }
        const raw = window.localStorage?.getItem(downloadKey)
        if (!raw) return
        const record = JSON.parse(raw), age = Date.now() - record.chosenAt
        if (!validReceipt(record) || !Number.isFinite(age) || age < 0 || age > 7*86400000) return
        await setSharing(record.enabled,record.chosenAt)
        if (window.localStorage.getItem(downloadKey) === raw) window.localStorage.removeItem(downloadKey)
      } catch { /* 浏览器存储不可用时，可从建议统计导入下载选择。 */ }
    }

    // samples 与 rounds 在同一事务内更新。撤回时清除 samples 不影响本机既有指标。
    function stageSample(tx, row, change, value, eventTime) {
      if (!feedbackTarget || sharingPaused) return
      const pref = tx.objectStore('sharing').get('choice')
      pref.onsuccess = () => {
        const choice = pref.result
        if (!choice?.enabled || choice.target !== targetKey) return
        if (!row.shareId) {
          if (!['opportunity','shown','filled'].includes(change) ||
              !Number.isFinite(eventTime) || eventTime < choice.since || row.at < choice.since) return
          row.shareId = crypto.randomUUID()
          row.shareEpoch = choice.epoch
          tx.objectStore('rounds').put(row)
        }
        if (row.shareEpoch !== choice.epoch) return
        const samples = tx.objectStore('samples')
        const prior = samples.get(row.shareId)
        prior.onsuccess = () => {
          const prev = prior.result
          const sample = {id:row.shareId, revision:(prev?.sample.revision ?? 0) + 1,
            policy, version:prev?.sample.version ?? feedbackVersion,
            day:prev?.sample.day ?? new Date(row.at).toISOString().slice(0,10),
            suggestion:row.text ?? null, actual:prev?.sample.actual ?? null,
            previousUser:prev?.sample.previousUser ?? null, previousAssistant:prev?.sample.previousAssistant ?? null,
            filled:row.filled === true, outcome:row.outcome ?? null,
            autoIntent:row.auto?.intent ?? null, autoSevere:row.auto?.severe ?? null,
            manualIntent:row.intent ?? null, manualSevere:row.severe ?? null}
          if (change === 'outcome') {
            sample.actual = value.follow?.text ?? null
            sample.previousUser = value.previousUser ?? null
            sample.previousAssistant = value.previousAssistant ?? null
          }
          samples.put({id:row.shareId, epoch:choice.epoch, pending:1, sample})
        }
      }
    }

    async function nextSample() {
      const db = await statsDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['samples','sharing'])
        const pref = tx.objectStore('sharing').get('choice')
        let sample
        pref.onsuccess = () => {
          const choice = pref.result
          if (!choice?.enabled || choice.target !== targetKey) return
          const req = tx.objectStore('samples').index('pending').openCursor(1)
          req.onsuccess = () => {
            if (req.result?.value.epoch === choice.epoch) sample = req.result.value
          }
        }
        tx.oncomplete = () => resolve(sample)
        tx.onabort = () => reject(tx.error)
      })
    }

    async function markUpload(record, pending) {
      const db = await statsDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('samples','readwrite')
        const store = tx.objectStore('samples'), req = store.get(record.id)
        req.onsuccess = () => {
          if (req.result?.sample.revision === record.sample.revision && req.result.epoch === record.epoch)
            store.put({...req.result,pending})
        }
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    }

    async function queueStatus() {
      const db = await statsDb()
      return new Promise((resolve,reject) => {
        const tx = db.transaction('samples'), index = tx.objectStore('samples').index('pending')
        const queued = index.count(1), rejected = index.count(2)
        tx.oncomplete = () => resolve('待同步 '+queued.result+' 条 · 超限或格式不符 '+rejected.result+' 条')
        tx.onabort = () => reject(tx.error)
      })
    }

    async function flushSamples() {
      await startupChoice
      if (sending || !feedbackTarget || sharingPaused) return
      sending = true
      try {
        for (let i = 0; i < 20; i++) {
          const record = await nextSample()
          if (!record) break
          const controller = new AbortController()
          activeUpload = controller
          const choice = await preference()
          if (!choice?.enabled || choice.epoch !== record.epoch || controller.signal.aborted) break
          const timer = setTimeout(() => controller.abort(), 15000)
          try {
            const reply = await fetch(feedbackTarget.url, {method:'POST', mode:'cors', credentials:'omit',
              referrerPolicy:'no-referrer', redirect:'error', signal:controller.signal,
              headers:{'Content-Type':'application/json'},body:JSON.stringify(record.sample)})
            if ([413,422].includes(reply.status)) {
              await markUpload(record,2)
              continue
            }
            if (reply.status !== 204) throw Error('接收服务未确认')
          } finally { clearTimeout(timer) }
          await markUpload(record,0)
          uploadMessage = '最近一次同步成功'
        }
      } catch { uploadMessage = '同步未完成，样本已保留，将自动重试' }
      finally { sending = false; activeUpload = undefined; announce() }
    }


    // 离线判读只保存理由代码。原句、实际消息和当前轮上下文留在各自的已有存储中。
    const reasons = {
      exact: '你逐字发送了这条建议。',
      equivalent: '两句话的动作、对象和限定一致，仅措辞有变化。',
      overlap: '两句话提到了相同对象，但动作或限定没有完全对上。',
      different: '两句话都有具体内容，未找到相同的任务或关注对象。',
      commitment: '建议替你作出了选择，实际消息仍在比较或询问。',
      opposite: '对于同一个动作，两句话的要求方向相反。',
      actor: '同一件事，建议与实际消息指定了不同的执行人。',
      restriction: '建议要求执行的操作，与用户明确说过的限制冲突。',
      aligned: '双方要求的动作一致，未发现越权或转移责任。',
      inquiry: '建议在询问或索取信息，未发现授权、承诺或改派任务的表述。',
      displaced: '建议要求搁置的任务，在你前后的消息里都仍是关注对象。',
      permission: '你前后都在询问信息，建议却直接要求执行会改变现状的操作。',
      ambiguous: '两句话提供的线索不足以判定。',
      attachment: '实际发送含有附件，正文不足以代表整条消息。',
      waiting: '还没有可供对照的本人消息。',
      short: '实际回复很短，无法确定它指的是哪件事。',
    }
    const exactReview = () => ({intent:'hit', severe:false, whyIntent:'exact', whySevere:'exact'})
    const actionWords = [
      ['删除', /删除|删掉|清掉|清除|清空|\b(?:delete|remove|erase)\b/giu],
      ['发布', /发布|上线|发帖|\b(?:publish|deploy)\b/giu],
      ['安装', /安装|装上|装吧|\binstall\b/giu],
      ['付款', /付款|支付|扣款|\bpay\b/giu],
      ['授权', /授权|准许|\bauthorize\b/giu],
      ['核实', /核实|核对|查证|核验|确认一下|\b(?:verify|check)\b/giu],
      ['比较', /比较|对比|比一比|\bcompare\b/giu],
      ['解释', /解释|讲解|说清楚|讲清楚|说明一下|\bexplain\b/giu],
      ['原因', /为什么|为何|什么原因|怎么回事|\bwhy\b/giu],
      ['修改', /修改|改写|改一下|调整|\b(?:revise|edit)\b/giu],
      ['提供', /发给我|给我发|发我|提供|给我看|\bprovide\b/giu],
      ['撰写', /撰写|写一篇|写一份|起草|\bdraft\b/giu],
      ['暂停', /放一放|放一边|放到一边|搁置|暂缓|暂停|放弃|\bpause\b/giu],
    ]
    const impactful = new Set(['删除','发布','安装','付款','授权','暂停'])
    const segmenter = new Intl.Segmenter('zh', {granularity:'word'})
    const stopWords = new Set('我 你 您 请 帮 把 将 给 的 得 地 了 吧 啊 呢 一下 一点 这个 那个 这些 那些 我们 现在 直接 进行 一份 一篇 一下子 能否 能不能 the a an to of please can you me i'.split(' '))
    const wording = text => text.normalize('NFC').trim()
    // 保留数字、数量词、问号和负号。它们可能直接改变用户的要求。
    const comparable = text => wording(text).replace(/[。！!]$/u,'').trim()
    const generic = new Set('问题 内容 东西 事情 地方 方面 方案 结果 一个 一些 下一步 情况 这边 然后 出来 需要 帮忙 时候 继续 觉得 知道 看看 是 还 也 就 还是 应该 之前 能 让 说 有 都'.split(' '))
    const meaningful = w => !generic.has(w) && (Array.from(w).length >= 2 || /[A-Z0-9]/u.test(w))
    const overlap = (a,b) => [...a].filter(word => b.has(word) && meaningful(word))
    function traits(text) {
      let canonical = wording(text)
      const actions = new Set()
      for (const [name, pattern] of actionWords) {
        canonical = canonical.replace(pattern, () => { actions.add(name); return ' ' + name + ' ' })
      }
      const words = new Set()
      for (const part of segmenter.segment(canonical)) {
        if (part.isWordLike && !stopWords.has(part.segment) && !actions.has(part.segment)) words.add(part.segment)
      }
      const lead = canonical.match(/^(?:请|麻烦)?([我你])(?:先|再|要|会|可以|需要)?\s*(\S+)/u)
      const explicitActor = lead && [...actions].some(action => lead[2].startsWith(action)) ? lead[1] : null
      const actor = explicitActor === '我' || /(?:我自己|我来|我去|我负责|由我|\bi (?:will|shall)\b)/iu.test(text) ? 'user'
        : explicitActor === '你' || /(?:你来|你去|你负责|由你|帮我|请你|\byou (?:should|must)\b)/iu.test(text) ? 'assistant' : null
      const negative = /别|不要|不(?:用|要|准|能|想|必)|禁止|不能|暂不|勿|\b(?:not|never|don't)\b/iu.test(text)
      const question = /[？?]|吗[。！!\s]*$|要不要|能不能|可不可以|是不是|是否|为什么|为何|怎么|如何|什么原因|\b(?:why|how|whether)\b/iu.test(text)
      const complex = /[;；。！？!?]\s*\S|但是|而是|同时|除非|如果|不仅|不是不|并非不|\b(?:unless|instead|except|if)\b/iu.test(text)
      return {words, actions, canonical, actor, negative, question, complex}
    }

    const shares = (a,b) => [...a].some(item => b.has(item))
    function judgePair(suggestion, follow, priorUser = '') {
      function result(intent, severe, whyIntent, whySevere = whyIntent) {
        return {intent, severe, whyIntent, whySevere}
      }
      if (!follow) return result(null,null,'waiting')
      if (follow.attachment) return result(null,null,'attachment')
      const actual = follow.text.trim()
      if (!actual) return result(null,null,'ambiguous')
      if (suggestion === follow.text) return exactReview()
      if (actual.length > 2400) return result(null,null,'ambiguous')
      const s = traits(suggestion), a = traits(actual)
      const risk = shares(s.actions, impactful)
      const relatedAction = shares(s.actions,a.actions)
      const matched = overlap(s.words, a.words)
      const relatedObject = matched.length > 0
      const sameActor = !(s.actor && a.actor && s.actor !== a.actor)
      const qualified = /(?:只|除了|仅|至少|最多|全部|部分|改为|改成|\bonly\b)/iu
      // 只在同一句内绑定动作、对象和否定。复合指令容易把另一项的“不要”错配过来。
      const simple = x => !x.complex && !/[，,、]/u.test(x.canonical.trim().replace(/^[好行][，,]/u,''))
      const opposite = simple(s) && simple(a) && relatedAction && relatedObject && s.negative !== a.negative && !s.question && !a.question
      const reversal = simple(s) && simple(a) && relatedAction && relatedObject && !sameActor && !s.question && !a.question
      const priorConflict = risk && !s.negative && !s.question && simple(s) && priorUser.slice(-1200).split(/[。！？!?；;，,\n]/u).some(clause => {
        const old = traits(clause)
        return old.negative && !old.question && !old.complex && shares(s.actions,old.actions) && overlap(s.words, old.words).length > 0
      })
      if (opposite) return result('miss', risk && !s.negative ? true : null, 'opposite', risk && !s.negative ? 'restriction' : 'ambiguous')
      if (reversal) return result('miss',true,'actor')
      const containsSyntax = /[“”「」『』"'‘’`/\\=+<>_%$#:@.\-]/u.test(suggestion + actual)
      const identical = comparable(suggestion) === comparable(actual)
      const sameWords = relatedObject && s.words.size === a.words.size && [...s.words].every(w => a.words.has(w))
      const sameActions = relatedAction && s.actions.size === a.actions.size && [...s.actions].every(v=>a.actions.has(v))
      const synonymous = !containsSyntax && relatedAction && simple(s) && simple(a) && sameActor && s.negative === a.negative && s.question === a.question &&
        comparable(s.canonical) === comparable(a.canonical)
      // 保留语序，避免把“把 A 改成 B”和“把 B 改成 A”视作同义。
      const core = x => [...segmenter.segment(x.canonical)].filter(p=>p.isWordLike && !stopWords.has(p.segment)).map(p=>p.segment).join('|')
      const mentionsPronoun = x => [...x.canonical.matchAll(/[我你您]|\b(?:I|you|me)\b/giu)].map(match=>match[0]).join('')
      const sameRequest = mentionsPronoun(s) === mentionsPronoun(a) && !containsSyntax && simple(s) && simple(a) && sameWords && sameActions && sameActor &&
        s.negative === a.negative && s.question === a.question && core(s) === core(a)
      if (identical || synonymous || sameRequest) return result('hit',false,'equivalent','aligned')
      let intent = null, whyIntent = 'ambiguous'
      const concrete = x => [...x.words].filter(meaningful).length
      const previous = priorUser ? traits(priorUser.slice(-1200)) : null
      const clauses = text => text.split(/[，,。！？!?；;\n]/u).filter(Boolean)
      if (s.actions.has('暂停') && !s.question && !a.actions.has('暂停') && previous) {
        const requested = clauses(priorUser.slice(-1200)).map(traits).filter(c => !c.negative && !c.actions.has('暂停'))
        const stillRequested = clauses(actual).map(traits).filter(c => !c.negative)
        const dropped = clauses(suggestion).map(traits).filter(c => !c.negative && c.actions.has('暂停'))
        const sameGoal = dropped.some(c => requested.some(old =>
          overlap(c.words, old.words).some(w => stillRequested.some(next => next.words.has(w)))))
        if (sameGoal) return result('miss',true,'displaced')
      }
      const informationRequest = x => x && (x.question || shares(x.actions, new Set(['解释','原因','比较']))) &&
        !shares(x.actions, impactful)
      const consequential = shares(s.actions, new Set(['删除','付款','发布','授权']))
      const modifying = /(?:删除|删掉|清掉|清空|付款|支付|扣款|发布|上线|授权)(?:吧|掉|一下|这|那|所有|全部)|^(?:请|先|直接|帮我|你来|把|将|现在|就|给我)*(?:删除|清空|付款|发布|授权)/u
      if (consequential && !s.question && !s.negative && modifying.test(suggestion) && informationRequest(previous) && informationRequest(a))
        return result(relatedObject ? 'partial' : 'miss',true,relatedObject ? 'overlap' : 'different','permission')
      const indirect = /^(?:好[的吧]?|行|可以|继续|同意|就这[样个]|按你说的|按.{0,3}方案|第[一二三两\d]+个)[。！!\s]*$/u.test(actual)
      if (indirect) return result(null,null,'short')
      if (relatedObject && (relatedAction || matched.length >= 2)) {
        intent = 'partial'; whyIntent = 'overlap'
      } else if (!relatedObject && !relatedAction && concrete(s) >= 2 && concrete(a) >= 2) {
        intent = 'miss'; whyIntent = 'different'
      } else if (actual.length <= 4 && !a.actions.size) whyIntent = 'short'
      if (priorConflict) {
        // 用户这次可能亲自改了决定。有同向授权线索时不沿用旧限制。
        if (!(relatedAction && !a.negative && (!a.words.size || relatedObject)) && !/^(?:好|可以|行|同意|继续|做|确认)[吧的。！!\s]*$/u.test(actual))
          return result(intent,true,whyIntent,'restriction')
      }
      const decisionLanguage = /(?:我(?:已经|已)?决定|我(?:就选|同意|批准)|就定(?:这个|这版)|\bi (?:have decided|approve|agree to)\b)/iu
      if (relatedObject && decisionLanguage.test(suggestion) && !s.question && a.question && !decisionLanguage.test(actual))
        return result('miss',true,'commitment')
      const onTopic = relatedObject || (previous && overlap(s.words, previous.words).length > 0)
      const questionsOnly = suggestion.split(/[？?。！!]/u).filter(clause => clause.trim()).every(clause =>
        /(?:吗|么|为何|为什么|什么|是否|多少|哪里|哪[个些里]|能不能|有没有|如何|怎么|可否)/u.test(clause))
      const informative = !risk && !s.actor && !s.negative && !decisionLanguage.test(suggestion) &&
        ((onTopic && simple(s) && informationRequest(s)) || (s.question && questionsOnly)) &&
        !/(?:我(?:来|负责|承诺|同意|决定)|已经|既然|改为|改成|换成|搁置|放弃)/u.test(suggestion)
      const aligned = !/[0-9]/u.test(suggestion + actual) && relatedObject && sameActions && sameActor && !s.negative && !a.negative && !qualified.test(suggestion + actual) && !risk && simple(s) && simple(a)
      return result(intent, informative || aligned ? false : null, whyIntent, informative ? 'inquiry' : aligned ? 'aligned' : 'ambiguous')
    }

    function priorRequest(chat, turn) {
      for (const key of [...(chat?.locations?.getTurn?.(turn) ?? [])].reverse()) {
        const n = chat.nodes.get(key)
        if (['user','steering'].includes(n?.kind) && n.data?.source?.kind === 'user' && Array.isArray(n.data.content))
          return n.data.content.filter(b=>b.type === 'text').map(b=>b.text).join('')
      }
      return ''
    }

    function decision(row, field) {
      return row[field] != null ? row[field] : row.auto?.[field] ?? null
    }

    function statsDb() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = window.indexedDB.open(DB_NAME, 3)
          req.onupgradeneeded = event => {
            const samples = req.result.createObjectStore('samples', {keyPath:'id'})
            samples.createIndex('pending', 'pending')
            req.result.createObjectStore('sharing')
            if (event.oldVersion === 0) {
              const store = req.result.createObjectStore('rounds', {keyPath: ['sessionId', 'turn']})
              store.createIndex('pending', ['sessionId', 'pending'])
              return
            }
            if (event.oldVersion >= 2) return
            const cursor = req.transaction.objectStore('rounds').openCursor()
            cursor.onsuccess = () => {
              const item = cursor.result
              if (!item) return
              const row = item.value
              if (row.text) {
                if (row.outcome === 'exact') row.auto = exactReview()
                else if (row.outcome !== 'no-send') row.pending = 1
                item.update(row)
              }
              item.continue()
            }
          }
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            const db = req.result
            db.onversionchange = () => { db.close(); dbPromise = undefined }
            resolve(db)
          }
        }).catch(error => { dbPromise = undefined; throw error })
      }
      return dbPromise
    }

    function notifyStats() {
      window.dispatchEvent(new Event(statsChanged))
    }

    // 同一设备的多个窗口在同一个读写事务内合并，视图重绘不会增加回合数。
    async function updateRound(sessionId, turn, change, value, eventTime) {
      await startupChoice
      const db = await statsDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['rounds','sharing','samples'], 'readwrite')
        const rounds = tx.objectStore('rounds')
        const read = rounds.get([sessionId, turn])
        let changed = false
        read.onsuccess = () => {
          let row = read.result
          if (!row) {
            if (!['opportunity','shown','filled'].includes(change)) return
            row = {sessionId, turn, at: Date.now()}
            changed = true
          }
          if (change === 'shown' || change === 'filled') {
            if (row.text && row.text !== value) return
            if (!row.text) { row.text = value; row.pending = 1; changed = true }
            if (change === 'filled' && !row.filled) { row.filled = true; changed = true }
          } else if (change === 'outcome' && row.pending === 1) {
            row.outcome = value.outcome
            row.auto = value.auto
            delete row.pending
            changed = true
          } else if ((change === 'intent' || change === 'severe') && row.text && row[change] !== value) {
            row[change] = value
            changed = true
          }
          if (changed) {
            rounds.put(row)
            stageSample(tx, row, change, value, eventTime)
          }
        }
        tx.oncomplete = () => { if (changed) notifyStats(); resolve() }
        tx.onabort = () => reject(tx.error ?? new Error('本地统计写入中断'))
        tx.onerror = () => reject(tx.error)
      })
    }

    async function readRounds(pendingSession) {
      const db = await statsDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('rounds')
        const store = tx.objectStore('rounds')
        const request = pendingSession === undefined ? store.getAll() : store.index('pending').getAll([pendingSession, 1])
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }

    function visible(element) {
      if (!element?.isConnected || document.visibilityState !== 'visible' || !element.getBoundingClientRect) return false
      if (element.checkVisibility && !element.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return false
      const r = element.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth
    }

    // 只采用紧接所评回合的下一轮、由本人发送的已落入时间线的消息。
    function followingMessage(chat, turn) {
      const next = chat?.timeline?.turns?.get(turn + 1)
      if (!next?.start || !chat.locations?.getTurn || !chat.nodes?.get) return undefined
      const keys = chat.locations.getTurn(turn + 1)
      for (const key of keys) {
        const node = chat.nodes.get(key)
        if (!['user','steering'].includes(node?.kind) || node.data?.source?.kind !== 'user') continue
        const content = node.data.content
        if (!Array.isArray(content)) return undefined
        return {
          text: content.filter(b => b.type === 'text').map(b => b.text).join(''),
          attachment: content.some(b => b.type !== 'text'),
        }
      }
      return next.status === 'closed' ? null : undefined
    }

    async function reconcile(sessionId, chat) {
      if (!chat?.locations?.getTurn || !sessionId) return
      for (const row of await readRounds(sessionId)) {
        const follow = followingMessage(chat, row.turn)
        if (follow === undefined) continue
        if (follow === null && row.outcome && row.outcome !== 'no-send') continue
        let outcome = 'no-send'
        if (follow) outcome = follow.attachment ? 'attachment' : follow.text === row.text ? 'exact' : 'different'
        const auto = judgePair(row.text, follow, priorRequest(chat, row.turn))
        let previousUser = null, previousAssistant = null
        if (row.shareId && feedbackTarget) {
          previousUser = priorRequest(chat, row.turn).slice(0,1200)
          const last = [...chat.locations.getTurn(row.turn)].reverse().map(k => chat.nodes.get(k))
            .find(n => n?.kind === 'assistant' && n.blocks?.some(b => b.kind === 'text'))
          previousAssistant = last?.blocks.filter(b=>b.kind === 'text').map(b=>b.text).join('').slice(0,1200) ?? null
        }
        await updateRound(sessionId, row.turn, 'outcome', {outcome, auto, follow, previousUser, previousAssistant})
      }
    }

    function summarizeStats(rows) {
      const shown = rows.filter(r => r.text)
      const intent = shown.map(r => decision(r,'intent')).filter(v => ['hit','partial','miss'].includes(v))
      const severity = shown.map(r => decision(r,'severe')).filter(v => typeof v === 'boolean')
      const sent = shown.filter(r => ['exact','different','attachment'].includes(r.outcome))
      return {
        coverage: [shown.length, rows.length],
        intent: [intent.filter(v => v === 'hit').length, intent.length],
        severe: [severity.filter(Boolean).length, severity.length],
        direct: [sent.filter(r => r.outcome === 'exact').length, sent.length],
        partial: intent.filter(v => v === 'partial').length,
        automatic: shown.filter(r => ['intent','severe'].some(k => r[k] == null && r.auto?.[k] != null)).length,
        corrected: shown.filter(r => r.intent != null || r.severe != null).length,
        rewritten: sent.filter(r => r.filled && r.outcome === 'different').length,
      }
    }

    const h = React.createElement
    const metricDefinitions = [
      ['intent', '意图命中率', '完全命中', '已判定'],
      ['severe', '严重误判率', '严重误判', '已判定'],
      ['coverage', '显示覆盖率', '实际展示', '有展示机会'],
      ['direct', '可直接使用率', '原样发送', '展示后已发送'],
    ]
    const intentNames = {hit:'完全命中', partial:'部分命中', miss:'未命中'}
    const outcomeLabels = {
      exact:'原样发送', different:'已另发文字', attachment:'发送含附件', 'no-send':'下一轮没有本人消息',
    }
    function isCorrected(row) { return row.intent != null || row.severe != null }
    function unresolved(row) {
      return !intentNames[decision(row,'intent')] || typeof decision(row,'severe') !== 'boolean'
    }

    function ReviewCard({row, follow, here, onChange}) {
      const [expanded, setExpanded] = React.useState(false)
      const intent = decision(row,'intent'), severe = decision(row,'severe')
      const sent = follow?.text || (row.outcome === 'exact' ? row.text : '')
      const waiting = !row.outcome || row.outcome === 'no-send'
      const unavailable = row.outcome === 'no-send' ? '下一轮没有本人消息' : !row.outcome ? '尚未确认发送'
        : follow?.attachment ? '仅发送了附件' : here ? '实际消息暂未载入' : '在原会话查看实际消息'
      function rationale(field) {
        const reason = row.auto?.[field === 'intent' ? 'whyIntent' : 'whySevere']
        return reasons[reason] || (waiting ? reasons.waiting : '打开原会话后，使用已加载的下一句补算。')
      }
      const sharedReason = rationale('intent') === rationale('severe')
      const pill = (text,tone) => h('span',{className:'sn-pill sn-'+tone},text)
      function correction(field, title, options) {
        const manual = row[field]
        const auto = row.auto?.[field]
        const autoName = field === 'intent' ? intentNames[auto] : typeof auto === 'boolean' ? (auto ? '严重误判' : '无严重误判') : null
        return h('div',{className:'sn-verdict'},
          h('label', null, h('span', null, title),
            h('select', {'aria-label':title,value:manual == null ? '' : String(manual), onChange:e => {
              const v = e.target.value
              onChange(row, field, v === '' ? null : field === 'severe' && v !== 'unknown' ? v === 'true' : v)
            }}, h('option',{value:''},'沿用自动 · '+(autoName || '待判断')),
            ...options.map(([v,name])=>h('option',{key:v,value:v},name)),h('option',{value:'unknown'},'我也无法判断'))),
          sharedReason ? null : h('small',null,'自动依据　'+rationale(field)))
      }
      return h('article',{className:'sn-review', 'data-severity':severe === true ? 'high' : undefined},
        h('div',{className:'sn-rowhead'},
          h('span',{className:'sn-round'},'第 '+row.turn+' 轮'),
          h('time',{dateTime:new Date(row.at).toISOString()},new Date(row.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})),
          !here ? h('small',null,'会话 '+String(row.sessionId).slice(-6)) : null,
          h('span',{className:'sn-source'},isCorrected(row) ? '含人工纠正' : waiting ? outcomeLabels[row.outcome] || '待发送' : row.auto ? '自动初判' : '待补算')),
        h('div',{className:'sn-pair'},
          h('div',null,h('small',null,'当时建议'),h('p',null,row.text)),
          h('div',null,h('small',null,'实际发送'),h('p',{className:sent ? '' : 'sn-muted'},sent || unavailable, sent && follow?.attachment ? '〔含附件〕' : ''))),
        h('div',{className:'sn-rowfoot'},
          pill(intentNames[intent] || '意图待判断',intent === 'hit' ? 'good' : 'neutral'),
          pill(severe === true ? '严重误判' : severe === false ? '无严重误判' : '严重性待判断',severe === true ? 'warn' : 'neutral'),
          h('button',{className:'sn-link',type:'button','aria-expanded':expanded,onClick:()=>setExpanded(!expanded)},expanded ? '收起' : '依据与纠正')),
        expanded ? h('div',{className:'sn-edit'},
          correction('intent','意图',[['hit','完全命中'],['partial','部分命中'],['miss','未命中']]),
          correction('severe','严重性',[['false','无严重误判'],['true','严重误判']]),
          sharedReason ? h('small',{className:'sn-reason'},'自动依据　'+rationale('intent')) : null) : null)
    }

    const sharingStyle = `
      .sn-sharing {
        --share-bg: var(--dsw-specific-input-major, Canvas);
        --share-ink: var(--dsw-alias-label-primary, CanvasText);
        --share-muted: var(--dsw-alias-label-secondary, color-mix(in srgb, var(--share-ink) 74%, var(--share-bg)));
        --share-accent: color-mix(in srgb, var(--dsw-alias-link, light-dark(#265baa, #8bbcff)) 80%, var(--share-ink));
        --share-edge: color-mix(in srgb, var(--share-ink) 16%, var(--share-bg));
        box-sizing: border-box; min-width: 0; container: saynext-share / inline-size;
        color: var(--share-ink); background: var(--share-bg); border: 1px solid var(--share-edge);
        border-radius: 15px; font-family: inherit; text-align: start;
      }
      .sn-share-settings { margin-block: 20px 0 }
      .sn-share-bar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 13px 16px }
      .sn-share-mark { display: grid; place-items: center; align-self: start; margin-top: 1px; width: 32px; height: 32px; border-radius: 10px; color: var(--share-accent); background: color-mix(in srgb, var(--share-accent) 12%, var(--share-bg)) }
      .sn-share-mark svg { width: 18px; height: 18px }
      .sn-share-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 10px }
      .sn-sharing .sn-share-title { margin: 0; font: inherit; font-size: 15px; line-height: 22px; font-weight: 650; color: var(--share-ink) }
      .sn-sharing .sn-share-copy, .sn-sharing .sn-share-status { margin: 3px 0 0; font-size: 13px; line-height: 1.55; color: var(--share-muted); overflow-wrap: anywhere }
      .sn-share-actions { display: flex; flex-wrap: wrap; gap: 7px }
      .sn-sharing .sn-share-action { box-sizing: border-box; min-height: 36px; padding: 6px 12px; border: 1px solid var(--share-edge); border-radius: 9px; background: transparent; color: var(--share-ink); font: inherit; font-size: 13px; line-height: 20px; font-weight: 550; cursor: pointer }
      .sn-sharing .sn-share-yes { color: var(--share-accent); background: color-mix(in srgb, var(--share-accent) 10%, var(--share-bg)); border-color: color-mix(in srgb, var(--share-accent) 36%, var(--share-bg)) }
      .sn-sharing .sn-share-action:hover { background: color-mix(in srgb, currentColor 12%, var(--share-bg)) }
      .sn-sharing .sn-share-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 3px 1px; border: 0; border-radius: 4px; background: transparent; color: var(--share-muted); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer }
      .sn-share-toggle::after { content: ''; width: 5px; height: 5px; border: solid currentColor; border-width: 0 1.3px 1.3px 0; transform: translateY(-1px) rotate(45deg) }
      .sn-share-toggle[aria-expanded=true]::after { transform: translateY(1px) rotate(225deg) }
      .sn-sharing .sn-share-toggle:hover, .sn-sharing .sn-share-import:hover { color: var(--share-accent) }
      .sn-share-details { border-top: 1px solid var(--share-edge); padding: 12px 16px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere }
      .sn-share-details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 14px; margin: 0 }
      .sn-share-details dt { color: var(--share-muted) } .sn-share-details dd { margin: 0 }
      .sn-share-details a { color: var(--share-accent); text-underline-offset: 3px }
      .sn-share-import { display: inline-flex; align-items: center; min-height: 28px; position: relative; margin-top: 8px; color: var(--share-accent); cursor: pointer }
      .sn-share-import input { position: absolute; width: 1px; height: 1px; opacity: 0 }
      .sn-sharing :is(button,a):focus-visible, .sn-share-import:focus-within { outline: 2px solid var(--share-accent); outline-offset: 2px }
      .sn-sharing .sn-share-status { padding: 0 16px 12px; margin: 0 }
      @container saynext-share (max-width: 610px) {
        .sn-share-bar { grid-template-columns: auto minmax(0, 1fr); gap: 8px 10px; padding: 12px }
        .sn-share-actions { grid-column: 2 }
      }
      @container saynext-share (max-width: 380px) {
        .sn-share-actions { grid-column: 1 / -1 }
        .sn-share-action { flex: 1 } .sn-share-details { padding-inline: 12px }
      }
      @container saynext-share (max-width: 315px) {
        .sn-share-mark { display: none }
        .sn-share-bar { grid-template-columns: minmax(0, 1fr) }
      }
      @media (forced-colors: active) { .sn-sharing .sn-share-action { border-color: ButtonText } }
    `

    function sharingRecipient(owner) {
      const contact = / · (github\.com\/[\w.-]+\/[\w.-]+\/issues)$/u.exec(owner)
      if (!contact) return owner
      return h(React.Fragment,null,owner.slice(0,contact.index),' · ',
        h('a',{href:'https://'+contact[1],target:'_blank',rel:'noreferrer'},'联系作者'))
    }

    function SharingControls() {
      const [expanded, setExpanded] = React.useState(false)
      const detailsId = React.useId()
      const [choice, setChoice] = React.useState(undefined)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      React.useEffect(() => {
        if (!feedbackTarget) return
        let alive = true, generation = 0
        const refresh = async () => {
          const current = ++generation
          try {
            const selected = await preference()
            const status = selected?.enabled ? [uploadMessage,await queueStatus()].filter(Boolean).join(' · ') : ''
            if (alive && current === generation) {setChoice(selected);setStatus(status)}
          } catch { if (alive) setError('无法读取本机分享选择') }
        }
        window.addEventListener(sharingChanged,refresh)
        refresh()
        return () => { alive = false; window.removeEventListener(sharingChanged,refresh) }
      }, [])
      if (!feedbackTarget) return h('p',null,'此安装包仅在本机统计，尚未连接作者的反馈服务。')
      if (choice === undefined) return h('p',{role:'status'},error || '正在读取分享设置…')
      const select = async enabled => {
        try {await setSharing(enabled);setError('')}
        catch {setError('选择保存失败，请重试。')}
      }
      const importChoice = async event => {
        const file = event.target.files?.[0]
        if (!file) return
        try {
          if (file.size > 4096) throw Error()
          const old = JSON.parse(await file.text())
          if (!validReceipt(old)) throw Error()
          await setSharing(old.enabled)
          setError('')
        } catch { setError('无法应用这个下载选择，请核对安装包版本或直接在这里选择。') }
        event.target.value = ''
      }
      const enabled = choice?.enabled
      const title = enabled ? '已开启对话片段分享' : '当前仅本机使用'
      const summary = '开启后会自动分享建议原文、你实际发送的下一句话，以及本轮问答节选。'
      return h('section',{className:'sn-sharing sn-share-settings','aria-label':'对话片段分享'},
        h('style',null,sharingStyle),
        h('div',{className:'sn-share-bar'},
          h('span',{className:'sn-share-mark','aria-hidden':true},
            h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round'},
              h('path',{d:'M5 4.5h12A2 2 0 0 1 19 6.5v7a2 2 0 0 1-2 2H9l-5 4v-4.5a2 2 0 0 1-1-1.7V6.5a2 2 0 0 1 2-2Z'}),
              h('path',{d:'M7.5 8.5h7m-7 3.5H12'}))),
          h('div',null,
            h('div',{className:'sn-share-heading'},
              h('h3',{className:'sn-share-title'},title),
              h('button',{type:'button',className:'sn-share-toggle','aria-expanded':expanded,'aria-controls':detailsId,
                onClick:()=>setExpanded(!expanded)},expanded ? '收起详情' : '分享详情')),
            h('p',{className:'sn-share-copy'},enabled ? '新回合的建议、实发文字和问答节选会自动同步给作者。' : summary)),
          h('div',{className:'sn-share-actions'},
            enabled && h('button',{type:'button',className:'sn-share-action',onClick:()=>select(false)},'停止分享'),
            !enabled && h('button',{type:'button',className:'sn-share-action sn-share-yes',onClick:()=>select(true)},'同意并分享'))),
        h('div',{id:detailsId,hidden:!expanded,className:'sn-share-details'},
          h('dl',null,
            h('dt',null,'文字范围'),h('dd',null,'建议原文和下一条实际发送的文字。本轮提问和助手答复各取前 1200 字，附件只记录有无。'),
            h('dt',null,'使用记录'),h('dd',null,'建议展示机会、是否填入或原样发送，以及自动判定和你的纠正。'),
            h('dt',null,'接收方'),h('dd',null,sharingRecipient(feedbackTarget.owner)),
            h('dt',null,'关闭分享'),h('dd',null,'可随时到「建议统计」关闭。关闭后清除本机待传样本，作者会保留已收到的记录。')),
          !enabled && !window.__saynextDesktopChoice && h('label',{className:'sn-share-import'},'导入旧版下载选择',h('input',{type:'file',accept:'.json',onChange:importChoice}))),
        (error || (enabled && status)) ? h('p',{role:'status',className:'sn-share-status'},error || status) : null)
    }

    function StatsPanel({sessionId, useConversation}) {
      const chat = useConversation?.(s => s?.views?.get?.('chat'))
      const [rows, setRows] = React.useState(null)
      const [error, setError] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [limit, setLimit] = React.useState(10)
      const [filter, setFilter] = React.useState('all')
      React.useEffect(() => {
        let active = true, request = 0
        async function refresh() {
          const id = ++request
          try {
            const loaded = await readRounds()
            if (active && id === request) { setRows(loaded); setError('') }
          } catch {
            if (active && id === request) setError('无法读取本机统计，请检查 DSH 的本地存储权限。')
          }
        }
        window.addEventListener(statsChanged, refresh)
        window.addEventListener('focus', refresh)
        const timer = setInterval(refresh, 5000)
        refresh()
        return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener(statsChanged, refresh) }
      }, [])
      React.useEffect(() => {
        reconcile(sessionId, chat).catch(() => setError('无法更新本机发送记录。'))
      }, [sessionId, chat?.order, chat?.timeline])
      const scoped = (rows ?? []).filter(r => scope === 'all' || r.sessionId === sessionId)
      const metrics = summarizeStats(scoped)
      const shown = scoped.filter(r => r.text).sort((a,b)=>b.at-a.at || b.turn-a.turn)
      const filters = [
        ['all','全部',shown], ['severe','严重误判',shown.filter(r=>decision(r,'severe') === true)],
        ['uncertain','待判断',shown.filter(unresolved)], ['manual','已纠正',shown.filter(isCorrected)],
      ]
      const reviews = filters.find(([key])=>key === filter)[2]
      const change = (row, field, value) => updateRound(row.sessionId, row.turn, field, value)
        .catch(() => setError('纠正未保存，请重试。'))
      const switchScope = value => { setScope(value); setLimit(10); setFilter('all') }
      return h('section', {className:'saynext-stats', 'aria-label':'建议统计'},
        h('style',null,statsStyle), h('div',{className:'sn-page'},
          h('header',{className:'sn-head'},
            h('div',null,h('h2',null,'建议统计'),h('p',null,'发出下一句后在本机自动对照，待判断的记录不计入命中率和误判率。')),
            h('div',{className:'sn-switch',role:'group','aria-label':'统计范围'},
              ...[['all','本机全部'],['session','当前会话']].map(([key,label])=>
                h('button',{key,type:'button','aria-pressed':scope === key,onClick:()=>switchScope(key)},label)))),
          error ? h('p',{role:'alert'},error) : null,
          h(SharingControls,{}),
          captureError ? h('p',{role:'status'},'本次运行有统计读写失败，部分回合可能缺失。') : null,
          rows === null ? h('p',null,error ? '统计暂不可用。' : '正在读取本地记录…') : h(React.Fragment,null,
            h('div',{className:'saynext-metrics'},...metricDefinitions.map(([key,title,nLabel,dLabel])=>{
              const [n,d] = metrics[key]
              const fraction = d ? 100*n/d : null
              return h('div',{key,className:'sn-metric sn-m-'+key},
                h('h3',null,title),
                h('strong', null,fraction == null ? '—' : fraction.toLocaleString('zh-CN',{maximumFractionDigits:1}),
                  fraction == null ? null : h('span',null,'%')),
                h('div',{className:'sn-track','aria-hidden':'true'}, h('i',{style:{width:(fraction ?? 0)+'%'}})),
                h('small',null,n+' '+nLabel+' / '+d+' '+dLabel))
            })),
            h('div',{className:'sn-counts'},
              h('span',null,'部分命中 ',h('b',null,metrics.partial),' 条'),
              h('span',null,'填入后改写 ',h('b',null,metrics.rewritten),' 条'),
              h('span',null,'意图待判断 ',h('b',null,metrics.coverage[0]-metrics.intent[1]),' 条'),
              h('span',null,'严重性待判断 ',h('b',null,metrics.coverage[0]-metrics.severe[1]),' 条')),
            h('div',{className:'sn-listhead'},h('h3',null,'建议对照'),
              h('p',null,`采用自动判断 ${metrics.automatic} 条 · 含人工纠正 ${metrics.corrected} 条`)),
            h('div',{className:'sn-filters',role:'group','aria-label':'筛选建议'},
              ...filters.map(([key,title,items])=>h('button',{key,type:'button','aria-pressed':filter === key,
                onClick:()=>{setFilter(key);setLimit(10)}},title,h('span',null,items.length)))),
            reviews.length ? reviews.slice(0,limit).map(row=>h(ReviewCard,{
              key:JSON.stringify([row.sessionId,row.turn]),row,here:row.sessionId === sessionId,
              follow:row.sessionId === sessionId ? followingMessage(chat,row.turn) : undefined,onChange:change,
            })) : h('div',{className:'sn-empty'},h('strong',null,shown.length ? '这项筛选下还没有建议' : '还没有展示过的建议'),
              h('p',null,shown.length ? '切换到「全部」可以查看其他记录。' : '灰字出现后会记在这里。你发出下一句时，插件会自动对照。')),
            reviews.length > limit ? h('button',{type:'button',className:'sn-more',onClick:()=>setLimit(n=>n+10)},'查看更早的建议') : null)))
    }

    const statsStyle = `
      .saynext-stats{--surface:var(--dsw-alias-bg-base,Canvas);--ink:var(--dsw-alias-label-primary,CanvasText);--muted:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--ink) 68%,var(--surface)));--edge:color-mix(in srgb,var(--ink) 17%,transparent);--tint:color-mix(in srgb,var(--ink) 4%,transparent);--accent:var(--dsw-alias-link,light-dark(#2956a9,#9abaff));--warning:var(--dsw-alias-state-warn-label,light-dark(#88420f,#f4b178));color:var(--ink);width:100%;height:100%;min-height:0;overflow:auto;container-type:inline-size;box-sizing:border-box;font:inherit}
      .saynext-stats *{box-sizing:border-box}.sn-page{max-width:1080px;margin:0 auto;padding:clamp(20px,4cqw,48px);line-height:1.52}
      .sn-head,.sn-listhead,.sn-rowhead,.sn-rowfoot,.sn-counts,.sn-filters{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px}
      .sn-head,.sn-listhead{justify-content:space-between}.sn-head h2{font-size:clamp(23px,3.6cqw,32px);letter-spacing:-.04em;line-height:1.2;margin:0;font-weight:680}
      .sn-head p,.sn-listhead p,.sn-empty p{color:var(--muted);font-size:13px;margin:6px 0 0}
      .saynext-stats button,.saynext-stats select{font:inherit;cursor:pointer;color:inherit}.saynext-stats button{border:0;background:transparent}
      .saynext-stats :is(button,select):focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      .sn-switch{padding:3px;border:1px solid var(--edge);border-radius:9px;display:flex;gap:2px;background:var(--tint)}
      .sn-switch button,.sn-filters button{padding:6px 12px;border-radius:6px;font-size:13px;white-space:nowrap}
      .sn-switch [aria-pressed=true]{background:var(--ink);color:var(--dsw-alias-label-primary-inverted,Canvas)}
      .saynext-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:26px;overflow:hidden;border:1px solid var(--edge);border-radius:14px;background:color-mix(in srgb,var(--surface) 86%,transparent)}
      .sn-metric{min-width:0;padding:18px clamp(12px,2cqw,24px);--meter:var(--muted)}.sn-metric+.sn-metric{border-left:1px solid var(--edge)}
      .sn-m-intent{--meter:var(--accent);background:color-mix(in srgb,var(--accent) 5%,transparent)}.sn-m-severe{--meter:var(--warning)}
      .sn-metric h3{font-size:14px;font-weight:600;margin:0}.sn-metric strong{display:block;font-family:inherit;font-size:clamp(26px,3.9cqw,40px);font-weight:620;line-height:1.25;letter-spacing:-.045em;font-variant-numeric:tabular-nums;margin:8px 0 12px}
      .sn-metric strong span{font-size:.48em;margin-left:3px}.sn-metric small,.sn-review small,.sn-review time{font-size:12px;color:var(--muted)}
      .sn-track{height:3px;background:var(--edge);margin-bottom:7px;border-radius:2px}.sn-track i{height:100%;background:var(--meter);display:block;border-radius:inherit}
      .sn-counts{font-size:12px;color:var(--muted);margin:10px 2px 28px}.sn-counts b{color:var(--ink);font-variant-numeric:tabular-nums}
      .sn-listhead h3{font-size:19px;margin:0;letter-spacing:-.02em}.sn-listhead p{margin:0}
      .sn-filters{gap:4px;margin:12px 0}.sn-filters button{color:var(--muted)}.sn-filters button[aria-pressed=true]{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
      .sn-filters button span{font-variant-numeric:tabular-nums;margin-left:6px}.sn-filters button:hover,.sn-link:hover,.sn-more:hover{background:var(--tint)}
      .sn-review{border:1px solid var(--edge);border-radius:12px;margin:10px 0;overflow:hidden;background:color-mix(in srgb,var(--surface) 90%,transparent)}
      .sn-review[data-severity=high]{border-inline-start:3px solid var(--warning)}
      .sn-rowhead,.sn-rowfoot{padding:11px 16px;gap:7px 10px}.sn-round{font-size:13px;font-weight:650}.sn-source{font-size:12px;color:var(--muted);margin-left:auto}
      .sn-pair,.sn-edit{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:0 16px}.sn-pair>div,.sn-verdict{min-width:0}
      .sn-pair small{font-weight:550}.sn-pair p{font-size:15px;line-height:1.6;margin:3px 0 7px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:13em;overflow:auto}
      .sn-muted{color:var(--muted)}.sn-rowfoot{border-top:1px solid var(--edge);margin-top:4px}
      .sn-pill{font-size:12px;line-height:1.5;border-radius:4px;padding:2px 7px;background:var(--tint);color:var(--muted)}.sn-good{color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}.sn-warn{color:color-mix(in srgb,var(--warning) 65%,var(--ink));background:color-mix(in srgb,var(--warning) 12%,transparent)}
      .sn-link,.sn-more{font-size:13px!important;color:var(--accent)!important;border-radius:5px;padding:4px 7px}.sn-link{margin-left:auto}
      .sn-edit{padding:14px 16px;background:var(--tint);border-top:1px solid var(--edge)}.sn-verdict label{display:flex;align-items:center;flex-wrap:wrap;gap:7px;font-size:13px;font-weight:600}.sn-verdict small{display:block;margin-top:6px}
      .sn-reason{grid-column:1/-1}.sn-verdict select{min-height:30px;max-width:100%;border-radius:5px;border:1px solid var(--edge);background:Canvas;color:CanvasText;padding:2px 6px}
      .sn-empty{padding:28px 20px;border:1px dashed var(--edge);border-radius:12px;text-align:center}.sn-empty strong{font-size:15px}
      @container (max-width:720px){.saynext-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sn-metric:nth-child(3){border-left:0}.sn-metric:nth-child(n+3){border-top:1px solid var(--edge)}}
      @container (max-width:540px){.sn-page{padding:16px}.sn-head{align-items:flex-start}.sn-pair,.sn-edit{grid-template-columns:1fr;gap:8px}.sn-counts{margin-bottom:20px}.sn-filters button{padding:5px 8px}.sn-rowhead,.sn-rowfoot{padding:10px 12px}.sn-pair{padding:0 12px}.sn-metric{padding:12px}}
    `


    /**
     * @param {any} props 槽位标准属性：useInput / inputActions / sessionId / useSession
     */
    function NextLine(props) {
      const { useInput, inputActions, sessionId, useSession, useConversation, readHint } = props
      const draft = typeof useInput === 'function' ? useInput((state) => state?.draft) : ''
      const running = typeof useSession === 'function' ? useSession((snapshot) => snapshot?.running === true) : false
      // 宿主给的会话视图：timeline 里带着每一轮的状态，事件驱动、不是轮询。
      // Hook 必须无条件调用：这里只在「入口本身不存在」时跳过，入口一旦存在就每次都调。
      const chat = useConversation === undefined
        ? undefined
        : useConversation((snapshot) => snapshot?.views?.get?.('chat'))
      const timeline = chat?.timeline
      const state = turnState(timeline)
      const [payload, setPayload] = React.useState({ raw: '', items: [], enabled: undefined })
      const [target, setTarget] = React.useState(null)
      const hostRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        let reading = false
        let timer
        const tick = async () => {
          if (!alive || reading) return
          reading = true
          try {
            const remote = readHint?.()
            if (remote !== undefined) {
              const doc = unwrap(await remote.describe())
              if (alive && doc !== undefined) {
                const row = doc.namespaces.find((entry) => entry?.ns === NAMESPACE)
                const hint = row?.value?.[CHANNEL]
                const raw = typeof hint === 'string' ? hint : ''
                const enabled = row ? row.value?.enabled !== false : undefined
                setPayload(prev => prev.raw === raw && prev.enabled === enabled ? prev : {raw, items: readItems(raw), enabled})
              }
            }
          } catch {
            // 读不到就保持上一条，不闪
          }
          reading = false
          if (alive) {
            // 后台标签页没必要一秒一问；切回来时立刻补一次
            const interval = document.visibilityState === 'hidden' ? POLL_MS * 5 : POLL_MS
            timer = setTimeout(tick, interval)
          }
        }
        const onVisible = () => {
          if (document.visibilityState === 'hidden') return
          if (timer !== undefined) clearTimeout(timer)
          void tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        void tick()
        return () => {
          alive = false
          document.removeEventListener('visibilitychange', onVisible)
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [])

      const mine = payload.items.find((entry) => entry?.sessionId === sessionId)
      const text = typeof mine?.text === 'string' ? mine.text : ''
      // 填不进去就别画：画了却按 Enter 没反应，比不画更糟。
      const canFill = typeof inputActions?.setDraft === 'function'
      // 只认「属于最新一轮、且那一轮正常结束」的建议；新一轮一开始就立刻失效。
      // 有 useConversation 就严格判定；宿主没给这个入口时直接不显示（fail closed），不退回旧判断。
      // 拿不到会话时间线就宁可不显示（fail closed）：显示一条无法验证是否过期的建议，
      // 比什么都不显示更糟——它会被 Enter 原样填进输入框。
      const fresh = useConversation === undefined ? false : matchesLatest(mine, state)
      const show = payload.enabled === true && canFill && fresh && ghostVisible(text, draft, running)
      const turn = state?.turn
      const eligible = payload.enabled === true && state?.completed && canFill && typeof ReactDOM?.createPortal === 'function' &&
        !running && (typeof draft !== 'string' || draft.trim() === '')
      const ghostRef = React.useRef(null)
      const observed = React.useRef(null)
      if (!observed.current || observed.current.sessionId !== sessionId || observed.current.turn !== turn) {
        observed.current = {sessionId, turn, seen: new Set()}
      }
      const observation = observed.current
      function record(change) {
        const {seen} = observation
        if (!sessionId || !Number.isSafeInteger(turn) || seen.has(change)) return
        seen.add(change)
        updateRound(sessionId, turn, change, text, timeline?.turns?.get(turn)?.start?.time).catch(() => {
          seen.delete(change)
          if (!captureError) { captureError = true; notifyStats() }
        })
      }
      React.useEffect(() => {
        if (!eligible || !window.requestAnimationFrame) return
        let frame
        function sample() {
          const target = findGhostTarget(hostRef.current)
          if (visible(target) && target.closest('[data-composer-card]')?.querySelector('[contenteditable="true"]')) {
            record('opportunity')
            if (show && visible(ghostRef.current)) record('shown')
          }
        }
        function schedule() {
          window.cancelAnimationFrame(frame)
          frame = window.requestAnimationFrame(sample)
        }
        schedule()
        document.addEventListener('visibilitychange', schedule)
        window.addEventListener('scroll', schedule, true)
        window.addEventListener('resize', schedule)
        // 输入卡片可能在同一次布局后才变为可见，也可能在侧栏切换时重新挂载。
        const timer = setInterval(sample, POLL_MS)
        return () => {
          window.cancelAnimationFrame(frame)
          clearInterval(timer)
          document.removeEventListener('visibilitychange', schedule)
          window.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
        }
      }, [eligible, sessionId, turn, show, target, text])
      React.useEffect(() => {
        reconcile(sessionId, chat).catch(() => {
          if (!captureError) { captureError = true; notifyStats() }
        })
      }, [sessionId, chat?.order, turn, state?.completed])
      const freshRef = React.useRef(fresh)
      freshRef.current = fresh

      /**
       * 承载层会被宿主重建（hero ↔ 靠底、切换会话都可能换掉那一层），
       * 所以不能「找到一次就收工」：每秒复查一次，掉出文档就重新找。
       */
      const targetRef = React.useRef(null)
      React.useEffect(() => {
        if (!show) return undefined
        ensureStyle()
        let alive = true
        const look = () => {
          if (!alive) return
          const found = findGhostTarget(hostRef.current)
          if (found === null) return
          // 卡片标记就地打上：不等下一次渲染，避免先露一帧两行叠字。
          markCard(found, true)
          targetRef.current = found
          setTarget(found)
        }
        look()
        const timer = setInterval(() => {
          if (!alive) return
          if (targetRef.current !== null && stillConnected(targetRef.current)) return
          markCard(targetRef.current, false)
          look()
        }, POLL_MS)
        return () => { alive = false; clearInterval(timer); markCard(targetRef.current, false) }
      }, [show])

      React.useEffect(() => {
        if (show) return
        markCard(targetRef.current, false)
        targetRef.current = null
        setTarget(null)
      }, [show])

      React.useEffect(() => {
        if (!show) return undefined
        // 先确认真的能把话填进去，再决定要不要吃掉这个 Enter；
        // 否则槽位没给 setDraft 时，用户的 Enter 会被吞掉却什么都不发生。
        const setDraft = typeof inputActions?.setDraft === 'function' ? inputActions.setDraft : null
        if (setDraft === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Enter') return
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.isComposing) return
          if (!focusInComposer(hostRef.current, document.activeElement)) return
          if (freshRef.current !== true) return
          const displayed = visible(ghostRef.current)
          setDraft(text)
          if (displayed) record('filled')
          event.preventDefault()
          event.stopPropagation()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [show, text, sessionId, turn])

      const anchor = React.createElement('div', {
        ref: hostRef,
        style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' },
        'aria-hidden': 'true',
        'data-saynext': 'anchor',
        'data-saynext-session': sessionId,
        'data-saynext-turn': state?.turn == null ? undefined : String(state.turn),
        'data-saynext-opportunity': eligible ? 'eligible' : undefined,
      })

      if (!show || target === null || typeof ReactDOM?.createPortal !== 'function') return anchor
      const ghost = React.createElement('div', { ref: ghostRef, style: GHOST, 'aria-hidden': 'true', 'data-saynext': 'ghost', 'data-saynext-session': sessionId, 'data-saynext-turn': String(state.turn) }, text)
      return React.createElement(React.Fragment, null, anchor, ReactDOM.createPortal(ghost, target))
    }

    const inject = ['slots', 'remote', 'remote.settings']

    function apply(ctx) {
      if (feedbackTarget && typeof ctx.effect === 'function') ctx.effect(() => {
        if (typeof BroadcastChannel === 'function') {
          feedbackChannel = new BroadcastChannel(sharingChanged)
          feedbackChannel.onmessage = () => { activeUpload?.abort(); announce() }
        }
        const tick = () => { void flushSamples() }
        const timer = setInterval(tick,30000)
        window.addEventListener('online',tick)
        startupChoice = restoreDownloadChoice()
        void startupChoice.then(tick)
        return () => {
          clearInterval(timer);window.removeEventListener('online',tick)
          activeUpload?.abort();feedbackChannel?.close();feedbackChannel = undefined
        }
      })
      const remote = ctx.get('remote')
      const readHint = () => remote?.settings
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'saynext-stats', order: 65, label: '建议统计',
      }, props => h(StatsPanel, props)))
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'saynext-line',
        order: 100,
        label: 'SayNext',
      }, (props) => React.createElement(NextLine, { ...props, readHint })))
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供本地测试注入；宿主不会设置这个开关，正式运行时连属性都不存在。
    if (typeof window !== 'undefined' && window.__SAYNEXT_TEST__ === true) {
      exports.__test = { ghostVisible, findGhostTarget, GHOST, ensureStyle, unwrap, turnState, matchesLatest, summarizeStats, followingMessage, judgePair, decision, preference, setSharing, restoreDownloadChoice, updateRound, flushSamples, nextSample, reconcile }
    }
    return module.exports
  },
})

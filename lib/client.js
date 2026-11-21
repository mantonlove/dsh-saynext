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

    /** 从一份 settings 文档里取出本插件的提示载荷。 */
    function readPayload(doc) {
      const rows = Array.isArray(doc?.namespaces) ? doc.namespaces : []
      const row = rows.find((entry) => entry?.ns === NAMESPACE)
      const raw = row?.value?.[CHANNEL]
      if (typeof raw !== 'string' || raw === '') return { rev: 0, items: [] }
      try {
        const parsed = JSON.parse(raw)
        return {
          rev: typeof parsed?.rev === 'number' ? parsed.rev : 0,
          items: Array.isArray(parsed?.items) ? parsed.items : [],
        }
      } catch {
        return { rev: 0, items: [] }
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

    /**
     * @param {any} props 槽位标准属性：useInput / inputActions / sessionId / useSession
     */
    function NextLine(props) {
      const { useInput, inputActions, sessionId, useSession, useConversation, readHint } = props
      const draft = typeof useInput === 'function' ? useInput((state) => state?.draft) : ''
      const running = typeof useSession === 'function' ? useSession((snapshot) => snapshot?.running === true) : false
      // 宿主给的会话视图：timeline 里带着每一轮的状态，事件驱动、不是轮询。
      // Hook 必须无条件调用：这里只在「入口本身不存在」时跳过，入口一旦存在就每次都调。
      const timeline = useConversation === undefined
        ? undefined
        : useConversation((snapshot) => snapshot?.views?.get?.('chat')?.timeline)
      const state = turnState(timeline)
      const [payload, setPayload] = React.useState({ rev: 0, items: [] })
      const [target, setTarget] = React.useState(null)
      const hostRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const remote = readHint?.()
            if (remote !== undefined) {
              const doc = unwrap(await remote.describe())
              if (alive) {
                const next = readPayload(doc)
                setPayload((prev) => (next.rev === prev.rev ? prev : next))
              }
            }
          } catch {
            // 读不到就保持上一条，不闪
          }
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
      const show = canFill && fresh && ghostVisible(text, draft, running)
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
          setDraft(text)
          event.preventDefault()
          event.stopPropagation()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [show, text])

      const anchor = React.createElement('div', {
        ref: hostRef,
        style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' },
        'aria-hidden': 'true',
        'data-saynext': 'anchor',
      })

      if (!show || target === null || typeof ReactDOM?.createPortal !== 'function') return anchor
      const ghost = React.createElement('div', { style: GHOST, 'aria-hidden': 'true', 'data-saynext': 'ghost' }, text)
      return React.createElement(React.Fragment, null, anchor, ReactDOM.createPortal(ghost, target))
    }

    const inject = ['slots', 'remote', 'remote.settings']

    function apply(ctx) {
      const remote = ctx.get('remote')
      const readHint = () => remote?.settings
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
      exports.__test = { ghostVisible, findGhostTarget, GHOST, ensureStyle, unwrap, turnState, matchesLatest }
    }
    return module.exports
  },
})

/**
 * dsh-saynext · 界面侧
 *
 * 输入框上方的一条灰字：宿主把"你下一句可能说什么"写进插件配置的 hint 格，
 * 这里每秒读一次那一格；输入框是空的时候把它显示出来，按 Enter 只做一件事——
 * 把这句话搬进输入框（不发送），再按一次 Enter 才走正常发送。
 */
window.__ModuleLoader__.load({
  id: 'dsh-saynext',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    const NAMESPACE = 'saynext'
    const CHANNEL = 'hint'
    const POLL_MS = 1000

    /** settings.describe() 的返回可能被 RPC 信封裹过一层，逐层剥到 namespaces。 */
    function unwrap(response) {
      let node = response
      for (let depth = 0; depth < 4; depth += 1) {
        if (typeof node !== 'object' || node === null) return undefined
        if (Array.isArray(node.namespaces)) return node
        if (node.ok === true) { node = node.value; continue }
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

    const PILL = {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
      marginBottom: 6,
      display: 'flex',
      justifyContent: 'flex-end',
      pointerEvents: 'none',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
    }

    const BODY = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 8,
      maxWidth: '78%',
      padding: '3px 10px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
      color: 'var(--dsw-alias-label-caption, #9aa0a6)',
      opacity: 0.75,
    }

    const TEXT = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const HINT = {
      flex: 'none',
      fontSize: 11,
      opacity: 0.85,
    }

    /**
     * 只有当焦点真的在这条会话的输入框里时，才允许接管 Enter。
     * 判据：焦点元素必须是可编辑区，且它和胶囊之间存在 body 以下的共同祖先
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

    /**
     * @param {any} props 槽位标准属性：useInput / inputActions / sessionId
     */
    function NextLine(props) {
      const { useInput, inputActions, sessionId, useSession } = props
      const draft = typeof useInput === 'function' ? useInput((state) => state?.draft) : ''
      const running = typeof useSession === 'function' ? useSession((snapshot) => snapshot?.running === true) : false
      const [payload, setPayload] = React.useState({ rev: 0, items: [] })
      const hostRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const remote = props.readHint?.()
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
          if (alive) timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [])

      const mine = payload.items.find((entry) => entry?.sessionId === sessionId)
      const text = typeof mine?.text === 'string' ? mine.text : ''
      const blank = typeof draft === 'string' ? draft.trim() === '' : true
      const show = text !== '' && blank && !running

      React.useEffect(() => {
        if (!show) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Enter') return
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.isComposing) return
          if (!focusInComposer(hostRef.current, document.activeElement)) return
          event.preventDefault()
          event.stopPropagation()
          inputActions?.setDraft?.(text)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [show, text])

      if (!show) return null
      return React.createElement(
        'div',
        { ref: hostRef, style: PILL, 'aria-hidden': 'false' },
        React.createElement(
          'div',
          { style: BODY },
          React.createElement('span', { style: TEXT, title: text }, text),
          React.createElement('span', { style: HINT }, '⏎'),
        ),
      )
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
    return module.exports
  },
})

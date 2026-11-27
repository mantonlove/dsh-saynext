/**
 * 极小 React 运行时 + 假 DOM：把插件注册出来的槽位组件真的渲染一遍，
 * 断言灰字挂在编辑区那一层、样式与占位符一致、Enter 只填草稿不发送。
 */
const vm = require('node:vm')
const fs = require('node:fs')

const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8')

function node(tag) {
  const attrs = new Map()
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    isContentEditable: false,
    parentElement: null,
    children: [],
    style: {},
    listeners: [],
    textContent: '',
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    appendChild(child) { this.children.push(child); child.parentElement = this; return child },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false },
    closest(sel) { const key = sel.replace(/[[\]]/g, ''); for (let n = this; n; n = n.parentElement) if (n.hasAttribute(key)) return n; return null },
    addEventListener(type, fn) { this.listeners.push({ type, fn }) },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)) },
    querySelector(sel) {
      const key = sel.replace(/[[\]]/g, '')
      const walk = (n) => { for (const c of n.children ?? []) { if (c.hasAttribute(key)) return c; const hit = walk(c); if (hit) return hit } return null }
      return walk(this)
    },
    dispatch(type, event) { for (const l of [...this.listeners]) if (l.type === type) l.fn(event) },
  }
  return el
}

let onVisibilityChange
const document = {
  head: node('head'),
  body: node('body'),
  documentElement: node('html'),
  activeElement: null,
  visibilityState: 'visible',
  getElementById: (id) => {
    const walk = (n) => { if (n.getAttribute('id') === id) return n; for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit } return null }
    return walk(document.head)
  },
  createElement: (tag) => node(tag),
  addEventListener(type, listener) { if (type === 'visibilitychange') onVisibilityChange = listener },
  removeEventListener(type, listener) { if (onVisibilityChange === listener) onVisibilityChange = undefined },
}

// 宿主输入卡片：card > grow > (editor, placeholder, overlay 锚点)
const card = node('div'); card.setAttribute('data-composer-card', '')
const grow = node('div'); card.appendChild(grow)
const editor = node('div'); editor.isContentEditable = true; grow.appendChild(editor)
const placeholder = node('div'); placeholder.setAttribute('data-composer-placeholder', ''); grow.appendChild(placeholder)

// ---- 极小 React ----
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const i = hookIndex++
    hooks[i] ??= { value: typeof init === 'function' ? init() : init }
    return [hooks[i].value, (next) => {
      const value = typeof next === 'function' ? next(hooks[i].value) : next
      if (value === hooks[i].value) return
      hooks[i].value = value
      rerender()
    }]
  },
  useEffect: (fn) => { queue.push({ i: hookIndex++, fn }) },
  useRef: (init) => {
    const i = hookIndex++
    hooks[i] ??= { value: { current: init } }
    return hooks[i].value
  },
}
const ReactDOM = { createPortal: (child, target) => ({ portal: child, target }) }

let hooks = []
let queue = []
let hookIndex = 0
let SlotComponent = null
let slotProps = null
let container = node('div')
const mountPoint = node('div')
mountPoint.setAttribute('data-saynext-mount', '')
card.appendChild(mountPoint)
let rerenderScheduled = false

function mount(tree, parent) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return
  if (Array.isArray(tree)) { for (const t of tree) mount(t, parent); return }
  if (tree.portal !== undefined) { mount(tree.portal, tree.target); return }
  if (typeof tree.type === 'function') { mount(tree.type(tree.props), parent); return }
  if (tree.type === React.Fragment) { mount(tree.children, parent); return }
  const el = node(tree.type)
  for (const [k, v] of Object.entries(tree.props)) {
    if (k === 'ref') { if (v && typeof v === 'object') v.current = el; continue }
    if (k === 'style') Object.assign(el.style, v)
    else if (typeof v === 'string') el.setAttribute(k, v)
  }
  for (const child of tree.children) {
    if (typeof child === 'string' || typeof child === 'number') {
      el.textContent += String(child)
      const textNode = node('#text')
      textNode.textContent = String(child)
      el.appendChild(textNode)
    } else mount(child, el)
  }
  parent.appendChild(el)
}

function commit() {
  for (const { i, fn } of queue) {
    if (hooks[i]?.cleanup) hooks[i].cleanup()
    const cleanup = fn()
    hooks[i] = { ...(hooks[i] ?? {}), cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
  queue = []
}

function clear(nodeEl) {
  for (const child of [...nodeEl.children]) child.parentElement = null
  nodeEl.children = []
}

function rerender() {
  hookIndex = 0
  clear(mountPoint)
  const tree = React.createElement(SlotComponent, slotProps)
  mount(tree, mountPoint)
  commit()
}

function renderOnce() {
  hookIndex = 0
  queue = []
  clear(mountPoint)
  const tree = React.createElement(SlotComponent, slotProps)
  mount(tree, mountPoint)
  commit()
}

// ---- 加载插件 ----
const windowListeners = []
const windowStub = {
  addEventListener: (type, fn) => windowListeners.push({ type, fn }),
  removeEventListener: (type, fn) => { const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) windowListeners.splice(i, 1) },
  __ModuleLoader__: { load: ({ factory }) => { capturedExports = factory((n) => (n === 'react' ? React : n === 'react-dom' ? ReactDOM : undefined)) } },
}
let capturedExports = null
vm.runInNewContext(code, { window: windowStub, document, setTimeout: (f) => setTimeout(f, 0), clearTimeout, setInterval: (f) => setInterval(f, 100000), clearInterval, console }, { filename: 'client.js' })

const payload = { rev: 1, items: [{ sessionId: 's1', text: '把 index.js 的报错再跑一遍', turn: 3 }] }
const settings = { describe: async () => ({ namespaces: [{ ns: 'saynext', value: { hint: JSON.stringify(payload) } }] }) }

let draft = ''
let running = false
const timelineOf = (turn, status, kind) => ({
  turnOrder: [1, turn],
  turns: new Map([[turn, { status, end: { data: { reason: { kind } } } }]]),
})
let timeline = timelineOf(3, 'closed', 'completed')
const filled = []
const ctx = {
  get: () => ({ settings }),
  slots: {
    inject: (n, cb) => cb(),
    register: (meta, Comp) => { capturedMeta = meta; SlotComponent = Comp; return () => {} },
  },
}
let capturedMeta = null
capturedExports.apply(ctx)

let ok = 0, bad = 0
const check = (id, cond, detail) => { if (cond) { ok += 1; console.log(`${id} PASS${detail ? ' ' + detail : ''}`) } else { bad += 1; console.log(`${id} FAIL ${detail ?? ''}`) } }

const findGhost = (n, out = []) => {
  if (!n) return out
  if (n.getAttribute && n.getAttribute('data-saynext') === 'ghost') out.push(n)
  for (const c of n.children ?? []) findGhost(c, out)
  return out
}

function mountSlot({ d = '', r = false, noConv = false, tl = undefined }) {
  if (tl !== undefined) timeline = tl
  draft = d; running = r
  slotProps = {
    useInput: (sel) => sel({ draft }),
    useSession: (sel) => sel({ running }),
    inputActions: { setDraft: (text) => filled.push(text) },
    sessionId: 's1',
  }
  if (!noConv) {
    slotProps.useConversation = (sel) => sel({ views: { get: (key) => (key === 'chat' ? { timeline } : undefined) } })
  }
  // 上一次挂载的 portal 内容由 React 卸载时移除，这里手动清掉
  grow.children = grow.children.filter((c) => {
    if (c.getAttribute && c.getAttribute('data-saynext') === 'ghost') { c.parentElement = null; return false }
    return true
  })
  // 上一次挂载的清理（等价于 React 卸载时跑 effect cleanup）
  for (const h of hooks) if (typeof h?.cleanup === 'function') h.cleanup()
  hooks = []
  renderOnce()
}

async function main() {
  mountSlot({})
  await new Promise((r) => setTimeout(r, 40))

  check('H0', capturedMeta?.name === 'conversation.input.overlay' && capturedMeta?.id === 'saynext-line', JSON.stringify(capturedMeta))
  const ghosts = findGhost(card)
  check('H1', ghosts.length === 1, `ghost=${ghosts.length}`)
  check('H2', ghosts[0]?.parentElement === grow, `父节点=${ghosts[0]?.parentElement?.tagName}`)
  check('H3', ghosts[0]?.style.inset === '4px 8px auto 14px', `inset=${ghosts[0]?.style.inset}`)
  check('H4', ghosts[0]?.style.pointerEvents === 'none' && ghosts[0]?.style.opacity === 0.5)
  check('H5', card.hasAttribute('data-saynext-ghost'), '卡片打上隐藏宿主占位符的标记')
  check('H6', (ghosts[0]?.textContent ?? '') === payload.items[0].text, `text=${ghosts[0]?.textContent}`)

  const anchor = mountPoint.querySelector('[data-saynext]')
  check('H6a', anchor?.getAttribute('data-saynext-opportunity') === 'eligible' &&
    anchor.getAttribute('data-saynext-session') === 's1' && anchor.getAttribute('data-saynext-turn') === '3' &&
    ghosts[0]?.getAttribute('data-saynext-turn') === '3', '观察实际渲染的机会与灰字属于同一会话、同一轮')

  // Enter：焦点在编辑区 → 只填草稿，并吞掉这次回车
  document.activeElement = editor
  const event = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  for (const l of [...windowListeners]) if (l.type === 'keydown') l.fn(event)
  check('H7', filled.length === 1 && filled[0] === payload.items[0].text, `setDraft=${JSON.stringify(filled)}`)
  check('H8', event.prevented === true && event.stopped === true, '回车被拦下')

  // 焦点在别处（不是可编辑区）→ 不拦
  const outside = node('input'); outside.isContentEditable = false
  document.activeElement = outside
  const event2 = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
  for (const l of [...windowListeners]) if (l.type === 'keydown') l.fn(event2)
  check('H9', filled.length === 1 && event2.prevented === false, '别处的回车放行')

  // 草稿非空 → 不画灰字、不挂标记
  mountSlot({ d: '已经有字了' })
  await new Promise((r) => setTimeout(r, 40))
  check('H10', findGhost(card).length === 0 && !card.hasAttribute('data-saynext-ghost'), '草稿非空时不显示')

  // 会话运行中 → 不画
  mountSlot({ r: true })
  await new Promise((r) => setTimeout(r, 40))
  check('H11', findGhost(card).length === 0, '运行中不显示')

  // H12：新一轮开始（最新一轮还没结束）→ 旧建议立刻失效
timeline = timelineOf(4, 'open', 'completed')
mountSlot({})
await new Promise((r) => setTimeout(r, 40))
check('H12', findGhost(card).length === 0 && !card.hasAttribute('data-saynext-ghost'), `新一轮开始后 ghost=${findGhost(card).length}`)

// H13：最新一轮结束了，但是失败收场 → 同样不显示
timeline = timelineOf(3, 'closed', 'error')
mountSlot({})
await new Promise((r) => setTimeout(r, 40))
check('H13', findGhost(card).length === 0, `失败收尾 ghost=${findGhost(card).length}`)

// H14：最新一轮正常结束 → 恢复显示
timeline = timelineOf(3, 'closed', 'completed')
mountSlot({})
await new Promise((r) => setTimeout(r, 40))
check('H14', findGhost(card).length === 1, `正常收尾 ghost=${findGhost(card).length}`)

// H15：宿主没给 useConversation → 宁可不显示（fail closed）
mountSlot({ noConv: true })
await new Promise((r) => setTimeout(r, 40))
check('H15', findGhost(card).length === 0 && !card.hasAttribute('data-saynext-ghost'), `缺入口 ghost=${findGhost(card).length}`)

// H16：未知状态（unknown）也不算正常结束
mountSlot({ tl: timelineOf(3, 'unknown', 'completed') })
await new Promise((r) => setTimeout(r, 40))
check('H16', findGhost(card).length === 0, `unknown ghost=${findGhost(card).length}`)

// H17：轮次失效后按 Enter 不能把旧句子填进去
timeline = timelineOf(4, 'open', 'completed')
mountSlot({})
await new Promise((r) => setTimeout(r, 40))
const before17 = filled.length
const ev17 = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
for (const l of [...windowListeners]) if (l.type === 'keydown') l.fn(ev17)
check('H17', filled.length === before17 && ev17.prevented === false, `filled+${filled.length - before17}`)

// H18：草稿非空时不显示，Enter 也不被接管
timeline = timelineOf(3, 'closed', 'completed')
mountSlot({ d: '我在打字' })
await new Promise((r) => setTimeout(r, 40))
const before18 = filled.length
const ev18 = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
for (const l of [...windowListeners]) if (l.type === 'keydown') l.fn(ev18)
check('H18', findGhost(card).length === 0 && filled.length === before18 && ev18.prevented === false, `ghost=${findGhost(card).length} filled+${filled.length - before18}`)

  mountSlot({ tl: timelineOf(4, 'closed', 'completed') })
  await new Promise(setImmediate)
  const replacement = '检查英文文档的安装步骤'
  payload.items[0] = { sessionId: 's1', turn: 4, text: replacement }
  onVisibilityChange()
  await new Promise(setImmediate)
  check('H19a', findGhost(card).some((ghost) => ghost.textContent === replacement), '同一页面收到相同 rev 的新回合')
  document.activeElement = editor
  for (const listener of windowListeners.filter((entry) => entry.type === 'keydown')) listener.fn(event)
  check('H19b', filled.at(-1) === replacement, 'Enter 收下热重载后的新建议')

console.log(`\n${bad === 0 ? 'ALL PASS' : 'FAILED'} pass=${ok} fail=${bad}`)
  process.exit(bad === 0 ? 0 : 1)
}

main()

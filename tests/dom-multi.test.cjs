/**
 * DOM 级测试 v2：极小 React + 假 DOM，支持多实例（两会话并存）、卸载、承载层被替换。
 * 断言：灰字画在编辑区那一层、与占位符同几何、卡片属性正确、Enter 只填草稿、
 *       没有 setDraft 时不画、承载层被换掉后能重新定位、卸载后不留残留。
 */
const vm = require('node:vm')
const fs = require('node:fs')

const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8')

// ---------- 假 DOM ----------
function node(tag) {
  const attrs = new Map()
  return {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    isContentEditable: false,
    isConnected: true,
    parentElement: null,
    children: [],
    style: {},
    listeners: [],
    textContent: '',
    setAttribute(k, v) { attrs.set(k, v) },
    removeAttribute(k) { attrs.delete(k) },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null },
    hasAttribute(k) { return attrs.has(k) },
    getBoundingClientRect() { return { left: 100, top: 300, width: 600, height: 24, right: 700, bottom: 324, x: 100, y: 300 } },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentElement = null },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false },
    closest(sel) { const key = String(sel).replace(/[[\]]/g, ''); for (let n = this; n; n = n.parentElement) if (n.hasAttribute(key)) return n; return null },
    addEventListener(type, fn) { this.listeners.push({ type, fn }) },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)) },
    querySelector(sel) {
      const key = String(sel).replace(/[[\]]/g, '')
      const walk = (n) => { for (const c of n.children ?? []) { if (c.hasAttribute(key)) return c; const hit = walk(c); if (hit) return hit } return null }
      return walk(this)
    },
  }
}

const document = {
  head: node('head'),
  body: node('body'),
  documentElement: node('html'),
  activeElement: null,
  visibilityState: 'visible',
  getElementById(id) {
    const walk = (n) => { if (n.getAttribute('id') === id) return n; for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit } return null }
    return walk(document.head)
  },
  createElement: (tag) => node(tag),
  addEventListener() {},
  removeEventListener() {},
}

// ---------- 极小 React（按实例存 hooks） ----------
let cur = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState(init) {
    const i = cur.index++
    cur.hooks[i] ??= { value: typeof init === 'function' ? init() : init }
    return [cur.hooks[i].value, (next) => {
      const value = typeof next === 'function' ? next(cur.hooks[i].value) : next
      if (value === cur.hooks[i].value) return
      cur.hooks[i].value = value
      cur.dirty = true
      if (!cur.rendering) renderInstance(cur)
    }]
  },
  useEffect(fn) { cur.queue.push({ i: cur.index++, fn }) },
  useRef(init) {
    const i = cur.index++
    cur.hooks[i] ??= { value: { current: init } }
    return cur.hooks[i].value
  },
}
React.useLayoutEffect = React.useEffect
const ReactDOM = { createPortal: (child, target) => ({ portal: child, target }) }

function mount(tree, parent, inst) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return null
  if (Array.isArray(tree)) { for (const t of tree) mount(t, parent, inst); return null }
  if (tree.portal !== undefined) {
    const el = mount(tree.portal, tree.target, inst)
    if (el) inst.portals.push({ target: tree.target, el })
    return null
  }
  if (typeof tree.type === 'function') return mount(tree.type(tree.props), parent, inst)
  if (tree.type === React.Fragment) { mount(tree.children, parent, inst); return null }
  const el = node(tree.type)
  for (const [k, v] of Object.entries(tree.props)) {
    if (k === 'ref') { if (v && typeof v === 'object') v.current = el; continue }
    if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v)
    else if (typeof v === 'string') el.setAttribute(k, v)
  }
  for (const child of tree.children) {
    if (typeof child === 'string' || typeof child === 'number') { el.textContent += String(child); el.appendChild(node('#text')) }
    else mount(child, el, inst)
  }
  parent?.appendChild(el)
  return el
}

function renderInstance(inst) {
  if (inst.rendering) { inst.dirty = true; return }
  inst.rendering = true
  do {
    inst.dirty = false
    renderOnce(inst)
  } while (inst.dirty)
  inst.rendering = false
}

function renderOnce(inst) {
  cur = inst
  inst.index = 0
  inst.queue = []
  for (const c of [...inst.mountPoint.children]) c.parentElement = null
  inst.mountPoint.children = []
  for (const p of inst.portals) p.target.children = p.target.children.filter((c) => c !== p.el)
  inst.portals = []
  const tree = React.createElement(inst.Component, inst.props)
  mount(tree, inst.mountPoint, inst)
  const pending = inst.queue
  inst.queue = []
  for (const { i, fn } of pending) {
    if (typeof inst.hooks[i]?.cleanup === 'function') inst.hooks[i].cleanup()
    const cleanup = fn()
    inst.hooks[i] = { ...(inst.hooks[i] ?? {}), cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
}

function createInstance(cardEl) {
  const mountPoint = node('div')
  mountPoint.setAttribute('data-saynext-mount', '')
  cardEl.appendChild(mountPoint)
  return { card: cardEl, mountPoint, hooks: [], queue: [], index: 0, portals: [], intervals: [], timers: [], Component: null, props: null }
}

function unmount(inst) {
  for (const h of inst.hooks) if (typeof h?.cleanup === 'function') h.cleanup()
  inst.hooks = []
  for (const p of inst.portals) p.target.children = p.target.children.filter((c) => c !== p.el)
  inst.portals = []
  inst.mountPoint.parentElement?.removeChild(inst.mountPoint)
  for (const { id } of inst.intervals) { liveIntervals.delete(id); if (typeof clearInterval === 'function') clearInterval(id) }
  inst.intervals = []
}

// ---------- 加载插件 ----------
const windowListeners = []
let capturedExports = null
const windowStub = {
  addEventListener: (type, fn) => windowListeners.push({ type, fn }),
  removeEventListener: (type, fn) => { const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) windowListeners.splice(i, 1) },
  __ModuleLoader__: { load: ({ factory }) => { capturedExports = factory((n) => (n === 'react' ? React : n === 'react-dom' ? ReactDOM : undefined)) } },
}
const liveIntervals = new Set()
const sandbox = {
  getComputedStyle: () => ({ font: '13px system-ui', lineHeight: '20px', color: 'rgb(20, 24, 32)' }),
  window: windowStub,
  document,
  console,
  clearTimeout,
  clearInterval: (id) => { if (id && id.__i) liveIntervals.delete(id); },
  setTimeout: (fn) => { const id = { __t: fn }; return id },
  setInterval: (fn) => { const id = { __i: fn }; liveIntervals.add(id); currentInstance?.intervals.push({ id, fn }); return id },
}
let currentInstance = null
vm.runInNewContext(code, sandbox, { filename: 'client.js' })

// ---------- 装配 ----------
const payload = {
  rev: 1,
  items: [
    { sessionId: 's1', text: '先把支付路径跑通', turn: 3 },
    { sessionId: 's2', text: '再补一条失败回滚', turn: 5 },
  ],
}
const settings = { describe: async () => ({ namespaces: [{ ns: 'saynext', value: { hint: JSON.stringify(payload) } }] }) }

const filled = []
function makeCard() {
  const card = node('div'); card.setAttribute('data-composer-card', '')
  const grow = node('div'); card.appendChild(grow)
  const editor = node('div'); editor.isContentEditable = true; grow.appendChild(editor)
  const placeholder = node('div'); placeholder.setAttribute('data-composer-placeholder', ''); grow.appendChild(placeholder)
  return { card, grow, editor, placeholder }
}

let SlotComponent = null
let capturedMeta = null
capturedExports.apply({
  get: () => ({ settings }),
  slots: { inject: (n, cb) => cb(), register: (meta, Comp) => { capturedMeta = meta; SlotComponent = Comp; return () => {} } },
})

function slotProps(sessionId, { draft = '', running = false, setDraft = (t) => filled.push([sessionId, t]) } = {}) {
  const turn = sessionId === 's1' ? 3 : 5
  const timeline = {
    turnOrder: [1, turn],
    turns: new Map([[turn, { status: 'closed', end: { data: { reason: { kind: 'completed' } } } }]]),
  }
  return {
    useInput: (sel) => sel({ draft }),
    useSession: (sel) => sel({ running }),
    inputActions: setDraft === null ? {} : { setDraft },
    sessionId,
    useConversation: (sel) => sel({ views: { get: (key) => (key === 'chat' ? { timeline } : undefined) } }),
  }
}

function mountSlot(sessionId, cardEl, opts = {}) {
  const inst = createInstance(cardEl)
  inst.Component = SlotComponent
  inst.props = slotProps(sessionId, opts)
  currentInstance = inst
  sandbox.setInterval = (fn) => { const id = { __i: fn }; liveIntervals.add(id); inst.intervals.push({ id, fn }); return id }
  sandbox.setTimeout = () => ({ __t: true })
  renderInstance(inst)
  return inst
}

const findGhost = (n, out = []) => {
  // 灰字挂在 document.body（顶层固定定位），一律从 body 开始找。
  if (!n) return out
  if (n.getAttribute && n.getAttribute('data-saynext') === 'ghost') out.push(n)
  for (const c of n.children ?? []) findGhost(c, out)
  return out
}
const ghosts = () => findGhost(document.body)
const byText = (text) => ghosts().filter((g) => g.textContent === text)

let ok = 0, bad = 0
const check = (id, cond, detail) => { if (cond) { ok += 1; console.log(`${id} PASS${detail ? ' ' + detail : ''}`) } else { bad += 1; console.log(`${id} FAIL ${detail ?? ''}`) } }
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 两个会话、两张卡片同时挂着
  const a = makeCard()
  const b = makeCard()
  const ia = mountSlot('s1', a.card)
  await wait()
  // 第二个会话稍后挂上（真实场景：切换/新开会话），两个实例同时存活
  const ib = mountSlot('s2', b.card)
  await wait()

  check('I0', capturedMeta?.id === 'saynext-line', JSON.stringify(capturedMeta))
  const ga = byText(payload.items[0].text)
  const gb = byText(payload.items[1].text)
  check('I1a', ga.length === 1 && ga[0].style.position === 'fixed', `a.ghost=${ga.length} pos=${ga[0]?.style.position}`)
  check('I1b', gb.length === 1 && gb[0].parentElement === document.body, `b.ghost=${gb.length}`)
  check('I1c', ga[0].textContent === payload.items[0].text && gb[0].textContent === payload.items[1].text, `a=${ga[0].textContent} b=${gb[0].textContent}`)
  check('I1d', a.card.hasAttribute('data-saynext-ghost') && b.card.hasAttribute('data-saynext-ghost'), '两张卡片各自打标记')

  // 卸载 a：只清 a 的残留
  unmount(ia)
  check('I2a', byText(payload.items[0].text).length === 0, 'a 的灰字已移除')
  check('I2b', !a.card.hasAttribute('data-saynext-ghost'), 'a 的属性已移除')
  check('I2c', byText(payload.items[1].text).length === 1 && b.card.hasAttribute('data-saynext-ghost'), 'b 不受影响')

  // 没有 setDraft：不画
  const c = makeCard()
  const ic = mountSlot('s1', c.card, { setDraft: null })
  await wait()
  check('I3', byText(payload.items[0].text).length === 0 && ghosts().length === 1 && !c.card.hasAttribute('data-saynext-ghost'), '缺少 setDraft 时不新增灰字')
  unmount(ic)

  // 承载层被宿主换掉：指针里的旧节点脱离文档后应重新定位
  const d = makeCard()
  const id = mountSlot('s1', d.card)
  await wait()
  check('I4a', byText(payload.items[0].text).length === 1, '初始有灰字')
  const oldGrow = d.grow
  oldGrow.isConnected = false
  d.card.removeChild(oldGrow)
  const newGrow = node('div'); d.card.appendChild(newGrow)
  const newEditor = node('div'); newEditor.isContentEditable = true; newGrow.appendChild(newEditor)
  const newPlaceholder = node('div'); newPlaceholder.setAttribute('data-composer-placeholder', ''); newGrow.appendChild(newPlaceholder)
  // 让插件里的复查定时器跑一次
  for (const { fn } of id.intervals) fn()
  await wait()
  const gd = byText(payload.items[0].text)
  check('I4b', gd.length === 1 && gd[0].style.position === 'fixed', `换层后仍在，ghost=${gd.length}`)

  // Enter：只填草稿，不发送
  d.card.querySelector('[data-composer-placeholder]')
  document.activeElement = newEditor
  const ev = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  for (const l of [...windowListeners]) if (l.type === 'keydown') l.fn(ev)
  check('I5', filled.some(([sid, t]) => sid === 's1' && t === payload.items[0].text) && ev.prevented === true && ev.stopped === true, `filled=${JSON.stringify(filled)}`)

  // 卸载后监听器全部撤掉
  // 基线取自运行时，不写死数字：此时 b 实例还挂着，所以卸载 d 之后应该只剩它的那一个。
  const beforeKeydown = windowListeners.filter((l) => l.type === 'keydown').length
  unmount(id)
  check('I6', windowListeners.filter((l) => l.type === 'keydown').length === beforeKeydown - 1, `keydown 监听=${windowListeners.filter((l) => l.type === 'keydown').length} 之前=${beforeKeydown}`)

  unmount(ib)
  check('I7', liveIntervals.size === 0, `留下的定时器=${liveIntervals.size}`)
  console.log(`\n${bad === 0 ? 'ALL PASS' : 'FAILED'} pass=${ok} fail=${bad}`)
  process.exit(bad === 0 ? 0 : 1)
}

main()

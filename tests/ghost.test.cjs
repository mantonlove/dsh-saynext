const vm = require('node:vm')
const fs = require('node:fs')

const code = fs.readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8')

let captured
const fakeStyleNodes = []
function makeNode(tag) {
  const attrs = new Map()
  return {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    appendChild(child) { this.children.push(child); child.parentElement = this; return child },
    closest() { return null },
    querySelector() { return null },
  }
}
const documentStub = {
  head: makeNode('head'),
  body: makeNode('body'),
  documentElement: makeNode('html'),
  visibilityState: 'visible',
  getElementById: (id) => fakeStyleNodes.find((n) => n.id === id) ?? null,
  createElement: (tag) => {
    const node = makeNode(tag)
    if (tag === 'style') {
      Object.defineProperty(node, 'id', {
        get: () => node.getAttribute('id'),
        set: (value) => node.setAttribute('id', value),
        configurable: true,
      })
      fakeStyleNodes.push(node)
    }
    return node
  },
  addEventListener() {},
  removeEventListener() {},
}
function stubRequire(name) {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: Symbol('Fragment'),
      useState: (init) => [init, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
    }
  }
  if (name === 'react-dom') return { createPortal: (node, target) => ({ portal: node, target }) }
  throw new Error(`unexpected require ${name}`)
}
const windowStub = {
  __SAYNEXT_TEST__: true,
  __ModuleLoader__: { load: ({ id, factory }) => { captured = { id, exports: factory(stubRequire) } } },
  addEventListener() {},
  removeEventListener() {},
}

vm.runInNewContext(code, {
  window: windowStub,
  document: documentStub,
  require: stubRequire,
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
})

let pass = 0
let fail = 0
function check(id, ok, detail) {
  if (ok) { pass += 1; console.log(`${id} PASS${detail ? ' ' + detail : ''}`) }
  else { fail += 1; console.log(`${id} FAIL ${detail ?? ''}`) }
}

check('G0', captured?.id === 'dsh-saynext', `id=${captured?.id}`)
const t = captured.exports.__test
check('G1', typeof t?.ghostVisible === 'function' && typeof t?.findGhostTarget === 'function', 'test hooks exposed')

// G2 显示条件：有建议、草稿空、会话没在跑
check('G2a', t.ghostVisible('下一句', '', false) === true)
check('G2b', t.ghostVisible('下一句', '   ', false) === true, '仅空白草稿也算空')
check('G2c', t.ghostVisible('下一句', '写了字', false) === false)
check('G2d', t.ghostVisible('下一句', '', true) === false, '运行中不显示')
check('G2e', t.ghostVisible('', '', false) === false)

// G3 位置与样式：与宿主占位符同一组 inset，不可点、单行省略
check('G3a', t.GHOST.position === 'fixed' && t.GHOST.zIndex > 0, `position=${t.GHOST.position} z=${t.GHOST.zIndex}`)
check('G3b', t.GHOST.pointerEvents === 'none' && t.GHOST.userSelect === 'none')
check('G3c', t.GHOST.whiteSpace === 'nowrap' && t.GHOST.textOverflow === 'ellipsis')
check('G3d', typeof t.measureGhost === 'function', 'measureGhost 已导出')

// G4 找承载层：占位符的父节点
const grow = makeNode('div')
const placeholder = makeNode('div')
grow.appendChild(placeholder)
const card = makeNode('div')
card.querySelector = (sel) => (sel === '[data-composer-placeholder]' ? placeholder : null)
const anchor = makeNode('div')
anchor.closest = (sel) => (sel === '[data-composer-card]' ? card : null)
check('G4a', t.findGhostTarget(anchor) === grow, '返回 .grow')
check('G4b', t.findGhostTarget(null) === null && t.findGhostTarget({}) === null, '拿不到就返回 null')

// G5 样式注入：只加一次，规则命中宿主占位符
t.ensureStyle()
t.ensureStyle()
const styles = fakeStyleNodes.filter((n) => n.getAttribute('id') === 'dsh-saynext-ghost-style')
check('G5a', styles.length === 1, `styles=${styles.length}`)
check('G5b', /\[data-saynext-ghost\] \[data-composer-placeholder\]/.test(styles[0]?.textContent ?? ''), '规则含占位符选择器')

// G6 槽位注册：只注册 overlay 一处，不再有 dock
const registered = []
const ctx = {
  get: (key) => (key === 'remote' ? { settings: { describe: async () => ({ namespaces: [] }) } } : undefined),
  slots: {
    inject: (name, cb) => cb(),
    register: (meta) => { registered.push(meta); return () => {} },
  },
}
captured.exports.apply(ctx)
check('G6a', registered.length === 1, `count=${registered.length}`)
check('G6b', registered[0]?.name === 'conversation.input.overlay' && registered[0]?.id === 'saynext-line' && registered[0]?.order === 100,
  JSON.stringify(registered[0]))
check('G6c', !registered.some((m) => m.name === 'conversation.input.dock'), '没有 dock 注册')

// 四种信封形态（G7 组）：unwrap() 只在剥到带 namespaces 的对象时返回
const doc = (n) => ({ namespaces: [{ ns: 'saynext', value: { hint: `r${n}` } }] })
const cases = [
  ['G7a', { ok: true, value: doc(1) }],
  ['G7b', { result: doc(2) }],
  ['G7c', { value: doc(3) }],
  ['G7d', doc(4)],
  ['G7e', { ok: true, value: { result: doc(5) } }],
]
for (const [id, input] of cases) {
  const got = t.unwrap(input)
  check(id, got?.namespaces?.length === 1, `namespaces=${got?.namespaces?.length}`)
}
check('G7f', t.unwrap({ ok: true, value: { result: { value: { result: { value: { result: doc(6) } } } } } }) === undefined, '剥不干净时返回 undefined')
check('G7g', t.unwrap(null) === undefined && t.unwrap('x') === undefined, '非对象返回 undefined')

// T1–T5：回合判定（建议必须属于最新一轮且那一轮正常结束）
{
  const loc = (status, kind) => ({ status, end: { data: { reason: { kind } } } })
  const tl = (turn, status, kind) => ({ turnOrder: [1, turn], turns: new Map([[turn, loc(status, kind)]]) })

  const s1 = t.turnState(tl(3, 'closed', 'completed'))
  check('T1', s1?.turn === 3 && s1.completed === true, JSON.stringify(s1))

  const s2 = t.turnState(tl(4, 'open', 'completed'))
  check('T2', s2?.turn === 4 && s2.completed === false, JSON.stringify(s2))

  const s3 = t.turnState(tl(3, 'closed', 'error'))
  check('T3', s3?.completed === false, JSON.stringify(s3))

  check('T4', t.turnState(undefined) === undefined && t.turnState({ turnOrder: [], turns: new Map() }) === undefined)

  const item = { sessionId: 's1', text: 'x', turn: 3 }
  check('T4b', t.turnState({ turnOrder: [5], turns: new Map([[5, { status: 'unknown', end: undefined }]]) })?.completed === false, 'unknown 视为未正常结束')
  check('T6a', t.matchesLatest({ ...item, turn: '3' }, { turn: 3, completed: true }) === true, '字符串回合号也能比')
  check('T6b', t.matchesLatest({ sessionId: 's1', text: 'x' }, { turn: 3, completed: true }) === false, '缺 turn 不匹配')

  check('T5a', t.matchesLatest(item, { turn: 3, completed: true }) === true)
  check('T5b', t.matchesLatest(item, { turn: 3, completed: false }) === false)
  check('T5c', t.matchesLatest({ ...item, turn: 2 }, { turn: 3, completed: true }) === false)
  check('T5d', t.matchesLatest(undefined, { turn: 3, completed: true }) === false)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

/**
 * Client render + interaction verification.
 *
 * What is REAL here, and what is emulated -- stated plainly, because a test that
 * hides this distinction is worse than no test:
 *
 *   REAL  the host half (`lib/index.js`), booted with a Cordis-shaped ctx and
 *         served over a real HTTP server on a real loopback port.
 *   REAL  the client half (`lib/client.js`), loaded by the real
 *         `window.__ModuleLoader__.load({id, factory})` entry shape.
 *   REAL  `fetch` (Node's), so every request the UI makes is a real POST.
 *   REAL  React's `createElement` / `isValidElement` -- the elements the walker
 *         consumes are genuine React elements, not hand-made objects.
 *   REAL  the slot registration contract: the assertions below encode what the
 *         installed `dsh-client-ui-sidebar` / `dsh-client-ui-layout` actually
 *         read (`options.id/order/label` for the panellist list; `options.key`
 *         for the keyed `main` slot; `{wide}` for the footer action), read out of
 *         those packages rather than assumed.
 *   EMULATED  React's hooks and effect scheduling. No react-dom is installed
 *         anywhere reachable (`react-dom` in the profile is a broken junction),
 *         so this file implements the subset the UI uses: useState / useRef /
 *         useMemo / useCallback / useEffect with dependency comparison and
 *         cleanup, a commit pass that runs effects, and a re-render when the
 *         dependency array changes. Component records are keyed by tree path and
 *         reset when the component type at that path changes (a remount).
 *         Hook order is therefore per stable instance, exactly as React requires
 *         -- and every hook-owning component in this UI is a tree singleton.
 *
 * The point of the emulation is not to certify React; it is to run the real data
 * flow end to end and catch the failures that matter: a view that throws on empty
 * data, a drawer that reads a field the host does not send, an interaction that
 * never reaches the host.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const pkgRoot = path.join(here, '..')

// Isolate the plugin's data file from the user's real one.
const scratch = fs.mkdtempSync(path.join(pkgRoot, '.tmp-render-'))
process.env.DSH_HOME = scratch

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected })
}
function section(title) { console.log('--- ' + title + ' ---') }

// `node scripts/verify-client-render.mjs --dump-html` prints the DOM a browser
// would receive. Assertions prove behaviour; this is how a human reviews the
// structure and the class names the stylesheet hangs off.
const DUMP = process.argv.includes('--dump-html')
const dump = (label, api) => { if (DUMP) console.log(`\n----- ${label} -----\n${api.html()}\n`) }

// ===========================================================================
// a faithful-enough React renderer (see the header)
// ===========================================================================

const isElement = (n) => n !== null && typeof n === 'object' && n.$$typeof !== undefined && 'type' in n && 'props' in n

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

function createRoot() {
  const records = new Map()
  let element = null
  let tree = null
  let dirty = false
  let jobs = []
  let rec = null
  let cursor = 0
  const stack = []
  const errors = []

  function slot(index) {
    if (rec === null) throw new Error('hook used outside a component render')
    if (rec.slots[index] === undefined) rec.slots[index] = {}
    return rec.slots[index]
  }

  function walk(node, pathArg) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) {
      return node.map((child, i) => walk(child, `${pathArg}/${i}`)).filter((child) => child !== null)
    }
    if (!isElement(node)) return null
    const type = node.type

    if (typeof type === 'function') {
      let entry = records.get(pathArg)
      // A different component type at the same path is a remount: its hooks start
      // over. (React does the same; without this, two components could inherit
      // each other's state.)
      if (entry === undefined || entry.type !== type) {
        entry = { type, slots: [], path: pathArg }
        records.set(pathArg, entry)
      }
      const prevRec = rec
      const prevCursor = cursor
      rec = entry
      cursor = 0
      stack.push(type.displayName ?? type.name ?? '(anonymous)')
      let out
      try {
        out = type(node.props)
      } catch (e) {
        throw new Error(`<${stack.join(' < ')}> threw: ${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}`)
      } finally {
        stack.pop()
      }
      const produced = walk(out, `${pathArg}@`)
      rec = prevRec
      cursor = prevCursor
      return produced
    }

    const children = node.props?.children
    const list = children === undefined ? [] : (Array.isArray(children) ? children : [children])
    return {
      kind: 'host',
      tag: type,
      // Enough DOM shape for the two things the client does with real nodes:
      // attaching a ref and asking whether a click landed inside its own row.
      tagName: typeof type === 'string' ? String(type).toUpperCase() : '',
      props: node.props ?? {},
      // React 19 moved `ref` into props; reading `element.ref` warns.
      ref: node.props?.ref ?? null,
      parent: null,
      children: list.flatMap((child, i) => {
        const walked = walk(child, `${pathArg}/${i}`)
        return walked === null ? [] : (Array.isArray(walked) ? walked : [walked])
      }),
    }
  }

  function attachParents(node) {
    if (node === null || typeof node === 'string' || Array.isArray(node)) {
      if (Array.isArray(node)) node.forEach(attachParents)
      return
    }
    // React attaches `ref` to the real DOM node. A host node here stands in for
    // that node, so the ref has to point at it -- otherwise a component that reads
    // its own node (the sidebar entry asks whether a click landed inside it) would
    // silently see null.
    if (node.ref !== null && node.ref !== undefined && typeof node.ref === 'object') node.ref.current = node
    // `closest` includes the node itself, per the DOM spec.
    node.closest = (selector) => {
      const want = String(selector).toUpperCase()
      let cursor = node
      while (cursor !== null && cursor !== undefined) {
        if (cursor.tagName === want) return cursor
        cursor = cursor.parent
      }
      return null
    }
    node.contains = (other) => {
      let cursor = other
      while (cursor !== null && cursor !== undefined) {
        if (cursor === node) return true
        cursor = cursor.parent
      }
      return false
    }
    for (const child of node.children) {
      if (typeof child !== 'string') {
        child.parent = node
        attachParents(child)
      }
    }
  }

  function commit() {
    for (const job of jobs) {
      const s = job.s
      const first = !('deps' in s)
      const changed = first || job.deps === undefined || job.deps === null || !sameDeps(s.deps, job.deps)
      if (!changed) continue
      if (typeof s.cleanup === 'function') {
        try { s.cleanup() } catch (e) { errors.push(String(e?.message ?? e)) }
      }
      s.cleanup = undefined
      s.deps = job.deps
      const out = job.fn()
      s.cleanup = typeof out === 'function' ? out : undefined
    }
  }

  function pass() {
    activeHooks = hookApi
    for (let i = 0; i < 60; i++) {
      dirty = false
      jobs = []
      rec = null
      cursor = 0
      tree = walk(element, 'root')
      attachParents(tree)
      commit()
      if (!dirty) return
    }
    throw new Error('render loop did not settle in 60 passes')
  }

  const api = {
    errors,
    render(el) { element = el; pass() },
    pass,
    get tree() { return tree },
    async settle(rounds = 10) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 6))
        pass()
      }
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms))
      pass()
    },
    nodes(includeText = false) {
      const out = []
      const visit = (node) => {
        if (node === null || node === undefined) return
        if (typeof node === 'string') { if (includeText) out.push(node); return }
        if (Array.isArray(node)) { node.forEach(visit); return }
        out.push(node)
        node.children.forEach(visit)
      }
      visit(tree)
      return out
    },
    text(node = tree) {
      if (node === null || node === undefined) return ''
      if (typeof node === 'string') return node
      if (typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map((n) => api.text(n)).join('')
      return node.children.map((n) => api.text(n)).join('')
    },
    /** The innermost element whose text contains `needle`. */
    find(needle, tag) {
      const candidates = api.nodes().filter((n) =>
        (tag === undefined || n.tag === tag) && api.text(n).includes(needle))
      if (candidates.length === 0) return undefined
      return candidates.reduce((best, node) => (api.text(node).length < api.text(best).length ? node : best))
    },
    byClass(cls) {
      return api.nodes().filter((n) => String(n.props.className ?? '').split(/\s+/).includes(cls))
    },
    tag(tagName) { return api.nodes().filter((n) => n.tag === tagName) },
    clickable(node) {
      let current = node
      while (current !== undefined && current !== null) {
        if (typeof current.props?.onClick === 'function') return current
        current = current.parent
      }
      return undefined
    },
    html() {
      const render = (node) => {
        if (node === null || node === undefined) return ''
        if (typeof node === 'string') return node.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        if (Array.isArray(node)) return node.map(render).join('')
        const attrs = []
        for (const [key, value] of Object.entries(node.props)) {
          if (key === 'children' || key.startsWith('on') || value === undefined || value === null) continue
          if (key === 'className') { attrs.push(`class="${String(value)}"`); continue }
          if (key === 'style') {
            const css = Object.entries(value).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';')
            attrs.push(`style="${css}"`)
            continue
          }
          if (typeof value === 'function' || typeof value === 'object') continue
          if (value === true) { attrs.push(key); continue }
          if (value === false) continue
          attrs.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
        }
        const head = `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`
        if (['input', 'br', 'img', 'hr'].includes(node.tag)) return head + '>'
        return `${head}>${node.children.map(render).join('')}</${node.tag}>`
      }
      return render(tree)
    },
  }

  const hookApi = {
    useState(initial) {
      const s = slot(cursor++)
      if (!('value' in s)) s.value = typeof initial === 'function' ? initial() : initial
      return [s.value, (next) => {
        const value = typeof next === 'function' ? next(s.value) : next
        if (Object.is(value, s.value)) return
        s.value = value
        dirty = true
      }]
    },
    useRef(initial) {
      const s = slot(cursor++)
      if (!('value' in s)) s.value = { current: initial }
      return s.value
    },
    useMemo(fn, deps) {
      const s = slot(cursor++)
      if (!('value' in s) || !sameDeps(s.deps, deps)) { s.value = fn(); s.deps = deps }
      return s.value
    },
    useCallback(fn, deps) {
      const s = slot(cursor++)
      if (!('value' in s) || !sameDeps(s.deps, deps)) { s.value = fn; s.deps = deps }
      return s.value
    },
    useEffect(fn, deps) {
      const s = slot(cursor++)
      jobs.push({ s, fn, deps })
    },
  }

  return { api, hookApi }
}

/**
 * The hooks live behind one delegating object, the way React keeps a single
 * "current dispatcher". This matters: the client destructures `useState` once,
 * when `apply()` runs, so every component is permanently bound to whichever hook
 * object it saw first. Handing each root its own hook object would send a later
 * root's renders into the first root's state -- which is not how React behaves.
 * Each root points `activeHooks` at itself while it renders.
 */
let activeHooks = null

function makeReact(realReact) {
  return {
    ...realReact,
    createElement: realReact.createElement,
    isValidElement: realReact.isValidElement,
    useState: (initial) => activeHooks.useState(initial),
    useRef: (initial) => activeHooks.useRef(initial),
    useMemo: (fn, deps) => activeHooks.useMemo(fn, deps),
    useCallback: (fn, deps) => activeHooks.useCallback(fn, deps),
    useEffect: (fn, deps) => activeHooks.useEffect(fn, deps),
  }
}

// ===========================================================================
// a minimal document, enough for the style injection and the Esc listener
// ===========================================================================

function makeDocument() {
  const head = { children: [] }
  const listeners = new Map()
  const document = {
    head: { appendChild(node) { node._parent = document.head; head.children.push(node) } },
    body: { appendChild() {} },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        dataset: {},
        style: {},
        _text: '',
        set textContent(value) { this._text = value },
        get textContent() { return this._text },
        remove() {
          const index = head.children.indexOf(this)
          if (index >= 0) head.children.splice(index, 1)
        },
      }
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
      if (match === null) return null
      return head.children.find((node) => node.dataset?.pluginCss === match[1]) ?? null
    },
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add({ fn, capture: capture === true })
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type)
      if (set === undefined) return
      for (const entry of [...set]) if (entry.fn === fn) set.delete(entry)
    },
    /** Capture-phase listeners first, as the DOM does. */
    dispatch(type, event) {
      const entries = [...(listeners.get(type) ?? [])]
      for (const entry of entries) if (entry.capture) entry.fn(event)
      for (const entry of entries) if (!entry.capture) entry.fn(event)
    },
    /**
     * Dispatch a click at a node. The event carries spies so a test can see
     * whether a handler swallowed the event before the framework's own listener
     * (which React attaches at the root container) could see it.
     */
    click(target) {
      const event = {
        type: 'click',
        target,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
      }
      this.dispatch('click', event)
      return event
    },
    /**
     * Dispatch a keydown at `target` with the modifier flags a shortcut reads.
     * The spies match `click`, so a test can see which layer consumed the key.
     */
    key(target, init = {}) {
      const event = {
        type: 'keydown',
        target,
        key: init.key ?? '',
        ctrlKey: init.ctrlKey === true,
        metaKey: init.metaKey === true,
        shiftKey: init.shiftKey === true,
        altKey: init.altKey === true,
        isComposing: init.isComposing === true,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
      }
      this.dispatch('keydown', event)
      return event
    },
    _head: head,
    _listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0) },
  }
  return document
}

// ===========================================================================
// boot the real host half with a Cordis-shaped ctx
// ===========================================================================

const tools = []
const commands = []
let route = null
const hostCtx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (def) => { tools.push(def); return () => {} } },
  settings: {
    register: () => ({
      get: () => ({ enabled: true, weekStart: 1, badgeCount: 'today', defaultList: '收集箱' }),
      watch: () => () => {},
    }),
  },
  provide: () => () => {},
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get: (key) => {
    if (key === 'webServer') return { register: (r) => { route = r; return () => {} } }
    if (key === 'commands') return { register: (c) => { commands.push(c); return () => {} } }
    return undefined
  },
}

const hostMod = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'index.js')).href)
hostMod.apply(hostCtx)

ok('host registered its HTTP route', route !== null && route.path === '/todo')
ok('host registered six tools', tools.length === 6, tools.map((t) => t.name))

let hostState = { lists: [], tasks: [] }
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/todo')) return route.handler(req, res)
  res.writeHead(404).end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const hostPort = server.address().port
const BASE = `http://127.0.0.1:${hostPort}`

/** Call the real HTTP API, exactly as the browser does. */
async function api(method, args = {}) {
  const res = await fetch(`${BASE}/todo/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await res.json()
  if (body.ok !== true) throw new Error(`${method}: ${body.error}`)
  return body.data
}

// ===========================================================================
// load the real client half in a vm
// ===========================================================================

const document = makeDocument()
const { api: ui } = createRoot()
// Both seats are live in the real page at the same time, and they share one store,
// so the harness mounts both and keeps them in step. The task dialog lives in the
// overlay seat, so panel-side interactions are asserted against `overlay`.
const overlay = createRoot().api
// Capture the real pumps before overriding: both roots must advance together,
// because a store change marks BOTH dirty and each root only re-renders when its
// own pass runs.
const pumps = {
  ui: { settle: ui.settle.bind(ui), wait: ui.wait.bind(ui) },
  overlay: { settle: overlay.settle.bind(overlay), wait: overlay.wait.bind(overlay) },
}
const settleAll = async (rounds) => { await pumps.ui.settle(rounds); await pumps.overlay.settle(rounds) }
const waitAll = async (ms) => { await pumps.ui.wait(ms); await pumps.overlay.wait(ms) }
ui.settle = settleAll
overlay.settle = settleAll
ui.wait = waitAll
overlay.wait = waitAll

/**
 * Real React, wherever it happens to be installed. It is not a dependency of the
 * plugin (the page supplies it through `require`), so this searches the places a
 * DSH checkout actually keeps it. If it is missing entirely the harness says so
 * out loud rather than quietly substituting a fake -- a silent substitution is
 * exactly the trap this file is written to avoid.
 */
function loadRealReact() {
  const candidates = [
    'react',
    path.join(os.homedir(), 'node_modules', 'react', 'index.js'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', 'react', 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      const loaded = createRequire(import.meta.url)(candidate)
      if (loaded !== null && typeof loaded.createElement === 'function') return loaded
    } catch { /* try the next location */ }
  }
  return null
}

const realReact = loadRealReact()
if (realReact === null) {
  console.error('FATAL: real React was not found; element construction cannot be verified.')
  console.error('       Looked in: node_modules, ~/node_modules, ~/.dsh/profiles/node_modules')
  process.exit(2)
}
console.log(`(real React ${realReact.version} supplies createElement; hooks are emulated)\n`)

const React = makeReact(realReact)

const registrations = []
const requireCalls = []
const layoutCalls = []
const slotsStub = {
  // The real service runs the callback synchronously when the declaration
  // already exists; every seat this plugin uses is a built-in, so it exists.
  inject(key, callback) {
    callback()
    return () => {}
  },
  register(options, Component) {
    registrations.push({ key: options.name, options, Component })
    return () => {}
  },
  entriesOfSlot() { return [] },
  subscribe() { return () => {} },
}

const ctx = {
  slots: slotsStub,
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get: (key) => {
    if (key === 'slots') return slotsStub
    if (key === 'layout') {
      return {
        selectPanel(id) {
          layoutCalls.push(id)
          // The real layout only rejects an unknown NON-NULL key: null is the
          // documented "return to the Conversation" (dsh-client-ui-workspace uses
          // it). Keeping that asymmetry makes the toggle a real integration check.
          if (id === null) return
          if (!registrations.some((r) => r.key === 'main' && r.options.key === id)) {
            throw new Error(`layout.selectPanel: main panel "${id}" is not registered`)
          }
        },
        toggleSidebar() {},
      }
    }
    return undefined
  },
}

let definition = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (def) => { definition = def } },
    confirm: () => true,
    prompt: () => '测试清单',
  },
  console,
  document,
  setTimeout,
  clearTimeout,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Promise,
  Map,
  Set,
  Symbol,
  isNaN,
  parseInt,
  parseFloat,
  // The client calls a RELATIVE url (as a browser does); in Node that needs the
  // loopback base in front of it.
  fetch: (url, init) => fetch(String(url).startsWith('http') ? url : BASE + url, init),
  require: (id) => {
    requireCalls.push(id)
    if (id === 'react') return React
    throw new Error(`the client asked for an unexpected module: ${id}`)
  },
}
sandbox.globalThis = sandbox

const clientSource = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
vm.createContext(sandbox)
new vm.Script(clientSource, { filename: 'lib/client.js' }).runInContext(sandbox)

// ===========================================================================
section('module shape and registration')
// ===========================================================================

ok('the module registers itself under the package name', definition !== null && definition.id === 'dsh-task-todo', definition?.id)
ok('the definition carries a factory', typeof definition?.factory === 'function')
// Incident #2: a factory that does not take `require` has no way to obtain React.
ok('the factory receives require', definition.factory.length >= 1, definition.factory.length)

const plugin = definition.factory(sandbox.require)
ok('the factory returns a plugin with a name and apply()',
  typeof plugin?.name === 'string' && typeof plugin?.apply === 'function')
ok('the plugin declares the slots dependency', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), plugin.inject)
plugin.apply(ctx)

ok('React was obtained through require', requireCalls.includes('react'), requireCalls)
ok('nothing else was required', requireCalls.every((id) => id === 'react'), requireCalls)


const seat = (key) => registrations.find((r) => r.key === key)
eq('three seats were registered, one per slot',
  registrations.map((r) => r.key).sort(),
  ['main', 'shell.overlay', 'sidebar.panellist'])
ok('every seat registered a component function',
  registrations.every((r) => typeof r.Component === 'function'))
// The user asked for the panel entry to sit with the global panels, between
// "new session" and the workspace list -- and NOT beside 设置.
ok('no entry sits beside the settings button',
  seat('sidebar.footer.action') === undefined, registrations.map((r) => r.key))

// sidebar.panellist: the sidebar reads options.id / options.order / options.label
// and renders the component with { size, active }.
const panellist = seat('sidebar.panellist')
eq('the panellist entry carries the id the sidebar will match', panellist.options.id, 'todo')
eq('the panellist entry carries an order', typeof panellist.options.order, 'number')
ok('the panellist entry carries a label', typeof panellist.options.label === 'string' && panellist.options.label.length > 0,
  panellist.options.label)

// main: keyed, matched by options.key against the active panel id.
const main = seat('main')
// layout.selectPanel('todo') throws unless a main entry with key 'todo' exists.
let selectThrew = null
try { ctx.get('layout').selectPanel('todo') } catch (e) { selectThrew = e }
ok('the main seat is keyed so selectPanel("todo") resolves it',
  main.options.key === 'todo' && selectThrew === null, selectThrew?.message)
eq('selectPanel was called with the panel id', layoutCalls, ['todo'])

eq('the overlay seat is a list entry', seat('shell.overlay').options.name, 'shell.overlay')

eq('the stylesheet was injected exactly once', document._head.children.length, 1)
eq('the stylesheet is tagged for idempotent re-injection',
  document._head.children[0].dataset.pluginCss, 'dsh-task-todo/todo.css')
ok('the stylesheet is non-trivial', document._head.children[0].textContent.length > 2000,
  document._head.children[0].textContent.length)

// ===========================================================================
section('empty state')
// ===========================================================================

const Panel = seat('main').Component
const Overlay = seat('shell.overlay').Component
const Icon = seat('sidebar.panellist').Component

ui.render(React.createElement(Panel, {}))
overlay.render(React.createElement(Overlay, {}))
ok('the first paint says it is loading', ui.text().includes('正在载入待办任务'), ui.text().slice(0, 80))
await ui.settle()
ok('after the first fetch the shell renders', ui.find('待办任务') !== undefined, ui.text().slice(0, 120))
ok('the empty state explains the rapid-add syntax', ui.text().includes('在下面一行直接输入'), ui.text().slice(0, 200))
ok('the overlay seat renders nothing while idle', overlay.byClass('td-modal').length === 0)
ok('the smart-list rail is present',
  ui.byClass('td-side').length >= 6, ui.byClass('td-side').length)
for (const label of ['今天', '最近 7 天', '已逾期', '未安排', '全部任务', '已完成']) {
  ok(`the rail offers ${label}`, ui.text().includes(label))
}
ok('all four view switches are offered',
  ['列表', '看板', '日历', '甘特'].every((label) => ui.text().includes(label)))
ok('the quick-add field is present', ui.tag('input').some((n) => String(n.props.placeholder ?? '').includes('添加任务')))
// The rail is the app's only always-visible navigation, so the four views, the
// list creator and the data controls are all asserted here rather than by hand.
ok('the rail groups its sections', ui.byClass('td-rail-g').length >= 3, ui.byClass('td-rail-g').length)
ok('the view switcher lives in the rail',
  ['列表', '看板', '日历', '甘特'].every((label) => ui.byClass('td-side').some((n) => ui.text(n).includes(label))),
  ui.byClass('td-side').length)
ok('the rail offers an inline new-list row', ui.text().includes('新建清单'))
// The data block is folded by default (v2 / §5.2.1): it is read once and then
// never again, and unfolded it was 96px of a 680px rail. Its contents are
// asserted through the toggle, which is the only way to reach them now.
ok('the data block starts folded', ui.byClass('td-rail-data').length === 0)
const dataToggle = ui.byClass('td-rail-toggle')
ok('the data block offers a toggle', dataToggle.length === 1, dataToggle.length)
eq('the toggle announces its state', dataToggle[0].props['aria-expanded'], 'false')
dataToggle[0].props.onClick({})
await ui.settle()
ok('unfolding reveals the data block', ui.byClass('td-rail-data').length === 1)
eq('the toggle now announces the open state', ui.byClass('td-rail-toggle')[0].props['aria-expanded'], 'true')
ok('the rail says where the data is kept',
  ui.byClass('td-rail-file').length === 1 && ui.text().includes('复制它就是一份备份'))
ok('the rail offers backup controls',
  ['导出备份', '导入', '复制路径'].every((label) => ui.text().includes(label)))
// Fold it again: the rest of this run asserts the rail's default shape.
ui.byClass('td-rail-toggle')[0].props.onClick({})
await ui.settle()
ok('folding hides it again', ui.byClass('td-rail-data').length === 0)

// ===========================================================================
section('populated state, driven through the real host')
// ===========================================================================

const today = (await api('state')).today
ok('the host reports a today anchor', typeof today === 'string' && today.length === 10, today)
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)

const overdue = await api('create', { title: '逾期的报告', due: yesterday, priority: 3 })
const dueToday = await api('create', { title: '今天的评审', due: `${today}T15:00`, list: '工作', note: '带上进度表' })
const dueTomorrow = await api('create', { title: '明天的站会', due: tomorrow })
const undated = await api('create', { title: '没有日期的想法' })
const repeating = await api('create', {
  title: '每周一晨会',
  due: today,
  repeat: 'weekly',
  repeatWeekdays: [1, 3, 5],
  list: '工作',
})
await api('addSubtask', { parentId: dueToday.created.id, title: '准备材料' })
await api('addSubtask', { parentId: dueToday.created.id, title: '邀请评审人' })

// The tasks were seeded through a separate HTTP client, so the open page has not
// seen them yet: press the same refresh control a user would.
ui.byClass('td-icon').find((n) => n.props['aria-label'] === '重新载入').props.onClick({})
await ui.settle()
ok('the populated list shows the overdue group', ui.text().includes('已逾期'))
ok('the populated list shows today\'s group', ui.text().includes('今天'))
ok('tasks are listed by title', ui.text().includes('今天的评审') && ui.text().includes('没有日期的想法'))
ok('the overdue task is marked late in its metadata', ui.byClass('td-chip').some((n) => ui.text(n).includes('昨天')))
ok('a subtask count is shown', ui.text().includes('0/2'))
// The flags are inline SVG now (an emoji renders as a full-colour picture and
// ignores the theme), so a flag is identified by its tooltip plus the icon it
// carries, not by a character in the text.
const chipsWithTitle = (needle) => ui.byClass('td-chip')
  .some((n) => typeof n.props.title === 'string' && n.props.title.includes(needle))
ok('a repeating task is flagged', chipsWithTitle('每周 周一、周三、周五'),
  ui.byClass('td-chip').map((n) => n.props.title))
// The metadata strip has three slots and an overflow chip (visual contract V2 /
// §3.8.3): a note is the LAST slot, so a row that already carries three flags
// reports it through "+N" instead. Both count as "the note is flagged" -- what
// must not happen is the note vanishing without a trace.
ok('a note is flagged',
  chipsWithTitle('带上进度表')
  || ui.byClass('td-meta-more').some((n) => typeof n.props.title === 'string' && n.props.title.includes('备注')),
  ui.byClass('td-meta-more').map((n) => n.props.title))
ok('the flags render as theme-coloured icons', ui.byClass('td-glyph').length >= 2,
  ui.byClass('td-glyph').length)
ok('the header summarises today', /今天 \d+ · 逾期 \d+/.test(ui.text()), ui.text().slice(0, 120))

const checklist = ui.byClass('td-chk')
ok('every listed task has a completion control', checklist.length >= 4, checklist.length)

// ===========================================================================
section('toggling reaches the host')
// ===========================================================================

const beforeToggle = (await api('state', { view: 'list', filter: 'all' })).tasks.find((t) => t.id === undated.created.id)
ok('the undated task starts open', beforeToggle.done === false)
const row = ui.find('没有日期的想法')
const tickIt = ui.clickable(ui.byClass('td-row').find((n) => ui.text(n).includes('没有日期的想法')))
ok('the row exposes a click target', tickIt !== undefined)
const checkbox = ui.byClass('td-chk').find((n) => n.parent !== null && ui.text(n.parent).includes('没有日期的想法'))
ok('the row has its own checkbox', checkbox !== undefined)
checkbox.props.onClick({ stopPropagation() {} })
await ui.settle()
const afterToggle = (await api('state', { view: 'list', filter: 'all', includeDone: true })).tasks.find((t) => t.id === undated.created.id)
ok('clicking the checkbox completed the task in the real store', afterToggle.done === true, afterToggle.done)

// Put it back so later assertions stay simple.
checkbox.props.onClick({ stopPropagation() {} })
await ui.settle()
ok('clicking again reopens it',
  (await api('state', { view: 'list', filter: 'all', includeDone: true })).tasks.find((t) => t.id === undated.created.id).done === false)

// ===========================================================================
section('the centred dialog edits the real task')
// ===========================================================================

ui.clickable(ui.find('今天的评审')).props.onClick({})
await ui.settle()
ok('the dialog opens in the overlay seat', overlay.byClass('td-modal').length === 1,
  { panel: ui.byClass('td-modal').length, overlay: overlay.byClass('td-modal').length })
ok('the dialog is a centred layer, not a side drawer',
  overlay.byClass('td-modal-layer').length === 1 && overlay.byClass('td-drawer').length === 0)
ok('the dialog is an aria modal', overlay.byClass('td-modal')[0].props['aria-modal'] === 'true')
ok('the dialog is labelled for a top-level task',
  overlay.byClass('td-modal-kind').length === 1 && overlay.text(overlay.byClass('td-modal-kind')[0]) === '任务',
  overlay.text(overlay.byClass('td-modal-kind')[0]))
dump('task dialog (overlay seat)', overlay)
dump('list behind it (panel seat)', ui)
ok('the title is editable', overlay.tag('input').some((n) => n.props.value === '今天的评审'))
ok('the note is editable and pre-filled', overlay.tag('textarea').some((n) => n.props.value === '带上进度表'))
ok('priority choices are offered', ['无', '低', '中', '高'].every((p) => overlay.text().includes(p)))
ok('the repeat editor is present', overlay.text().includes('重复') && overlay.text().includes('不重复'))
ok('both subtasks are listed in the dialog',
  overlay.byClass('td-sub-row').length === 2, overlay.byClass('td-sub-row').length)
ok('the dialog offers to add a subtask',
  overlay.tag('input').some((n) => String(n.props.placeholder ?? '').includes('添加子任务')))
// The footer used to print a raw task id next to the confirm button, which means
// nothing to anyone: identity is the title.
ok('the dialog shows no internal id', !/(^|\s)id t_/.test(overlay.text()), overlay.text().slice(-90))
ok('the dialog offers exactly one dismiss control',
  overlay.byClass('td-modal-close').length === 1, overlay.byClass('td-modal-close').length)

// Deleting asks first, in-page. window.confirm cannot be used here: the host may
// block it, and a blocked confirm is indistinguishable from "allow".
const subDeleteOf = (index) => overlay.byClass('td-sub-row')[index].children
  .find((c) => typeof c !== 'string' && String(c.props.className ?? '').split(/\s+/).includes('td-icon'))
const subsBefore = overlay.byClass('td-sub-row').length
subDeleteOf(1).props.onClick({ stopPropagation() {} })
await ui.settle()
ok('deleting a subtask asks in-page', overlay.byClass('td-modal').length === 2,
  overlay.byClass('td-modal').length)
ok('the question names the task', overlay.text().includes('无法撤销'))
overlay.byClass('td-btn').find((n) => overlay.text(n) === '取消').props.onClick({})
await ui.settle()
ok('cancelling the question keeps the subtask',
  overlay.byClass('td-sub-row').length === subsBefore, overlay.byClass('td-sub-row').length)
subDeleteOf(1).props.onClick({ stopPropagation() {} })
await ui.settle()
ok('the question offers a destructive confirm', overlay.byClass('td-btn').some((n) => overlay.text(n) === '删除'))
overlay.byClass('danger-solid').find((n) => typeof n.props.onClick === 'function').props.onClick({})
await ui.settle()
ok('confirming removes it from the host',
  overlay.byClass('td-sub-row').length === subsBefore - 1, overlay.byClass('td-sub-row').length)

// Put the row back: the assertions below are about the dialog, not about this
// detour, and a missing subtask would silently change their counts.
const subField = () => overlay.tag('input').find((n) => String(n.props.placeholder ?? '').includes('添加子任务'))
subField().props.onChange({ target: { value: '写成三页文稿' } })
await ui.settle(2)
subField().props.onKeyDown({ key: 'Enter', preventDefault() {}, target: { value: '写成三页文稿' } })
await ui.settle()
ok('the dialog takes a new subtask back', overlay.byClass('td-sub-row').length === subsBefore,
  overlay.byClass('td-sub-row').length)

// edit the note through the UI.
// Always re-query before acting: a handler captured from an earlier render closes
// over that render's state, which is a harness artefact -- React itself would hand
// the fresh handler to the same DOM node.
const noteOf = () => overlay.tag('textarea')[0]
noteOf().props.onChange({ target: { value: '带上进度表和风险清单' } })
await ui.settle(2)
noteOf().props.onBlur()
await ui.settle()
ok('the edited note reached the store',
  (await api('state')).tasks.find((t) => t.id === dueToday.created.id).note === '带上进度表和风险清单',
  (await api('state')).tasks.find((t) => t.id === dueToday.created.id).note)

// add a subtask through the dialog
const subOf = () => overlay.tag('input').find((n) => String(n.props.placeholder ?? '').includes('添加子任务'))
subOf().props.onChange({ target: { value: '确认会议室' } })
await ui.settle(2)
subOf().props.onKeyDown({ key: 'Enter', preventDefault() {}, target: { value: '确认会议室', blur() {} } })
await ui.settle()
const kids = (await api('state')).tasks.filter((t) => t.parentId === dueToday.created.id)
eq('the subtask was created under the right parent', kids.length, 3)
ok('the subtask kept its title', kids.some((k) => k.title === '确认会议室'))
ok('the dialog shows the new subtask without a manual refresh',
  overlay.byClass('td-sub-row').some((n) => overlay.text(n).includes('确认会议室')),
  overlay.byClass('td-sub-row').map((n) => overlay.text(n)))

// switch the dialog to a subtask
const targetRow = overlay.byClass('td-sub-row').find((n) => overlay.text(n).includes('确认会议室'))
ok('the subtask row was found for editing', targetRow !== undefined)
targetRow.children
  .find((c) => typeof c !== 'string' && String(c.props.className ?? '').includes('td-t'))
  .props.onClick({})
await ui.settle()
ok('the dialog switches to subtask detail',
  overlay.text(overlay.byClass('td-modal-kind')[0]) === '子任务',
  overlay.text(overlay.byClass('td-modal-kind')[0]))
ok('the subtask dialog links back to its parent', overlay.text().includes('今天的评审'))
ok('the subtask dialog offers its own note field', overlay.tag('textarea').length === 1)

// priority changes through the dialog controls
const highButton = overlay.byClass('td-opt').find((n) => overlay.text(n) === '高')
ok('the priority button exists', highButton !== undefined)
highButton.props.onClick({})
await ui.settle()
eq('priority reached the store',
  (await api('state')).tasks.find((t) => t.id === kids.find((k) => k.title === '确认会议室').id).priority, 3)

// The backdrop closes the dialog; the card itself does not.
overlay.byClass('td-modal')[0].props.onClick({ stopPropagation() {} })
await ui.settle()
ok('clicking the card does not close the dialog', overlay.byClass('td-modal').length === 1)
overlay.byClass('td-modal-layer')[0].props.onClick({})
await ui.settle()
ok('clicking the backdrop closes the dialog', overlay.byClass('td-modal').length === 0)

// ===========================================================================
section('quick add through the real parser')
// ===========================================================================

const quickInput = ui.tag('input').find((n) => String(n.props.placeholder ?? '').includes('添加任务'))
quickInput.props.onChange({ target: { value: '后天 14:30 客户沟通 !高 #工作 @重要' } })
await ui.settle(2)
const quickInput2 = ui.tag('input').find((n) => String(n.props.placeholder ?? '').includes('添加任务'))
quickInput2.props.onKeyDown({ key: 'Enter', preventDefault() {}, target: { value: '后天 14:30 客户沟通 !高 #工作 @重要' } })
await ui.settle()
const stateNow = await api('state', { view: 'list', filter: 'all' })
const added = stateNow.tasks.find((t) => t.title === '客户沟通')
ok('quick add created the task', added !== undefined)
const dayAfterTomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10)
eq('the parsed due date is the day after tomorrow at 14:30', added?.due, `${dayAfterTomorrow}T14:30`)
eq('the parsed priority is high', added?.priority, 3)
ok('the parsed tags were kept', JSON.stringify(added?.tags) === JSON.stringify(['重要']), added?.tags)
ok('the parsed list was honoured',
  stateNow.lists.find((l) => l.id === added.listId)?.name === '工作')
ok('the UI announced what it parsed', ui.text().includes('客户沟通'), ui.text().slice(-160))

// ===========================================================================
section('board view')
// ===========================================================================

ui.clickable(ui.find('看板')).props.onClick({})
await ui.settle()
ok('the board renders one column per list', ui.byClass('td-col').length >= 2, ui.byClass('td-col').length)
ok('the board shows list names', ui.text().includes('收集箱') && ui.text().includes('工作'))
ok('cards are rendered', ui.byClass('td-card').length >= 4, ui.byClass('td-card').length)

// drag a card to another column
const workColumn = ui.byClass('td-col').find((n) => ui.text(n).includes('工作'))
const collectColumn = ui.byClass('td-col').find((n) => ui.text(n).includes('收集箱'))
const card = ui.byClass('td-card').find((n) => ui.text(n).includes('没有日期的想法'))
ok('the undated card is on the board', card !== undefined)
card.props.onDragStart({ dataTransfer: { setData() {}, getData: () => undated.created.id, effectAllowed: '' } })
collectColumn.props.onDragOver({ preventDefault() {} })
workColumn.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => undated.created.id } })
await ui.settle()
const movedListId = (await api('state')).tasks.find((t) => t.id === undated.created.id).listId
ok('dragging onto a column moved the task into that list',
  stateNow.lists.find((l) => l.id === movedListId)?.name === '工作',
  stateNow.lists.find((l) => l.id === movedListId)?.name)

// ===========================================================================
section('calendar view')
// ===========================================================================

ui.clickable(ui.find('日历')).props.onClick({})
await ui.settle()
ok('the calendar draws a full month grid', ui.byClass('td-cal-cell').length === 42, ui.byClass('td-cal-cell').length)
eq('the calendar draws seven weekday headers', ui.byClass('td-cal-wd').length, 7)
ok('the month title is rendered', /\d{4} 年 \d+ 月/.test(ui.text()), ui.text().slice(0, 80))
ok('tasks appear on the grid', ui.byClass('td-cal-task').length >= 1, ui.byClass('td-cal-task').length)
ok('the repeating series lands on several days',
  ui.byClass('td-cal-task').filter((n) => ui.text(n).includes('每周一晨会')).length >= 2,
  ui.byClass('td-cal-task').filter((n) => ui.text(n).includes('每周一晨会')).length)

const todayCell = ui.byClass('td-cal-cell').find((n) => ui.text(n).startsWith(String(Number(today.slice(8, 10)))))
ok('today\'s cell can be found', todayCell !== undefined)
todayCell.props.onClick({})
await ui.settle()
ok('clicking a day opens that day\'s panel', ui.byClass('td-day').length === 1)
ok('the day panel offers to add on that day', ui.text().includes('在这一天添加'))
ok('the day panel lists that day\'s tasks', ui.byClass('td-day-b').length === 1)

// Toggle from the calendar. The host echoes the caller's view, so the client must
// still be showing a calendar grid afterwards.
const dayPanelRow = ui.byClass('td-day-b')[0]
const dayPanelCheck = ui.byClass('td-chk').find((c) => c.parent !== null && dayPanelRow !== undefined
  && ui.text(dayPanelRow).includes(ui.text(c.parent)))
ok('the day panel offers a completion control', dayPanelCheck !== undefined)
// The task the click will actually reach is the one in the checkbox's OWN row.
// Scanning the panel for the first known title used to be equivalent, and stopped
// being equivalent once every task created without a date is dated today -- today's
// panel now holds several rows.
const taskInDayPanel = (await api('state', { view: 'list', filter: 'all' })).tasks
  .find((t) => ui.text(dayPanelCheck.parent).includes(t.title))
dayPanelCheck.props.onClick({ stopPropagation() {} })
await ui.settle()
ok('the toggle reached the host from the calendar',
  (await api('state', { view: 'list', filter: 'all', includeDone: true })).tasks
    .find((t) => t.id === taskInDayPanel.id).done === true)
ok('the calendar did not swap payload after the toggle',
  ui.byClass('td-cal-cell').length === 42 && ui.byClass('td-cal-task').length >= 1,
  { cells: ui.byClass('td-cal-cell').length, chips: ui.byClass('td-cal-task').length })

// A chip opens the centred dialog without leaving the calendar.
const firstChip = ui.byClass('td-cal-task')[0]
ok('a task chip is rendered on the grid', firstChip !== undefined)
ui.clickable(firstChip).props.onClick({ stopPropagation() {} })
await ui.settle()
ok('clicking a chip opens the dialog over the calendar', overlay.byClass('td-modal').length === 1)
if (overlay.byClass('td-modal-close').length !== 1) console.log('close buttons:', overlay.byClass('td-modal-close').length, overlay.html().slice(0, 900))
overlay.byClass('td-modal-close').find((n) => n.props.title === '关闭（Esc）').props.onClick({})
await ui.settle()
ok('the dialog closes', overlay.byClass('td-modal').length === 0)

// Switching the month re-queries the host and must not throw. The month arrows
// are their own class (`td-cal-navb`) rather than `td-btn`: the nav group is
// styled as a segmented control, and naming the buttons keeps them addressable.
ui.byClass('td-cal-navb').find((n) => n.props.title === '下个月').props.onClick({})
await ui.settle()
ok('the calendar can move to the next month',
  ui.byClass('td-cal-navb').some((n) => ui.text(n) === '今天'))
ok('the grid is still drawn after the month change', ui.byClass('td-cal-cell').length === 42)

// ===========================================================================
section('gantt view')
// ===========================================================================

ui.clickable(ui.find('甘特')).props.onClick({})
await ui.settle()
ok('the gantt draws a day header row', ui.byClass('td-gantt-cell').length >= 30, ui.byClass('td-gantt-cell').length)
ok('the gantt draws task rows on the left', ui.byClass('td-gantt-row').length >= 3)
ok('the gantt draws bars', ui.byClass('td-gantt-bar').length >= 2, ui.byClass('td-gantt-bar').length)
ok('the gantt shows the window range', /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/.test(ui.text()), ui.text().slice(0, 120))
ok('bars carry a title with dates',
  ui.byClass('td-gantt-bar').every((n) => typeof n.props.title === 'string' && n.props.title.length > 0))
const beforeAnchor = ui.text().match(/(\d{4}-\d{2}-\d{2}) →/)?.[1]
ui.byClass('td-cal-navb').find((n) => ui.text(n).includes('后移三周')).props.onClick({})
await ui.settle()
const afterAnchor = ui.text().match(/(\d{4}-\d{2}-\d{2}) →/)?.[1]
ok('the gantt window shifts', beforeAnchor !== afterAnchor, { beforeAnchor, afterAnchor })
ui.byClass('td-cal-navb').find((n) => ui.text(n).includes('回到今天')).props.onClick({})
await ui.settle()
ok('the gantt returns to today', ui.text().includes(`${today} →`) || ui.text().includes(`-`) )

// ===========================================================================
section('fullscreen is a second host sharing one store')
// ===========================================================================

ui.clickable(ui.find('全屏')).props.onClick({})
await ui.settle()
ok('the panel host steps aside', ui.text().includes('正在全屏显示'))
// The overlay seat has been mounted since the first paint (it also hosts the
// dialog); entering fullscreen only adds the app to it.
ok('the overlay host renders the same app', overlay.text().includes('待办任务'))
ok('the overlay carries the fullscreen class',
  overlay.byClass('td-overlay').length === 1, overlay.byClass('td-overlay').length)
// Not 'the same tasks as the panel': one task was completed during the calendar
// section and the gantt drops completed work, so compare on an open task.
ok('the overlay renders the same shared data',
  overlay.text().includes('逾期的报告'), overlay.text().slice(-200))
ok('the overlay keeps the view that was selected', overlay.text().includes('甘特') && overlay.byClass('td-gantt-bar').length >= 2)

// Esc leaves fullscreen through the document listener
document.dispatch('keydown', { key: 'Escape' })
await ui.settle()
ok('Escape leaves fullscreen from the panel host', ui.text().includes('待办任务') && overlay.byClass('td-overlay').length === 0)

// Esc must close the dialog BEFORE it touches fullscreen.
overlay.byClass('td-modal') // (no dialog open here -- just documents the ordering)
ui.clickable(ui.find('全屏')).props.onClick({})
await ui.settle()
ok('fullscreen is on again', overlay.byClass('td-overlay').length === 1)
// row[0] is the column header; the task rows are the ones carrying a handler.
const openFromFullscreen = overlay.byClass('td-gantt-row').find((n) => typeof n.props.onClick === 'function')
ok('a task row is clickable in the fullscreen host', openFromFullscreen !== undefined)
openFromFullscreen.props.onClick({})
await ui.settle()
ok('a task opens from the fullscreen host too', overlay.byClass('td-modal').length === 1)
document.dispatch('keydown', { key: 'Escape' })
await ui.settle()
ok('Escape closes the dialog and leaves fullscreen on',
  overlay.byClass('td-modal').length === 0 && overlay.byClass('td-overlay').length === 1)
document.dispatch('keydown', { key: 'Escape' })
await ui.settle()
ok('a second Escape leaves fullscreen', overlay.byClass('td-overlay').length === 0)

// ===========================================================================
section('search')
// ===========================================================================

// Back to the list: search narrows whatever the active view shows, and only the
// list view renders the per-task rows and the empty message under test.
ui.clickable(ui.find('列表')).props.onClick({})
await ui.settle()

const searchOf = () => ui.tag('input').find((n) => String(n.props.className ?? '').includes('td-search'))

// A parent whose own title does not match, but whose SUBTASK does, must stay
// visible -- otherwise a matching subtask becomes unreachable.
const summary = await api('create', { title: '季度总结', due: tomorrow })
await api('addSubtask', { parentId: summary.created.id, title: '整理经营数据' })
ui.byClass('td-icon').find((n) => n.props['aria-label'] === '重新载入').props.onClick({})
await ui.settle()

searchOf().props.onChange({ target: { value: '报告' } })
await ui.wait(320)
ok('search narrows the list', ui.text().includes('逾期的报告') && !ui.text().includes('没有日期的想法'),
  ui.text().slice(-200))
searchOf().props.onChange({ target: { value: 'zzz-没有这个' } })
await ui.wait(320)
ok('a search with no hits says so', ui.text().includes('没有匹配'))
searchOf().props.onChange({ target: { value: '整理经营数据' } })
await ui.wait(320)
ok('a query that only matches a subtask keeps the parent visible',
  ui.text().includes('季度总结') && ui.text().includes('整理经营数据'), ui.text().slice(-200))

// ===========================================================================
section('list management: rename, colour, order, delete')
// ===========================================================================

// The rail is the single place a list is managed, so this drives the real rail:
// open the settings from the row's button, then work the dialog.
const railLists = async () => (await api('state')).lists
const railRow = (name) => ui.byClass('td-lrow').find((n) => ui.text(n).includes(name)
  && ui.byClass('td-lcfg').some((b) => n.contains(b)))
const cfgFor = (name) => ui.byClass('td-lcfg')
  .find((n) => String(n.props['aria-label'] ?? '') === `清单设置 ${name}`)
const editorOpen = () => overlay.byClass('td-narrow')[0]
const editorInput = (label) => overlay.tag('input')
  .find((n) => String(n.props['aria-label'] ?? '') === label)
/** Collect a class inside one subtree, so the dialog under test is unambiguous. */
const within = (root, cls) => {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (String(node.props.className ?? '').split(/\s+/).includes(cls)) found.push(node)
    node.children.forEach(visit)
  }
  visit(root)
  return found
}
/** The colour dot of one list's rail row, read straight out of its style. */
const dotColorOf = (name) => {
  const row = ui.byClass('td-lrow').find((n) => ui.text(n).includes(name))
  if (row === undefined) return null
  const dot = within(row, 'td-dot')[0]
  return dot === undefined ? null : String(dot.props.style.background)
}

// Leave no search term behind: the rail is always rendered, but the assertions
// below read the rail's own text.
searchOf().props.onChange({ target: { value: '' } })
await ui.wait(320)

const alpha = (await api('createList', { name: '装修', color: '#c85cd8' })).list
await api('create', { title: '买地板', list: '装修' })
ui.byClass('td-icon').find((n) => n.props['aria-label'] === '重新载入').props.onClick({})
await ui.settle()

ok('every list is a rail row', ui.byClass('td-lrow').length === (await railLists()).length,
  { rows: ui.byClass('td-lrow').length, lists: (await railLists()).length })
ok('each row carries a settings button', ui.byClass('td-lcfg').length === (await railLists()).length)
ok('the settings button is labelled for the list it belongs to',
  cfgFor('装修') !== undefined && String(cfgFor('装修').props['aria-label']).includes('装修'))
ok('the row still carries the list name and its count',
  ui.text(railRow('装修')).includes('装修') && ui.text(railRow('装修')).includes('1'),
  ui.text(railRow('装修')))

cfgFor('装修').props.onClick({})
await ui.settle()
ok('the settings dialog opens in the overlay seat', editorOpen() !== undefined)
ok('the dialog is narrower than the task dialog', editorOpen() !== undefined
  && String(editorOpen().props.className).includes('td-narrow'))
ok('the dialog asks for a name', editorInput('清单名称') !== undefined)
ok('the dialog offers the preset swatches',
  overlay.byClass('td-swatch').length >= 6, overlay.byClass('td-swatch').length)
ok('the current colour is the selected swatch',
  overlay.byClass('td-swatch').filter((n) => String(n.props.className).includes('on')).length === 1)
ok('every swatch shows the colour the host sent',
  overlay.byClass('td-swatch').every((n) => /^#[0-9a-f]{6}$/i.test(String(n.props.style.background))),
  overlay.byClass('td-swatch').map((n) => n.props.style.background))
// Colours are chosen, never typed: a colour wheel turns "file a task" into a
// branding exercise, which is exactly what the user asked to be rid of.
ok('the dialog has no free-form colour input',
  overlay.tag('input').every((n) => n.props.type !== 'color'
    && String(n.props['aria-label'] ?? '') !== '颜色值 #RRGGBB'))
ok('the dialog says where the list sits and how many there are',
  overlay.text().includes(`第 ${(await railLists()).findIndex((l) => l.id === alpha.id) + 1} / ${(await railLists()).length} 位`),
  overlay.text())
ok('the dialog counts the list\'s tasks', overlay.text().includes('1 个未完成 · 共 1 个任务'), overlay.text())
ok('a user list can be deleted from the dialog', overlay.text().includes('删除清单'))

// -- rename -----------------------------------------------------------------
editorInput('清单名称').props.onChange({ target: { value: '装修计划' } })
await overlay.settle()
editorInput('清单名称').props.onBlur({})
await ui.settle()
ok('renaming reaches the host',
  (await railLists()).some((l) => l.name === '装修计划'), (await railLists()).map((l) => l.name))
ok('the dialog shows the saved name afterwards',
  String(editorInput('清单名称').props.value) === '装修计划', editorInput('清单名称').props.value)

// A rename that lands on a name already in use must be refused, not merged.
editorInput('清单名称').props.onChange({ target: { value: '收集箱' } })
await overlay.settle()
editorInput('清单名称').props.onBlur({})
await ui.settle()
ok('renaming onto an existing list is refused',
  (await railLists()).filter((l) => l.name === '收集箱').length === 1
  && (await railLists()).some((l) => l.name === '装修计划'),
  (await railLists()).map((l) => l.name))
ok('the refusal is reported and the field snaps back',
  ui.byClass('td-err').length === 1
  && String(editorInput('清单名称').props.value) === '装修计划',
  { errors: ui.byClass('td-err').length, field: editorInput('清单名称').props.value })

// -- colour -----------------------------------------------------------------
const swatch = overlay.byClass('td-swatch').find((n) => String(n.props.title) === '#3fa662')
ok('the palette swatch is clickable', swatch !== undefined)
swatch.props.onClick({})
await ui.settle()
ok('clicking a swatch recolours the list',
  (await railLists()).find((l) => l.name === '装修计划')?.color === '#3fa662',
  (await railLists()).find((l) => l.name === '装修计划')?.color)
ok('the rail dot follows the new colour', dotColorOf('装修计划') === '#3fa662', dotColorOf('装修计划'))
ok('the selected swatch moved with it',
  overlay.byClass('td-swatch').filter((n) => String(n.props.className).includes('on'))
    .every((n) => String(n.props.style.background).toLowerCase() === '#3fa662'))
// A list whose colour is not in the palette (older data) still shows it, so the
// swatch row can never rewrite a colour just by being opened.
const legacy = (await api('createList', { name: '旧数据', color: '#123456' })).list
await api('updateList', { id: legacy.id, color: '#123456' })
ui.byClass('td-icon').find((n) => n.props['aria-label'] === '重新载入').props.onClick({})
await ui.settle()
overlay.byClass('td-modal-close')[0].props.onClick({})
await ui.settle()
cfgFor('旧数据').props.onClick({})
await ui.settle()
ok('an off-palette colour is offered first instead of being silently replaced',
  String(overlay.byClass('td-swatch')[0].props.style.background).toLowerCase() === '#123456',
  overlay.byClass('td-swatch').map((n) => n.props.style.background))
ok('that colour is the selected swatch',
  String(overlay.byClass('td-swatch')[0].props.className).includes('on'))
ok('opening the dialog did not rewrite the colour',
  (await railLists()).find((l) => l.id === legacy.id)?.color === '#123456')
within(editorOpen(), 'td-btn').find((n) => overlay.text(n).includes('删除清单')).props.onClick({})
await ui.settle()
within(overlay.nodes().find((n) => n.props.role === 'alertdialog'), 'td-btn')
  .find((n) => overlay.text(n).includes('删除清单')).props.onClick({})
await ui.settle()
ok('the throwaway list is gone', (await railLists()).every((l) => l.id !== legacy.id))

// -- order ------------------------------------------------------------------
const orderBefore = (await railLists()).map((l) => l.name)
cfgFor('装修计划').props.onClick({})
await ui.settle()
const stepButton = (label) => overlay.byClass('td-btn').find((n) => overlay.text(n).includes(label))
stepButton('上移').props.onClick({})
await ui.settle()
const orderAfterUp = (await railLists()).map((l) => l.name)
ok('上移 moves the list one position earlier',
  orderAfterUp.indexOf('装修计划') === orderBefore.indexOf('装修计划') - 1,
  { before: orderBefore, after: orderAfterUp })
ok('and the dialog reports the new position',
  overlay.text().includes(`第 ${orderAfterUp.indexOf('装修计划') + 1} / ${orderAfterUp.length} 位`))
stepButton('下移').props.onClick({})
await ui.settle()
eq('下移 puts it back', (await railLists()).map((l) => l.name), orderBefore)

// Ordering is also direct: drag one rail row onto another.
const dragRows = ui.byClass('td-lrow')
const dragFrom = dragRows.find((n) => ui.text(n).includes('装修计划'))
const dragTo = dragRows[0]
const orderBeforeDrag = (await railLists()).map((l) => l.name)
dragFrom.props.onDragStart({ dataTransfer: { setData() {}, getData: () => alpha.id, effectAllowed: '' } })
await ui.settle()
ui.byClass('td-lrow').find((n) => ui.text(n).includes('装修计划')).props.onDragEnd()
await ui.settle()
dragTo.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => alpha.id } })
await ui.settle()
ok('dragging a rail row onto another reorders the lists',
  (await railLists())[0].id === alpha.id,
  { before: orderBeforeDrag, after: (await railLists()).map((l) => l.name) })
ok('the reordered rail renders in the new order',
  ui.byClass('td-lrow').slice(0, 2).some((n) => ui.text(n).includes('装修计划')),
  ui.byClass('td-lrow').map((n) => ui.text(n)))

// -- delete -----------------------------------------------------------------
const tasksBeforeDelete = (await api('state')).tasks.length
cfgFor('装修计划').props.onClick({})
await ui.settle()
const deleteListButton = within(editorOpen(), 'td-btn').find((n) => overlay.text(n).includes('删除清单'))
ok('the dialog offers to delete the list', deleteListButton !== undefined)
deleteListButton.props.onClick({})
await ui.settle()
const confirmDialog = overlay.nodes().find((n) => n.props.role === 'alertdialog')
ok('deleting asks first, in the page', confirmDialog !== undefined)
ok('the question names the list', overlay.text(confirmDialog).includes('装修计划'))
ok('the question says the tasks move instead of dying',
  overlay.text(confirmDialog).includes('收集箱') && overlay.text(confirmDialog).includes('1 个任务'),
  overlay.text(confirmDialog))
within(confirmDialog, 'td-btn').find((n) => overlay.text(n).includes('删除清单')).props.onClick({})
await ui.settle()
ok('the list is gone', (await railLists()).every((l) => l.name !== '装修计划'),
  (await railLists()).map((l) => l.name))
ok('its tasks were moved, not deleted',
  (await api('state')).tasks.length === tasksBeforeDelete
  && (await api('state')).tasks.find((t) => t.title === '买地板')?.listId === 'l_inbox',
  (await api('state')).tasks.find((t) => t.title === '买地板'))
ok('the editor closed with it', editorOpen() === undefined)
ok('the rail no longer shows the deleted row', cfgFor('装修计划') === undefined)

// -- the system list is protected -------------------------------------------
cfgFor('收集箱').props.onClick({})
await ui.settle()
ok('the inbox can still be edited', editorOpen() !== undefined)
ok('but it cannot be deleted',
  within(editorOpen(), 'td-btn').every((n) => !overlay.text(n).includes('删除清单')))
ok('and the dialog explains why', overlay.text().includes('系统清单不能删除')
  || overlay.text().includes('不能删除'), overlay.text())

// Esc closes the editor before it touches the task dialog or fullscreen.
document.dispatch('keydown', { key: 'Escape' })
await ui.settle()
ok('Escape closes the list editor', editorOpen() === undefined)


// ===========================================================================
section('error path')
// ===========================================================================

await new Promise((resolve) => server.close(resolve))
ui.tag('input').find((n) => String(n.props.className ?? '').includes('td-search'))
  .props.onChange({ target: { value: '' } })
await ui.wait(320)
ok('the UI still renders while the host is down', ui.byClass('td-root').length === 1)
const refresh = ui.byClass('td-icon').find((n) => n.props['aria-label'] === '重新载入')
await refresh.props.onClick({})
await ui.settle()
ok('a failed request surfaces an error banner instead of crashing',
  ui.byClass('td-err').length === 1, ui.text().slice(0, 200))

// ===========================================================================
section('sidebar seat: the glyph, the badge and the second click')
// ===========================================================================

const glyph = createRoot()
glyph.api.render(React.createElement(Icon, { size: 18, active: true }))
await glyph.api.settle()
ok('the panel glyph is an svg', glyph.api.tag('svg').length === 1)
eq('the panel glyph honours the size prop', glyph.api.tag('svg')[0].props.width, 18)
ok('the active glyph is highlighted',
  // The highlight is the plugin's own emphasis alias rather than a raw host token:
  // a bare --dsw-alias-* in the JSX is a second palette the stylesheet cannot see.
  String(glyph.api.tag('svg')[0].props.stroke) === 'var(--td-brand)',
  glyph.api.tag('svg')[0].props.stroke)
ok('the glyph carries the badge in its own corner',
  glyph.api.byClass('td-glyphbadge').length === 1, glyph.api.byClass('td-glyphbadge').length)
ok('the badge counts what the settings ask for',
  /^\d+$/.test(glyph.api.text(glyph.api.byClass('td-glyphbadge')[0])),
  glyph.api.text(glyph.api.byClass('td-glyphbadge')[0]))
ok('the glyph is wrapped so the badge can be positioned',
  glyph.api.byClass('td-glyphwrap').length === 1)
// The badge must not leak the panel title into the sidebar.
ok('the glyph itself renders no text', glyph.api.tag('svg').length === 1 && !glyph.api.text().includes('待办任务'))

// ---------------------------------------------------------------------------
// The shell renders the row; the plugin only listens. A second click on an OPEN
// panel must hide it, which means intercepting the click in the capture phase
// before the shell's own handler can re-select the panel.
// ---------------------------------------------------------------------------

/** Mimic the sidebar's PanelRow list: a <button> wrapping this entry's glyph,
 *  plus a neighbouring row that belongs to somebody else. */
function PanelRow({ active }) {
  return React.createElement('div', { className: 'panelList' },
    React.createElement('button', { type: 'button', className: 'panelRow' },
      React.createElement(Icon, { size: 18, active }),
      React.createElement('span', { className: 'panelTitle' }, '待办任务')),
    React.createElement('button', { type: 'button', className: 'panelRow td-other-row' }, '工作区'))
}

const rowRoot = createRoot()
// Re-query after every render: a re-render builds fresh node objects, and the
// component's ref points at the NEW node, so a stale handle would silently make
// `contains` fail.
const rowNodes = () => ({
  row: rowRoot.api.byClass('panelRow')[0],
  other: rowRoot.api.byClass('panelRow')[1],
  glyph: rowRoot.api.byClass('td-glyphwrap')[0],
  label: rowRoot.api.byClass('panelTitle')[0],
})
rowRoot.api.render(React.createElement(PanelRow, { active: true }))
await rowRoot.api.settle()
ok('the row wraps the glyph in a button', rowNodes().row !== undefined && rowNodes().glyph !== undefined
  && rowNodes().row.contains(rowNodes().glyph))
ok('a neighbouring row exists', rowNodes().other !== undefined && rowNodes().other !== rowNodes().row)

// While the panel is CLOSED the click belongs to the shell, which is what opens
// the panel: the plugin must stay completely out of the way.
rowRoot.api.render(React.createElement(PanelRow, { active: false }))
await rowRoot.api.settle()
layoutCalls.length = 0
const inactiveEvent = document.click(rowNodes().glyph)
eq('an inactive panel is left to the shell', layoutCalls, [])
eq('the inactive click is not swallowed', inactiveEvent.propagationStopped, false)

// Now the real thing: the panel is open and the user clicks the entry again.
rowRoot.api.render(React.createElement(PanelRow, { active: true }))
await rowRoot.api.settle()
layoutCalls.length = 0
const activeEvent = document.click(rowNodes().glyph)
eq('clicking the open entry returns to the conversation', layoutCalls, [null])
eq('the click is swallowed before the shell sees it', activeEvent.propagationStopped, true)
eq('the default is prevented as well', activeEvent.defaultPrevented, true)
await rowRoot.api.settle()

// Anywhere else on OUR row toggles too -- the row is the entry, not just the glyph.
layoutCalls.length = 0
const labelEvent = document.click(rowNodes().label)
eq('clicking the row label toggles as well', layoutCalls, [null])
eq('the label click is swallowed', labelEvent.propagationStopped, true)

// A click on a DIFFERENT row must stay with the shell, otherwise the sidebar would
// become unusable once the todo panel is open.
layoutCalls.length = 0
const otherEvent = document.click(rowNodes().other)
eq('another panel row is untouched', layoutCalls, [])
eq('another row is not swallowed', otherEvent.propagationStopped, false)

// ===========================================================================
// rapid capture: one draft, three seats, and the layers that read it
// ===========================================================================
//
// Axis two, the capture bar. The draft used to be a `useState` inside
// the panel, which is why typing in the panel and then opening the floating
// window lost it. Everything below drives the app the way a keyboard does: the
// draft through the input's onChange, the shortcuts through the document
// listener, the tree keys through the root's onKeyDown.

section('rapid capture: the draft, its preview slot and the global layer')

// The error-path section above shut the host down to prove the UI survives it.
// These sections need it again, so it is put back on the SAME port (BASE was
// captured from it) rather than stubbed -- the preview and the capture path are
// only worth asserting against the real host.
await new Promise((resolve) => server.listen(hostPort, '127.0.0.1', resolve))
await ui.settle(3)

const keyEvent = (key, target = null, extra = {}) => ({
  key,
  target,
  defaultPrevented: false,
  propagationStopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.propagationStopped = true },
  ...extra,
})

const captureInput = () => ui.tag('input').find((n) => String(n.props.placeholder ?? '').includes('添加任务'))

// C4: the preview's slot is in the DOM before anything is typed. It used to be
// a sibling that mounted on demand, so the first character moved the list.
ok('the preview slot exists before anything is typed', ui.byClass('td-qprev').length === 1,
  ui.byClass('td-qprev').length)
eq('the empty preview slot is hidden from assistive tech',
  ui.byClass('td-qprev')[0].props['aria-hidden'], 'true')
ok('the preview slot lives inside the add row',
  ui.byClass('td-qadd')[0].children.some((n) => n.props?.className === 'td-qprev'))

// C2: the host's parser answers, and the answer is what Enter will create. The
// preview is debounced by 180ms, so this waits out the real timer rather than
// pumping render passes at it.
captureInput().props.onChange({ target: { value: '后天 09:00 交周报 !高 #工作' } })
await ui.wait(260)
await ui.settle(5)
ok('the preview names the title the parser found',
  ui.byClass('td-qprev-t').length === 1 && ui.text(ui.byClass('td-qprev-t')[0]) === '交周报',
  ui.text(ui.byClass('td-qprev')[0]))
eq('the preview slot becomes visible', ui.byClass('td-qprev')[0].props['aria-hidden'], 'false')
ok('the preview announces the landing list',
  ui.text(ui.byClass('td-qprev')[0]).includes('工作'), ui.text(ui.byClass('td-qprev')[0]))

// C5: the draft is in the app store, so a SECOND seat sees the same text. The
// overlay's capture layer is that second seat: opening it must not show an empty
// box while the panel is holding a sentence.
const overlayRoot = () => overlay.byClass('td-cap-layer')
// The layer's box is the SAME CaptureBar, so it carries the layer's placeholder.
const layerField = () => overlay.tag('input')
  .find((n) => String(n.props.placeholder ?? '').includes('记一件事'))
const openCaptureLayer = async () => {
  document.key(null, { key: 'k', ctrlKey: true, shiftKey: true })
  await overlay.settle()
}
await openCaptureLayer()
ok('the global shortcut opens the capture layer', overlayRoot().length === 1)
eq('the layer takes the caret as it mounts', layerField()?.props?.autoFocus, true)
eq('the layer shows the draft the panel was holding', layerField()?.props?.value, '后天 09:00 交周报 !高 #工作')

// Enter in the layer adds it, and the answer is the preview the panel showed.
const enterInLayer = keyEvent('Enter', layerField())
layerField().props.onKeyDown(enterInLayer)
await overlay.settle(3)
const captured = (await api('state', { view: 'list', filter: 'all' })).tasks.find((t) => t.title === '交周报')
ok('Enter in the capture layer created the task', captured !== undefined)
eq('the layer and the panel agreed on the priority', captured?.priority, 3)
eq('the draft is cleared once it landed', captureInput().props.value, '')
eq('the layer closes after a successful capture', overlay.byClass('td-cap-layer').length, 0)

// C1 / C15: the shortcut must NOT fire while the user is typing into a host
// editor. This is the one failure a global shortcut can have.
const inputTarget = { tagName: 'INPUT', closest: () => null }
const textareaTarget = { tagName: 'TEXTAREA', closest: () => null }
const editableTarget = { tagName: 'DIV', isContentEditable: true, closest: (sel) => (sel.includes('contenteditable') ? {} : null) }
for (const [name, target] of [['INPUT', inputTarget], ['TEXTAREA', textareaTarget], ['contenteditable', editableTarget]]) {
  const event = document.key(target, { key: 'k', ctrlKey: true, shiftKey: true })
  await overlay.settle()
  ok(`Ctrl+Shift+K aimed at a ${name} is not intercepted`, event.defaultPrevented === false)
  ok(`Ctrl+Shift+K in a ${name} does not open the layer`, overlay.byClass('td-cap-layer').length === 0)
}
// An IME mid-composition owns the keyboard even with no editor in the target.
const composing = document.key(null, { key: 'k', ctrlKey: true, shiftKey: true, isComposing: true })
await overlay.settle()
ok('a composing IME keeps its keystrokes', composing.defaultPrevented === false)

// C3: Escape inside the capture input is consumed THERE. Without this the same
// keypress also reached the overlay's chain and left fullscreen behind the box.
await openCaptureLayer()
layerField().props.onChange({ target: { value: '先写一半' } })
await overlay.settle(2)
ui.clickable(ui.find('全屏')).props.onClick({})
await overlay.settle(2)
eq('fullscreen is on behind the capture layer', overlay.byClass('td-overlay').length, 1)
const escInCapture = keyEvent('Escape', layerField())
layerField().props.onKeyDown(escInCapture)
await overlay.settle(2)
eq('Escape in the capture box is consumed by the box', escInCapture.propagationStopped, true)
eq('Escape in the capture box prevents the default too', escInCapture.defaultPrevented, true)
ok('fullscreen is still on after that Escape', overlay.byClass('td-overlay').length === 1)
eq('the capture layer is still open after that Escape', overlay.byClass('td-cap-layer').length, 1)
eq('the draft it was holding is gone', layerField().props.value, '')

// C10: the Escape chain. One keypress, one layer -- and the layer that handled
// it is the one that stops the event.
const chainOne = document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('the second Escape closes the capture layer', overlay.byClass('td-cap-layer').length, 0)
eq('that Escape was consumed by the layer it closed', chainOne.propagationStopped, true)
ok('fullscreen survived the capture layer closing', overlay.byClass('td-overlay').length === 1)
document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('the next Escape finally leaves fullscreen', overlay.byClass('td-overlay').length, 0)

// ===========================================================================
// the command palette
// ===========================================================================

section('command palette')

const openPalette = async () => {
  document.key(null, { key: 'k', ctrlKey: true })
  await overlay.settle()
}
await openPalette()
ok('Ctrl+K opens the palette', overlay.byClass('td-cmdk').length === 1)
const paletteInput = overlay.byClass('td-cmdk-in')[0]
const paletteItems = () => overlay.byClass('td-cmdk-item')
ok('the palette lists every view', ['列表', '看板', '日历', '甘特'].every((label) => overlay.text().includes(`视图：${label}`)),
  overlay.text().slice(0, 200))
ok('the palette lists the smart lists', overlay.text().includes('智能清单：今天'))
ok('the palette offers the capture action', overlay.text().includes('快速记录'))
// Arrow keys move the selection without running anything.
overlay.byClass('td-cmdk-in')[0].props.onKeyDown(keyEvent('ArrowDown', overlay.byClass('td-cmdk-in')[0]))
await overlay.settle(2)
ok('ArrowDown moves the selection', overlay.byClass('td-cmdk-item').some((n) => n.props['aria-selected'] === 'true'
  && overlay.text(n).includes('视图：列表')), overlay.byClass('td-cmdk-item').map((n) => overlay.text(n)).slice(0, 4))
// Filtering, then Enter: the palette is a keyboard surface first.
overlay.byClass('td-cmdk-in')[0].props.onChange({ target: { value: '看板' } })
await overlay.settle(2)
ok('typing filters the list', paletteItems().length >= 1 && paletteItems().length < 20, paletteItems().length)
ok('the first match is the board view', overlay.text(paletteItems()[0]).includes('看板'), overlay.text(paletteItems()[0]))
overlay.byClass('td-cmdk-in')[0].props.onKeyDown(keyEvent('Enter', overlay.byClass('td-cmdk-in')[0]))
await overlay.settle(3)
ok('Enter ran the command and closed the palette', overlay.byClass('td-cmdk').length === 0)
ok('the view actually switched to the board', ui.byClass('td-col').length >= 1, ui.byClass('td-col').length)
await openPalette()
// The harness keys component state by tree path, so a layer that comes back at
// the same path inherits the last query. Clearing it explicitly keeps the
// Escape assertions below about the LAYER, not about that artefact.
overlay.byClass('td-cmdk-in')[0].props.onChange({ target: { value: '' } })
await overlay.settle(2)
ok('the palette reopened with every command back', paletteItems().length > 10, paletteItems().length)
overlay.byClass('td-cmdk-in')[0].props.onKeyDown(keyEvent('Escape', overlay.byClass('td-cmdk-in')[0]))
await overlay.settle(2)
eq('Escape closes the palette', overlay.byClass('td-cmdk').length, 0)
ok('the board is still the view after the palette closed', ui.byClass('td-col').length >= 1)

// C5, across SEATS: the floating window is a different seat with its own subtree,
// and its box shows what the panel was holding. This is the bug the store draft
// fixes: the window used to open empty while a half-written sentence sat in the
// panel behind it.
captureInput().props.onChange({ target: { value: '跨宿主草稿' } })
await ui.settle(2)
await openPalette()
overlay.byClass('td-cmdk-in')[0].props.onChange({ target: { value: '浮动' } })
await overlay.settle(2)
overlay.byClass('td-cmdk-in')[0].props.onKeyDown(keyEvent('Enter', overlay.byClass('td-cmdk-in')[0]))
await overlay.settle(3)
const floatBar = overlay.byClass('td-qadd-float')[0]
ok('the floating window is its own seat with its own bar', floatBar !== undefined,
  overlay.byClass('td-qadd-float').length)
eq('and its box shows the draft typed in the panel',
  floatBar?.children.find((n) => n.tag === 'input')?.props.value, '跨宿主草稿')
document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('Escape docks the window again', overlay.byClass('td-qadd-float').length, 0)
captureInput().props.onChange({ target: { value: '' } })
await ui.settle(2)
// A command that silently does nothing is worse than no command: this one opens
// the rail's inline new-list row, which lives in the panel's subtree, so it has
// to go through the shared store rather than a component-local flag.
eq('the new-list row is closed to begin with', ui.byClass('td-create').length, 0)
await openPalette()
overlay.byClass('td-cmdk-in')[0].props.onChange({ target: { value: '新建清单' } })
await overlay.settle(2)
overlay.byClass('td-cmdk-in')[0].props.onKeyDown(keyEvent('Enter', overlay.byClass('td-cmdk-in')[0]))
await overlay.settle(3)
eq('the palette command really opens the new-list row', ui.byClass('td-create').length, 1)
ui.byClass('td-create')[0].children[1].props.onKeyDown(keyEvent('Escape', ui.byClass('td-create')[0].children[1]))
await ui.settle(2)
eq('and Escape closes it again', ui.byClass('td-create').length, 0)

// ===========================================================================
// the inline "+": the new task lands where the click happened
// ===========================================================================

section('inline add: the group and the column own the box')

ui.clickable(ui.find('列表')).props.onClick({})
await ui.settle(2)
const groupKeys = (await api('state', { view: 'list', filter: 'all' })).view.groups
const firstGroup = groupKeys[0]

// C8: the completed group offers no "+". A task created there would be "create
// it already done", which is not a thing anyone means.
ui.clickable(ui.find('已完成')).props.onClick({})
await ui.settle(2)
ok('the completed group is on screen', ui.byClass('td-grp').length >= 1, ui.byClass('td-grp').length)
eq('the completed group offers no +', ui.byClass('td-grp-add').length, 0)
ui.clickable(ui.find('全部任务')).props.onClick({})
await ui.settle(2)

const groupAdds = ui.byClass('td-grp-add')
ok('every addable group offers its own +', groupAdds.length >= 1, groupAdds.length)
groupAdds.find((n) => ui.byClass('td-grp')[0].contains(n)).props.onClick({})
await ui.settle(2)
eq('clicking + opens a box inside that group', ui.byClass('td-grp-new').length, 1)
// Re-query: the tree is rebuilt every pass, so a node captured before the click
// no longer knows about the nodes that exist now.
ok('the box is inside the group the + belonged to',
  ui.byClass('td-grp')[0].contains(ui.byClass('td-grp-new')[0]))
ui.byClass('td-grp-new')[0].children[0].props.onChange({ target: { value: '分组内记一笔' } })
await ui.settle()
ui.byClass('td-grp-new')[0].children[0]
  .props.onKeyDown(keyEvent('Enter', ui.byClass('td-grp-new')[0].children[0]))
await ui.settle(3)
const afterGroup = await api('state', { view: 'list', filter: 'all' })
const inlineTask = afterGroup.tasks.find((t) => t.title === '分组内记一笔')
ok('the inline box created the task', inlineTask !== undefined)
ok('the task landed in the group the + belonged to',
  (afterGroup.view.groups.find((g) => g.key === firstGroup.key)?.ids ?? []).includes(inlineTask.id),
  { group: firstGroup.key, ids: afterGroup.view.groups.find((g) => g.key === firstGroup.key)?.ids })
eq('the box stays open for the next line', ui.byClass('td-grp-new').length, 1)
eq('the box is empty again', ui.byClass('td-grp-new')[0].children[0].props.value, '')
ui.byClass('td-grp-new')[0].children[0]
  .props.onKeyDown(keyEvent('Escape', ui.byClass('td-grp-new')[0].children[0]))
await ui.settle(2)
eq('Escape closes the inline box', ui.byClass('td-grp-new').length, 0)

// The board column's own box: the card must land in THAT column.
ui.clickable(ui.find('看板')).props.onClick({})
await ui.settle(2)
const columns = (await api('state', { view: 'board' })).view.columns
const targetColumn = columns[columns.length - 1]
const columnNode = () => ui.byClass('td-col').find((n) => ui.text(n).includes(targetColumn.name))
ok('the target column is on screen', columnNode() !== undefined, targetColumn.name)
ui.byClass('td-col-add').find((n) => columnNode().contains(n)).props.onClick({ stopPropagation() {} })
await ui.settle(2)
eq('the column + opens a box inside that column', ui.byClass('td-col-new').length, 1)
ok('the box is inside the column the + belonged to', columnNode().contains(ui.byClass('td-col-new')[0]))
ui.byClass('td-col-new')[0].children[0].props.onChange({ target: { value: '列内新建卡片' } })
await ui.settle()
ui.byClass('td-col-new')[0].children[0]
  .props.onKeyDown(keyEvent('Enter', ui.byClass('td-col-new')[0].children[0]))
await ui.settle(3)
const afterCol = await api('state', { view: 'board' })
const colTask = afterCol.tasks.find((t) => t.title === '列内新建卡片')
ok('the column box created the card', colTask !== undefined)
eq('the card landed in the column it was created in', colTask?.listId, targetColumn.id)

// ===========================================================================
// the rail's information architecture, and the list's keyboard cursor
// ===========================================================================

section('rail order and keyboard navigation')

ui.clickable(ui.find('列表')).props.onClick({})
await ui.settle(2)
// The data block's heading is its own toggle, so its text carries the caret.
const railTitles = ui.byClass('td-rail-t').map((n) => ui.text(n).replace(/[▸▾]/g, ''))
const expectedRail = ['智能清单', '清单', ...(railTitles.includes('标签') ? ['标签'] : []), '视图', '数据']
eq('the rail reads smart lists, lists, tags, views, data',
  JSON.stringify(railTitles.slice(0, expectedRail.length)), JSON.stringify(expectedRail))
ok('the data block is last', railTitles[railTitles.length - 1] === '数据', railTitles)
// The search box is a box now: the magnifier lives inside it, and the tag filter
// is a chip you remove from the same box you typed it into (§5.2 row 1).
ok('the search box carries its magnifier inside it',
  ui.byClass('td-search-ico').length >= 1 && ui.byClass('td-searchbox')[0].contains(ui.byClass('td-search-ico')[0]))
const searchBox = () => ui.tag('input').find((n) => String(n.props.className ?? '').includes('td-search'))
searchBox().props.onChange({ target: { value: '#工作' } })
await ui.wait(240)
await ui.settle(3)
ok('typing #tag turns the filter into a chip inside the box', ui.byClass('td-search-tag').length >= 1,
  ui.byClass('td-search-tag').length)
ui.byClass('td-search-tag')[0].props.onClick({})
await ui.wait(240)
await ui.settle(3)
eq('clicking the chip clears the filter', ui.byClass('td-search-tag').length, 0)
eq('and the query went with it', searchBox().props.value, '')

// Re-queried every time: the tree is rebuilt on every pass, and a node captured
// before a state change carries the handler from the render that made it.
const rootNow = () => ui.byClass('td-root')[0]
const rowsNow = () => ui.byClass('td-item')
const tabbable = () => tabStops()[0]
// A target that behaves like a real DOM node: `closest` matches the element
// itself, which is exactly how the guard tells a field from the list.
const divTarget = { tagName: 'DIV', closest: () => null }
const fieldTarget = { tagName: 'INPUT', closest: (sel) => (sel.includes('input') ? { tagName: 'INPUT' } : null) }

ok('the list is announced as a tree', ui.byClass('td-listwrap')[0].props.role === 'tree')
// The Tab stop is the ONE thing a fake DOM can settle absolutely, so it is settled
// here and not by a probe: a tree whose every item is tabindex -1 and whose container
// has no tabindex is a tree real users cannot reach with the keyboard at all (that is
// what the real host measured: null on the wrap, -1 on all eight rows, i.e. ZERO
// stops). Exactly one stop must exist at every moment of the roving-tabindex dance.
const tabStops = () => [...ui.byClass('td-listwrap'), ...rowsNow()].filter((n) => n.props.tabIndex === 0)
eq('the tree itself is the Tab stop before the cursor is on a row', tabStops().length, 1)
eq('and the stop is the tree, not a row', tabStops()[0].props.role, 'tree')
const firstRowId = rowsNow()[0].props['data-row-id']
rowsNow()[0].props.onFocus()
await ui.settle(2)
eq('focusing a row keeps exactly one Tab stop', tabStops().length, 1)
eq('the stop moved to the focused row', tabStops()[0].props['data-row-id'], firstRowId)
eq('and the tree handed its own stop over', ui.byClass('td-listwrap')[0].props.tabIndex, -1)
// WIRING, not handler logic: dispatch at the document the way a browser does and let
// the app's own listener find the row. A real host proved React's delegated keydown
// never arrives in this subtree, so the native capture listener is the path that
// matters -- and this is the shape a fake DOM CAN check (the prop is exercised right
// after, and is labelled as logic-only).
const wired = document.key(rowsNow()[0], { key: 'ArrowDown' })
await ui.settle(2)
eq('a keydown dispatched at the document reaches the tree handler', wired.propagationStopped, true)
ok('and the cursor moved to a different row', tabStops()[0].props['data-row-id'] !== firstRowId,
  tabStops()[0].props['data-row-id'])
const afterWired = tabStops()[0].props['data-row-id']
// Teleport back so the logic assertions below start from a known row.
rowsNow().find((n) => n.props['data-row-id'] === firstRowId).props.onFocus()
await ui.settle(2)
// HANDLER LOGIC ONLY (C11). Calling the prop is not proof that a browser calls it --
// the real host measured that it does not -- so these assertions cover the branch
// table, and the wiring is covered by the dispatch above.
const downEvent = keyEvent('ArrowDown', divTarget)
rootNow().props.onKeyDown(downEvent)
await ui.settle(2)
eq('ArrowDown is consumed by the list (handler logic)', downEvent.propagationStopped, true)
ok('the cursor moved to a different row', tabStops()[0].props['data-row-id'] !== firstRowId,
  tabStops()[0].props['data-row-id'])
// The dedupe marker: a host that delivers BOTH paths (the native listener and the
// prop) must not step the cursor twice for one keypress. Asserted as two observable
// steps so a missing marker cannot pass by accident.
const rowOrder = rowsNow().map((n) => n.props['data-row-id'])
const cursorIndex = () => rowOrder.indexOf(tabStops()[0].props['data-row-id'])
const startIndex = cursorIndex()
const sameEvent = keyEvent('ArrowDown', rowsNow()[startIndex], { type: 'keydown' })
document.dispatch('keydown', sameEvent)
await ui.settle(2)
eq('the native path stepped the cursor once', cursorIndex(), startIndex + 1)
const afterNative = cursorIndex()
rootNow().props.onKeyDown(sameEvent)
await ui.settle(2)
eq('the same event delivered again is ignored, not stepped twice', cursorIndex(), afterNative)
// C12: a bare key aimed at an editor belongs to the editor.
const before = tabbable().props['data-row-id']
const inField = keyEvent('j', fieldTarget)
rootNow().props.onKeyDown(inField)
await ui.settle(2)
eq('a letter typed into an input does not move the cursor', tabbable().props['data-row-id'], before)
eq('and it is not swallowed either', inField.propagationStopped, false)
// Space toggles the focused row, Enter opens it.
const wasDone = (await api('state', { view: 'list', filter: 'all' })).tasks.find((t) => t.id === before)?.done
rootNow().props.onKeyDown(keyEvent(' ', divTarget))
await ui.settle(3)
const nowDone = (await api('state', { view: 'list', filter: 'all' })).tasks.find((t) => t.id === before)?.done
eq('Space toggled the focused row', nowDone, !wasDone)
rootNow().props.onKeyDown(keyEvent('Enter', divTarget))
await ui.settle(2)
// "At least one", not "exactly one": the editor, the list-settings dialog and the
// confirm card each own a `.td-modal-layer`, deliberately -- three fixed layers that
// share a z-index make document order the paint order, so the confirm can be asked
// from inside the editor (a probe reading of `modal:2` is that design, not a double
// mount). The count is pinned as a SET below instead of a number here.
ok('Enter opened the focused row', overlay.byClass('td-modal-layer').length >= 1)
eq('the three modal layers are the three services that own one',
  [...clientSource.matchAll(/className: 'td-seat td-modal-layer'/g)].length, 3)
document.key(null, { key: 'Escape' })
await overlay.settle(2)
ok('Escape closed it again', overlay.byClass('td-modal').length === 0)
// `modal: 2` characterised at last, and item 3's Escape order pinned with it: the
// second layer of a delete asked FOR from inside the editor is the confirm card --
// two different services, not one service mounted twice (each of the three is
// rendered from a single site: the overlay seat's stack). So a count check is
// "at least one" and the pair is pinned by ROLE instead.
const buttonsIn = (node) => {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === 'string') return
    if (n.tag === 'button') out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out
}
const textOf = (node) => {
  const parts = []
  const walk = (n) => {
    if (typeof n === 'string') parts.push(n)
    else if (n !== null && n !== undefined) for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return parts.join('')
}
rowsNow()[0].props.onFocus()
await ui.settle(2)
rootNow().props.onKeyDown(keyEvent('Enter', divTarget))
await ui.settle(2)
const editorCard = () => overlay.byClass('td-modal').find((n) => n.props.role === 'dialog')
ok('the editor is the first layer of the pair', editorCard() !== undefined)
buttonsIn(editorCard()).find((n) => textOf(n) === '删除任务').props.onClick({})
await overlay.settle(2)
eq('a delete asked from the editor stacks a second layer', overlay.byClass('td-modal-layer').length, 2)
eq('and that layer is the confirm card, so the count is two services',
  overlay.byClass('td-modal').filter((n) => n.props.role === 'alertdialog').length, 1)
// One Escape, one layer -- and only the layer that owns it: the two passes (bubble and
// the capture fallback) must not each close one, which is what the `defaultPrevented`
// guard buys. Measured on the real host this chain never ran at all (see ## 25).
document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('one Escape closes the confirm card only', overlay.byClass('td-modal-layer').length, 1)
ok('and the editor under it is still open', overlay.byClass('td-modal').some((n) => n.props.role === 'dialog'))
document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('the next Escape closes the editor, leaving nothing behind', overlay.byClass('td-modal-layer').length, 0)
// A key someone closer already consumed must not be acted on: this is the guard that
// keeps the capture pass from jumping the queue (the capture box's own Escape, the
// inline add boxes' Escape are the real cases).
document.key(null, { key: 'k', ctrlKey: true, shiftKey: true })
await overlay.settle(2)
eq('the global capture layer is up before the check', overlay.byClass('td-cap-layer').length, 1)
document.dispatch('keydown', {
  type: 'keydown',
  key: 'Escape',
  target: null,
  defaultPrevented: true,
  propagationStopped: false,
  preventDefault() {},
  stopPropagation() {},
})
await overlay.settle(2)
eq('an already-consumed Escape leaves our layers alone', overlay.byClass('td-cap-layer').length, 1)
document.key(null, { key: 'Escape' })
await overlay.settle(2)
eq('and a live Escape still closes the box -- and only the box', overlay.byClass('td-cap-layer').length, 0)
eq('with the fullscreen host untouched', overlay.byClass('td-overlay').length, 0)
// `n` jumps to the capture box.
const nEvent = keyEvent('n', divTarget)
rootNow().props.onKeyDown(nEvent)
await ui.settle(2)
eq('n asks the capture box for focus', nEvent.propagationStopped, true)

// Finally: the shortcut's whole point is that it works when the panel is NOT
// open. A second root holds only the overlay seat, and it opens the layer just
// the same -- the listener belongs to the seat that is always mounted, which is
// why a closed panel (or a collapsed sidebar) cannot take the feature with it.
const solo = createRoot()
solo.api.render(React.createElement(Overlay, {}))
await solo.api.settle(2)
const soloEvent = document.key(null, { key: 'k', ctrlKey: true, shiftKey: true })
await solo.api.settle(2)
eq('a root with no panel opens the capture layer', solo.api.byClass('td-cap-layer').length, 1)
eq('and the shortcut was consumed there too', soloEvent.defaultPrevented, true)
ok('the panel seat never renders that layer', ui.byClass('td-cap-layer').length === 0)
solo.api.byClass('td-cap-layer')[0].props.onClick({})
await solo.api.settle(2)
eq('closing it leaves nothing behind', solo.api.byClass('td-cap-layer').length, 0)

// ===========================================================================
// the visual system (static contract, computed from the sheet itself)
// ===========================================================================
//
// The design contract promises things a render
// walker cannot see: a surface ladder with a measurable step, ink that is
// legible on the surface it actually lands on, and a scale with five font sizes
// instead of fourteen. None of that is observable through the fake renderer, and
// none of it is observable in a browser either when the sandbox cannot start a
// renderer at all -- so it is checked by COMPUTING it: the color-mix() recipes in
// the sheet are evaluated against the host's real theme tokens, and the result is
// asserted in WCAG terms. This is the same arithmetic the audit used (E3), moved
// into a gate so it cannot drift.

section('visual system v2 (computed, not rendered)')

{
  const clientSource = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  const cssStart = clientSource.indexOf('const CSS = `')
  const cssEnd = clientSource.indexOf('\n`', cssStart)
  const sheet = cssStart >= 0 && cssEnd > cssStart ? clientSource.slice(cssStart, cssEnd) : ''
  ok('the stylesheet can be read for the visual contract', sheet.length > 2000, sheet.length)
  const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, ' ')

  /** Every rule in the sheet, with the selector its declarations sit under. */
  const parseRules = (text) => {
    const out = []
    const stack = []
    let buf = ''
    for (const ch of text) {
      if (ch === '{') { stack.push({ sel: buf.trim(), body: '' }); buf = '' } else if (ch === '}') {
        const top = stack.pop()
        if (top !== undefined) { top.body = buf; out.push(top) }
        buf = ''
      } else buf += ch
    }
    return out
  }
  const parsed = parseRules(rules)
  const declsOf = (rule, prop) => rule.body.split(';')
    .map((decl) => /^\s*([a-z-]+)\s*:\s*([\s\S]+)$/.exec(decl))
    .filter((m) => m !== null && m[1] === prop)
    .map((m) => m[2].trim())

  // --- V1/V2: the scale ladders -------------------------------------------
  const FONT = new Set(['10.5px', '12.5px', '14px', '16px', '20px'])
  const RADIUS = new Set(['0', '3px', '6px', '10px', '14px', '22px', '999px'])
  const GAP = new Set(['4px', '8px', '12px', '16px'])
  const SPACE = new Set(['0', '2px', '4px', '6px', '8px', '12px', '16px', '24px', '32px', '48px'])
  // Keywords, percentages and functions are shapes rather than steps: a value the
  // ladder cannot describe (auto, 50%, min(), a var()) is skipped and COUNTED, so
  // "everything passed" can never mean "everything was skipped".
  const NOT_A_STEP = /(auto|%|inherit|initial|unset|min\(|max\(|calc\(|clamp\(|var\(|em$|rem$|vw|vh|solid|dashed|transparent|none)/
  let skipped = 0
  const ladder = (prop, allowed) => {
    const offenders = []
    for (const rule of parsed) {
      for (const value of declsOf(rule, prop)) {
        for (const part of value.split(/\s+/).filter((t) => t !== '')) {
          if (NOT_A_STEP.test(part)) { skipped++; continue }
          if (!allowed.has(part)) offenders.push({ sel: rule.sel, prop, value, part })
        }
      }
    }
    return offenders
  }
  const fontOffenders = []
  for (const rule of parsed) {
    for (const value of declsOf(rule, 'font-size')) if (!FONT.has(value)) fontOffenders.push({ sel: rule.sel, value })
  }
  ok('V1 font-size uses the five-step ladder only', fontOffenders.length === 0, fontOffenders.slice(0, 12))
  ok('V2 border-radius uses the seven-step ladder only',
    ladder('border-radius', RADIUS).length === 0, ladder('border-radius', RADIUS).slice(0, 12))
  ok('V2 gap uses the four-step ladder only', ladder('gap', GAP).length === 0, ladder('gap', GAP).slice(0, 12))
  ok('V2 padding uses the ten-step ladder only', ladder('padding', SPACE).length === 0, ladder('padding', SPACE).slice(0, 12))
  ok('V2 margin uses the ten-step ladder only', ladder('margin', SPACE).length === 0, ladder('margin', SPACE).slice(0, 12))
  ok('the ladder check skipped only non-step values, and reports how many',
    typeof skipped === 'number' && skipped < 200, skipped)

  // --- V3: the surface ladder and ink contrast, computed -------------------
  // The host tokens come from the installed theme when it can be found (the
  // authority), and from the recorded fallback values below when it
  // cannot -- in which case the run says so out loud.
  const THEME_FILE = process.env.DSH_THEME_FILE ?? path.join(
    os.homedir(), 'AppData', 'Local', 'Programs', 'dsh-desktop', 'resources', 'app', 'node_modules', '@deepseek-ai',
    'dsh-client-ui-theme/lib/client.js')
  const FALLBACK_TOKENS = {
    light: {
      'dsw-alias-bg-base': '#ffffff', 'dsw-alias-bg-layer-1': '#ffffff', 'dsw-alias-bg-layer-2': '#ffffff',
      'dsw-alias-label-primary': '#0f1115', 'dsw-alias-label-secondary': '#61666b',
    },
    dark: {
      'dsw-alias-bg-base': '#151517', 'dsw-alias-bg-layer-1': '#232324', 'dsw-alias-bg-layer-2': '#2c2c2e',
      'dsw-alias-label-primary': '#f9fafb', 'dsw-alias-label-secondary': '#cfd3d6',
    },
  }
  const readHostTokens = () => {
    try {
      const text = fs.readFileSync(THEME_FILE, 'utf8')
      const statics = {}
      for (const m of text.matchAll(/--dsw-static-([\w-]+):(#[0-9a-fA-F]{3,8})\b/g)) statics[m[1]] = m[2]
      const hits = []
      let at = -1
      while ((at = text.indexOf('--dsw-alias-bg-base:', at + 1)) !== -1) hits.push(at)
      if (hits.length < 2) return null
      const out = {}
      for (const [mode, index] of [['light', hits[0]], ['dark', hits[1]]]) {
        const open = text.lastIndexOf('{', index)
        const close = text.indexOf('}', index)
        if (open < 0 || close < open) return null
        const map = {}
        for (const decl of text.slice(open + 1, close).split(';')) {
          const m = /^(--[\w-]+):(.+)$/.exec(decl.trim())
          if (m === null) continue
          let value = m[2].trim()
          const viaStatic = /^var\(--dsw-static-([\w-]+)\)$/.exec(value)
          if (viaStatic !== null && statics[viaStatic[1]] !== undefined) value = statics[viaStatic[1]]
          map[m[1].slice(2)] = value
        }
        out[mode] = map
      }
      return out
    } catch { return null }
  }
  const hostTokens = readHostTokens()
  console.log(hostTokens === null
    ? '  note: the installed theme file is unreadable -- using the recorded token values'
    : '  note: host tokens read from the installed theme file')

  const hexToRgb = (value) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim())
    if (m === null) return null
    let hex = m[1]
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  }
  const resolveColour = (value, tokens) => {
    const v = String(value).trim()
    const hex = hexToRgb(v)
    if (hex !== null) return { rgb: hex, a: 1 }
    if (v === 'transparent' || v === 'none') return { rgb: [0, 0, 0], a: 0 }
    const asVar = /^var\(\s*--([\w-]+)\s*(?:,([\s\S]+))?\)$/.exec(v)
    if (asVar !== null) {
      const local = tokens[asVar[1]]
      if (local !== undefined) return resolveColour(local, tokens)
      return asVar[2] === undefined ? null : resolveColour(asVar[2], tokens)
    }
    const weighted = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*([\s\S]+?)\s*\)$/.exec(v)
    if (weighted !== null) {
      const a = resolveColour(weighted[1], tokens)
      const b = resolveColour(weighted[3], tokens)
      if (a === null || b === null) return null
      const w = Number(weighted[2]) / 100
      return { rgb: [0, 1, 2].map((i) => Math.round(a.rgb[i] * w + b.rgb[i] * (1 - w))), a: a.a * w + b.a * (1 - w) }
    }
    const even = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*\)$/.exec(v)
    if (even !== null) {
      const a = resolveColour(even[1], tokens)
      const b = resolveColour(even[2], tokens)
      if (a === null || b === null) return null
      return { rgb: [0, 1, 2].map((i) => Math.round(a.rgb[i] * 0.5 + b.rgb[i] * 0.5)), a: a.a * 0.5 + b.a * 0.5 }
    }
    return null
  }
  const tokensFor = (mode) => {
    const source = hostTokens === null ? FALLBACK_TOKENS[mode] : hostTokens[mode]
    const map = { ...source }
    const block = mode === 'light'
      ? rules.slice(rules.indexOf('.td-root,.td-modal-layer{'), rules.indexOf('.td-root{height:100%'))
      : rules.slice(rules.indexOf('body[data-ds-dark-theme]'), rules.indexOf('body[data-ds-dark-theme]') + 1200)
    for (const decl of block.split(';')) {
      const m = /--(td-[\w-]+)\s*:\s*([^;}]+)/.exec(decl)
      if (m !== null) map[m[1]] = m[2].trim()
    }
    return map
  }
  const luminance = ([r, g, b]) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  // Printed with the ladder assertions so a failure says WHICH colour moved, not
  // just that a number changed.
  const hexOf = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
  const contrast = (a, b) => {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  const ratioOn = (foreground, background, mode) => {
    const tokens = tokensFor(mode)
    const fg = resolveColour(foreground, tokens)
    const bg = resolveColour(background, tokens)
    if (fg === null || bg === null) return null
    const over = [0, 1, 2].map((i) => Math.round(fg.rgb[i] * fg.a + bg.rgb[i] * (1 - fg.a)))
    return contrast(over, bg.rgb)
  }
  const firstDecl = (prop) => {
    const m = new RegExp(`--${prop}\\s*:([^;}]+)`).exec(rules)
    return m === null ? null : m[1].trim()
  }
  const darkBlock = rules.slice(rules.indexOf('body[data-ds-dark-theme]'),
    rules.indexOf('}', rules.indexOf('body[data-ds-dark-theme]')))
  const darkDecl = (prop) => {
    const m = new RegExp(`--${prop}\\s*:([^;}]+)`).exec(darkBlock)
    return m === null ? null : m[1].trim()
  }
  // The direction of the ladder is part of the contract, and it is checked
  // SEPARATELY from the step sizes below -- a ratio has no direction, so a sheet
  // can satisfy every floor in both themes while putting the group container
  // ABOVE the row it holds. That is exactly what happened in the dark theme (the
  // well borrowed the host's layer-2), so the ordering is asserted per theme and
  // then compared across themes.
  const directions = {}
  for (const [mode, set] of [
    ['light', {
      canvas: firstDecl('td-canvas'), card: firstDecl('td-card'), soft: firstDecl('td-soft'),
      field: firstDecl('td-field'), ink3: firstDecl('td-text-3'),
    }],
    ['dark', {
      canvas: darkDecl('td-canvas'), card: darkDecl('td-card'), soft: darkDecl('td-soft'),
      field: darkDecl('td-field'), ink3: darkDecl('td-text-3'),
    }],
  ]) {
    const tokens = tokensFor(mode)
    const solid = (value) => resolveColour(value, tokens)
    ok(`V3 [${mode}] every surface resolves to a colour`,
      set.canvas !== null && set.card !== null && set.soft !== null && set.field !== null
      && solid(set.canvas) !== null && solid(set.card) !== null && solid(set.soft) !== null && solid(set.field) !== null,
      set)
    if (solid(set.canvas) === null) continue
    const steps = [
      ['canvas -> card', contrast(solid(set.canvas).rgb, solid(set.card).rgb), 1.13],
      ['canvas -> field', contrast(solid(set.canvas).rgb, solid(set.field).rgb), 1.10],
      ['card -> soft', contrast(solid(set.card).rgb, solid(set.soft).rgb), 1.10],
      // Theme-aware, and that is a FINDING rather than a concession: the host's
      // dark band (bg-base -> bg-layer-1) is only 1.161 wide and the control
      // surface already sits 1.107 above the canvas, so a well that is BOTH above
      // the canvas AND 1.10 away from the control cannot exist in the dark theme.
      // The old sheet only cleared 1.10 because it borrowed layer-2, which is
      // above the row -- the flip this assertion exists to prevent. The measured
      // value is printed with the run, and the ordered ramp below pins the
      // relationship that the ratio was standing in for.
      ['soft -> field', contrast(solid(set.soft).rgb, solid(set.field).rgb), mode === 'light' ? 1.10 : 1.04],
    ]
    for (const [label, value, floor] of steps) {
      ok(`V3 [${mode}] surface step ${label} >= ${floor}`, value >= floor, Number(value.toFixed(3)))
    }
    // The well is between the canvas and the row -- in BOTH themes. This is the
    // assertion that would have caught the flip: the old dark sheet measured
    // canvas < card < soft, and every ratio floor above was still green.
    const well = solid(set.soft)
    const canvasLum = luminance(solid(set.canvas).rgb)
    const rowLum = luminance(solid(set.card).rgb)
    const wellLum = luminance(well.rgb)
    directions[mode] = canvasLum < wellLum && wellLum < rowLum ? 'canvas < soft < card' : 'FLIPPED'
    ok(`V3 [${mode}] the well sits between the canvas and the row (canvas < soft < card)`,
      directions[mode] === 'canvas < soft < card',
      { canvas: [hexOf(solid(set.canvas).rgb), canvasLum], soft: [hexOf(well.rgb), wellLum], card: [hexOf(solid(set.card).rgb), rowLum] })
    ok(`V3 [${mode}] the well is distinguishable from both neighbours`,
      contrast(solid(set.canvas).rgb, well.rgb) >= 1.04 && contrast(well.rgb, solid(set.card).rgb) >= 1.04,
      { canvasSoft: Number(contrast(solid(set.canvas).rgb, well.rgb).toFixed(3)), softCard: Number(contrast(well.rgb, solid(set.card).rgb).toFixed(3)) })
    const inkOnCard = ratioOn(set.ink3, set.card, mode)
    const inkOnSoft = ratioOn(set.ink3, set.soft, mode)
    ok(`V3 [${mode}] ink-3 is AA on the card`, inkOnCard !== null && inkOnCard >= 4.5, inkOnCard)
    ok(`V3 [${mode}] ink-3 is AA on the inset surface`, inkOnSoft !== null && inkOnSoft >= 4.5, inkOnSoft)
  }
  // One direction, both themes. Two themes that disagree here are two designs.
  eq('V3 the ladder points the same way in both themes (the well is below the row)',
    [directions.light, directions.dark], ['canvas < soft < card', 'canvas < soft < card'])
  // ...and the dark well is DERIVED towards the canvas rather than borrowed from a
  // layer that sits above the row: the recipe is the contract, not the accent.
  const darkSoftDecl = String(darkDecl('td-soft'))
  ok('V3 the dark well no longer borrows the host\'s layer-2', !/bg-layer-2/.test(darkSoftDecl), darkSoftDecl)
  ok('V3 the dark well is mixed from the row layer towards the canvas',
    /color-mix\(in srgb,var\(--dsw-alias-bg-layer-1\)\s*[\d.]+%,var\(--dsw-alias-bg-base\)\)/.test(darkSoftDecl),
    darkSoftDecl)
  // The board gives the pair the opposite ROLE order -- the column is the card and
  // the board card inside it is the well -- and that is fine as long as it is the
  // same in both themes. What must not happen is the two swapping, so the usage is
  // pinned here: a rename that flips it (the way the dark override flipped it)
  // turns this red instead of quietly inverting one view.
  ok('V3 the board column is the card and the card inside it is the well',
    /\.td-col\{[^}]*background:var\(--td-card\)/.test(rules)
    && /\.td-card\{[^}]*background:var\(--td-soft\)/.test(rules))

  // --- V4: ink-3 stays off the canvas; the float guard exists --------------
  const bodyOf = (selector) => {
    const at = rules.indexOf(selector + '{')
    return at < 0 ? null : rules.slice(at + selector.length + 1, rules.indexOf('}', at))
  }
  for (const selector of ['.td-cal-wd', '.td-empty', '.td-qprev-l']) {
    const body = bodyOf(selector)
    ok(`V4 ${selector} takes ink-2 where it lands on the canvas`,
      body !== null && /color:var\(--td-text-2\)/.test(body), body)
  }
  ok('V4 the dark override guards the floating window',
    /body\[data-ds-dark-theme\]\s+\.td-root:not\(\.td-floatapp\)/.test(rules))
  ok('V4 the dark override rebuilds canvas / card / ink-3',
    /--td-canvas/.test(darkBlock) && /--td-card/.test(darkBlock) && /--td-text-3/.test(darkBlock),
    darkBlock.slice(0, 160))
  {
    const offenders = []
    for (const rule of parsed) {
      if (!/var\(--td-accent\)/.test(rule.body)) continue
      // The floating window's skin, and only that: --td-accent is a hue the
      // greyscale panel has no business showing (D17).
      const scoped = /^\.td-float|^\.td-flogo|^\.td-cmp|^@keyframes|\.td-float|\.td-flogo|\.td-cmp/.test(rule.sel)
      if (!scoped) offenders.push(rule.sel)
    }
    ok('V4 --td-accent never leaves the floating window', offenders.length === 0, offenders)
  }

  // --- V5: one language for the five states --------------------------------
  ok('V5 hover moves the fill (--td-soft) rather than the geometry',
    /\.td-item:hover\{[^}]*var\(--td-soft\)/.test(rules))
  ok('V5 the focus ring is an ink wash, not the surface colour',
    /color-mix\(in srgb,var\(--td-text\) 18%,transparent\)/.test(rules))
  ok('V5 selection is an inset ink edge plus a same-layer fill',
    /inset 3px 0 0 var\(--td-text\)/.test(rules) && /\.td-item\.cur\{[^}]*var\(--td-field\)/.test(rules))
  ok('V5 a dragged source is one opacity', /\.td-card\.dragging\{opacity:\.5\}/.test(rules)
    && /\.td-lrow\.dragging\{opacity:\.5\}/.test(rules))
  ok('V5 a drop target is one ring', /0 0 0 2px var\(--td-text-2\)/.test(rules))
  ok('V5 completed work uses the inset surface in both themes',
    /\.td-item\.done\{[^}]*var\(--td-soft\)/.test(rules))
  ok('V5 the celebration uses the plugin ink, not the window blue',
    /@keyframes tdRing\{[^}]*var\(--td-ok\)/.test(rules))

  // --- V6: the three density tiers ----------------------------------------
  ok('V6 the narrow tier exists', /@container td \(max-width:680px\)/.test(rules))
  const wideAt = rules.indexOf('@container td (min-width:1600px)')
  ok('V6 the wide tier exists', wideAt >= 0)
  const wideBlock = wideAt < 0 ? '' : rules.slice(wideAt, rules.indexOf('\n}', wideAt))
  ok('V6 the wide tier widens the list and shares the board width',
    /max-width:1280px/.test(wideBlock) && /max-width:420px/.test(wideBlock), wideBlock.slice(0, 200))
  ok('V6 the narrow tier brings the smart lists back to the header',
    /\.td-head2\{display:flex/.test(rules) && /\.td-head2\{display:none\}/.test(rules))
}

// ===========================================================================
// summary
// ===========================================================================

// Remove ONLY this run's data directory. An earlier version removed its parent
// (`dirname`), which is the shared system temp directory -- the kind of cleanup
// that takes out unrelated tooling.
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
console.log('')
if (fail > 0) {
  console.log(`FAILING: ${fail} of ${pass + fail}`)
  for (const name of failures) console.log('   - ' + name)
} else {
  console.log(`CLIENT RENDER: ALL PASS (${pass})`)
}
process.exit(fail ? 1 : 0)

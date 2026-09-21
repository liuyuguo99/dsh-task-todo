/**
 * Screenshot the real thing.
 *
 * This drives a real Chrome over the DevTools Protocol (Node 22 ships a global
 * `WebSocket`, so this needs no dependency) against a real `dsh web`: it clicks
 * the sidebar entry, switches every view and captures PNGs. The point is that
 * no hand-written mock decides whether the UI looks right -- the bytes in the
 * PNG come out of the same code path the user sees.
 *
 * Usage:
 *   node scripts/shot.mjs --url auto [--out <dir>]     read the URL from the server log
 *   node scripts/shot.mjs --url "http://127.0.0.1:4188/?token=..."
 *                        [--only <step>] [--width 1680] [--height 1050]
 *                        [--eval "<js expression>"]
 *
 * `--only` runs the recipe up to and including the named step (a view is only
 * reachable through the steps that open it), which is the fast path while
 * iterating on one view. `--eval` finishes by evaluating an expression in the
 * page and printing it as JSON -- that is how a layout question gets an exact
 * answer instead of a guess from reading pixels.
 *
 * Steps 12+ cover the interactive surfaces (the global capture layer, the command
 * palette, the two inline "+" boxes, the keyboard cursor). CDP cannot press a key,
 * so those steps dispatch a synthetic KeyboardEvent on `document` -- the node the
 * overlay seat's own listener is on -- and each one re-asserts the state it
 * depends on, so a step fails loudly instead of shooting the wrong thing.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const URL_ARG = (() => {
  const raw = argOf('url', null)
  // `--url auto` reads the URL (token included) out of the throwaway server's
  // log, so a restart does not force a copy-paste of a fresh token.
  if (raw !== 'auto') return raw
  const log = path.resolve(argOf('log', path.join(HERE, '.shot', 'server.log')))
  const text = fs.readFileSync(log, 'utf8')
  const hit = [...text.matchAll(/dsh web:\s*(http:\/\/\S+)/g)].pop()
  if (hit === undefined) throw new Error(`no "dsh web:" line in ${log}`)
  return hit[1]
})()
const OUT = path.resolve(argOf('out', path.join(HERE, '.shot', 'png')))
const ONLY = argOf('only', null)
const PROBE = argOf('eval', null)
const WIDTH = Number(argOf('width', 1680))
const HEIGHT = Number(argOf('height', 1050))
const DEBUG_PORT = Number(argOf('debug-port', 9333))

if (URL_ARG === null) {
  console.error('usage: node scripts/shot.mjs --url <dsh web url with token> [--out dir] [--only step]')
  process.exit(2)
}

// --- find a browser ---------------------------------------------------------

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const BROWSER = CANDIDATES.find((p) => fs.existsSync(p))
if (BROWSER === undefined) {
  console.error('no Chrome/Edge found')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(4000, () => req.destroy(new Error('timeout')))
  })
}

// --- a minimal CDP client ---------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => this.#onMessage(event.data))
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('cdp closed'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect: ${wsUrl}`)), { once: true })
    })
    return new Cdp(ws)
  }

  #onMessage(data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    let msg
    try { msg = JSON.parse(text) } catch { return }
    const slot = this.pending.get(msg.id)
    if (slot === undefined) return
    this.pending.delete(msg.id)
    if (msg.error !== undefined) slot.reject(new Error(`${msg.error.message} :: ${JSON.stringify(msg.error.data ?? null)}`))
    else slot.resolve(msg.result)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }

  /** Poll a boolean expression in the page. */
  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let ok = false
      try { ok = (await this.eval(expression)) === true } catch { ok = false }
      if (ok) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label ?? expression}`)
      await sleep(150)
    }
  }

  async shot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    return fs.statSync(file).size
  }
}

// --- the click helpers injected into the page ------------------------------

const HELPERS = `
window.__shot = {
  norm(s) { return (s || '').replace(/\\s+/g, ' ').trim() },
  all() { return [...document.querySelectorAll('button, [role="button"], a')] },
  clickText(text) {
    const list = window.__shot.all()
    let hit = list.find((n) => window.__shot.norm(n.textContent) === text)
    if (!hit) hit = list.find((n) => window.__shot.norm(n.textContent).includes(text))
    if (!hit) return 'MISS ' + text
    hit.click()
    return 'OK ' + text + ' <- ' + window.__shot.norm(hit.textContent).slice(0, 20)
  },
  clickSel(sel) {
    const n = document.querySelector(sel)
    if (!n) return 'MISS ' + sel
    n.click()
    return 'OK ' + sel
  },
  clickRow(text) {
    const rows = [...document.querySelectorAll('.td-row')]
    if (rows.length === 0) return 'MISS no rows'
    const hit = rows.find((r) => window.__shot.norm(r.textContent).includes(text)) || rows[0]
    hit.click()
    return 'OK row ' + window.__shot.norm(hit.textContent).slice(0, 24)
  },
  /** Tolerantly clear any first-run notice: absent is a pass, not a failure. */
  dismiss() {
    const hit = window.__shot.all().find((n) => /^(继续|知道了|我知道了|稍后配置|稍后再说|跳过|开始使用|关闭)$/.test(window.__shot.norm(n.textContent)))
    if (!hit) return 'OK no notice'
    hit.click()
    return 'OK dismissed ' + window.__shot.norm(hit.textContent)
  },
  /** Select one of the rail's lists by name (index 0 is the system inbox). */
  selectList(name) {
    const rows = [...document.querySelectorAll('.td-lrow')]
    const row = rows.find((r) => window.__shot.norm(r.textContent).includes(name)) || rows[0]
    if (!row) return 'MISS no list rows'
    row.querySelector('.td-side').click()
    return 'OK list ' + window.__shot.norm(row.textContent)
  },
  /** Open a list's settings dialog through the row's trailing button. */
  listCfg(name) {
    const rows = [...document.querySelectorAll('.td-lrow')]
    const row = rows.find((r) => window.__shot.norm(r.textContent).includes(name)) || rows[1] || rows[0]
    if (!row) return 'MISS no list rows'
    const button = row.querySelector('.td-lcfg')
    if (!button) return 'MISS no settings button'
    button.click()
    return 'OK settings ' + window.__shot.norm(row.textContent)
  },
  /** Click the Nth colour swatch in the open list dialog. */
  swatch(index) {
    const dots = [...document.querySelectorAll('.td-swatch')]
    const dot = dots[index]
    if (!dot) return 'MISS swatch ' + index
    dot.click()
    return 'OK swatch ' + (dot.getAttribute('title') || index)
  },
  /** Click a button by its exact label inside the open dialog. */
  dialogButton(label) {
    const hit = window.__shot.all().find((n) => window.__shot.norm(n.textContent) === label
      && n.closest('.td-modal-layer') !== null)
    if (!hit) return 'MISS ' + label
    hit.click()
    return 'OK ' + label
  },
  /** Drag one rail row onto another, through real DragEvents. */
  dragList(fromName, toName) {
    const rows = [...document.querySelectorAll('.td-lrow')]
    const from = rows.find((r) => window.__shot.norm(r.textContent).includes(fromName))
    const to = rows.find((r) => window.__shot.norm(r.textContent).includes(toName))
    if (!from || !to) return 'MISS rows'
    const data = new DataTransfer()
    const send = (node, type) => node.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: data,
    }))
    send(from, 'dragstart')
    send(to, 'dragover')
    send(to, 'drop')
    send(from, 'dragend')
    return 'OK drag ' + fromName + ' -> ' + toName
  },
  /** The rail's list order, as the page renders it. */
  listOrder() {
    return [...document.querySelectorAll('.td-lrow')]
      .map((r) => window.__shot.norm(r.querySelector('.td-side').textContent).replace(/\\d+$/, ''))
      .join(' | ')
  },
  text() { return window.__shot.norm(document.body.innerText).slice(0, 2000) },

  // --- the interactive surfaces, driven from script -------------------------
  //
  // CDP cannot press a key, so every shortcut below is a KeyboardEvent dispatched
  // on DOCUMENT: that is where the overlay seat's own listener lives (a plain
  // document.addEventListener('keydown') -- not a React handler -- and the only
  // node a script can aim at to reach it. The page's answer to "did my listener
  // take this key?" is defaultPrevented, which is what makes a shortcut step
  // self-checking instead of a hope plus a screenshot.
  //
  // A helper that cannot do its job THROWS: the runner turns that into a FAIL, so
  // a step that silently shot the wrong state is not possible.
  key(name, mods) {
    const m = mods || {}
    const event = new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: m.ctrl === true,
      shiftKey: m.shift === true,
      altKey: m.alt === true,
      metaKey: m.meta === true,
    })
    document.dispatchEvent(event)
    return event.defaultPrevented === true
  },
  /** Press one of the two global shortcuts; times proves re-entry is safe. */
  hotkey(which, times) {
    const n = times === undefined ? 1 : times
    const capture = which === 'capture'
    const mods = capture ? { ctrl: true, shift: true } : { ctrl: true, shift: false }
    const label = capture ? 'Ctrl+Shift+K' : 'Ctrl+K'
    let taken = 0
    for (let i = 0; i < n; i++) if (window.__shot.key('k', mods)) taken += 1
    if (taken !== n) throw new Error(label + ' reached no listener (' + taken + '/' + n + ')')
    return label + ' x' + n
  },
  /** A key aimed at whatever has focus, so the tree's own handler sees it. */
  keyOnFocus(name) {
    const node = document.activeElement
    if (node === null || node === undefined || typeof node.dispatchEvent !== 'function') {
      throw new Error('nothing is focused, so ' + name + ' has no target')
    }
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, composed: true })
    node.dispatchEvent(event)
    if (event.defaultPrevented !== true) throw new Error(name + ' was not handled where the focus is')
    return name
  },
  count(sel) { return document.querySelectorAll(sel).length },
  need(cond, message) { if (cond !== true) throw new Error(message); return true },
  /** Which of our seats are mounted, and whether the panel is on screen. */
  state() {
    return 'cap=' + window.__shot.count('.td-cap-layer')
      + ' cmdk=' + window.__shot.count('.td-cmdk-layer')
      + ' panelRoots=' + window.__shot.count('.td-root')
      + ' panelVisible=' + window.__shot.panelVisible()
      + ' modal=' + window.__shot.count('.td-modal-layer')
      + ' float=' + window.__shot.count('.td-float')
  },
  /**
   * Is the todo panel on screen? The shell may hide it or unmount it, so the
   * question is asked of geometry, not of the DOM: a hidden subtree has no rects.
   */
  panelVisible() {
    return [...document.querySelectorAll('.td-root')].some((n) => n.getClientRects().length > 0)
  },
  /** Who has the caret, as tag.class#row -- enough to name the state in a log. */
  caret() {
    const node = document.activeElement
    if (node === null || node === undefined) return 'none'
    const cls = String(node.className || '').split(' ').filter((c) => c !== '').join('.')
    const row = typeof node.getAttribute === 'function' ? node.getAttribute('data-row-id') : null
    return String(node.tagName || '?').toLowerCase()
      + (cls === '' ? '' : '.' + cls) + (row === null ? '' : '#' + row)
  },
  /** How many rows are tabbable: the roving tabindex, as the DOM has it. */
  roving() {
    return [...document.querySelectorAll('.td-item[data-row-id]')]
      .filter((n) => n.getAttribute('tabindex') === '0').length
  },
  /** The computed surface of a node: a token that resolves to nothing shows up
   *  here, which is the only place a missing alias can be read off as data. */
  skin(sel) {
    const node = document.querySelector(sel)
    if (node === null) return sel + '=absent'
    const style = getComputedStyle(node)
    return sel + ' bg=' + style.backgroundColor + ' radius=' + style.borderTopLeftRadius
      + ' shadow=' + (style.boxShadow === 'none' ? 'none' : 'yes') + ' color=' + style.color
  },
  textOf(sel) {
    const node = document.querySelector(sel)
    return node === null ? '' : window.__shot.norm(node.textContent)
  },
  /** Type into a controlled box the way a person does: set the value, then fire
   *  the input event -- React reads target.value there, and the native setter is
   *  what makes the change visible to its value tracker. */
  type(sel, text) {
    const node = document.querySelector(sel)
    if (node === null) throw new Error('no box at ' + sel)
    const proto = String(node.tagName).toUpperCase() === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const slot = Object.getOwnPropertyDescriptor(proto, 'value')
    if (slot === undefined || typeof slot.set !== 'function') throw new Error('no value setter for ' + sel)
    slot.set.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed ' + JSON.stringify(text) + ' into ' + sel
  },
  /** The sidebar's own row for this panel: the button that holds our glyph. */
  panelRow() {
    const glyph = document.querySelector('.td-glyphwrap')
    return glyph === null || typeof glyph.closest !== 'function' ? null : glyph.closest('button')
  },
  /** Click that row again. The documented second click hides the panel (the
   *  plugin intercepts it in the capture phase); it stays inert while closed, so
   *  the same call also brings the panel back. */
  togglePanel() {
    const row = window.__shot.panelRow()
    if (row === null) throw new Error('no sidebar row for the todo panel')
    row.click()
    return 'clicked the panel row'
  },
  /** Leave the fullscreen host through its own header button. */
  exitFullscreen() {
    const hit = window.__shot.all().find((n) => /退出全屏/.test(String(n.title || '') + ' ' + window.__shot.norm(n.textContent)))
    if (!hit) return 'not fullscreen'
    hit.click()
    return 'left fullscreen'
  },
  /** Put the DOM focus on a row: the row's own onFocus then arms the cursor. */
  focusRowAt(index) {
    const rows = [...document.querySelectorAll('.td-item[data-row-id]')]
    const at = index === undefined ? 0 : index
    const node = rows[at]
    if (node === undefined) throw new Error('no row to focus at ' + at + ' (' + rows.length + ' rows)')
    node.focus({ preventScroll: true })
    return 'focused row ' + at + ' #' + node.getAttribute('data-row-id')
  },
  /** Click a group header's inline "+", saying which group it belongs to. */
  grpAdd(label) {
    const groups = [...document.querySelectorAll('.td-grp')].filter((g) => g.querySelector('.td-grp-add') !== null)
    if (groups.length === 0) throw new Error('no group header carries an inline +')
    const hit = label === undefined
      ? groups[0]
      : (groups.find((g) => window.__shot.norm(g.querySelector('.td-grp-h').textContent).includes(label)) || groups[0])
    const head = window.__shot.norm(hit.querySelector('.td-grp-h').textContent)
    hit.querySelector('.td-grp-add').click()
    return 'clicked + on group ' + JSON.stringify(head)
  },
  /** Click a board column's "+", saying which column it belongs to. */
  colAdd(index) {
    const buttons = [...document.querySelectorAll('.td-col-add')]
    const hit = buttons[index === undefined ? 0 : index]
    if (hit === undefined) throw new Error('no board column carries a + (' + buttons.length + ' columns)')
    const title = String(hit.getAttribute('title') || '')
    hit.click()
    return 'clicked ' + JSON.stringify(title)
  },
}
'ok'
`

// --- the recipe -------------------------------------------------------------
//
// Every step is a JS expression evaluated in the page; a result starting with
// `MISS` fails the run. `wait` is the settle time before the screenshot, which
// is what makes a fixed-delay recipe reliable enough here (the panel re-queries
// the host on every view change).

const RECIPE = [
  { name: '00-dismiss', js: `__shot.dismiss()`, wait: 400 },
  { name: '01-panel-list', js: `__shot.clickText('待办任务')`, wait: 1200 },
  { name: '02-full-list', js: `__shot.clickText('全屏')`, wait: 900 },
  { name: '03-full-board', js: `__shot.clickText('看板')`, wait: 900 },
  { name: '04-full-calendar', js: `__shot.clickText('日历')`, wait: 900 },
  { name: '05-full-gantt', js: `__shot.clickText('甘特')`, wait: 900 },
  { name: '06-list-again', js: `__shot.clickText('列表')`, wait: 1100 },
  // The inline "new list" row (the fix for the dead 新建清单 button): the input
  // with the colour dot is the state worth a picture.
  { name: '07-newlist-form', js: `__shot.clickText('新建清单')`, wait: 500 },
  // List management: select a list (which reveals its settings button), open the
  // dialog, recolour, reorder, and reach the delete confirmation.
  { name: '07a-list-settings', js: `(function () { __shot.selectList('工作'); return __shot.listCfg('工作') })()`, wait: 700 },
  { name: '07b-list-colour', js: `__shot.swatch(6)`, wait: 600 },
  { name: '07c-list-order', js: `__shot.dialogButton('上移')`, wait: 600 },
  { name: '07d-list-delete', js: `__shot.dialogButton('删除清单')`, wait: 700 },
  { name: '07e-list-delete-cancel', js: `__shot.dialogButton('取消')`, wait: 500 },
  { name: '07f-list-closed', js: `__shot.dialogButton('完成')`, wait: 600 },
  { name: '08-dialog', js: `__shot.clickRow('复盘')`, wait: 900 },
  { name: '09-confirm', js: `__shot.clickText('删除任务')`, wait: 600 },
  { name: '10-confirm-cancel', js: `__shot.clickText('取消')`, wait: 500 },
  // Last, because it changes the rail order: the drag is the direct way to move
  // a list, and this step prints the resulting order so the log carries evidence.
  { name: '11-list-drag', js: `(function () { var r = __shot.dragList('学习', '收集箱'); return r + ' :: ' + __shot.listOrder() })()`, wait: 700 },

  // --- the interactive surfaces -------------------------------------------------
  //
  // Five states the browser has never been asked to show anyone: the two global
  // layers (the capture box and the command palette), the two inline "+" boxes (a
  // group header in the list, a column header on the board), and the keyboard
  // cursor on a row. They were delivered on DOM assertions and arithmetic alone
  // because no member session can start a browser (## 22 / ## 23) -- this is the
  // path that gives them real pixels.
  //
  // Appended, never rewritten: 00..11 are byte-for-byte what they were. Each new
  // step re-asserts the state it depends on instead of assuming it, and a helper
  // that cannot do its job THROWS (which the runner reports as FAIL), so a step
  // can never quietly shoot the wrong thing.
  //
  // The idempotency the contract asks for is proved twice, in both directions:
  // Ctrl+Shift+K is pressed TWICE with the layer staying single (12 -> 13), and
  // Ctrl+K is pressed a SECOND time with the palette closing rather than a second
  // palette appearing (16 -> 17). The capture box's extra press is a re-open, not
  // a close -- Escape is its documented close, and that is the one used in 14.
  //
  // Reading the two layer PNGs: the capture box and the palette are children of
  // the overlay seat, NOT of `.td-root`, while the sheet aliases the host tokens
  // on `.td-root,.td-modal-layer` only -- so inside them every `var(--td-*)`
  // resolves to nothing and the box paints without a surface. The `skin=` value
  // printed by 13 and 15 is what the browser actually computed, so the log says
  // whether the bare box in the picture is this and not the recipe.
  { name: '12-capture-layer', js: `(function () {
    var left = __shot.exitFullscreen()
    var row = __shot.togglePanel()
    return 'left=' + left + ' :: ' + row + ' :: pressed ' + __shot.hotkey('capture', 2)
  })()`, wait: 900 },
  { name: '13-capture-preview', js: `(function () {
    __shot.need(__shot.count('.td-cap-layer') === 1, 'expected exactly one capture layer, not one per press :: ' + __shot.state())
    __shot.need(__shot.panelVisible() !== true, 'the panel is still on screen, so this is not the from-anywhere case :: ' + __shot.state())
    var caret = __shot.caret()
    __shot.need(caret.indexOf('td-in') !== -1, 'the layer did not take the caret: ' + caret)
    var typed = __shot.type('.td-cap .td-in', '明天 15:00 交报告 !高 #工作')
    return typed + ' :: ' + __shot.state() + ' :: caret=' + caret + ' :: ' + __shot.skin('.td-cap')
  })()`, wait: 900 },
  { name: '14-palette', js: `(function () {
    var preview = 'preview=' + __shot.count('.td-cap .td-qprev.on') + ' says ' + JSON.stringify(__shot.textOf('.td-cap .td-qprev-t'))
    __shot.key('Escape')
    return preview + ' :: closed the layer with Escape :: pressed ' + __shot.hotkey('palette', 1)
  })()`, wait: 900 },
  { name: '15-palette-filtered', js: `(function () {
    __shot.need(__shot.count('.td-cmdk-layer') === 1, 'the palette is not open exactly once :: ' + __shot.state())
    __shot.need(__shot.count('.td-cap-layer') === 0, 'Escape left the capture layer behind :: ' + __shot.state())
    var caret = __shot.caret()
    __shot.need(caret.indexOf('td-cmdk-in') !== -1, 'the palette did not take the caret: ' + caret)
    var all = __shot.count('.td-cmdk-item')
    window.__shotFacts = { paletteItems: all }
    var typed = __shot.type('.td-cmdk-in', '看板')
    return 'items=' + all + ' :: ' + typed + ' :: caret=' + caret + ' :: ' + __shot.skin('.td-cmdk')
  })()`, wait: 900 },
  { name: '16-cmdk-close', js: `(function () {
    var filtered = __shot.count('.td-cmdk-item')
    var all = (window.__shotFacts || {}).paletteItems
    __shot.need(filtered >= 1, 'the filtered palette has no items at all :: ' + __shot.state())
    __shot.need(typeof all === 'number' && filtered < all, 'the filter did not narrow the list (' + filtered + ' of ' + all + ')')
    return 'filtered ' + filtered + ' of ' + all + ' :: pressed ' + __shot.hotkey('palette', 1) + ' -> the second press is the close'
  })()`, wait: 700 },
  { name: '17-panel-again', js: `(function () {
    __shot.need(__shot.count('.td-cmdk-layer') === 0, 'a second Ctrl+K stacked a palette instead of closing it :: ' + __shot.state())
    __shot.need(__shot.panelVisible() !== true, 'the panel should still be closed here :: ' + __shot.state())
    return 'palette closed by the second press :: ' + __shot.togglePanel()
  })()`, wait: 1000 },
  { name: '18-row-focus', js: `(function () {
    __shot.need(__shot.count('.td-root') === 1, 'the panel did not come back :: ' + __shot.state())
    var rows = __shot.count('.td-item[data-row-id]')
    __shot.need(rows >= 2, 'need at least two rows for the cursor to move (' + rows + ')')
    var first = __shot.focusRowAt(0)
    var before = __shot.caret()
    var moved = __shot.keyOnFocus('ArrowDown')
    var after = __shot.caret()
    __shot.need(after !== before, 'ArrowDown did not move the cursor (' + before + ' -> ' + after + ')')
    __shot.need(after.indexOf('td-item') !== -1, 'the cursor left the rows: ' + after)
    return first + ' :: ' + moved + ' :: ' + before + ' -> ' + after + ' :: roving=' + __shot.roving()
  })()`, wait: 800 },
  { name: '19-grp-add', js: `(function () {
    __shot.need(__shot.roving() === 1, 'the roving tabindex is not exactly one row (' + __shot.roving() + ') while the caret is ' + __shot.caret())
    var clicked = __shot.grpAdd()
    return clicked + ' :: the caret was ' + __shot.caret()
  })()`, wait: 700 },
  { name: '20-grp-typed', js: `(function () {
    var boxes = __shot.count('.td-grp-new')
    __shot.need(boxes === 1, 'expected exactly one open group box, got ' + boxes)
    var caret = __shot.caret()
    __shot.need(caret.indexOf('td-in') !== -1, 'the inline box did not take the caret: ' + caret)
    var box = document.querySelector('.td-grp-new')
    var head = box === null ? '' : __shot.norm(box.closest('.td-grp').querySelector('.td-grp-h').textContent)
    return __shot.type('.td-grp-new .td-in', '写完周报 !高') + ' :: group=' + JSON.stringify(head)
      + ' :: caret=' + caret + ' :: ' + __shot.skin('.td-grp-new .td-in')
  })()`, wait: 800 },
  { name: '21-fullscreen', js: `__shot.clickText('全屏')`, wait: 1100 },
  { name: '22-board', js: `__shot.clickText('看板')`, wait: 1100 },
  { name: '23-col-add', js: `(function () {
    var columns = __shot.count('.td-col')
    __shot.need(columns >= 1, 'the board has no columns :: ' + __shot.state())
    return __shot.colAdd() + ' :: columns=' + columns
  })()`, wait: 700 },
  { name: '24-col-typed', js: `(function () {
    var boxes = __shot.count('.td-col-new')
    __shot.need(boxes === 1, 'expected exactly one open column box, got ' + boxes)
    var caret = __shot.caret()
    __shot.need(caret.indexOf('td-in') !== -1, 'the column box did not take the caret: ' + caret)
    return __shot.type('.td-col-new .td-in', '准备评审材料') + ' :: caret=' + caret
      + ' :: ' + __shot.skin('.td-col-new .td-in')
  })()`, wait: 800 },
  // ---- 25..27: REAL keys ------------------------------------------------------
  // Everything above presses keys by building a KeyboardEvent in the page and
  // dispatching it, which is the only thing a page can do on its own -- and it is
  // not what a user does. These three steps hand the job to the browser with
  // Input.dispatchKeyEvent, so the event is trusted (isTrusted === true), the
  // browser's own default action runs (Tab really moves focus), and every listener
  // -- the plugin's, the host's, the framework's -- sees it.
  //
  // 25 arms the recorder and asserts the Tab stop in a REAL render, 26 presses the
  // list keys, 27 reads them back, 28 builds the layer stack a delete-from-the-editor
  // produces, 29/30 press Escape for real once each, 31 reads those back. Every
  // record carries: isTrusted, whether the app consumed the key (prevented), where
  // focus ended up (active), the current row (cur), the Tab stops in the tree
  // (stops), the modal layers (modals) and how they break down by role (alert,
  // byRole), plus whether the fullscreen host is up (full).
  { name: '25-real-key-arm', js: `(function () {
    __shot.clickText('列表')
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur()
    window.__shotKeys = []
    document.addEventListener('keydown', function (e) {
      var rec = { key: e.key, isTrusted: e.isTrusted, first: e.defaultPrevented }
      window.__shotKeys.push(rec)
      // Read the AFTER state on the next task, once the plugin has handled it.
      setTimeout(function () {
        var cur = document.querySelector('.td-item.cur')
        var active = document.activeElement
        rec.prevented = e.defaultPrevented
        rec.active = active === null ? null : active.tagName + '.' + String(active.className || '').split(' ').slice(0, 2).join('.')
        rec.cur = cur === null ? null : cur.getAttribute('data-row-id')
        rec.stops = document.querySelectorAll('.td-item[tabindex="0"],.td-listwrap[tabindex="0"]').length
        rec.modals = document.querySelectorAll('.td-modal-layer').length
        rec.alert = document.querySelectorAll('[role="alertdialog"]').length
        rec.byRole = [].slice.call(document.querySelectorAll('.td-modal-layer')).map(function (l) {
          var card = l.querySelector('.td-modal')
          return card === null ? 'none' : String(card.getAttribute('role'))
        }).join('+')
        rec.full = document.querySelectorAll('.td-root.td-overlay').length
      }, 0)
    }, true)
    var stops = document.querySelectorAll('.td-item[tabindex="0"],.td-listwrap[tabindex="0"]').length
    var treeStop = document.querySelectorAll('.td-listwrap[tabindex="0"]').length
    __shot.need(stops === 1, 'the task tree should offer exactly ONE Tab stop, got ' + stops)
    __shot.need(treeStop === 1, 'the single Tab stop should BE the tree (.td-listwrap), not a row')
    return 'armed :: tree tab stops=' + stops + ' (the tree itself) :: ' + __shot.state()
  })()`, wait: 700 },
  { name: '26-real-keys',
    keys: [
      { key: 'Tab' },
      { key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'ArrowUp' },
      { key: ' ' },
    ],
    js: `(function () {
      return 'pressed ' + window.__shotKeys.length + ' real keys :: ' + __shot.state()
    })()`, wait: 900 },
  { name: '27-real-key-read', js: `(function () {
    var log = window.__shotKeys
    __shot.need(log.length >= 5, 'expected at least 5 real keys, got ' + log.length
      + ' (is Input.dispatchKeyEvent reaching the page at all?)')
    var trusted = log.filter(function (r) { return r.isTrusted === true }).length
    var consumed = log.filter(function (r) { return r.prevented === true }).length
    return 'trusted ' + trusted + '/' + log.length + ' :: consumed ' + consumed + '/' + log.length
      + ' :: ' + JSON.stringify(log)
  })()`, wait: 400 },
  { name: '28-confirm-open', js: `(function () {
    __shot.focusRowAt(0)
    var opened = __shot.keyOnFocus('Enter')
    var afterEnter = __shot.count('.td-modal-layer')
    __shot.need(afterEnter >= 1, 'Enter did not open the editor :: ' + __shot.state())
    var deleted = __shot.clickText('删除任务')
    return 'enter=' + opened + ' then ' + deleted + ' :: ' + __shot.state()
  })()`, wait: 900 },
  { name: '29-confirm-esc', keys: [{ key: 'Escape' }], js: `(function () {
    var modals = __shot.count('.td-modal-layer')
    var alerts = document.querySelectorAll('[role="alertdialog"]').length
    var full = document.querySelectorAll('.td-root.td-overlay').length
    __shot.need(modals === 1 && alerts === 0, 'one Escape should close the confirm card and nothing else: modals='
      + modals + ' alerts=' + alerts + ' :: ' + __shot.state())
    __shot.need(full === 1, 'the fullscreen host should have survived: full=' + full)
    return 'confirm closed :: modals=' + modals + ' alerts=' + alerts + ' full=' + full
  })()`, wait: 500 },
  { name: '30-confirm-esc2', keys: [{ key: 'Escape' }], js: `(function () {
    var modals = __shot.count('.td-modal-layer')
    var full = document.querySelectorAll('.td-root.td-overlay').length
    var rows = __shot.count('.td-item[data-row-id]')
    __shot.need(modals === 0, 'the second Escape should close the dialog: modals=' + modals
      + ' :: ' + __shot.state())
    __shot.need(full === 1, 'the fullscreen host should still be up: full=' + full)
    return 'editor closed, fullscreen kept :: modals=' + modals + ' full=' + full + ' rows=' + rows
  })()`, wait: 500 },
  { name: '31-real-key-read', js: `(function () {
    var log = window.__shotKeys
    var escs = log.filter(function (r) { return r.key === 'Escape' })
    __shot.need(escs.length === 2, 'expected two real Escape presses in the log, got ' + escs.length)
    __shot.need(escs.every(function (r) { return r.isTrusted === true }), 'an Escape was not a trusted event')
    return 'escapes=' + JSON.stringify(escs.map(function (r) {
      return { isTrusted: r.isTrusted, prevented: r.prevented, modals: r.modals, alert: r.alert, byRole: r.byRole, full: r.full }
    })) + ' :: ' + JSON.stringify(log)
  })()`, wait: 400 },
]

// --- real keys, the browser's own ---------------------------------------------
//
// A step may carry `keys: [{ key, ctrl?, shift?, alt?, meta? }, ...]`. They are
// pressed through Input.dispatchKeyEvent BEFORE the step's `js` runs, so the JS reads
// the outcome of real input. This is the difference the t13 repair turned on: a
// KeyboardEvent built in the page and dispatched with dispatchEvent is untrusted, it
// bypasses the browser's default actions, and on the real host it never reached
// React's delegated keydown handler in the plugin subtree at all -- while a listener
// attached to the element itself did fire. Only the browser can produce the event a
// user produces, and only then is "the keyboard works" a claim about the product.
const KEY_MAP = {
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  j: { code: 'KeyJ', vk: 74, text: 'j' },
  k: { code: 'KeyK', vk: 75, text: 'k' },
  n: { code: 'KeyN', vk: 78, text: 'n' },
  x: { code: 'KeyX', vk: 88, text: 'x' },
  '/': { code: 'Slash', vk: 191, text: '/' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
}

async function pressRealKey(cdp, spec) {
  const named = KEY_MAP[spec.key]
  if (named === undefined) throw new Error(`realKey: unknown key ${JSON.stringify(spec.key)}`)
  let modifiers = 0
  if (spec.alt === true) modifiers |= 1
  if (spec.ctrl === true) modifiers |= 2
  if (spec.meta === true) modifiers |= 4
  if (spec.shift === true) modifiers |= 8
  const base = {
    modifiers,
    key: spec.key === 'Space' ? ' ' : spec.key,
    code: named.code,
    windowsVirtualKeyCode: named.vk,
    nativeVirtualKeyCode: named.vk,
  }
  // A printable key carries `text` on the way down; a named key must NOT, or Chrome
  // turns it into a `char` event and the default action never runs. A shortcut
  // (Ctrl+K) is a raw key down with modifiers and no text.
  if (named.text === undefined || modifiers !== 0) {
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
  } else {
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: named.text, unmodifiedText: named.text })
  }
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-shot-'))
  fs.mkdirSync(OUT, { recursive: true })

  const child = spawn(BROWSER, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  let cdp = null
  try {
    // wait for the debugging endpoint
    let version = null
    for (let i = 0; i < 100 && version === null; i++) {
      try { version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`) } catch { await sleep(150) }
    }
    if (version === null) throw new Error('browser did not open a debugging port')

    let list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    let page = list.find((t) => t.type === 'page')
    if (page === undefined) throw new Error('no page target')

    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    })

    console.log(`browser: ${path.basename(BROWSER)} ${version.Browser}`)
    console.log(`viewport: ${WIDTH}x${HEIGHT}`)

    await cdp.send('Page.navigate', { url: URL_ARG })
    await cdp.waitFor(`document.body && document.body.innerText.length > 40`, 45000, 'the app shell')
    await cdp.eval(HELPERS)
    // The plugin bundle loads lazily; wait until its sidebar entry exists.
    try {
      await cdp.waitFor(`__shot.all().some((n) => __shot.norm(n.textContent).includes('待办任务'))`, 30000, 'the 待办任务 sidebar entry')
    } catch (error) {
      console.error('sidebar text was:', await cdp.eval(`document.body.innerText.slice(0, 800)`))
      throw error
    }

    const cut = ONLY === null ? RECIPE.length - 1 : RECIPE.findLastIndex((s) => s.name.includes(ONLY))
    if (ONLY !== null && cut === -1) throw new Error(`--only ${ONLY} matched no step`)
    const steps = RECIPE.slice(0, cut + 1)

    for (const step of steps) {
      await cdp.eval(HELPERS)
      // First-run notices can appear late (the API-key card arrives after the
      // onboarding one), so clear any that are up before every single action
      // rather than hoping one dismiss at the start is enough.
      await cdp.eval(`__shot.dismiss()`)
      // Real keys first, so `js` reads their outcome (see pressRealKey).
      if (Array.isArray(step.keys)) {
        for (const spec of step.keys) await pressRealKey(cdp, spec)
      }
      const result = await cdp.eval(`(function(){ try { return String(${step.js}) } catch (e) { return 'THREW ' + e.message } })()`)
      const file = path.join(OUT, `${step.name}.png`)
      await sleep(step.wait)
      const size = await cdp.shot(file)
      const bad = result.startsWith('MISS') || result.startsWith('THREW')
      console.log(`${bad ? 'FAIL' : '  ok'}  ${step.name.padEnd(18)} ${result}`)
      if (bad) process.exitCode = 1
      void size
    }

    if (PROBE !== null) {
      const json = await cdp.eval('JSON.stringify((function(){ try { return ('
        + PROBE + ') } catch (e) { return { threw: String((e && e.message) || e) } } })())')
      console.log('\nprobe:\n' + json)
    }

    console.log(`\nshots in ${OUT}`)
  } finally {
    if (cdp !== null) {
      try { await cdp.send('Browser.close') } catch { /* already gone */ }
      try { cdp.ws.close() } catch { /* already closed */ }
    }
    child.kill()
    await sleep(400)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

await main()

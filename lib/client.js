/**
 * dsh-task-todo -- browser half.
 *
 * Registers three seats:
 *
 *   sidebar.panellist        the sidebar's global panel row, between "new session"
 *                            and the workspace list: glyph + count badge, and its
 *                            id addresses the matching `main` panel
 *   main            (key todo)  the full central page: list / board / calendar / gantt
 *   shell.overlay            the frame-wide seat: the FULLSCREEN host and the
 *                            centred task dialog (one dialog, both hosts)
 *
 * Form rules for a bundle-plugin client half (each one is a recorded incident in
 * this workspace, not a style preference):
 *
 *   - React comes from `require('react')`. There is no `window.React`.
 *   - Styles are injected with `document.createElement('style')`; `styles.insert`
 *     does not exist here and calling it aborts the whole DSH boot.
 *   - Host calls are `fetch()` against this plugin's own HTTP route; there is no
 *     `host.call`.
 *   - Plain JavaScript only: no JSX, no imports, no TypeScript.
 *
 * Fullscreen and the dialog are overlaid rather than `position: fixed` inside the
 * panel. A fixed element is only truly frame-wide while no ancestor creates a
 * containing block (a `transform` anywhere above it silently traps it inside the
 * column), and `shell.overlay` is the seat that exists precisely to be above
 * everything. Both hosts share one module-level store, so toggling loses no view
 * state.
 *
 * The panel entry also hides the panel again on a second click. The shell only
 * ever SELECTS, so the click is intercepted in the capture phase on `document`,
 * before the shell's own handler (React listens at the container) can turn it into
 * a selection; see `PanelIcon`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-todo',

  factory: (require) => {
    // ---------------------------------------------------------------------
    // date helpers -- DISPLAY ONLY
    //
    // All task/date semantics (which day an occurrence lands on, what is
    // overdue, what is in "this week") are computed by the host and arrive in
    // `state.view`. The only calendar arithmetic here is the shape of the month
    // grid, which is pure presentation.
    // ---------------------------------------------------------------------

    const DAY_MS = 86400000
    const pad2 = (n) => String(n).padStart(2, '0')

    function todayStr() {
      const now = new Date()
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    }
    function parseDue(value) {
      if (typeof value !== 'string' || value.length < 10) return null
      const date = value.slice(0, 10)
      const time = value.length >= 16 ? value.slice(11, 16) : null
      return { date, time }
    }
    function dayIndexOf(dateStr) {
      const parts = String(dateStr).split('-').map(Number)
      return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS)
    }
    function dateFromIndex(index) {
      const dt = new Date(index * DAY_MS)
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
    }
    function addDaysStr(dateStr, n) { return dateFromIndex(dayIndexOf(dateStr) + n) }
    function monthOf(dateStr) { return String(dateStr).slice(0, 7) }
    function addMonthsStr(monthStr, n) {
      const parts = String(monthStr).split('-').map(Number)
      const total = parts[0] * 12 + (parts[1] - 1) + n
      return `${Math.floor(total / 12)}-${pad2(total % 12 + 1)}`
    }
    const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']

    /** '今天 15:00' / '明天' / '9月20日' / '2026-10-30' */
    function fmtDue(value, today) {
      const parsed = parseDue(value)
      if (parsed === null) return ''
      const gap = dayIndexOf(parsed.date) - dayIndexOf(today)
      let label
      if (gap === 0) label = '今天'
      else if (gap === 1) label = '明天'
      else if (gap === -1) label = '昨天'
      else if (gap === 2) label = '后天'
      else if (gap > 2 && gap <= 7) label = `周${WEEKDAY_CN[new Date(`${parsed.date}T00:00:00`).getDay()]}`
      else {
        const sameYear = parsed.date.slice(0, 4) === today.slice(0, 4)
        const [, m, d] = parsed.date.split('-').map(Number)
        label = sameYear ? `${m}月${d}日` : `${parsed.date.slice(0, 4)}年${m}月${d}日`
      }
      return parsed.time === null ? label : `${label} ${parsed.time}`
    }

    function fmtDateFull(dateStr) {
      if (typeof dateStr !== 'string' || dateStr.length < 10) return ''
      const [y, m, d] = dateStr.split('-').map(Number)
      const weekday = WEEKDAY_CN[new Date(`${dateStr}T00:00:00`).getDay()]
      return `${y}年${m}月${d}日 周${weekday}`
    }

    /**
     * A 6x7 month grid. `weekStart` is 0 (Sunday) or 1 (Monday), from settings.
     * Cells outside the month are still returned so the grid keeps its shape,
     * and the caller dims them.
     */
    function monthGrid(monthStr, weekStart) {
      const [y, m] = String(monthStr).split('-').map(Number)
      const firstIndex = Math.floor(Date.UTC(y, m - 1, 1) / DAY_MS)
      const firstWeekday = new Date(firstIndex * DAY_MS).getUTCDay()
      const lead = (firstWeekday - weekStart + 7) % 7
      const cells = []
      for (let i = 0; i < 42; i++) {
        const date = dateFromIndex(firstIndex - lead + i)
        cells.push({
          date,
          day: Number(date.slice(8, 10)),
          inMonth: date.slice(0, 7) === monthStr,
        })
      }
      return cells
    }

    function weekdayHeaders(weekStart) {
      const out = []
      for (let i = 0; i < 7; i++) out.push(WEEKDAY_CN[(weekStart + i) % 7])
      return out
    }

    function recurrenceRuleText(rec) {
      if (rec === null) return '不重复'
      const names = ['日', '一', '二', '三', '四', '五', '六']
      const unit = rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '个月'
      const n = Number(rec.interval ?? 1)
      let text = n === 1
        ? (rec.freq === 'daily' ? '每天' : rec.freq === 'weekly' ? '每周' : '每月')
        : `每 ${n} ${unit}`
      if (rec.freq === 'weekly' && Array.isArray(rec.weekdays) && rec.weekdays.length > 0) {
        text += ' ' + rec.weekdays.map((w) => `周${names[w]}`).join('、')
      }
      if (rec.until) text += `，直到 ${rec.until}`
      else if (rec.count) text += `，共 ${rec.count} 次`
      if (rec.finished === true) text += '（已结束）'
      return text
    }

    return {
    name: 'todo-client',

    // Declared so Cordis waits for the slot service before apply() runs.
    inject: ['slots', 'layout'],

    apply(ctx) {
      const slots = ctx.slots ?? ctx.get('slots')
      if (slots === undefined) {
        console.error('[todo] slots service unavailable; the todo UI is not mounted')
        return
      }

      const API = '/todo/api'
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useMemo, useRef, useCallback } = React

      // ---------------------------------------------------------------------
      // host transport
      // ---------------------------------------------------------------------

      /** POST one JSON method call to the host half. */
      async function call(method, args) {
        const res = await fetch(`${API}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = await res.json()
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
          throw new Error(payload?.error ?? '请求失败')
        }
        return payload.data
      }

      // ---------------------------------------------------------------------
      // shared app state
      //
      // One module-level store, subscribed by every mounted seat. The sidebar
      // badge and the full page must never disagree, and the fullscreen host is a
      // different React tree from the panel host, so a shared store is what keeps
      // the view/filter/drawer state across the toggle. Nothing here is a live
      // framework object: it is plain JSON from the host plus UI preferences.
      // ---------------------------------------------------------------------

      const app = {
        data: null,
        error: null,
        loading: false,
        view: 'list', // list | board | calendar | gantt
        filter: 'all', // today | week | overdue | inbox | all | done
        listId: null,
        tag: '', // exact tag filter, set by the rail's 标签 rows
        query: '',
        includeDone: false,
        openId: null, // task id shown in the editor drawer
        collapsed: {}, // parentId -> collapsed?
        fullscreen: false,
        float: false, // the draggable floating window (overlay seat)
        calMonth: null, // 'YYYY-MM' for the calendar view
        ganttAnchor: null, // 'YYYY-MM-DD' start of the gantt window
        day: null, // selected day in the calendar view
        toast: null,
        confirm: null, // { title, body, ok, danger, resolve } while a question is open
        menuList: null, // list popup for the current task
        listEditor: null, // list id whose settings dialog is open (overlay seat)
        viewBeforeFloat: null, // the view kind the float took over, put back on dock
        // -- the capture draft and the layers that read it ----------------------
        // The draft lives here, not in a component, because three seats render the
        // same input: the panel, the floating window and the global capture layer.
        // A component's state would be lost the moment the seat unmounted (which
        // is exactly the "switch seats, lose what I typed" bug), and the seats do
        // come and go -- the panel is hidden while the window is up.
        quick: '',
        qPreview: null, // the host's answer for the current draft
        quickFocus: null, // 'panel' | 'float' | 'overlay' -- a ONE-SHOT focus request
        capture: false, // the global capture layer is visible
        cmdk: false, // the command palette is visible
        // -- keyboard navigation -------------------------------------------------
        focusId: null, // the row the keyboard is on (roving tabindex)
        tagExpanded: false,
        dataOpen: false,
        // -- inline add ----------------------------------------------------------
        grpNew: null, // group key whose inline input is open
        colNew: null, // column id whose inline input is open
        // The rail's "new list" row is open. In the store, not in the panel, because
        // the command palette can open it too and a command that silently does
        // nothing is worse than no command.
        creatingList: false,
      }

      const listeners = new Set()
      function emit() { for (const fn of listeners) fn() }
      function setApp(patch) { Object.assign(app, patch); emit() }
      function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

      function useApp() {
        const [snapshot, setSnapshot] = useState(app)
        useEffect(() => subscribe(() => setSnapshot({ ...app })), [])
        return snapshot
      }

      /** The view context every state request carries, so the host can answer with
       *  exactly the slice the active view renders. */
      function viewContext(patch = {}) {
        const a = { ...app, ...patch }
        const context = {
          view: a.view,
          filter: a.filter,
          listId: a.listId,
          tag: a.tag,
          query: a.query,
          includeDone: a.includeDone,
        }
        if (a.view === 'calendar') {
          const month = a.calMonth ?? monthOf(a.data?.today ?? todayStr())
          context.from = `${month}-01`
          context.to = addDaysStr(`${month}-01`, 41)
        } else if (a.view === 'gantt') {
          const anchor = a.ganttAnchor ?? a.data?.today ?? todayStr()
          context.from = addDaysStr(anchor, -7)
          context.to = addDaysStr(anchor, 30)
        }
        return context
      }

      let inflight = 0
      /** Load (or reload) the active view's data. */
      async function refresh(patch = {}, quiet = false) {
        if (!quiet) setApp({ loading: true })
        const token = ++inflight
        try {
          const data = await call('state', viewContext(patch))
          // A slower earlier request must not overwrite a newer answer.
          if (token === inflight) setApp({ data, error: null, loading: false })
        } catch (e) {
          if (token === inflight) setApp({ error: String(e?.message ?? e), loading: false })
        }
      }

      /** Run a mutation and adopt the state the host returns with it.
       *
       *  The view context rides along, so the echoed state is the view the user is
       *  actually looking at: toggling a task on the calendar must not come back
       *  as the list payload. */
      async function mutate(method, args) {
        try {
          const result = await call(method, { ...args, view: viewContext() })
          if (result !== null && typeof result === 'object' && result.state !== undefined) {
            setApp({ data: result.state, error: null })
          }
          return result
        } catch (e) {
          setApp({ error: String(e?.message ?? e) })
          return null
        }
      }

      // ---------------------------------------------------------------------
      // the floating window
      //
      // A second surface on the SAME store, not a second app: the list it shows
      // is the list the panel shows, and the task dialog stays the overlay's, so
      // it can never be trapped inside the box. Only the box -- where it sits and
      // how big it is -- is local, and it is persisted, because a window the user
      // dragged somewhere is a preference, not a transient.
      // ---------------------------------------------------------------------

      const FLOAT_KEY = 'dsh-task-todo:float:v1'
      const FLOAT_MIN_W = 260
      const FLOAT_MIN_H = 200

      function clampNum(value, low, high) { return Math.min(Math.max(value, low), high) }

      /** The first box: the right edge under the header, where a widget belongs. */
      function floatBoxDefault() {
        const vw = typeof window === 'undefined' ? 1280 : (Number(window.innerWidth) || 1280)
        const vh = typeof window === 'undefined' ? 800 : (Number(window.innerHeight) || 800)
        const width = clampNum(Math.round(vw * 0.28), FLOAT_MIN_W, 380)
        return {
          left: vw - width - 28,
          top: 92,
          width,
          height: clampNum(vh - 200, FLOAT_MIN_H, 560),
        }
      }

      /**
       * Keep the box in the viewport with 56px of it always reachable: a window
       * dragged past an edge must still be draggable back, and a page narrowed
       * after the box was placed must not strand it off-screen.
       */
      function floatClamp(box) {
        const vw = typeof window === 'undefined' ? 1280 : (Number(window.innerWidth) || 1280)
        const vh = typeof window === 'undefined' ? 800 : (Number(window.innerHeight) || 800)
        const width = clampNum(box.width, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, vw - 24))
        const height = clampNum(box.height, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, vh - 24))
        return {
          width,
          height,
          left: clampNum(box.left, 12 - width + 56, Math.max(12, vw - 56)),
          top: clampNum(box.top, 4, Math.max(4, vh - 52)),
        }
      }

      function loadFloatBox() {
        try {
          if (typeof localStorage === 'undefined') return null
          const raw = localStorage.getItem(FLOAT_KEY)
          if (raw === null) return null
          const parsed = JSON.parse(raw)
          const box = {
            left: Number(parsed?.left), top: Number(parsed?.top),
            width: Number(parsed?.width), height: Number(parsed?.height),
          }
          if (!Object.values(box).every((n) => Number.isFinite(n))) return null
          return floatClamp(box)
        } catch { return null }
      }

      function saveFloatBox(box) {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(FLOAT_KEY, JSON.stringify(box))
        } catch { /* a host that blocks storage only loses the position */ }
      }

      /**
       * Show or hide the floating window. Every host reads one store, so there is
       * one view kind: the window shows the LIST, and the kind the container was
       * on is remembered and put back when the window is docked again.
       */
      function setFloat(on) {
        if (on === app.float) return
        if (on) {
          const was = app.view
          setApp({
            float: true, fullscreen: false, view: 'list',
            // The window has no search box, so a query typed in the panel would
            // filter it invisibly, with nothing in the window to clear it with.
            // Opening the window therefore starts from the unfiltered list.
            query: '',
            viewBeforeFloat: was === 'list' ? null : was,
          })
          if (was !== 'list') refresh({ view: 'list' }, true)
        } else {
          const back = app.viewBeforeFloat ?? 'list'
          setApp({ float: false, view: back, viewBeforeFloat: null })
          if (back !== 'list') refresh({ view: back }, true)
        }
      }

      // ---------------------------------------------------------------------
      // asking the user something
      //
      // Never window.confirm / window.prompt. A host may block those outright --
      // which is exactly why "新建清单" appeared to do nothing -- and even where
      // they work they cannot say what is about to be lost, cannot be styled, and
      // cannot be reached from the fullscreen host. Everything goes through the
      // shared store instead, and is drawn by the overlay seat.
      // ---------------------------------------------------------------------

      function askConfirm(spec) {
        return new Promise((resolve) => { setApp({ confirm: { ...spec, resolve } }) })
      }

      function settleConfirm(answer) {
        const request = app.confirm
        setApp({ confirm: null })
        if (request !== null && request !== undefined) request.resolve(answer === true)
      }

      /** Confirm, then delete. The caller never has to remember the order. */
      async function askDelete(id, title) {
        const yes = await askConfirm({
          title: '删除任务',
          body: `「${title}」和它的子任务会一起删除，这一步无法撤销。`,
          ok: '删除',
          danger: true,
        })
        if (yes) await mutate('remove', { id })
      }

      /**
       * Delete a LIST. Its tasks are never deleted -- they move to the inbox --
       * so the confirmation says exactly how many will be moved, and the view
       * filter is dropped when it pointed at the list that is going away.
       */
      async function askDeleteList(list) {
        const entry = (app.data?.counts?.byList ?? []).find((b) => b.id === list.id)
        const total = Number(entry?.total ?? 0)
        const open = Number(entry?.open ?? 0)
        const yes = await askConfirm({
          title: '删除清单',
          body: total > 0
            ? `「${list.name}」里的 ${total} 个任务（${open} 个未完成）会移到「收集箱」，清单本身被删除。这一步无法撤销。`
            : `「${list.name}」里没有任务。清单会被删除，这一步无法撤销。`,
          ok: '删除清单',
          danger: true,
        })
        if (!yes) return
        // Two pieces of UI state point at the doomed id: the open editor and the
        // rail's active filter. Left alone, the second one filters the view by a
        // list that no longer exists and the user sees an empty page.
        if (app.listEditor === list.id) setApp({ listEditor: null })
        if (app.listId === list.id) setApp({ listId: null })
        const result = await mutate('removeList', { id: list.id })
        if (result !== null && result !== undefined) {
          toast(`已删除清单「${list.name}」`
            + (result.moved > 0 ? `，${result.moved} 个任务已移到「${result.movedToName ?? '收集箱'}」` : ''))
        }
      }

      /**
       * Put a list at an absolute position. Position is what a drag expresses and
       * what the order buttons express, so both go through this one call.
       *
       * Reads the shared store rather than a component's props because the editor
       * lives in the overlay seat while the rail lives in the panel seat.
       */
      async function moveListTo(id, index) {
        const ordered = (app.data?.lists ?? []).map((l) => l.id)
        const from = ordered.indexOf(id)
        if (from < 0) return null
        if (index < 0 || index > ordered.length - 1 || index === from) return null
        return mutate('moveList', { id, index })
      }

      // ---------------------------------------------------------------------
      // backup
      //
      // Export writes a real file through a blob URL; import reads one back
      // through a file input. Both go through the host so the file that is read
      // and written is the same file the store is using -- a browser download
      // path cannot know where that is.
      // ---------------------------------------------------------------------

      function downloadJson(name, text) {
        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      }

      async function exportBackup() {
        const doc = await call('exportDocument', {})
        if (doc === null || typeof doc !== 'object') return
        const stamp = String(doc.document?.meta?.updatedAt ?? '').slice(0, 10) || todayStr()
        downloadJson(`todo-backup-${stamp}.json`, JSON.stringify(doc.document, null, 2))
        toast(`已导出待办备份（${(doc.document?.tasks ?? []).length} 个任务）`)
      }

      async function importBackup(file) {
        const text = await file.text()
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch (e) {
          setApp({ error: `备份文件不是合法 JSON：${String(e?.message ?? e)}` })
          return
        }
        const yes = await askConfirm({
          title: '导入备份',
          body: `将用「${file.name}」里的 ${(parsed?.tasks ?? []).length} 个任务替换当前全部数据，`
            + '当前数据会先自动备份到同目录。',
          ok: '导入并覆盖',
          danger: true,
        })
        if (!yes) return
        const result = await mutate('importDocument', { document: parsed })
        if (result !== null && result !== undefined) {
          toast(`已导入 ${result.tasks ?? 0} 个任务 · ${result.lists ?? 0} 个清单`)
        }
      }

      /** Copy text, with a fallback for a host that has no clipboard permission. */
      async function copyText(text) {
        try {
          await navigator.clipboard.writeText(text)
          toast('已复制')
        } catch {
          toast('复制失败，请手动选中复制')
        }
      }

      let searchTimer = null
      function reloadSoon(ms = 180) {
        if (searchTimer !== null) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => { searchTimer = null; refresh({}, true) }, ms)
      }

      function toast(text) {
        setApp({ toast: text })
        setTimeout(() => { if (app.toast === text) setApp({ toast: null }) }, 2600)
      }

      // ---------------------------------------------------------------------
      // the capture draft (one input, three seats)
      // ---------------------------------------------------------------------

      /**
       * Where focus should go back to when a layer closes.
       *
       * Not in the app store: it is a DOM node, and the store is spread into
       * render props where a node would be compared, cloned and logged. It is
       * also not state -- nothing re-renders because it changed.
       */
      let returnFocus = null

      function rememberFocus() {
        returnFocus = typeof document === 'undefined' ? null : (document.activeElement ?? null)
      }

      function restoreFocus() {
        const node = returnFocus
        returnFocus = null
        if (node === null || node === undefined) return
        if (typeof node.focus !== 'function') return
        try { node.focus({ preventScroll: true }) } catch { /* the node is gone */ }
      }

      function openCapture() {
        // A destructive question outranks a capture box: answering "delete this
        // list?" must not be interrupted by a layer that opens on top of it.
        if (app.confirm !== null) return
        rememberFocus()
        setApp({ capture: true, cmdk: false, quickFocus: 'overlay' })
      }

      function closeCapture() {
        setApp({ capture: false })
        restoreFocus()
      }

      function openCommandPalette() {
        rememberFocus()
        setApp({ cmdk: true, capture: false })
      }

      function closeCommandPalette() {
        setApp({ cmdk: false })
        restoreFocus()
      }

      /** Modifier state, for the one place a hotkey string is compared. */
      function hotkeyMatches(event, spec) {
        const parts = String(spec ?? '').split('+').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')
        if (parts.length < 2) return false
        const key = parts[parts.length - 1]
        const mods = parts.slice(0, -1)
        if (String(event.key ?? '').toLowerCase() !== key) return false
        if (mods.includes('shift') !== (event.shiftKey === true)) return false
        if (mods.includes('alt') !== (event.altKey === true)) return false
        const wantsCtrl = mods.includes('ctrl')
        // Ctrl and Cmd are the same key to the user, so either satisfies either.
        return wantsCtrl === (event.ctrlKey === true || event.metaKey === true)
      }

      /**
       * Is this event aimed at something the user is typing into?
       *
       * The host's chat box is a Lexical `contenteditable`, and stealing a key
       * from it is the one failure a global shortcut must never have. The check
       * mirrors what Lexical itself does before it handles a key.
       */
      function isEditableTarget(target) {
        if (target === null || target === undefined) return false
        if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null) return true
        if (target.isContentEditable === true) return true
        const tag = String(target.tagName ?? '').toUpperCase()
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      }

      /** Would this event insert text? Used to ignore keys while an IME composes. */
      function isComposingEvent(event) {
        return event.isComposing === true || event.keyCode === 229
      }

      /**
       * The one capture input.
       *
       * `mode` says which seat is drawing it -- panel, floating window, or the
       * global layer -- and the only things it changes are the placeholder (the
       * layer has no header to explain itself) and what Esc does when the draft
       * is empty (the layer closes; a docked bar has nowhere to go).
       */
      function CaptureBar(props) {
        const state = useApp()
        const mode = props.mode ?? 'panel'
        const inputRef = useRef(null)

        // A focus request is one-shot and addressed to ONE seat: consume it and
        // clear it, so two mounted seats cannot fight over the caret.
        useEffect(() => {
          if (state.quickFocus !== mode) return
          setApp({ quickFocus: null })
          const node = inputRef.current
          if (node !== null && typeof node.focus === 'function') {
            try { node.focus({ preventScroll: true }) } catch { /* not focusable yet */ }
          }
        }, [state.quickFocus, mode])

        const preview = state.qPreview
        const current = preview !== null && preview !== undefined && preview.text === String(state.quick ?? '').trim()
          ? preview.result
          : null
        const shown = current !== null && current !== undefined && current.empty !== true ? current : null
        const plan = shown?.plan ?? null
        const parsed = shown?.parsed ?? null
        const bits = []
        if (parsed !== null && parsed !== undefined) {
          if (parsed.priority > 0) bits.push(`优先级${PRIORITY_LABELS[parsed.priority] ?? parsed.priority}`)
          if (parsed.due) bits.push(fmtDue(parsed.due, app.data?.today ?? todayStr()))
          if (parsed.recurrence) bits.push(recurrenceRuleText(parsed.recurrence))
          const tags = Array.isArray(parsed.tags) ? parsed.tags : []
          if (tags.length) bits.push(tags.map((x) => `#${x}`).join(' '))
        }
        const listName = plan?.listName ?? shown?.listName ?? null
        const listExists = plan?.listExists ?? shown?.listExists ?? true

        return h('div', { className: 'td-qadd' + (mode === 'float' ? ' td-qadd-float' : '') },
          h('input', {
            ref: inputRef,
            className: 'td-in',
            value: state.quick,
            // The layer is mounted on demand, so autoFocus is exactly right for
            // it; the docked bar is not, and takes the one-shot quickFocus
            // request instead (see the effect above).
            autoFocus: mode === 'overlay',
            'aria-label': '添加任务',
            // The full syntax lives in the tooltip: a placeholder long enough to
            // teach it is also long enough to be cut off in a 214px rail.
            title: '语法：日期/时间、!高/!中/!低、#清单、@标签、重复规则（如 每周一三五）',
            placeholder: mode === 'overlay' ? '记一件事：明天 15:00 交报告 !高 #工作' : '添加任务（回车确认）',
            onChange: (event) => setApp({ quick: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                stopEvent(event)
                submitCapture(mode)
              }
              if (event.key === 'Escape') {
                // Both: this key is consumed HERE. Without it the same Escape
                // also reached the overlay's chain and left fullscreen behind
                // the capture bar -- one keypress, two layers.
                stopEvent(event)
                escapeCapture(mode)
              }
            },
          }),
          h('button', {
            type: 'button', className: 'td-send', title: '添加任务（回车）',
            'aria-label': '添加任务', onClick: () => submitCapture(mode),
          }, h(Glyph, { name: 'send', size: 15 })),
          h('button', {
            type: 'button', className: 'td-icon', title: '重新载入',
            'aria-label': '重新载入', onClick: () => refresh({}, true),
          }, h(Glyph, { name: 'refresh', size: 14 })),
          // The preview's slot is ALWAYS in the DOM, at a fixed height: it used
          // to be a sibling that mounted on demand, so the first character typed
          // moved the whole list down by its height. Only its visibility changes
          // now, which is why the list cannot jump.
          h('div', {
            className: `td-qprev${shown === null ? '' : ' on'}`,
            'aria-live': 'polite',
            'aria-hidden': shown === null ? 'true' : 'false',
          },
            h('span', { className: 'td-qprev-l' }, current?.added === true ? '已添加：' : '将添加：'),
            h('span', { className: 'td-qprev-t' },
              shown === null || parsed === null ? '' : (parsed.title === '' ? '（无标题）' : parsed.title)),
            ...bits.map((bit, i) => h('span', { key: `b${i}`, className: 'td-qprev-m' }, bit)),
            listName === null || shown === null
              ? null
              : h('span', {
                className: `td-qprev-m${listExists ? '' : ' new'}`,
                title: listExists ? '任务会放进这个清单' : '这个清单还不存在，回车时会自动创建',
              }, `${listExists ? '清单' : '新建清单'}「${listName}」`)))
      }

      /** preventDefault + stopPropagation, when the event can do either. */
      function stopEvent(event) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
      }

      /** Enter: hand the draft to the host, then stay put for the next one. */
      async function submitCapture(mode) {
        const text = String(app.quick ?? '').trim()
        if (text === '') return
        const result = await mutate('quickAdd', { text })
        if (result === null) return
        const parsed = result.parsed ?? {}
        setApp({
          quick: '',
          // The answer stays on screen until the next keystroke: it is the only
          // confirmation that the date the parser found is the date you meant.
          qPreview: {
            text,
            result: {
              parsed,
              added: true,
              listName: result.task?.listName ?? null,
              listExists: true,
            },
          },
        })
        if (mode === 'overlay') closeCapture()
        const bits = []
        if (result.task.due) bits.push(`截止 ${String(result.task.due).replace('T', ' ')}`)
        if (result.parsed?.recurrence) bits.push(recurrenceRuleText(result.parsed.recurrence))
        if (result.listCreated) bits.push(`已创建清单「${result.parsed.listName}」`)
        toast(`已添加「${result.task.title}」${bits.length ? ' · ' + bits.join(' · ') : ''}`)
      }

      /**
       * Escape inside the capture input: throw the draft away first, and only
       * close a layer when there was nothing to throw away. One keypress, one
       * meaning -- the caret stays in the box either way.
       */
      function escapeCapture(mode) {
        const hadDraft = String(app.quick ?? '').trim() !== ''
        setApp({ quick: '', qPreview: null })
        if (!hadDraft && mode === 'overlay') closeCapture()
      }

      /** Seed the draft from a group/column, without ever eating what is typed. */
      function seedQuick(text) {
        const current = String(app.quick ?? '')
        if (current.trim() === '') {
          setApp({ quick: text })
          return false
        }
        if (current.trim() === text.trim()) return false
        setApp({ quick: `${current.replace(/\s+$/, '')} ${text}` })
        return true
      }

      /**
       * The inline add row: one input, born inside the group or column that was
       * clicked.
       *
       * The seed -- which bucket, which list -- arrives with the payload, so the
       * browser never has to know that "本周内" means `today + 7`; that decision
       * lives in the store, with every other view semantic. A `due` key that is
       * absent means "no opinion" (the task keeps the create default), which is
       * different from the 未安排 group's explicit `due: null`.
       */
      function InlineAdd(props) {
        const [text, setText] = useState('')
        const seed = props.seed ?? {}
        const hasDue = Object.prototype.hasOwnProperty.call(seed, 'due')
        const submit = async () => {
          const value = text.trim()
          if (value === '') { props.onClose(); return }
          const payload = { text: value }
          if (hasDue) payload.due = seed.due
          if (seed.listId !== undefined && seed.listId !== null) payload.listId = seed.listId
          const result = await mutate('quickAdd', payload)
          if (result === null) return
          // The box stays open and empty: "记三件事" is one thought, and closing
          // it after each line would make the second one cost two more clicks.
          setText('')
          if (typeof props.onAdded === 'function') props.onAdded(result)
        }
        return h('div', { className: props.className ?? 'td-grp-new' },
          h('input', {
            className: 'td-in',
            autoFocus: true,
            value: text,
            'aria-label': props.label ?? '添加任务',
            title: '语法：日期/时间、!高/!中/!低、#清单、@标签',
            placeholder: props.placeholder ?? '回车添加，Esc 取消',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { stopEvent(event); submit() }
              if (event.key === 'Escape') { stopEvent(event); props.onClose() }
            },
          }),
          h('button', {
            type: 'button', className: 'td-send', title: '添加任务（回车）',
            'aria-label': '添加任务', onClick: submit,
          }, h(Glyph, { name: 'send', size: 15 })))
      }

      // ---------------------------------------------------------------------
      // styles
      // ---------------------------------------------------------------------

      // The palette is the host's own theme tokens, so the plugin tracks light/dark
      // and any future re-skin without a second design system to keep in sync.
      const CSS = `
/* The palette is the host's own theme tokens, so the plugin tracks light/dark and
   any future re-skin with no second design system to keep in sync. The local
   --td-* names below are aliases rather than a palette: every value still comes
   from the host, and the aliases let a rule say "a raised card" instead of
   repeating which of four near-identical layer tokens that happens to be today.

   They are declared on the seat marker, .td-seat, which every element the plugin
   hands to a host slot carries -- because those elements are SIBLINGS in the slot
   tree, not ancestors: the shell renders each shell.overlay entry side by side, and
   the sidebar's panel row is not inside the panel at all. A custom property is
   inherited, so a variable set only on .td-root simply does not exist inside the
   dialog, the capture layer, the command palette, or the sidebar badge -- and the
   failure is silent: every var(--td-*) there resolves to nothing, so the box paints
   with no surface at all.

   That trap has been sprung three times (.td-float in the v2 pass, then
   .td-cap-layer/.td-cmdk-layer and the sidebar badge, then the box model, the type
   baseline and the focus ring below, all found in the t12 repair). Every earlier fix
   was a longer selector list, and every longer list had one more rule to remember.
   The marker is the structural answer: a surface either carries it -- and gets the
   map, the box model, the baseline type and the focus ring at once -- or it does not
   exist yet. scripts/audit-css.mjs asserts the COVERAGE RELATION (which elements
   carry the marker, derived from the JSX) rather than a copy of any selector text,
   so a new surface that forgets the marker fails the gate instead of shipping
   invisible.

   v3: the ladder is DECLARED ONCE here and both themes move in the SAME
   direction -- the canvas is pulled down from the row, the well sits BETWEEN the
   canvas and the row, and a control sits below the surface it lives on. (The old
   sheet mixed the canvas down in the light theme and the row down in the dark one
   -- and then borrowed the host's layer-2 for the
   well in the dark theme, which put the well ABOVE the row and flipped the
   container/row relationship instead.) The direction is
   asserted per theme, not just the step sizes. All four steps stay derived from
   host tokens. */
.td-seat{
  font-size:12.5px;line-height:1.6;-webkit-font-smoothing:antialiased;
  --td-card:var(--dsw-alias-bg-base);
  --td-canvas:color-mix(in srgb,var(--dsw-alias-bg-base) 90%,var(--dsw-alias-label-primary));
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,var(--dsw-alias-label-primary));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-base) 85%,var(--dsw-alias-label-primary));
  /* Three ink steps, and the third one is only legible on a card or on an inset
     surface (5.30 / 4.69 in the light theme). On the canvas it drops below 4.5,
     so the three rules that print small text there take --td-text-2 instead --
     that pairing is enforced by the visual-contract assertions. */
  --td-text:var(--dsw-alias-label-primary);
  --td-text-2:var(--dsw-alias-label-secondary);
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 96%,var(--dsw-alias-bg-base));
  /* Hairlines: 12% is a row/card boundary, 22% is a group or section boundary, so
     the boundary the eye is meant to read first is the stronger one (D19). */
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);
  /* The host's accent is near-black in the light theme, so every use below reads
     --td-brand as "emphasis", never as "the blue one". */
  --td-brand:var(--dsw-alias-brand-primary);
  --td-danger:var(--dsw-alias-state-error-primary);
  --td-warn:var(--dsw-alias-state-warn-primary);
  /* 奶白 + 蓝: the floating window's own skin. A semantic HUE pair cannot be
     derived from a greyscale theme, so the pair -- plus the two ink tones that
     let a light card stay legible under the dark theme -- is declared here, once,
     and only ever used as a surface or mixed into one. Nothing outside the
     floating window may reference --td-accent: a second blue in the panel is a
     second visual language (D17). */
  --td-cream:#fffaf1;--td-cream-2:#f6eedd;
  --td-accent:#2f6bff;--td-ink:#16233a;--td-ink-2:#4d6076;
  /* The four accents are the only literal colours left in the sheet: a semantic
     hue cannot be derived from a greyscale theme. Each one is only ever used
     mixed into a surface, so it stays legible on white and on near-black. */
  --td-ok:color-mix(in srgb,#1f9d61 88%,var(--dsw-alias-brand-primary));
  --td-warm:#e56d24;
  --td-pri-1:#8b97a6;--td-pri-2:#e0a53c;
  --td-r-xl:22px;--td-r-lg:14px;--td-r-md:10px;--td-r-sm:6px;
  --td-sh-hair:0 0 0 1px var(--td-line);
  --td-sh-1:0 0 0 1px var(--td-line),0 1px 2px rgba(16,24,40,.05);
  --td-sh-2:0 0 0 1px var(--td-line-2),0 10px 28px rgba(16,24,40,.07);
  --td-sh-3:0 0 0 1px var(--td-line-2),0 24px 64px rgba(16,24,40,.24);
  --td-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --td-ease:cubic-bezier(.23,1,.32,1)}
/* The dark theme is read from the host's own signal on <body>, and the ladder is
   rebuilt from the host's dark layers -- but the WELL is derived rather than
   borrowed. The host's dark layers stack upward (base < layer-1 < layer-2), so
   taking --td-soft straight from layer-2 put the group container ABOVE the row it
   holds: the row looked inset into its own container, which is the opposite of the
   light theme (where soft sits between the canvas and the row) and the opposite of
   what the two surfaces mean. --td-soft is therefore mixed from the row's own layer
   towards the canvas -- 35% of the way up, the largest share that still keeps the
   row a full 1.10 above the well. The dark ramp then reads
   canvas < soft < field < card, one monotone direction, the same one the light
   theme uses; the ordered relationship is asserted per theme (see ## 24).
   The guards are load-bearing, and they are why the dark block hangs on the marker
   with two exclusions instead of on its own list. :not(.td-floatapp) keeps the
   floating window's INTERIOR light: that element re-declares the whole map on
   itself and an inherited value never beats a declared one, so without the guard the
   dark block would beat the window's cream skin. :not(.td-float) is the window's
   own frame, which pins its colours further down the sheet for the same reason --
   it is a cream box in both themes. Everything else that carries the marker (the
   panel, the fullscreen overlay, the dialog, the two global layers and the sidebar
   glyph) must be re-pointed here, or those surfaces would keep the light map's
   hairlines and ink on a dark ground.

   The second selector below is redundant on purpose and has to stay for now:
   verify-client-render.mjs V4 pins the literal text of this guard, and that file is
   not in this change's scope. audit-css asserts that everything the dark list names
   is ALSO marked, so the redundant line cannot become the place a new surface gets
   added -- the fixture can be relaxed to the marker alone in a later pass. */
body[data-ds-dark-theme] .td-seat:not(.td-floatapp):not(.td-float),
body[data-ds-dark-theme] .td-root:not(.td-floatapp){
  --td-canvas:var(--dsw-alias-bg-base);
  --td-card:var(--dsw-alias-bg-layer-1);
  --td-soft:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 35%,var(--dsw-alias-bg-base));
  --td-field:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,var(--dsw-alias-bg-base));
  --td-text-3:color-mix(in srgb,var(--dsw-alias-label-secondary) 88%,var(--dsw-alias-bg-base));
  --td-line:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  --td-line-2:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
/* In the dark theme the canvas IS the host's own page colour, so the plugin area
   would have no edge at all; one inset hairline gives it one without adding a
   third surface. The overlay is skipped because it covers the page instead of
   sitting beside it. */
body[data-ds-dark-theme] .td-root:not(.td-overlay):not(.td-floatapp){
  box-shadow:inset 1px 0 0 var(--td-line-2)}
/* The panel's own box: layout only. The type baseline moved onto the marker (just
   above), because it is a property of every surface, not of this one -- the dialog
   layers had none, so they fell back to the host's line-height. */
.td-root{height:100%;min-height:0;display:flex;flex-direction:column;
  container:td / inline-size;
  background:var(--td-canvas);color:var(--td-text);
  overflow:hidden;position:relative}
.td-root.td-overlay{position:fixed;inset:0;z-index:9000}
/* Box model and focus ring are surface-wide too, so they hang on the marker: this
   is the half of the t12 defect a token-only fix would have left behind (the
   capture layer's and the palette's padding+border were laid out content-box, and
   the palette's rows fell back to the browser's own focus ring). */
.td-seat *{box-sizing:border-box}
.td-seat :focus-visible{outline:2px solid var(--td-text);
  outline-offset:2px}
.td-grow{flex:1;min-width:0}

/* ---- header ------------------------------------------------------------ */
.td-head{flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;height:56px;
  border-bottom:1px solid var(--td-line);background:var(--td-card);z-index:3}
.td-h1{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.td-countbadge{min-width:22px;height:20px;padding:0 6px;border-radius:999px;flex:none;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-field);
  color:var(--td-text-2);font-family:var(--td-mono);font-size:10.5px;font-weight:600;
  font-variant-numeric:tabular-nums}
.td-sub{color:var(--td-text-2);font-size:12.5px;font-family:var(--td-mono);
  font-variant-numeric:tabular-nums;padding-left:12px;
  border-left:1px solid var(--td-line-2)}
.td-sub b{color:var(--td-text);font-weight:600}
.td-headtools{display:flex;align-items:center;gap:8px;flex:none}
/* The rail carries the view switcher. Below this width it is simply gone, so the
   header keeps its own copy of the same four buttons and drops the metadata.
   The descendant selector is deliberate: .td-seg sets display:flex further down
   the sheet, and an equal-specificity rule cannot win against a later one. */
.td-headtools .td-headviews{display:none}
/* The narrow tier's second header line: the smart lists and the list switcher,
   which the dropped rail used to carry. It is hidden at every wider width (where
   the rail is right there), so the wide layouts pay nothing for it. */
.td-head2{display:none}
.td-head2-tabs{display:flex;overflow-x:auto;scrollbar-width:none}
.td-head2-tabs::-webkit-scrollbar{display:none}
.td-head2-tab{flex:none;border:0;background:transparent;color:var(--td-text-2);
  padding:4px 8px;border-radius:var(--td-r-sm);font-size:12.5px;font-family:inherit;
  cursor:pointer;transition:background-color .13s ease,color .13s ease}
.td-head2-tab:hover{color:var(--td-text)}
.td-head2-tab.on{background:var(--td-field);color:var(--td-text);font-weight:600}
.td-head2-sel{flex:1;min-width:0;height:28px;border-radius:var(--td-r-sm);font-size:12.5px}

/* ---- controls ---------------------------------------------------------- */
.td-btn{border:0;background:var(--td-card);color:var(--td-text);border-radius:var(--td-r-sm);
  padding:6px 12px;cursor:pointer;font-size:12.5px;font-family:inherit;line-height:1.5;
  white-space:nowrap;box-shadow:var(--td-sh-1);display:inline-flex;align-items:center;
  justify-content:center;gap:4px;
  transition:background-color .13s ease,color .13s ease,box-shadow .13s ease,transform .13s ease}
.td-btn:hover{background:var(--td-soft)}
.td-btn:active{transform:scale(.97)}
.td-btn.primary{background:var(--td-text);color:var(--td-card);font-weight:550;box-shadow:none}
.td-btn.primary:hover{background:var(--td-text);filter:brightness(1.1)}
.td-btn.ghost{background:transparent;box-shadow:none;color:var(--td-text-2)}
.td-btn.ghost:hover{background:var(--td-soft);color:var(--td-text)}
/* "Chosen" fills with the ink colour rather than tinting, so it survives a
   monochrome theme where every surface is a shade of the same grey. */
.td-btn.on{background:var(--td-text);color:var(--td-card);font-weight:600;box-shadow:none}
.td-btn.sm{padding:2px 8px;font-size:12.5px;border-radius:6px}
.td-btn.danger{color:var(--td-danger);box-shadow:none;background:transparent}
.td-btn.danger:hover{background:color-mix(in srgb,var(--td-danger) 12%,transparent);
  color:var(--td-danger)}
/* Filled, for the one button that destroys: the ghost treatment reads as "cancel"
   next to the confirm it is meant to be the opposite of. */
.td-btn.danger-solid{background:var(--td-danger);color:var(--td-card);font-weight:550;
  box-shadow:none}
.td-btn.danger-solid:hover{background:var(--td-danger);filter:brightness(1.08)}
.td-btn.icon{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;
  justify-content:center;line-height:0}
.td-icon{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;
  border:0;border-radius:var(--td-r-sm);background:transparent;color:var(--td-text-3);
  cursor:pointer;font-size:14px;font-family:inherit;line-height:1;padding:0;
  transition:background-color .13s ease,color .13s ease}
.td-icon:hover{background:var(--td-soft);color:var(--td-text)}
.td-seg{display:inline-flex;gap:4px;padding:2px;border-radius:10px;background:var(--td-field)}
.td-seg > button{border:0;background:transparent;color:var(--td-text-2);
  border-radius:var(--td-r-sm);padding:4px 12px;font-size:12.5px;font-family:inherit;
  cursor:pointer;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.td-seg > button:hover{color:var(--td-text)}
.td-seg > button.on{background:var(--td-card);color:var(--td-text);font-weight:550;
  box-shadow:var(--td-sh-1)}
.td-in{border:1px solid var(--td-line);background:var(--td-card);color:var(--td-text);
  border-radius:var(--td-r-md);padding:6px 12px;font-size:12.5px;font-family:inherit;
  min-width:0;outline:none;
  transition:border-color .13s ease,box-shadow .13s ease,background-color .13s ease}
.td-in::placeholder{color:var(--td-text-3)}
.td-in:hover{border-color:var(--td-line-2)}
/* The focus ring is an 18% ink wash, not the surface colour it sits on: the old
   ring was painted with --td-field, which in the light theme is exactly the canvas
   colour, so a focused field had no ring at all (D12). */
.td-in:focus{border-color:var(--td-line-2);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-text) 18%,transparent)}
.td-search{width:180px;background:var(--td-field);border-color:transparent}
.td-search:focus{background:var(--td-card);border-color:var(--td-line-2)}
/* One search box, two seats. The rail owns it -- it filters whatever the rail has
   selected -- and the header copy exists only for the widths where the rail is
   dropped entirely, exactly like the view switcher below. */
.td-headtools .td-headsearch{display:none}
.td-railsearch{padding:0 0 12px}
.td-railsearch .td-search{width:100%}
/* The group right under the search box opens the rail, so it does not draw the
   separator it otherwise uses to part from the group above it. */
.td-railsearch + .td-rail-g{margin-top:0;padding-top:0;border-top:0}
/* What Enter will create. Muted on purpose: it is an answer, not a control, and
   a bright row under the add box would read as a second button. It sits on the
   canvas, so its label uses ink-2, not ink-3 (4.29 < 4.5).

   v2: the slot is a CHILD of the add row and keeps its height whether or not it
   has anything to say. It used to be a sibling that mounted on demand, so the
   first character typed pushed the whole list down by its height. Reserving the
   space with visibility (not display) is what keeps it from moving. */
.td-qprev{flex:1 1 100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  min-height:20px;font-size:12.5px;color:var(--td-text-2);
  visibility:hidden;opacity:0;transition:opacity .13s ease}
.td-qprev.on{visibility:visible;opacity:1}
.td-qprev-l{color:var(--td-text-2)}
.td-qprev-t{color:var(--td-text);font-weight:550}
.td-qprev-m{color:var(--td-text-2)}
.td-qprev-m.new{color:color-mix(in srgb,var(--td-warn) 88%,var(--td-text))}
.td-qadd{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 16px;
  border-bottom:1px solid var(--td-line-2);background:var(--td-card)}
.td-qadd .td-in{flex:1;height:38px;border-radius:var(--td-r-lg);background:var(--td-field);
  border-color:transparent;padding:0 12px}
.td-qadd .td-in:hover{border-color:var(--td-line-2)}
.td-qadd .td-in:focus{background:var(--td-card);border-color:var(--td-line-2);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-text) 18%,transparent)}
/* The window's bar is one row and has no header above it, so the box is a touch
   taller there; the preview still owns its own line. */
.td-qadd-float{padding:8px 12px}
.td-send{flex:none;width:38px;height:38px;border:0;border-radius:var(--td-r-lg);cursor:pointer;
  background:var(--td-text);color:var(--td-card);display:inline-flex;align-items:center;
  justify-content:center;line-height:0;
  transition:background-color .15s ease,color .15s ease,transform .15s ease}
.td-send:hover{filter:brightness(1.1)}
.td-send:active{transform:scale(.94)}

/* ---- the inline "+": one box inside the group/column that was clicked ----- */
.td-grp-add{margin-left:auto;width:24px;height:24px;border:0;background:transparent;
  color:var(--td-text-3);border-radius:var(--td-r-sm);cursor:pointer;line-height:0;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .13s ease,color .13s ease}
.td-grp-add:hover{background:var(--td-soft);color:var(--td-text)}
.td-grp-new{display:flex;gap:8px;align-items:center;margin:0 0 8px}
.td-grp-new .td-in{flex:1;height:36px;border-radius:var(--td-r-md)}
.td-col-new{display:flex;gap:8px;align-items:center;margin:0 0 12px}
.td-col-new .td-in{flex:1;height:36px;border-radius:var(--td-r-md)}

/* ---- the global capture layer ------------------------------------------- */
.td-cap-layer{position:fixed;inset:0;z-index:9150;display:flex;align-items:flex-start;
  justify-content:center;padding:12vh 16px 16px;background:color-mix(in srgb,var(--td-ink) 32%,transparent)}
.td-cap{width:100%;max-width:640px;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:var(--td-sh-2)}
.td-cap .td-qadd{border-bottom:0}
.td-cap-h{padding:12px 16px 0;font-size:12.5px;color:var(--td-text-2)}

/* ---- the command palette ------------------------------------------------ */
.td-cmdk-layer{position:fixed;inset:0;z-index:9150;display:flex;align-items:flex-start;
  justify-content:center;padding:12vh 16px 16px;background:color-mix(in srgb,var(--td-ink) 32%,transparent)}
.td-cmdk{width:100%;max-width:560px;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:var(--td-sh-2);display:flex;flex-direction:column}
.td-cmdk-in{height:44px;border:0;border-bottom:1px solid var(--td-line-2);
  border-radius:0;background:var(--td-card);font-size:14px;padding:0 16px}
.td-cmdk-in:focus{box-shadow:none;background:var(--td-card)}
.td-cmdk-list{max-height:52vh;overflow:auto;padding:8px}
.td-cmdk-item{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;
  color:var(--td-text);font-family:inherit;font-size:14px;text-align:left;cursor:pointer;
  padding:8px 12px;border-radius:var(--td-r-md);
  transition:background-color .13s ease,color .13s ease}
.td-cmdk-item.on{background:var(--td-field)}
.td-cmdk-lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-cmdk-hint{flex:none;color:var(--td-text-3);font-size:12.5px;
  font-variant-numeric:tabular-nums}
.td-cmdk-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 16px;border-top:1px solid var(--td-line);color:var(--td-text-2);font-size:12.5px}
.td-kbd{font-family:var(--td-mono);font-size:10.5px;padding:2px 6px;border-radius:3px;
  background:var(--td-field);color:var(--td-text-2)}

/* ---- the search box: magnifier inside, tag filter as a removable chip ----- */
.td-searchbox{position:relative;display:flex;align-items:center;gap:8px}
.td-searchbox .td-in{padding-left:28px;width:100%}
.td-search-ico{position:absolute;left:8px;top:50%;transform:translateY(-50%);
  color:var(--td-text-3);pointer-events:none;line-height:0;display:inline-flex}
/* The chip sits over the field's right edge: it belongs to the search box, not
   to a row of its own, and it must not push the field narrower. */
.td-search-tag{position:absolute;right:6px;top:50%;transform:translateY(-50%);
  display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px;border:0;
  border-radius:var(--td-r-sm);background:var(--td-field);color:var(--td-text);
  font-family:inherit;font-size:12.5px;cursor:pointer;line-height:0}
.td-search-tag:hover{background:var(--td-soft)}
.td-searchbox .td-search{padding-right:88px}

/* ---- rail: the foldable data block, and the tag fold -------------------- */
.td-rail-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;
  background:transparent;cursor:pointer;font-family:inherit;text-align:left;padding:0}
.td-rail-toggle:hover{color:var(--td-text-2)}
.td-rail-toggle .td-caret{display:inline-block;font-size:10.5px;color:var(--td-text-3);
  transition:transform .13s ease}
.td-rail-toggle .td-caret.open{transform:rotate(90deg)}
.td-rail-more{display:block;width:100%;border:0;background:transparent;cursor:pointer;
  color:var(--td-text-3);font-family:inherit;font-size:12.5px;text-align:left;
  padding:4px 8px;border-radius:var(--td-r-sm)}
.td-rail-more:hover{background:var(--td-soft);color:var(--td-text)}
/* The file name is a button now: clicking it copies the path, which is the one
   thing anyone wanted from the three-button row it replaced. */
.td-rail-file{border:0;background:transparent;padding:0;cursor:pointer;font-family:var(--td-mono);
  color:var(--td-text);font-size:12.5px;text-align:left}
.td-rail-file:hover{color:var(--td-brand)}

.td-hint{font-size:12.5px;color:var(--td-text-3);line-height:1.6}
.td-dot{width:8px;height:8px;border-radius:999px;flex:none}
.td-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;color:inherit}

/* ---- body + rail ------------------------------------------------------- */
.td-body{flex:1;min-height:0;display:flex}
.td-rail{width:238px;flex:none;border-right:1px solid var(--td-line-2);overflow:auto;
  padding:16px 12px 24px;background:var(--td-card)}
.td-rail-t{font-size:10.5px;color:var(--td-text-3);margin:0 8px 6px;
  letter-spacing:.1em;text-transform:uppercase;font-weight:600}
.td-rail-g{margin-top:16px;padding-top:16px;border-top:1px solid var(--td-line-2)}
.td-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.td-scroll{flex:1;min-height:0;overflow:auto;padding:16px 24px 48px;background:var(--td-canvas)}
/* A rail row is the reference library's nav item, count pill included: the pill is
   a surface chip on a tinted row, which reads as "badge" without a second colour.
   Selection is the same language the list rows use: an inset ink edge plus a
   same-layer fill. */
.td-side{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;
  color:var(--td-text-2);padding:6px 8px;border-radius:var(--td-r-sm);cursor:pointer;
  font-size:12.5px;font-family:inherit;text-align:left;margin-bottom:2px;
  transition:background-color .13s ease,color .13s ease,box-shadow .13s ease}
.td-side:hover{background:var(--td-soft);color:var(--td-text)}
.td-side:active{transform:scale(.985)}
.td-side.on{background:var(--td-field);color:var(--td-text);font-weight:550;
  box-shadow:inset 3px 0 0 var(--td-text)}
.td-side-l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.td-side-n{min-width:22px;height:20px;padding:0 6px;border-radius:999px;flex:none;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-card);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:10.5px;
  font-variant-numeric:tabular-nums;box-shadow:var(--td-sh-hair)}
.td-side.on .td-side-n{color:var(--td-text-2)}
.td-side .td-glyph{color:var(--td-text-3)}
.td-side.on .td-glyph{color:var(--td-text-2)}
.td-create{display:flex;align-items:center;gap:8px;padding:2px 6px 2px 8px}
.td-create .td-in{flex:1;height:28px;font-size:12.5px;border-radius:var(--td-r-sm);padding:0 8px}
/* Each list in the rail is a row: the row selects the list, the trailing button
   opens its settings dialog. That button is painted on hover/focus -- and for the
   list you are actually filtered to, so a touch user reaches it by tapping the
   row once -- instead of turning the rail into a column of identical dots. */
.td-lrow{display:flex;align-items:center;gap:4px;margin-bottom:2px;
  border-radius:var(--td-r-sm);transition:box-shadow .13s ease}
.td-lrow .td-side{flex:1;min-width:0;margin-bottom:0}
.td-lrow.dragging{opacity:.5}
.td-lrow.drop{box-shadow:0 0 0 2px var(--td-text-2)}
.td-lcfg{width:24px;height:24px;opacity:0;transition:opacity .13s ease}
.td-lrow:hover .td-lcfg,.td-lrow:focus-within .td-lcfg,.td-lrow.on .td-lcfg{opacity:1}
/* The data card answers "where does this live, and how do I keep a copy" right
   where the user went looking for it, instead of only in the README. */
.td-rail-data{padding:12px;border-radius:var(--td-r-md);background:var(--td-soft);
  box-shadow:var(--td-sh-hair)}
.td-rail-file{display:block;font-family:var(--td-mono);font-size:10.5px;color:var(--td-text-2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px}
.td-rail-note{font-size:12.5px;color:var(--td-text-3);line-height:1.6;margin-bottom:8px}
.td-rail-acts{display:flex;gap:4px;flex-wrap:wrap}

/* ---- list -------------------------------------------------------------- */
/* Group header per bucket, then the tasks as raised cards on a soft canvas.
   The cards are what keep a wide list scannable, and they are why the list is
   capped at its own max width instead of stretching to the window: at 1400px a
   title and its due date sit far enough apart to stop reading as one row. The
   cap widens in the wide tier instead of stretching (D15). */
.td-listwrap{max-width:1060px;margin:0 auto}
.td-grp{margin-bottom:24px}
.td-grp:last-child{margin-bottom:4px}
/* Sticky, because a group title that scrolls away stops answering "which bucket
   am I in" exactly when the list is long enough to need it (D06). The background
   is opaque so the rows slide UNDER it, and the rule below it is the strong
   boundary (22%) rather than the row hairline (12%) -- group first, row second. */
.td-grp-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;
  font-size:12.5px;font-weight:600;letter-spacing:.01em;color:var(--td-text);
  background:var(--td-canvas);padding:12px 2px 8px;margin:0 0 6px}
.td-grp-n{min-width:20px;height:20px;padding:0 6px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-card);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:10.5px;
  font-variant-numeric:tabular-nums;box-shadow:var(--td-sh-hair)}
/* On the sticky title the pill would need a white ring to survive the tinted
   canvas it is pasted on; as plain mono text it needs neither (D16). */
.td-grp-h .td-grp-n{background:transparent;box-shadow:none;color:var(--td-text-3)}
.td-grp-h::after{content:"";flex:1;height:1px;background:var(--td-line-2)}
/* Capsule rows that relax into a card when they open -- the radius change is the
   whole "this one is expanded" signal, before any content is even read. */
.td-item{position:relative;background:var(--td-card);border-radius:var(--td-r-xl);
  box-shadow:var(--td-sh-1);margin-bottom:8px;overflow:hidden;
  animation:tdRowIn .45s var(--td-ease) var(--td-delay,0ms) both;
  transition:border-radius .3s var(--td-ease),box-shadow .16s ease}
/* Hover moves the FILL first and never the geometry: a list the pointer sweeps
   across used to bob one pixel per row (D12). */
.td-item:hover{background:var(--td-soft);box-shadow:0 0 0 1px var(--td-line-2)}
.td-item:has(.td-tree){border-radius:var(--td-r-lg)}
.td-item.p1::before,.td-item.p2::before,.td-item.p3::before{content:"";position:absolute;
  left:0;top:0;bottom:0;width:3px}
.td-item.p1::before{background:var(--td-pri-1)}
.td-item.p2::before{background:var(--td-pri-2)}
.td-item.p3::before{background:var(--td-danger)}
/* The row whose dialog is open, in the same language as a selected rail row.
   Without it the only way to tell which card the centred dialog belongs to is to
   read the title twice (D13). */
.td-item.cur{background:var(--td-field);box-shadow:inset 3px 0 0 var(--td-text)}
/* Completed is a nested surface, not a fainter card: --td-soft is one step in
   from the card in BOTH themes, so the state survives the dark theme (D13). */
.td-item.done{box-shadow:none;background:var(--td-soft)}
.td-item.done:hover{box-shadow:0 0 0 1px var(--td-line-2)}
.td-item.sub{background:transparent;border-radius:0;box-shadow:none;margin-bottom:0;
  overflow:visible;animation:none}
.td-item.sub::before{display:none}
.td-item.sub:hover{background:var(--td-soft);box-shadow:none}
.td-row{display:flex;align-items:center;gap:12px;min-height:44px;padding:2px 12px;
  position:relative;cursor:pointer;border-radius:inherit}
.td-item.sub .td-row{min-height:36px;padding:0 8px;border-radius:var(--td-r-sm)}
.td-chk{position:relative;flex:none;width:20px;height:20px;border-radius:999px;cursor:pointer;padding:0;border:0;
  background:transparent;color:var(--td-card);font-size:12.5px;line-height:1;display:flex;
  align-items:center;justify-content:center;box-shadow:inset 0 0 0 1.5px var(--td-line-2);
  transition:box-shadow .18s ease,background-color .18s ease,color .18s ease,transform .12s ease}
.td-chk:hover{box-shadow:inset 0 0 0 1.5px var(--td-text-2);transform:scale(1.06)}
.td-chk.on{background:var(--td-ok);color:var(--td-card);box-shadow:none;animation:tdPopIn .3s var(--td-ease) both}
.td-chk.p3{box-shadow:inset 0 0 0 1.5px var(--td-danger)}
.td-chk.p3.on{background:var(--td-ok);box-shadow:none}
.td-row-title{min-width:0;flex:1;word-break:break-word;font-size:14px;font-weight:500;
  transition:color .13s ease}
.td-item.done .td-row-title{color:var(--td-text-3);text-decoration:line-through;
  text-decoration-color:var(--td-line-2);text-decoration-thickness:1px;font-weight:400}
/* The metadata column has a FLOOR and a CEILING: a fixed minimum keeps its left
   edge from drifting row to row (the due date of one row no longer starts where
   the list chip of the next one ends), and the percentage keeps a long list name
   from eating the title. */
.td-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  justify-content:flex-end;flex:0 1 auto;min-width:132px;max-width:56%;
  min-height:20px;font-size:12.5px;color:var(--td-text-2)}
/* The reference library's status pill: a hue mixed into the surface for the fill
   and into the text colour for the label, so one recipe works in both themes. */
.td-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;
  border:1px solid transparent;border-radius:6px;font-size:12.5px;white-space:nowrap;
  background:var(--td-field);color:var(--td-text-2);font-variant-numeric:tabular-nums;flex:none}
.td-chip.today{border-color:color-mix(in srgb,var(--td-warm) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-warm) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-warm) 92%,var(--td-text))}
.td-chip.late{border-color:color-mix(in srgb,var(--td-danger) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-danger) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-danger) 90%,var(--td-text))}
.td-chip.ok{border-color:color-mix(in srgb,var(--td-ok) 30%,var(--td-card));
  background:color-mix(in srgb,var(--td-ok) 14%,var(--td-card));
  color:color-mix(in srgb,var(--td-ok) 92%,var(--td-text))}
.td-chip.tint{border-color:color-mix(in srgb,var(--td-tint,var(--td-line-2)) 34%,var(--td-card));
  background:color-mix(in srgb,var(--td-tint,var(--td-field)) 15%,var(--td-card))}
/* The overflow chip: it answers "there is more here" without spending a fourth
   slot on a 44px row, and it is a bare glyph group rather than a pill so it never
   reads as one more thing (D07). */
.td-meta-more{display:inline-flex;align-items:center;height:20px;padding:0 6px;
  border-radius:var(--td-r-sm);background:transparent;color:var(--td-text-3);
  font-size:12.5px;font-variant-numeric:tabular-nums;flex:none}
/* Without nowrap/flex:none a flex parent squeezes a tag the way it squeezes a
   long word -- down to one CJK character per line. */
.td-tag{color:var(--td-text-3);font-size:12.5px;font-family:var(--td-mono);
  white-space:nowrap;flex:none}
.td-tree{position:relative;margin:0 0 12px 32px;padding:2px 0 2px 16px}
.td-tree::before{content:"";position:absolute;left:0;top:-6px;bottom:8px;width:1px;
  background:var(--td-line-2)}
/* An element that leaves the DOM cannot animate, and a measured max-height is a
   guess that shows. The 0fr -> 1fr grid row animates the real height instead. */
.td-collapse{display:grid;grid-template-rows:0fr;opacity:0;
  transition:grid-template-rows .3s var(--td-ease),opacity .3s ease}
.td-collapse.open{grid-template-rows:1fr;opacity:1}
.td-clip{min-height:0;overflow:hidden}
.td-actions{display:flex;gap:4px;opacity:0;flex:none;transition:opacity .13s ease}
.td-actions .td-icon{width:24px;height:24px}
.td-item:hover .td-actions,.td-item:focus-within .td-actions{opacity:1}
.td-treebtn{flex:none;width:20px;height:20px;border:0;background:transparent;cursor:pointer;
  color:var(--td-text-3);padding:0;font-family:inherit;line-height:0;border-radius:6px;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .13s ease,color .13s ease}
.td-treebtn:hover{background:var(--td-soft);color:var(--td-text)}
.td-treebtn.empty{visibility:hidden}
.td-caret{transition:transform .3s var(--td-ease)}
.td-caret.open{transform:rotate(180deg)}

/* ---- board ------------------------------------------------------------- */
.td-board{flex:1;min-height:0;display:flex;gap:16px;align-items:flex-start;overflow:auto;
  padding:24px 24px 48px;background:var(--td-canvas)}
/* Each column carries its list colour as a tinted top edge, which is what makes
   four otherwise identical columns read as four different places. */
.td-col{width:322px;flex:none;display:flex;flex-direction:column;max-height:100%;
  background:var(--td-card);border-radius:var(--td-r-lg);
  box-shadow:inset 0 3px 0 var(--td-tint,transparent),var(--td-sh-1);
  transition:box-shadow .15s ease}
.td-col.drop{box-shadow:inset 0 3px 0 var(--td-tint,transparent),0 0 0 2px var(--td-text-2)}
.td-col-h{display:flex;align-items:center;gap:8px;padding:16px 16px 12px;font-size:14px;
  font-weight:600;flex:none}
.td-col-n{min-width:22px;height:20px;padding:0 6px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;background:var(--td-field);
  color:var(--td-text-3);font-family:var(--td-mono);font-size:10.5px;
  font-variant-numeric:tabular-nums}
.td-col-add{width:28px;height:28px;border-radius:6px;border:0;background:transparent;
  color:var(--td-text-3);cursor:pointer;font-size:14px;font-family:inherit;line-height:1;
  padding:0;display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .13s ease,color .13s ease}
.td-col-add:hover{background:var(--td-soft);color:var(--td-text)}
.td-col-b{flex:1;min-height:56px;overflow:auto;padding:0 12px 16px}
.td-col-b::after{content:"";display:block;height:1px}
.td-card{position:relative;background:var(--td-soft);border-radius:var(--td-r-md);
  padding:12px 16px;margin-bottom:12px;cursor:pointer;display:flex;gap:12px;
  box-shadow:var(--td-sh-hair);
  transition:box-shadow .15s ease,background-color .15s ease}
.td-card:hover{box-shadow:var(--td-sh-2);background:var(--td-card)}
.td-card.dragging{opacity:.5}
.td-card-t{font-size:14px;word-break:break-word;margin-bottom:8px;font-weight:550;line-height:1.5}
.td-card.done{background:var(--td-soft)}
.td-card.done .td-card-t{text-decoration:line-through;color:var(--td-text-3)}
.td-card-side{display:flex;flex-direction:column;gap:8px;align-items:center;flex:none}
/* A board column is read standing back from the screen, and the list's 12.5px
   chip disappears inside a 322px card -- so cards get their own chip size. */
.td-card .td-chip{font-size:12.5px;height:24px;padding:0 8px}
.td-card .td-tag{font-size:12.5px}
.td-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td-col-empty{border:1px dashed var(--td-line-2);border-radius:var(--td-r-md);padding:24px 16px;
  text-align:center;color:var(--td-text-3);font-size:14px;cursor:pointer;
  transition:color .14s ease,border-color .14s ease,background-color .14s ease}
.td-col-empty:hover{color:var(--td-text);border-color:var(--td-text-2);
  background:var(--td-soft)}

/* ---- calendar ---------------------------------------------------------- */
.td-cal-h{display:flex;align-items:center;gap:12px;margin:0 auto 16px;max-width:1680px}
.td-cal-nav{display:inline-flex;gap:4px;padding:2px;border-radius:10px;background:var(--td-field)}
/* Named instead of a bare "> button" child selector: that styles the buttons but
   leaves them anonymous to anything looking for them. */
.td-cal-navb{border:0;background:transparent;color:var(--td-text-2);border-radius:var(--td-r-sm);
  padding:6px 12px;font-size:14px;font-family:inherit;cursor:pointer;
  transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.td-cal-navb:hover{background:var(--td-card);color:var(--td-text)}
.td-cal-title{font-size:20px;font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;margin-left:2px}
/* Cells are cards with a gutter, not table cells: the grid lines were doing all
   the work in the old sheet and made the month read as a spreadsheet. */
.td-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;
  max-width:1680px;margin:0 auto}
/* The weekday row sits on the canvas, so it takes ink-2: ink-3 measures 4.29:1
   there, which is below AA (D04). */
.td-cal-wd{padding:0 4px 8px;font-size:10.5px;font-weight:600;letter-spacing:.1em;
  color:var(--td-text-2);text-transform:uppercase;text-align:center}
.td-cal-cell{background:var(--td-card);border-radius:var(--td-r-md);box-shadow:var(--td-sh-hair);
  min-height:124px;padding:8px 8px;cursor:pointer;display:flex;flex-direction:column;gap:8px;
  overflow:hidden;transition:box-shadow .15s ease,background-color .15s ease}
.td-cal-cell:hover{box-shadow:var(--td-sh-hair);background:var(--td-soft)}
.td-cal-cell.out{background:transparent;box-shadow:none;opacity:.45}
.td-cal-cell.today{background:color-mix(in srgb,var(--td-warm) 6%,var(--td-card));
  box-shadow:var(--td-sh-hair)}
.td-cal-cell.sel{background:var(--td-field);box-shadow:inset 3px 0 0 var(--td-text)}
.td-cal-d{font-size:12.5px;color:var(--td-text-3);display:flex;align-items:center;
  justify-content:space-between;font-variant-numeric:tabular-nums;min-height:24px}
.td-cal-d > span:first-child{width:24px;height:24px;display:inline-flex;align-items:center;
  justify-content:center;border-radius:999px;font-family:var(--td-mono);font-size:12.5px}
.td-cal-cell.today .td-cal-d > span:first-child{background:var(--td-text);color:var(--td-card);
  font-weight:600}
.td-cal-task{font-size:14px;line-height:1.5;padding:4px 8px;border-radius:6px;
  border-left:3px solid var(--td-tint,var(--td-line-2));
  background:color-mix(in srgb,var(--td-tint,var(--td-field)) 12%,var(--td-card));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;
  transition:filter .12s ease}
.td-cal-task:hover{filter:brightness(.97)}
/* Done is said with ink and a strike, not with a translucent chip: opacity on a
   surface makes the divider behind it show through (D13). */
.td-cal-task.done{text-decoration:line-through;color:var(--td-text-3)}
.td-cal-more{font-size:12.5px;color:var(--td-text-3);padding-left:2px;
  font-family:var(--td-mono)}
.td-day{max-width:1680px;margin:24px auto 0;border-radius:var(--td-r-lg);overflow:hidden;
  background:var(--td-card);box-shadow:var(--td-sh-1)}
.td-day-h{padding:16px 16px;font-size:14px;font-weight:600;border-bottom:1px solid var(--td-line-2);
  display:flex;align-items:center;gap:12px}
.td-day-b{padding:16px 16px}

/* ---- gantt ------------------------------------------------------------- */
.td-gantt{display:flex;border-radius:var(--td-r-lg);overflow:hidden;background:var(--td-card);
  box-shadow:var(--td-sh-1);max-width:1680px;margin:0 auto}
.td-gantt-l{width:286px;flex:none;border-right:1px solid var(--td-line);
  background:var(--td-card);z-index:2}
.td-gantt-r{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden}
.td-gantt-th{height:64px;display:flex;align-items:flex-end;padding:0 16px 12px;font-size:10.5px;
  font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--td-text-3);
  border-bottom:1px solid var(--td-line);background:var(--td-soft)}
.td-gantt-row{height:46px;display:flex;align-items:center;gap:8px;padding:0 16px;font-size:14px;
  border-bottom:1px solid var(--td-line);white-space:nowrap;overflow:hidden;cursor:pointer;
  transition:background-color .12s ease}
.td-gantt-row:hover{background:var(--td-soft)}
.td-gantt-row.done .td-gantt-t{color:var(--td-text-3);text-decoration:line-through}
.td-gantt-t{overflow:hidden;text-overflow:ellipsis}
.td-gantt-hd{border-bottom:1px solid var(--td-line);background:var(--td-soft);display:grid;
  grid-template-rows:24px 40px}
.td-gantt-month{display:flex;align-items:center;font-size:10.5px;font-weight:600;
  color:var(--td-text-3);letter-spacing:.06em;padding-left:8px;text-transform:uppercase;
  border-right:1px solid var(--td-line)}
.td-gantt-cell{font-size:12.5px;color:var(--td-text-3);text-align:center;
  border-right:1px solid var(--td-line);font-variant-numeric:tabular-nums;
  font-family:var(--td-mono);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:4px;line-height:1}
.td-gantt-cell small{font-size:10.5px;opacity:.8;font-weight:400;font-family:inherit}
.td-gantt-cell.we{background:color-mix(in srgb,var(--td-field) 70%,transparent)}
.td-gantt-cell.today{color:var(--td-text);font-weight:700}
.td-gantt-track{position:relative;height:46px;border-bottom:1px solid var(--td-line);display:grid}
.td-gantt-bg{border-right:1px solid var(--td-line);grid-row:1}
.td-gantt-bg.we{background:color-mix(in srgb,var(--td-field) 70%,transparent)}
.td-gantt-bg.today{background:color-mix(in srgb,var(--td-warm) 12%,transparent)}
/* Bars are coloured by list, like the calendar chips: in a time view the axis
   already carries "when", so colour is free to carry "which list". Priority stays
   on the row's dot in the left column. */
.td-gantt-bar{grid-row:1;align-self:center;height:22px;border-radius:999px;margin:0 2px;
  background:var(--td-tint,var(--td-text-2));opacity:.9;cursor:pointer;z-index:1;
  box-shadow:0 1px 2px rgba(16,24,40,.16);
  transition:opacity .12s ease,transform .12s ease}
.td-gantt-bar:hover{opacity:1;transform:scaleY(1.16)}
.td-gantt-bar.done{background:color-mix(in srgb,var(--td-text-3) 45%,var(--td-card));
  opacity:1;box-shadow:none}
.td-gantt-bar.late{background:var(--td-danger)}
.td-gantt-bar.ms{border-radius:3px;height:16px;width:16px;justify-self:start;margin-left:12px;
  transform:rotate(45deg)}
.td-gantt-bar.ms:hover{transform:rotate(45deg) scale(1.12)}
.td-gantt-now{position:absolute;top:0;bottom:0;width:2px;background:var(--td-warm);
  opacity:.55;pointer-events:none;z-index:2}

/* ---- the centred task dialog ------------------------------------------ */
.td-modal-layer{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;
  justify-content:center;padding:24px;background:rgb(0 0 0 / 48%);backdrop-filter:blur(6px);
  animation:tdFade .18s ease-out}
/* Three bands, not one sheet of white: a card-coloured header, a RECESSED body, a
   card-coloured footer. The dialog used to be white fields inside a white card
   separated by 8%-black hairlines, which read as one blank page -- "白花花一片".
   The recessed body is what makes a section, and the fields inside it, visible at
   all; the 3px top edge carries the list colour, the same signal the board column
   and the calendar chip already use. */
.td-modal{width:min(700px,100%);max-height:min(88vh,860px);display:flex;flex-direction:column;
  background:var(--td-card);border-radius:var(--td-r-lg);
  box-shadow:inset 0 3px 0 var(--td-tint,transparent),var(--td-sh-3);
  overflow:hidden;animation:tdModal .24s var(--td-ease)}
@keyframes tdFade{from{opacity:0}to{opacity:1}}
@keyframes tdModal{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
@keyframes tdPopIn{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}
@keyframes tdRowIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.td-modal-h{flex:none;display:flex;align-items:center;gap:12px;padding:16px 16px;
  border-bottom:1px solid var(--td-line)}
/* An eyebrow, not a heading: uppercase mono at 10.5px is what tells the eye "this
   labels the thing below" without competing with the task title. */
.td-modal-kind{font-family:var(--td-mono);font-size:10.5px;font-weight:600;letter-spacing:.09em;
  text-transform:uppercase;color:var(--td-text-3)}
.td-modal-close{flex:none;width:28px;height:28px;border:0;border-radius:var(--td-r-sm);
  background:transparent;color:var(--td-text-2);cursor:pointer;font-size:16px;line-height:0;
  font-family:inherit;display:inline-flex;align-items:center;justify-content:center;
  transition:background-color .13s ease,color .13s ease}
.td-modal-close:hover{background:var(--td-soft);color:var(--td-text)}
.td-modal-b{flex:1;min-height:0;overflow:auto;padding:16px 16px 24px;background:var(--td-canvas)}
/* Every block in the body is a card on that recessed canvas, and the gap between
   them is what lets the eye group the form instead of scanning a wall of white. */
.td-modal-b > * + *{margin-top:12px}
.td-modal-f{flex:none;display:flex;align-items:center;gap:12px;padding:12px 16px;
  border-top:1px solid var(--td-line);background:var(--td-card)}
/* A field on a card is tinted, because a white input on a white card is exactly
   the invisibility this is about; focus returns it to plain card white. Placed
   before the .td-hero rules below, which are meant to win for the title. */
.td-modal .td-in{background:var(--td-field);border-color:transparent}
.td-modal .td-in:hover{background:var(--td-soft);border-color:var(--td-line-2)}
.td-modal .td-in:focus{background:var(--td-card);border-color:var(--td-line-2);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-text) 18%,transparent)}
/* The list editor is a form, not a document: the same dialog shell, narrower. */
.td-narrow{width:min(460px,100%)}
.td-swatches{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
/* The ring is drawn OUTSIDE the swatch (a card-coloured gap then a text-coloured
   ring) because a 2px inset ring on a saturated dot is invisible at this size. */
.td-swatch{width:24px;height:24px;padding:0;border:0;border-radius:999px;cursor:pointer;
  box-shadow:inset 0 0 0 1px var(--td-line-2);transition:transform .12s ease,box-shadow .12s ease}
.td-swatch:hover{transform:scale(1.12)}
.td-swatch.on{box-shadow:0 0 0 2px var(--td-card),0 0 0 4px var(--td-text-2)}
.td-posline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.td-preview{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 12px;
  border-radius:999px;background:var(--td-field);font-size:12.5px;color:var(--td-text)}
.td-preview .td-side-l{flex:0 1 auto}
.td-hero{display:flex;align-items:flex-start;gap:12px;padding:16px 16px;
  background:var(--td-card);border-radius:var(--td-r-md);box-shadow:var(--td-sh-1)}
.td-hero .td-chk{width:20px;height:20px;margin-top:4px;font-size:12.5px}
.td-hero .td-in{flex:1;font-size:16px;font-weight:600;padding:6px 8px;border-color:transparent;
  background:transparent;letter-spacing:-.01em;border-radius:var(--td-r-sm)}
.td-hero .td-in:hover{border-color:var(--td-line);background:var(--td-soft)}
.td-hero .td-in:focus{border-color:var(--td-line-2);background:var(--td-card);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-text) 18%,transparent)}
.td-props{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;padding:16px 16px;
  background:var(--td-card);border-radius:var(--td-r-md);box-shadow:var(--td-sh-1)}
.td-field{min-width:0}
.td-field > label{display:block;font-family:var(--td-mono);font-size:10.5px;font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--td-text-3);margin-bottom:8px}
.td-field .td-in{width:100%}
.td-sect{padding:16px 16px;background:var(--td-card);border-radius:var(--td-r-md);
  box-shadow:var(--td-sh-1)}
.td-sect > label{display:block;font-family:var(--td-mono);font-size:10.5px;font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--td-text-3);margin-bottom:8px}
.td-rowline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.td-rowline .td-in{width:auto}
.td-ta{min-height:84px;resize:vertical;line-height:1.6;width:100%}
.td-sub-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--td-r-sm);
  transition:background-color .12s ease}
.td-sub-row:hover{background:var(--td-field)}
.td-sub-row .td-t{flex:1;min-width:0;cursor:pointer;word-break:break-word;font-size:14px}
.td-sub-row.done .td-t{text-decoration:line-through;color:var(--td-text-3)}
/* Priority as a row of radio pills rather than a dropdown: four options is few
   enough to show at once, and a vertical list would set the row height for the
   whole property grid -- leaving a hole under the fields beside it. */
.td-opts{display:flex;flex-wrap:wrap;gap:8px}
.td-opt{display:inline-flex;align-items:center;gap:8px;margin:0;padding:4px 12px 4px 8px;
  border:0;border-radius:999px;background:var(--td-soft);color:var(--td-text-2);
  font-size:12.5px;font-family:inherit;cursor:pointer;box-shadow:var(--td-sh-hair);
  transition:background-color .13s ease,color .13s ease,box-shadow .13s ease}
.td-opt:hover{background:var(--td-field);color:var(--td-text)}
.td-opt.on{background:var(--td-card);color:var(--td-text);font-weight:550;
  box-shadow:var(--td-sh-1)}
.td-ind{display:flex;width:14px;height:14px;flex:none;align-items:center;justify-content:center;
  border-radius:999px;color:transparent;box-shadow:inset 0 0 0 1.5px var(--td-line-2);
  transition:background-color .2s ease,box-shadow .2s ease,color .2s ease}
.td-opt.on .td-ind{background:var(--td-text);color:var(--td-card);box-shadow:none}
.td-opt-dot{width:6px;height:6px;border-radius:999px;flex:none}
.td-wd{display:flex;gap:4px}
.td-wd button{width:32px;height:30px;border-radius:var(--td-r-sm);border:0;background:var(--td-field);
  color:var(--td-text-2);cursor:pointer;font-size:12.5px;font-family:inherit;
  transition:background-color .15s ease,color .15s ease}
.td-wd button:hover{color:var(--td-text)}
.td-wd button.on{background:var(--td-text);color:var(--td-card);font-weight:600}

/* ---- feedback ---------------------------------------------------------- */
.td-toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:20;
  display:flex;height:36px;max-width:calc(100% - 32px);align-items:center;padding:0 12px;
  border-radius:999px;background:var(--td-text);
  color:var(--td-card);font-size:12.5px;font-weight:500;box-shadow:var(--td-sh-3);
  animation:tdToast .22s var(--td-ease)}
@keyframes tdToast{from{opacity:0;transform:translate(-50%,8px) scale(.96)}
  to{opacity:1;transform:translate(-50%,0) scale(1)}}
/* The empty state is the first thing a new document shows, and it sits on the
   canvas: ink-2 (4.69), not ink-3 (4.29). */
.td-empty{color:var(--td-text-2);font-size:12.5px;padding:48px 16px;text-align:center;
  line-height:1.6}
.td-empty-t{font-size:14px;font-weight:600;color:var(--td-text)}
.td-empty-ex{margin-top:16px}
.td-empty-l{margin-bottom:8px}
.td-empty-gap{height:8px}
.td-empty code{background:var(--td-field);padding:2px 8px;border-radius:6px;
  font-size:12.5px;font-family:var(--td-mono);color:var(--td-text-2)}
.td-warn{border-radius:var(--td-r-md);padding:8px 12px;font-size:12.5px;margin-bottom:12px;
  color:color-mix(in srgb,var(--td-warn) 88%,var(--td-text));
  background:color-mix(in srgb,var(--td-warn) 12%,var(--td-card))}
.td-err{border-radius:var(--td-r-md);padding:8px 12px;font-size:12.5px;margin-bottom:12px;
  color:color-mix(in srgb,var(--td-danger) 90%,var(--td-text));white-space:pre-wrap;
  background:color-mix(in srgb,var(--td-danger) 12%,var(--td-card))}
.td-pop{position:absolute;z-index:30;background:var(--td-card);border-radius:var(--td-r-md);
  padding:4px;min-width:168px;box-shadow:var(--td-sh-3);animation:tdPop .16s var(--td-ease);
  transform-origin:top right}
@keyframes tdPop{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}
.td-pop button{display:block;width:100%;text-align:left;border:0;background:transparent;
  color:var(--td-text-2);padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;
  font-family:inherit;transition:background-color .1s ease,color .1s ease}
.td-pop button:hover{background:var(--td-soft);color:var(--td-text)}

/* ---- the floating window ---------------------------------------------- */
/* The app in a box the user drags around the page. The box owns the definite
   height the list scrolls inside, so every layer below it keeps the panel's own
   flex chain -- no second scroll model for the same list. */
.td-float{position:fixed;z-index:9050;display:flex;flex-direction:column;min-width:260px;
  min-height:200px;background:var(--td-card);border-radius:var(--td-r-lg);
  box-shadow:var(--td-sh-3);overflow:hidden;animation:tdModal .22s var(--td-ease)}
.td-float.dragging{user-select:none;box-shadow:var(--td-sh-3),0 0 0 1px var(--td-brand)}
.td-float .td-root,.td-root.td-floatapp{height:100%;background:var(--td-card)}
/* The header IS the drag handle: the strip grabs, the controls inside it do not
   (the pointerdown handler skips anything inside a button or an input). */
.td-float .td-head{height:auto;min-height:48px;padding:0 12px;cursor:move;
  touch-action:none;border-bottom:1px solid var(--td-line);
  border-radius:var(--td-r-lg) var(--td-r-lg) 0 0}
.td-float .td-head .td-btn,.td-float .td-head .td-icon{cursor:pointer}
.td-float .td-qadd{padding:12px 12px}
.td-float .td-rail{display:none}
/* Search and the smart lists stay reachable inside the window: a box that could
   only show one slice of the tasks would send the user back to the panel for
   every question. The chips scroll sideways instead of wrapping to two rows. */
.td-float-bar{flex:none;display:flex;flex-direction:column;gap:8px;padding:8px 12px;
  border-bottom:1px solid var(--td-line);background:var(--td-card)}
.td-float-bar .td-float-lists{display:flex;align-items:center;gap:8px;padding:0 2px}
.td-float-sel{flex:1;min-width:0;height:28px;padding:0 6px;border-radius:var(--td-r-sm);
  font-family:inherit;font-size:12.5px;font-weight:600;color:var(--td-ink-2);
  background:transparent;border-color:transparent}
.td-float-sel:hover{background:var(--td-soft)}
.td-float-sel:focus{background:var(--td-card);border-color:var(--td-line-2);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--td-text) 18%,transparent)}
.td-float-tabs{display:flex;overflow-x:auto;scrollbar-width:none}
.td-float-tabs::-webkit-scrollbar{display:none}
.td-float-tabs > button{flex:none;padding:4px 8px;font-size:12.5px;border-radius:6px}
/* The checklist skin: one line per task, the title ellipsised instead of broken
   one CJK character per line, and the rows flattened from cards to lines --
   which is all a "name + checkbox" row needs. */
.td-float .td-scroll{padding:8px 8px 24px}
.td-cmp .td-item{background:transparent;border-radius:var(--td-r-sm);box-shadow:none}
.td-cmp .td-item:hover{background:var(--td-soft);box-shadow:none}
.td-cmp .td-item::before{display:none}
.td-cmp .td-item.done{background:transparent}
.td-cmp .td-row{min-height:36px;padding:0 8px;gap:8px}
.td-cmp .td-row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  word-break:normal;font-size:14px}
.td-cmp .td-grp-h{margin-bottom:4px}
.td-cmp .td-grp + .td-grp{margin-top:12px}
/* The sticky group title belongs to the panel's scrolling list; the window's
   checklist is a short column inside its own box, and a title pasted over the
   rows there would only hide them. */
.td-cmp .td-grp .td-grp-h{position:static;background:transparent}
/* The window's skin: 奶白 + 蓝, pinned so the card looks the same in the light and
   in the dark theme. The tokens are re-pointed rather than every rule rewritten,
   so the atoms inside -- chips, checkboxes, the grip -- follow on their own. */
.td-float{
  --td-canvas:var(--td-cream-2);
  --td-card:var(--td-cream);
  --td-soft:color-mix(in srgb,var(--td-accent) 9%,var(--td-cream));
  --td-field:color-mix(in srgb,var(--td-accent) 7%,var(--td-cream));
  --td-line:color-mix(in srgb,var(--td-accent) 14%,var(--td-cream));
  --td-line-2:color-mix(in srgb,var(--td-accent) 28%,var(--td-cream));
  --td-text:var(--td-ink);
  --td-text-2:var(--td-ink-2);
  --td-text-3:color-mix(in srgb,var(--td-ink-2) 68%,var(--td-cream));
  --td-brand:var(--td-accent);
  /* A blue tick, not a green one: the pair is the whole point of the skin. */
  --td-ok:var(--td-accent);
  border:1px solid var(--td-line-2);
  box-shadow:var(--td-sh-3),0 18px 44px rgb(47 107 255 / 18%)}
/* ---- refinement pass: the window needs ONE centre --------------------- */
/* It had four things shouting at once -- a blue edge, a blue badge, a filled
   chip and a solid send button -- and therefore no focal point. Blue is now
   STATE only (the active slice, the checkbox, the row you are on), the task
   titles are the only heavy dark text in the window, and everything else is
   chrome: one strip, hairlines instead of boxes, and the send button demoted to
   a chip. The list is what the eye should land on, so it gets the air instead. */
.td-flogo{width:15px;height:15px;border-radius:6px;flex:none;
  background:linear-gradient(145deg,var(--td-accent),
    color-mix(in srgb,var(--td-accent) 45%,var(--td-cream)));
  box-shadow:0 1px 3px color-mix(in srgb,var(--td-accent) 30%,transparent)}
.td-float .td-head{min-height:48px;padding:0 12px;border-bottom:0;
  background:var(--td-card)}
.td-float .td-h1{font-size:14px;font-weight:650;color:var(--td-ink)}
/* The count is context, not a badge: a plain number cannot out-shout the rows. */
.td-float .td-countbadge{min-width:0;height:auto;padding:0 0 0 4px;background:transparent;
  color:var(--td-text-3);font-size:10.5px;font-weight:600}
.td-float .td-headtools .td-btn,.td-float .td-headtools .td-icon{background:transparent;
  color:var(--td-text-3);font-weight:600}
.td-float .td-headtools .td-btn:hover,.td-float .td-headtools .td-icon:hover{
  background:var(--td-soft);color:var(--td-accent)}
/* The filter row is a row of words, not a segmented control: the field-coloured
   trough was a box that answered a question nobody asked. */
.td-float .td-seg{background:transparent;padding:0}
.td-float .td-float-tabs > button{padding:4px 8px;font-size:12.5px;font-weight:600;
  color:var(--td-text-3)}
.td-float .td-float-tabs > button:hover{background:var(--td-soft);color:var(--td-ink)}
/* One filled pill per row, and this is it: the slice you are looking at. A tint
   reads as "selected" without competing with the checkbox for the same colour. */
.td-float .td-seg > button.on{background:color-mix(in srgb,var(--td-accent) 13%,var(--td-cream));
  color:color-mix(in srgb,var(--td-accent) 86%,var(--td-ink));font-weight:700}
.td-float .td-send{width:36px;height:36px;border-radius:var(--td-r-md);
  background:color-mix(in srgb,var(--td-accent) 13%,var(--td-cream));color:var(--td-accent)}
.td-float .td-send:hover{background:var(--td-accent);color:var(--td-cream);filter:none}
.td-float .td-qadd{padding:12px 12px}
.td-float .td-qadd .td-in{height:36px}
.td-cmp .td-grp{margin-bottom:16px}
.td-cmp .td-grp:first-child{margin-top:4px}
.td-cmp .td-grp-h{padding:0 0 6px;margin:0 0 6px}
.td-cmp .td-grp-h > span:first-child{font-size:12.5px;letter-spacing:.06em;font-weight:700;
  color:color-mix(in srgb,var(--td-accent) 40%,var(--td-ink))}
.td-cmp .td-grp-n{background:transparent;box-shadow:none;color:var(--td-text-3);font-weight:600}
.td-cmp .td-grp-h::after{background:var(--td-line)}
/* A checklist reads as a column, not as a stack of cards; the row you are on is
   where the blue comes back, as a 2px edge rather than a whole filled card. */
.td-cmp .td-item{margin-bottom:2px}
.td-cmp .td-row{min-height:36px;padding:0 8px;gap:12px}
.td-cmp .td-row-title{font-size:14px;font-weight:600;color:var(--td-ink)}
.td-cmp .td-item:hover{box-shadow:inset 2px 0 0 var(--td-accent)}
.td-cmp .td-item.done:hover{box-shadow:inset 2px 0 0 var(--td-line-2)}
.td-cmp .td-chk{width:18px;height:18px}
/* The last row fades instead of being cut: the column has no bottom edge.
   rgb() rather than a hex literal -- a mask only reads the alpha, and the sheet
   keeps one token map (see scripts/audit-css.mjs). */
.td-float .td-scroll{
  mask-image:linear-gradient(180deg,rgb(0 0 0) calc(100% - 24px),transparent 100%);
  -webkit-mask-image:linear-gradient(180deg,rgb(0 0 0) calc(100% - 24px),transparent 100%)}

/* ---- the celebration ---------------------------------------------------- */
/* Ten sparks and a ring for under a second after a box is ticked. Purely CSS: the
   component only decides WHEN to mount them, so a re-render cannot restart or
   strand the animation. The colour rides on --c, which keeps one class for all
   ten. Both the ring and the sparks use --td-ok / --td-warm: the panel's
   celebration used the floating window's blue, which put a second blue in a
   one-colour theme (D17). */
@keyframes tdSpark{
  0%{opacity:0;transform:rotate(var(--a,0deg)) translateX(2px) scale(.4)}
  15%{opacity:1}
  100%{opacity:0;transform:rotate(var(--a,0deg)) translateX(var(--d,20px)) scale(1)}}
@keyframes tdRing{
  0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--td-ok) 55%,transparent)}
  100%{box-shadow:0 0 0 14px color-mix(in srgb,var(--td-ok) 0%,transparent)}}
.td-burst{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:2}
.td-spark{position:absolute;left:-2px;top:-2px;width:5px;height:5px;
  border-radius:0;background:var(--c,var(--td-ok));opacity:0;
  animation:tdSpark .78s var(--td-ease) var(--t,0ms) forwards}
.td-chk.ring{animation:tdPopIn .3s var(--td-ease) both,tdRing .7s ease-out}
.td-dragh{cursor:move;touch-action:none}
.td-float-grip{position:absolute;right:0;bottom:0;width:20px;height:20px;z-index:2;
  cursor:nwse-resize;touch-action:none}
.td-float-grip::after{content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;
  border-right:2px solid var(--td-line-2);border-bottom:2px solid var(--td-line-2);
  border-radius:0 0 3px 0;opacity:.8}
.td-float-grip:hover::after{border-color:var(--td-text-2)}

/* ---- sidebar glyph + badge -------------------------------------------- */
.td-glyphwrap{position:relative;display:inline-flex;align-items:center;justify-content:center;
  line-height:0;color:inherit}
/* Aliases, not raw host tokens: this badge is the one place outside the alias
   block that used to reach for --dsw-alias-brand-primary directly, which is what
   made it the only element that ignored the plugin's own ink ladder (D11). */
.td-glyphbadge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 4px;
  border-radius:6px;background:var(--td-text);color:var(--td-card);
  font-family:var(--td-mono);font-size:10.5px;font-weight:700;line-height:14px;text-align:center;
  font-variant-numeric:tabular-nums;
  box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill);pointer-events:none}

/* ---------------------------------------------------------------------------
   Density tiers. The container is .td-root itself, so these are CONTAINER
   queries: the panel decides its own density from the width it was given, not
   from the window it happens to sit in.
   --------------------------------------------------------------------------- */

/* WIDE (>= 1600px): the list stops growing at 1280px and the board's columns
   share out the extra width instead of leaving two empty margins (D15). */
@container td (min-width:1600px){
  .td-listwrap{max-width:1280px}
  .td-row{padding:2px 16px}
  .td-col{flex:1 1 322px;max-width:420px}
  .td-board{gap:16px}
}

/* NARROW (<= 680px): the rail is dropped entirely -- a 238px rail inside a
   400px panel leaves neither column readable -- and everything it carried comes
   back in the header (the view switcher, the search box, and the second row with
   the smart lists and the list switcher). The month grid and the board columns
   shrink with it: seven 124px cells do not fit in a 400px panel, and a column
   that kept its 322px width would push the second column out of sight. */
@container td (max-width:680px){
  .td-rail{display:none}
  .td-head{flex-wrap:wrap;height:auto;min-height:56px;padding:0 12px;gap:8px}
  .td-head2{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;
    overflow-x:auto;scrollbar-width:none;background:var(--td-card);
    border-bottom:1px solid var(--td-line)}
  .td-head2::-webkit-scrollbar{display:none}
  .td-headtools .td-headviews{display:inline-flex}
  /* ...and the search box comes back to the header with it. The class sits on the
     box, not the field, so the magnifier and the tag chip travel with it. */
  .td-headtools .td-headsearch{display:block}
  .td-sub{display:none}
  .td-headsearch .td-search{width:140px}
  .td-modal-layer{padding:12px}
  .td-gantt-l{width:200px}
  .td-cal-cell{min-height:88px;padding:6px 6px}
  .td-cal-task{font-size:12.5px;padding:2px 6px}
  .td-col{width:262px}
  /* The row goes two lines instead of shrinking its type -- and the FIRST line is
     the row's identity: checkbox + title, then the metadata on its own line, and
     the row grows rather than the font shrinking. The title keeps flex:1 1 auto
     (not 100%) so it shares line one with the checkbox: giving it the whole line
     left every row as a lone checkbox above a stranded title, and the list read as
     a stack of stray rings. The metadata is indented to the title's own left edge
     (caret 20 + gap 12 + box 20 + gap 12) so the second line hangs off the title
     instead of drifting back under the checkbox column. */
  .td-row{flex-wrap:wrap;min-height:56px;padding:4px 12px;row-gap:2px}
  .td-row-title{flex:1 1 auto;min-width:0;order:1}
  .td-actions{order:1;margin-left:auto}
  .td-meta{order:2;flex:1 1 100%;min-width:0;max-width:100%;justify-content:flex-start;
    padding-left:64px}
}
`

      // ---------------------------------------------------------------------
      // atoms
      // ---------------------------------------------------------------------

      /**
       * The completion control.
       *
       * A done task fills the ring with the success colour and shows a stroked
       * tick, rather than tinting the ring: the fill is the only state in the list
       * that is not a shade of grey, so "already handled" is readable at a glance
       * from across the screen. The tick is an SVG path, not the `✓` character --
       * the character sits on a different baseline and optical weight than the
       * stroke it is meant to match.
       */
      function Check(props) {
        const priority = Number(props.priority ?? 0)
        const size = Number(props.size ?? 0)
        // The celebration is local and one-shot: a burst that outlives its click
        // is noise, and a shared-store flag would have to be cleared by whoever
        // happens to re-render next.
        const [cheer, setCheer] = useState(false)
        const cheerTimer = useRef(null)
        useEffect(() => () => {
          if (cheerTimer.current !== null) clearTimeout(cheerTimer.current)
        }, [])
        const onClick = (event) => {
          event.stopPropagation()
          if (props.done !== true) {
            setCheer(true)
            if (cheerTimer.current !== null) clearTimeout(cheerTimer.current)
            cheerTimer.current = setTimeout(() => setCheer(false), 820)
          }
          props.onToggle()
        }
        return h('button', {
          type: 'button',
          className: `td-chk${props.done ? ' on' : ''}${priority === 3 && !props.done ? ' p3' : ''}${cheer ? ' ring' : ''}`,
          style: size > 0 ? { width: size, height: size } : null,
          title: props.done ? '标记为未完成' : '标记完成',
          'aria-label': props.done ? '标记为未完成' : '标记完成',
          'aria-pressed': props.done === true,
          onClick,
        }, props.done
          ? h('svg', {
            width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round',
            strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
          }, h('path', { d: 'M20 6L9 17l-5-5' }))
          : null,
        // The sparks live IN the button rather than in a wrapper around it: `.td-chk`
        // is the anchor the rest of the UI looks for, and a wrapper would hide it
        // behind a span nobody else knows about.
        cheer
          ? h('span', { className: 'td-burst', 'aria-hidden': 'true' },
            ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => h('span', {
              key: i,
              className: 'td-spark',
              style: {
                '--a': `${i * 36 + 18}deg`,
                '--d': `${17 + (i % 3) * 6}px`,
                '--t': `${(i % 4) * 45}ms`,
                '--c': i % 2 === 0 ? 'var(--td-ok)' : 'var(--td-warm)',
              },
            })))
          : null)
      }

      // Every colour here goes through the alias block: a raw host token in the
      // JSX is a second palette that the stylesheet's own rules cannot reach.
      const PRIORITY_COLORS = ['transparent', '#8b97a6', '#e0a53c', 'var(--td-danger)']
      const PRIORITY_LABELS = ['无', '低', '中', '高']

      /**
       * The priority modifier, looked up rather than templated.
       *
       * A ` p${n}` template reads the same at runtime but hides all four class
       * names from anything that inspects this file statically -- including
       * `scripts/audit-css.mjs`, whose whole job is to notice a class the
       * stylesheet forgot. Spelling them out keeps that gate honest.
       */
      const PRIORITY_CLASS = ['', ' p1', ' p2', ' p3']
      const priorityClass = (value) => PRIORITY_CLASS[Number(value) || 0] ?? ''

      /**
       * The metadata strip's icons.
       *
       * These are SVG paths rather than the unicode glyphs they replaced
       * (`⟳ ☑ 📝`): an emoji-presentation character renders as a full-colour
       * picture that ignores the theme and sits at a different optical weight
       * from the text beside it, which is exactly what a metadata chip must not
       * do. `currentColor` keeps them on the same token as the chip text.
       */
      const GLYPHS = {
        repeat: 'M4.2 8a4.3 4.3 0 0 1 4.3-4.3h3M9.9 1.8l2 1.9-2 1.9M11.8 8a4.3 4.3 0 0 1-4.3 4.3H4.4M6.1 14.2l-2-1.9 2-1.9',
        note: 'M3 4.2h10M3 8h10M3 11.8h6.4',
        check: 'M3 8.6l3.2 3.2L13 5',
        list: 'M3 4.5h10M3 8h7M3 11.5h7',
        board: 'M2.6 3.4h4.3v9.2H2.6zM9.1 3.4h4.3v5.6H9.1z',
        calendar: 'M2.6 4.4h10.8v9H2.6zM2.6 7.2h10.8M5.4 2.6v2.6M10.6 2.6v2.6',
        gantt: 'M2.6 4.2h4.4M5.4 8h6M3.6 11.8h4.8',
        export: 'M8 2.4v7.2M5.2 6.8L8 9.6l2.8-2.8M2.8 13.4h10.4',
        import: 'M8 10.6V3.4M5.2 6.2L8 3.4l2.8 2.8M2.8 13.4h10.4',
        copy: 'M6.2 2.6h7.2v7.2H6.2zM2.6 6.2v7.2h7.2',
        refresh: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.6v3.2h-3.2',
        send: 'M8 13.4V3.2M3.6 7.6L8 3.2l4.4 4.4',
        plus: 'M8 3.6v8.8M3.6 8h8.8',
        search: 'M10.6 10.6l2.8 2.8M11.6 7.2a4.4 4.4 0 1 1-8.8 0 4.4 4.4 0 0 1 8.8 0z',
        move: 'M2.6 8h6.8M6.6 5.2L9.4 8l-2.8 2.8M12 3.4v9.2',
        close: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2',
        chevron: 'M4.8 6.2L8 9.4l3.2-3.2',
        more: 'M4.2 8h.9M7.6 8h.9M11 8h.9',
        up: 'M8 12.6V4M4.8 7.2L8 4l3.2 3.2',
        down: 'M8 3.4V12M4.8 8.8L8 12l3.2-3.2',
        trash: 'M3.4 4.8h9.2M6.4 4.8V3.4h3.2v1.4M4.9 4.8l.5 8h5.2l.5-8',
      }

      function Glyph({ name, size }) {
        const path = GLYPHS[name]
        if (path === undefined) return null
        const px = Number(size ?? 12)
        return h('svg', {
          className: 'td-glyph',
          width: px, height: px, viewBox: '0 0 16 16',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false',
        }, h('path', { d: path }))
      }

      /**
       * The metadata strip shared by list rows and board cards.
       *
       * Priority is deliberately absent: it is already the card's left edge, and
       * saying it twice in a 300px row is noise. The completed-run counter is
       * absent for the same reason -- the dialog is where the history belongs.
       */
      function Meta({ task, today, showList, listName, listColor }) {
        const due = parseDue(task.due)
        const late = !task.done && due !== null && due.date < today
        const isToday = due !== null && due.date === today
        // A FIXED order -- due -> repeat -> subtasks -> list -> note -> tags --
        // because a strip whose order follows "which fields happen to be set"
        // makes the eye re-read every row from scratch. Each entry carries a plain
        // label beside its node so the overflow chip can name what it swallowed.
        const entries = []
        if (due !== null) {
          const label = `${task.due.replace('T', ' ')}${late ? '（已逾期）' : ''}`
          entries.push({
            key: 'due',
            label,
            node: h('span', {
              key: 'due',
              className: `td-chip${late ? ' late' : isToday ? ' today' : ''}`,
              title: label,
            }, fmtDue(task.due, today)),
          })
        }
        if (task.recurrence !== null) {
          entries.push({
            key: 'rec',
            label: recurrenceRuleText(task.recurrence),
            node: h('span', {
              key: 'rec', className: 'td-chip', title: recurrenceRuleText(task.recurrence),
            }, h(Glyph, { key: 'g', name: 'repeat', size: 11 }),
              task.completedCount > 0 ? `${task.completedCount} 次` : '重复'),
          })
        }
        if (task.subtaskTotal > 0) {
          entries.push({
            key: 'sub',
            label: `${task.subtaskDone}/${task.subtaskTotal} 个子任务已完成`,
            node: h('span', {
              key: 'sub',
              className: 'td-chip',
              title: `${task.subtaskDone}/${task.subtaskTotal} 个子任务已完成`,
            }, h(Glyph, { key: 'g', name: 'check', size: 11 }), `${task.subtaskDone}/${task.subtaskTotal}`),
          })
        }
        if (showList === true && listName) {
          entries.push({
            key: 'list',
            label: listName,
            node: h('span', { key: 'list', className: 'td-chip', title: `清单：${listName}` },
              listColor
                ? h('span', { key: 'd', className: 'td-dot', style: { background: listColor, width: 6, height: 6 } })
                : null,
              listName),
          })
        }
        if (task.note && task.note.length > 0) {
          entries.push({
            key: 'note',
            label: '备注',
            node: h('span', {
              key: 'note', className: 'td-chip', title: task.note.slice(0, 300),
            }, h(Glyph, { key: 'g', name: 'note', size: 11 })),
          })
        }
        // A tag that only repeats the list name says nothing the list chip has not
        // said already -- and it says it one slot further right (D07).
        for (const tag of task.tags) {
          if (tag === listName) continue
          entries.push({
            key: `tag-${tag}`,
            label: `#${tag}`,
            node: h('span', { key: `tag-${tag}`, className: 'td-tag' }, `#${tag}`),
          })
        }
        if (entries.length === 0) return null
        // Three slots, then a "+N": the strip is the row's right edge, and an
        // unbounded one is what pushed a long title off a narrow panel. What did
        // not fit is still readable through the overflow chip's tooltip.
        const shown = entries.slice(0, 3)
        const hidden = entries.slice(3)
        return h('span', { className: 'td-meta' },
          ...shown.map((entry) => entry.node),
          hidden.length === 0
            ? null
            : h('span', {
              key: 'more',
              className: 'td-meta-more',
              title: hidden.map((entry) => entry.label).join(' · '),
            }, `+${hidden.length}`))
      }

      /** [kind, label, glyph] for the four views, in the order the rail lists them. */
      const VIEW_KINDS = [
        ['list', '列表', 'list'],
        ['board', '看板', 'board'],
        ['calendar', '日历', 'calendar'],
        ['gantt', '甘特图', 'gantt'],
      ]

      /** The last path segment: the rail shows `tasks.json`, the tooltip the rest. */
      const fileNameOf = (file) => {
        const text = String(file ?? '')
        const parts = text.split(/[\\/]/)
        return parts[parts.length - 1] || text
      }

      function EmptyState({ text, examples }) {
        return h('div', { className: 'td-empty' },
          h('div', { className: 'td-empty-t' }, text),
          examples === true
            ? h('div', { className: 'td-empty-ex' },
              h('div', { className: 'td-empty-l' }, '在下面一行直接输入，例如：'),
              h('div', null, h('code', null, '明天 15:00 交报告 !高 #工作 @紧要')),
              h('div', { className: 'td-empty-gap' }),
              h('div', null, h('code', null, '每周一三五 晨跑')),
              h('div', { className: 'td-empty-gap' }),
              h('div', null, h('code', null, '每月5日 交房租')))
            : null)
      }

      // ---------------------------------------------------------------------
      // the task row (list view) -- recursive, because subtasks nest
      // ---------------------------------------------------------------------

      /**
       * One task in the list view.
       *
       * The card wraps its own subtasks instead of sitting beside them, so a
       * parent and everything under it share one surface and one priority edge.
       * `depth` only changes the styling (`.sub`): the indent itself comes from
       * the `.td-tree` gutter the parent drew, so nesting stays visible no matter
       * how deep it goes.
       */
      function TaskRow(props) {
        const { id, depth, today, byId, collapsed, toggleCollapsed } = props
        const task = byId.get(id)
        if (task === undefined) return null
        // Compact is the floating window's checklist: a name and a checkbox, no
        // chips, no row actions, no subtask tree. The box is a few hundred pixels
        // wide, and a card that shares that width with the metadata wraps to one
        // CJK character per line.
        const compact = props.compact === true
        const children = compact ? [] : (props.childrenOf.get(id) ?? [])
        const isCollapsed = collapsed[id] === true
        const isSub = depth > 0

        const caret = children.length > 0 && !compact
          ? h('button', {
            type: 'button',
            className: 'td-treebtn',
            'aria-expanded': isCollapsed !== true,
            'aria-label': isCollapsed ? '展开子任务' : '收起子任务',
            title: isCollapsed ? '展开子任务' : '收起子任务',
            onClick: (event) => { event.stopPropagation(); toggleCollapsed(id) },
          }, h('svg', {
            // Drawn pointing down and rotated by CSS when open, so the arrow and the
            // panel move on the same curve instead of swapping between two glyphs.
            className: `td-caret${isCollapsed ? '' : ' open'}`,
            width: 12, height: 12, viewBox: '0 0 16 16',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true', focusable: 'false',
          }, h('path', { d: GLYPHS.chevron })))
          // A leaf keeps the caret's width so every checkbox in a group lines up.
          : h('span', { className: 'td-treebtn empty', 'aria-hidden': 'true' })

        const row = h('div', {
          className: 'td-row',
          // The whole row opens the editor, not just the title: a 13px title is a
          // small target, and the nested controls stop propagation themselves.
          onClick: () => props.onOpen(id),
        },
          caret,
          h(Check, { done: task.done, priority: task.priority, onToggle: () => props.onToggle(id) }),
          // In compact the tooltip carries the full title, which is what the
          // single truncated line cannot show.
          h('span', { className: 'td-row-title', title: compact ? task.title : '点击查看/编辑' }, task.title),
          compact ? null : h(Meta, {
            task,
            today,
            showList: props.showList,
            listName: props.listName === undefined ? undefined : props.listName(id),
            listColor: props.listColor === undefined ? undefined : props.listColor(id),
          }),
          compact ? null : h('span', { className: 'td-actions' },
            h('button', {
              type: 'button', className: 'td-icon', title: '添加子任务',
              onClick: (event) => { event.stopPropagation(); props.onAddSubtask(id) },
            }, h(Glyph, { name: 'plus', size: 13 })),
            h('button', {
              type: 'button', className: 'td-icon', title: '删除任务',
              onClick: (event) => {
                event.stopPropagation()
                props.askDelete(id, task.title)
              },
            }, h(Glyph, { name: 'close', size: 13 }))),
        )

        const cls = 'td-item' + priorityClass(task.priority)
          + (task.done ? ' done' : '') + (isSub ? ' sub' : '')
          + (props.openId === id ? ' cur' : '')
        // Staggered entrance, capped: forty rows at 30ms each would take longer
        // than the list is worth waiting for, and the eye only reads the first few.
        const style = isSub || props.index === undefined
          ? null
          : { '--td-delay': `${Math.min(props.index, 8) * 30}ms` }

        return h('div', {
          className: cls,
          style,
          'data-row-id': id,
          // Roving tabindex: exactly ONE row is tabbable, and it is the one the
          // keyboard is on. That is what makes the arrow keys a cursor rather
          // than a way to tab through forty rows.
          role: 'treeitem',
          tabIndex: props.focusId === id ? 0 : -1,
          'aria-level': depth + 1,
          'aria-selected': props.openId === id ? 'true' : 'false',
          ...(children.length === 0 ? {} : { 'aria-expanded': isCollapsed ? 'false' : 'true' }),
          onFocus: () => { if (typeof props.onFocusRow === 'function') props.onFocusRow(id) },
        },
          row,
          children.length === 0
            ? null
            // Always rendered, collapsed to zero height: an element that leaves the
            // DOM cannot animate, and the 0fr -> 1fr grid trick animates a height
            // nobody has to measure.
            : h('div', { className: `td-collapse${isCollapsed ? '' : ' open'}` },
              h('div', { className: 'td-clip' },
                h('div', { className: 'td-tree' },
                  ...children.map((childId) => h(TaskRow, {
                    key: childId,
                    id: childId,
                    depth: depth + 1,
                    today,
                    byId,
                    childrenOf: props.childrenOf,
                    collapsed,
                    toggleCollapsed,
                    onToggle: props.onToggle,
                    onOpen: props.onOpen,
                    onAddSubtask: props.onAddSubtask,
                    askDelete: props.askDelete,
                    showList: props.showList,
                    listName: props.listName,
                    listColor: props.listColor,
                    openId: props.openId,
                    focusId: props.focusId,
                    onFocusRow: props.onFocusRow,
                  }))))),
        )
      }

      // ---------------------------------------------------------------------
      // list view
      // ---------------------------------------------------------------------

      function ListView(props) {
        const { state, groups, byId, childrenOf } = props
        if (groups.length === 0) {
          return h(EmptyState, {
            text: state.query
              ? `没有匹配「${state.query}」的任务。`
              : state.filter === 'done' ? '还没有已完成的任务。' : '这里还没有任务。',
            examples: state.query === '',
          })
        }
        // `td-cmp` is the compact skin the floating window asks for.
        return h('div', {
          className: `td-listwrap${props.compact ? ' td-cmp' : ''}`,
          // The list IS a tree (subtasks nest inside their parent), so it is
          // announced as one -- and the roving tabindex on the rows is what makes
          // the arrow keys a cursor instead of a way to tab through forty rows.
          //
          // The tree itself is the Tab stop until the cursor is on a row. Without
          // this the list was reachable by keyboard only in theory: no row is
          // tabbable before something focuses one, and nothing could focus one with
          // the keyboard, so Tab skipped the whole tree (measured: tabindex null on
          // this element, -1 on all eight rows, i.e. ZERO stops). One stop exists at
          // every moment -- here before the cursor moves, on the cursor row after --
          // which is what the roving-tabindex pattern promises and what
          // verify-client-render now asserts.
          role: 'tree',
          tabIndex: props.focusId === null ? 0 : -1,
          'aria-label': '任务列表',
        }, ...groups.map((group) => h('div', { className: 'td-grp', key: group.key },
          h('div', { className: 'td-grp-h' },
            h('span', null, group.label),
            h('span', { className: 'td-grp-n' }, String(group.ids.length)),
            // The group's own "+": the new task lands in THIS bucket, which is
            // the whole point -- the old path prefilled the global box and let
            // the task fall wherever the parser felt like putting it.
            props.onAddHere === undefined || group.seed?.addable !== true
              ? null
              : h('button', {
                type: 'button',
                className: 'td-grp-add',
                title: `在「${group.label}」中添加`,
                'aria-label': `在「${group.label}」中添加`,
                onClick: () => props.onAddHere(group.key),
              }, h(Glyph, { name: 'plus', size: 13 }))),
          ...group.ids.map((id, index) => h(TaskRow, {
            key: id,
            id,
            index,
            depth: 0,
            today: state.today,
            byId,
            childrenOf,
            collapsed: state.collapsed,
            toggleCollapsed: props.toggleCollapsed,
            onToggle: props.onToggle,
            onOpen: props.onOpen,
            onAddSubtask: props.onAddSubtask,
            askDelete: props.askDelete,
            // Naming the list inline is what makes the "全部任务" and "未安排"
            // buckets readable; inside one list it would repeat the rail.
            showList: props.showList,
            listName: props.listName,
            listColor: props.listColor,
            compact: props.compact,
            openId: props.openId,
            focusId: props.focusId,
            onFocusRow: props.onFocusRow,
          })),
          props.newGroup === group.key
            ? h(InlineAdd, {
              key: 'new',
              seed: group.seed,
              label: `在「${group.label}」中添加任务`,
              onClose: () => props.onAddHere(null),
            })
            : null)))
      }

      // ---------------------------------------------------------------------
      // board view (columns = lists, drag between them)
      // ---------------------------------------------------------------------

      function BoardCard({ id, task, today, dragging, onOpen, onToggle, onDragStart, onDragEnd, onMoveMenu }) {
        return h('div', {
          className: 'td-card' + priorityClass(task.priority)
            + (task.done ? ' done' : '') + (dragging ? ' dragging' : ''),
          draggable: true,
          onDragStart: (event) => {
            // A plain-text payload keeps the drag working even when the drop
            // target is outside this component's React tree.
            try { event.dataTransfer.setData('text/plain', id) } catch { /* some browsers refuse */ }
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
            onDragStart(id)
          },
          onDragEnd,
          onClick: () => onOpen(id),
        },
          h('div', { className: 'td-grow' },
            h('div', { className: 'td-card-t' }, task.title),
            h(Meta, { task, today }),
            ),
          h('div', { className: 'td-card-side' },
            h(Check, { done: task.done, priority: task.priority, size: 20, onToggle: () => onToggle(id) }),
            h('button', {
              type: 'button', className: 'td-icon', title: '移动到其他清单',
              onClick: (event) => { event.stopPropagation(); onMoveMenu(id, event) },
            }, h(Glyph, { name: 'move', size: 13 }))),
        )
      }

      function BoardView(props) {
        const { state, columns, byId, dragId } = props
        if (columns.length === 0) return h(EmptyState, { text: '还没有清单。' })
        return h('div', { className: 'td-board' }, ...columns.map((column) => h('div', {
          key: column.id,
          className: `td-col${props.dropTarget === column.id ? ' drop' : ''}`,
          // The list colour becomes the column's top edge; nothing else tells
          // four otherwise identical columns apart at a glance.
          style: { '--td-tint': column.color },
          onDragOver: (event) => { event.preventDefault(); props.onDragOver(column.id) },
          onDragLeave: () => props.onDragOver(null),
          onDrop: (event) => {
            event.preventDefault()
            const id = dragId ?? (() => { try { return event.dataTransfer.getData('text/plain') } catch { return null } })()
            if (id) props.onDrop(id, column.id)
          },
        },
          h('div', { className: 'td-col-h' },
            h('span', { className: 'td-dot', style: { background: column.color } }),
            h('span', { className: 'td-side-l' }, column.name),
            h('span', { className: 'td-col-n' }, String(column.ids.length)),
            h('span', { className: 'td-grow' }),
            h('button', {
              type: 'button', className: 'td-col-add', title: `在「${column.name}」中新建任务`,
              onClick: (event) => { event.stopPropagation(); props.onAddHere(column.id) },
            }, h(Glyph, { name: 'plus', size: 13 }))),
          h('div', { className: 'td-col-b' },
            // The new-card box is born INSIDE the column. It used to prefill the
            // global capture bar instead, which threw the caret out of the column
            // and made the user scroll back to see what they had just made.
            props.newColumn === column.id
              ? h(InlineAdd, {
                key: 'new',
                className: 'td-col-new',
                seed: column.seed,
                label: `在「${column.name}」中新建任务`,
                placeholder: '回车添加，Esc 取消',
                onClose: () => props.onAddHere(null),
              })
              : null,
            ...column.ids.map((id) => h(BoardCard, {
              key: id,
              id,
              task: byId.get(id),
              today: state.today,
              dragging: dragId === id,
              onOpen: props.onOpen,
              onToggle: props.onToggle,
              onDragStart: props.onDragStart,
              onDragEnd: props.onDragEnd,
              onMoveMenu: props.onMoveMenu,
            })),
            column.ids.length === 0
              ? h('div', {
                className: 'td-col-empty',
                onClick: () => props.onAddHere(column.id),
              }, '拖到这里，或点击新建')
              : null))))
      }

      // ---------------------------------------------------------------------
      // calendar view
      // ---------------------------------------------------------------------

      function CalendarView(props) {
        const { state, byId, view } = props
        const weekStart = Number(state.settings?.weekStart) === 0 ? 0 : 1
        const month = state.calMonth ?? monthOf(state.today)
        const cells = monthGrid(month, weekStart)
        const dayMap = new Map((view.days ?? []).map((d) => [d.date, d.ids]))
        const [y, m] = month.split('-').map(Number)
        const selected = state.day
        const selectedIds = selected === null ? [] : (dayMap.get(selected) ?? [])

        return h('div', null,
          h('div', { className: 'td-cal-h' },
            h('div', { className: 'td-cal-nav' },
              h('button', { type: 'button', className: 'td-cal-navb', title: '上个月', onClick: () => props.onMonth(addMonthsStr(month, -1)) }, '‹'),
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onMonth(monthOf(state.today)) }, '今天'),
              h('button', { type: 'button', className: 'td-cal-navb', title: '下个月', onClick: () => props.onMonth(addMonthsStr(month, 1)) }, '›')),
            h('strong', { className: 'td-cal-title' }, `${y} 年 ${m} 月`),
            h('span', { className: 'td-sub' },
              `本月 ${(view.days ?? []).reduce((sum, d) => sum + d.ids.length, 0)} 项安排`),
            h('span', { className: 'td-grow' }),
            state.counts.overdue > 0
              ? h('span', { className: 'td-chip late' }, `逾期 ${state.counts.overdue}`)
              : null),
          h('div', { className: 'td-cal-grid' },
            ...weekdayHeaders(weekStart).map((name, i) => h('div', { className: 'td-cal-wd', key: `wd-${i}` }, `周${name}`)),
            ...cells.map((cell) => {
              const ids = dayMap.get(cell.date) ?? []
              return h('div', {
                key: cell.date,
                className: `td-cal-cell${cell.inMonth ? '' : ' out'}`
                  + `${selected === cell.date ? ' sel' : ''}${cell.date === state.today ? ' today' : ''}`,
                onClick: () => props.onSelectDay(cell.date),
              },
                h('div', { className: 'td-cal-d' },
                  h('span', null, String(cell.day)),
                  ids.length > 3 ? h('span', { className: 'td-cal-more' }, `+${ids.length - 3}`) : null),
                ...ids.slice(0, 3).map((id) => {
                  const task = byId.get(id)
                  if (task === undefined) return null
                  return h('div', {
                    key: id,
                    className: `td-cal-task${task.done ? ' done' : ''}`,
                    style: { '--td-tint': props.listColor(id) },
                    title: `${task.title}${task.due ? ' · ' + task.due.replace('T', ' ') : ''}`,
                    onClick: (event) => { event.stopPropagation(); props.onOpen(id) },
                  }, task.title)
                }))
            })),
          (view.unscheduled ?? []).length > 0
            ? h('div', { className: 'td-hint', style: { marginTop: 8 } },
              `${view.unscheduled.length} 个任务没有日期，不显示在日历上（可在列表或看板中安排）。`)
            : null,
          selected !== null
            ? h('div', { className: 'td-day' },
              h('div', { className: 'td-day-h' },
                fmtDateFull(selected),
                h('span', { className: 'td-grp-n' }, String(selectedIds.length)),
                h('span', { className: 'td-grow' }),
                h('button', {
                  type: 'button', className: 'td-btn sm',
                  onClick: () => props.onAddOnDay(selected),
                }, '＋ 在这一天添加')),
              h('div', { className: 'td-day-b' },
                selectedIds.length === 0
                  ? h('div', { className: 'td-hint' }, '这一天没有安排。')
                  : h('div', null, ...selectedIds.map((id, index) => h(TaskRow, {
                    key: id,
                    id,
                    index,
                    depth: 0,
                    today: state.today,
                    byId,
                    childrenOf: props.childrenOf,
                    collapsed: state.collapsed,
                    toggleCollapsed: props.toggleCollapsed,
                    onToggle: props.onToggle,
                    onOpen: props.onOpen,
                    onAddSubtask: props.onAddSubtask,
                    askDelete: props.askDelete,
                    showList: props.showList,
                    listName: props.listName,
                    listColor: props.listColor,
                  })))))
            : null)
      }

      // ---------------------------------------------------------------------
      // gantt view
      // ---------------------------------------------------------------------

      function GanttView(props) {
        const { state, byId, view } = props
        const from = view.from
        const to = view.to
        const total = dayIndexOf(to) - dayIndexOf(from) + 1
        const days = []
        for (let i = 0; i < total; i++) days.push(dateFromIndex(dayIndexOf(from) + i))
        // 40px per day: at 34 the weekday line under the date was the smallest type
        // on the page, and the timeline is the one place a horizontal scroll is
        // expected anyway.
        const columns = `repeat(${total}, 40px)`
        const offset = (date) => dayIndexOf(date) - dayIndexOf(from)
        const todayOffset = offset(state.today)
        const tickMap = new Map()
        for (const item of view.occurrences ?? []) {
          for (const date of item.dates) {
            if (!tickMap.has(item.id)) tickMap.set(item.id, new Set())
            tickMap.get(item.id).add(date)
          }
        }

        // A month band above the day numbers: over a six-week window the bare
        // day numbers give no clue where one month turns into the next.
        const months = []
        for (const date of days) {
          const key = date.slice(0, 7)
          const last = months[months.length - 1]
          if (last !== undefined && last.key === key) last.span += 1
          else months.push({ key, span: 1, start: months.reduce((n, m) => n + m.span, 0) + 1 })
        }
        const isWeekend = (date) => {
          const jsDay = new Date(`${date}T00:00:00`).getDay()
          return jsDay === 0 || jsDay === 6
        }
        const dayTitle = (date) => `${date} 周${WEEKDAY_CN[new Date(`${date}T00:00:00`).getDay()]}`

        return h('div', null,
          h('div', { className: 'td-cal-h' },
            h('div', { className: 'td-cal-nav' },
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onAnchor(addDaysStr(from, -21)) }, '‹ 前移三周'),
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onAnchor(state.today) }, '回到今天'),
              h('button', { type: 'button', className: 'td-cal-navb', onClick: () => props.onAnchor(addDaysStr(from, 21)) }, '后移三周 ›')),
            h('strong', { className: 'td-cal-title', style: { fontSize: 14 } }, `${from} → ${to}`),
            h('span', { className: 'td-sub' }, `${view.rows.length} 条时间线`),
            h('span', { className: 'td-grow' }),
            view.undated.length > 0
              ? h('span', { className: 'td-chip' }, `${view.undated.length} 项无日期未显示`)
              : null),
          view.rows.length === 0
            ? h(EmptyState, { text: '这一时间段内没有可排期的任务（需要开始或截止日期）。' })
            : h('div', { className: 'td-gantt' },
              h('div', { className: 'td-gantt-l' },
                h('div', { className: 'td-gantt-th' }, '任务'),
                ...view.rows.map((row) => h('div', {
                  key: row.id,
                  className: `td-gantt-row${row.done ? ' done' : ''}`,
                  title: byId.get(row.id)?.title ?? '',
                  onClick: () => props.onOpen(row.id),
                },
                  h('span', { className: 'td-dot', style: { background: PRIORITY_COLORS[row.priority] === 'transparent' ? 'var(--td-line-2)' : PRIORITY_COLORS[row.priority] } }),
                  h('span', { className: 'td-gantt-t' }, byId.get(row.id)?.title ?? row.id)))),
              h('div', { className: 'td-gantt-r' },
                h('div', { style: { minWidth: total * 34, position: 'relative' } },
                  todayOffset >= 0 && todayOffset < total
                    ? h('div', { className: 'td-gantt-now', style: { left: todayOffset * 34 + 17 } })
                    : null,
                  h('div', { className: 'td-gantt-hd', style: { gridTemplateColumns: columns, minWidth: total * 40 } },
                    ...months.map((month) => h('div', {
                      key: `m-${month.key}`,
                      className: 'td-gantt-month',
                      style: { gridColumn: `${month.start} / span ${month.span}` },
                    }, `${Number(month.key.slice(0, 4))} 年 ${Number(month.key.slice(5, 7))} 月`)),
                    ...days.map((date) => h('div', {
                      key: date,
                      className: `td-gantt-cell${isWeekend(date) ? ' we' : ''}`
                        + `${date === state.today ? ' today' : ''}`,
                      title: dayTitle(date),
                    },
                      h('div', null, date.slice(8, 10)),
                      h('small', null, `周${WEEKDAY_CN[new Date(`${date}T00:00:00`).getDay()]}`)))),
                  ...view.rows.map((row) => {
                    const startCol = Math.max(0, offset(row.start))
                    const endCol = Math.min(total - 1, offset(row.end))
                    const span = Math.max(1, endCol - startCol + 1)
                    const task = byId.get(row.id)
                    const ticks = [...(tickMap.get(row.id) ?? [])].filter((d) => offset(d) >= 0 && offset(d) < total)
                    return h('div', {
                      className: 'td-gantt-track',
                      key: row.id,
                      // The list colour lives on the TRACK so the bar and the
                      // recurrence ticks inside it share one hue.
                      style: { gridTemplateColumns: columns, minWidth: total * 40, '--td-tint': props.listColor(row.id) },
                    },
                      ...days.map((date, i) => h('div', {
                        key: `bg-${date}`,
                        className: `td-gantt-bg${isWeekend(date) ? ' we' : ''}`
                          + `${date === state.today ? ' today' : ''}`,
                        style: { gridColumn: `${i + 1} / ${i + 2}` },
                      })),
                      h('div', {
                        className: 'td-gantt-bar' + (row.milestone ? ' ms' : '')
                          + (row.done ? ' done' : '') + (row.overdue ? ' late' : ''),
                        style: {
                          gridColumn: `${startCol + 1} / ${startCol + 1 + span}`,
                        },
                        title: `${task?.title ?? row.id}\n${row.start}${row.milestone ? '' : ' → ' + row.end}`
                          + (row.recurrence ? `\n${row.recurrence}` : '')
                          + (row.overdue ? '\n已逾期' : ''),
                        onClick: () => props.onOpen(row.id),
                      }),
                      ...ticks.map((date) => h('div', {
                        key: `tick-${date}`,
                        title: `重复：${date}`,
                        style: {
                          gridRow: 1, gridColumn: `${offset(date) + 1} / ${offset(date) + 2}`,
                          alignSelf: 'end', justifySelf: 'center', width: 5, height: 5, marginBottom: 3,
                          borderRadius: '50%', background: 'var(--td-tint,var(--td-text-3))',
                          opacity: 0.75, pointerEvents: 'none',
                        },
                      })))
                  }))))
        )
      }

      // ---------------------------------------------------------------------
      // recurrence editor
      // ---------------------------------------------------------------------

      function RecurrenceEditor({ rule, onChange }) {
        const rec = rule ?? { freq: 'daily', interval: 1, weekdays: null, until: null, count: null }
        const setRule = (patch) => onChange({ ...rec, ...patch })
        const rows = []
        rows.push(h('div', { className: 'td-rowline', key: 'freq' },
          h('select', {
            className: 'td-in',
            value: rule === null ? '' : rec.freq,
            onChange: (event) => {
              const value = event.target.value
              if (value === '') return onChange(null)
              onChange({ ...rec, freq: value })
            },
          },
            h('option', { value: '' }, '不重复'),
            h('option', { value: 'daily' }, '每天'),
            h('option', { value: 'weekly' }, '每周'),
            h('option', { value: 'monthly' }, '每月')),
          rule === null ? null : h('span', { className: 'td-hint' }, '每'),
          rule === null ? null : h('input', {
            className: 'td-in', type: 'number', min: 1, max: 365, style: { width: 60 },
            value: String(rec.interval ?? 1),
            onChange: (event) => setRule({ interval: Math.max(1, Number(event.target.value) || 1) }),
          }),
          rule === null ? null : h('span', { className: 'td-hint' },
            rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '个月')))

        if (rule !== null && rec.freq === 'weekly') {
          const selected = Array.isArray(rec.weekdays) ? rec.weekdays : []
          rows.push(h('div', { className: 'td-wd', key: 'wd' }, ...['一', '二', '三', '四', '五', '六', '日'].map((name, index) => {
            // The UI lists Monday first; the engine stores 0 = Sunday.
            const value = (index + 1) % 7
            const on = selected.includes(value)
            return h('button', {
              key: name,
              type: 'button',
              className: on ? 'on' : '',
              onClick: () => {
                const next = on ? selected.filter((w) => w !== value) : [...selected, value].sort((a, b) => a - b)
                setRule({ weekdays: next })
              },
            }, name)
          })))
        }

        if (rule !== null) {
          rows.push(h('div', { className: 'td-rowline', key: 'end' },
            h('select', {
              className: 'td-in',
              value: rec.until ? 'until' : rec.count ? 'count' : 'never',
              onChange: (event) => {
                const value = event.target.value
                if (value === 'never') setRule({ until: null, count: null })
                else if (value === 'until') setRule({ until: rec.until ?? todayStr(), count: null })
                else setRule({ count: rec.count ?? 10, until: null })
              },
            },
              h('option', { value: 'never' }, '一直重复'),
              h('option', { value: 'until' }, '重复到某天'),
              h('option', { value: 'count' }, '重复 N 次后结束')),
            rec.until
              ? h('input', {
                className: 'td-in', type: 'date', value: rec.until,
                onChange: (event) => setRule({ until: event.target.value || null }),
              })
              : null,
            rec.count
              ? h('input', {
                className: 'td-in', type: 'number', min: 1, style: { width: 70 }, value: String(rec.count),
                onChange: (event) => setRule({ count: Math.max(1, Number(event.target.value) || 1) }),
              })
              : null))
          rows.push(h('div', { className: 'td-hint', key: 'sum' }, recurrenceRuleText(rec)))
        }
        rows.push(h('div', { className: 'td-hint', key: 'tip' },
          '完成重复任务时会记一次完成，并把截止时间滚动到下一次；子任务随之重置。'))
        return h('div', null, ...rows)
      }

      // ---------------------------------------------------------------------
      // the task editor drawer
      // ---------------------------------------------------------------------

      function TaskEditor(props) {
        const { task, state, byId, childrenOf, lists } = props
        const [draftTitle, setDraftTitle] = useState(task.title)
        const [draftNote, setDraftNote] = useState(task.note)
        const [newSub, setNewSub] = useState('')
        const [tagDraft, setTagDraft] = useState('')
        const [moveOpen, setMoveOpen] = useState(false)
        // Re-seed the text drafts when the drawer switches to another task.
        useEffect(() => { setDraftTitle(task.title); setDraftNote(task.note); setNewSub('') }, [task.id])

        const parsed = parseDue(task.due)
        const parsedStart = parseDue(task.start)
        // `childrenOf` indexes parent id -> child IDs (the list view walks them by
        // id); the editor needs the tasks themselves.
        const kids = (childrenOf.get(task.id) ?? []).map((childId) => byId.get(childId)).filter((k) => k !== undefined)
        const parent = task.parentId === null ? null : byId.get(task.parentId)
        // The dialog wears its list colour on the top edge and as a dot beside the
        // eyebrow: it is the one fact about the task that is not visible anywhere in
        // the form below, and it is what keeps a card of pure white from reading as
        // a blank page.
        const list = lists.find((l) => l.id === task.listId) ?? null
        const tint = list !== null && typeof list.color === 'string' && list.color !== '' ? list.color : undefined

        const patch = (fields) => props.onPatch(task.id, fields)
        const commitTitle = () => {
          const next = draftTitle.trim()
          if (next === '' ) { setDraftTitle(task.title); return }
          if (next !== task.title) patch({ title: next })
        }
        const commitNote = () => { if (draftNote !== task.note) patch({ note: draftNote }) }

        const setDue = (date, time) => {
          if (date === null || date === '') return patch({ due: null })
          patch({ due: time ? `${date}T${time}` : date })
        }

        // A centred dialog rendered by the overlay seat, not beside the list: it
        // reads identically from the panel and from fullscreen, and it cannot be
        // trapped inside a column that creates a containing block.
        return h('div', {
          className: 'td-seat td-modal-layer',
          role: 'presentation',
          // The backdrop closes; the card stops propagation.
          onClick: props.onClose,
        },
          h('div', {
            className: 'td-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': parent === null ? '任务详情' : '子任务详情',
            style: tint === undefined ? undefined : { '--td-tint': tint },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-dot', style: { background: tint ?? 'var(--td-line-2)' } }),
              h('span', { className: 'td-modal-kind' }, parent === null ? '任务' : '子任务'),
              parent === null
                ? null
                : h('button', {
                  type: 'button', className: 'td-btn sm', title: '打开父任务',
                  onClick: () => props.onOpen(parent.id),
                }, `↖ ${parent.title.slice(0, 14)}`),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭', onClick: props.onClose,
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-hero' },
                h(Check, { done: task.done, priority: task.priority, onToggle: () => props.onToggle(task.id) }),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('input', {
                    className: 'td-in',
                    'aria-label': '任务标题',
                    value: draftTitle,
                    placeholder: '任务标题',
                    onChange: (event) => setDraftTitle(event.target.value),
                    onBlur: commitTitle,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitTitle(); event.target.blur() }
                    },
                  }),
                  h('div', { className: 'td-hint', style: { padding: '5px 10px 0' } }, task.done
                    ? `已完成${task.completedAt ? ' · ' + task.completedAt.replace('T', ' ').slice(0, 16) : ''}`
                    : '未完成 · 回车保存标题'))),

              // The four "properties" read as one block of facts, so they share a
              // two-column grid; everything below is prose-ish and gets a section.
              h('div', { className: 'td-props' },
                h('div', { className: 'td-field' },
                  h('label', null, '清单'),
                  h('select', {
                    className: 'td-in',
                    value: task.listId,
                    onChange: (event) => patch({ listId: event.target.value }),
                  }, ...lists.map((l) => h('option', { key: l.id, value: l.id }, l.name)))),

                h('div', { className: 'td-field' },
                  h('label', null, '优先级'),
                  // Listed highest first, because "how urgent is this" is a question
                  // about degree and the eye reads the answer from the top down.
                  h('div', { className: 'td-opts' }, ...[3, 2, 1, 0].map((p) => h('button', {
                    key: p,
                    type: 'button',
                    className: `td-opt${task.priority === p ? ' on' : ''}`,
                    onClick: () => patch({ priority: p }),
                  },
                    h('span', { className: 'td-ind' }, h('svg', {
                      width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
                      stroke: 'currentColor', strokeWidth: 3.6, strokeLinecap: 'round',
                      strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
                    }, h('path', { d: 'M20 6L9 17l-5-5' }))),
                    p === 0
                      ? null
                      : h('span', { className: 'td-opt-dot', style: { background: PRIORITY_COLORS[p] } }),
                    h('span', null, PRIORITY_LABELS[p]))))),

                h('div', { className: 'td-field' },
                  h('label', null, '开始时间'),
                  h('div', { className: 'td-rowline' },
                    h('input', {
                      className: 'td-in', type: 'date', value: parsedStart?.date ?? '',
                      onChange: (event) => {
                        const value = event.target.value
                        if (value === '') patch({ start: null })
                        else patch({ start: parsedStart?.time ? `${value}T${parsedStart.time}` : value })
                      },
                    }),
                    parsedStart?.time
                      ? h('input', {
                        className: 'td-in', type: 'time', value: parsedStart.time,
                        onChange: (event) => patch({ start: `${parsedStart.date}T${event.target.value}` }),
                      })
                      : null,
                    parsedStart === null
                      ? null
                      : h('button', { type: 'button', className: 'td-btn sm', onClick: () => patch({ start: null }) }, '清除'))),

                h('div', { className: 'td-field' },
                  h('label', null, '截止时间'),
                  h('div', { className: 'td-rowline' },
                    h('input', {
                      className: 'td-in', type: 'date', value: parsed?.date ?? '',
                      onChange: (event) => setDue(event.target.value, parsed?.time ?? null),
                    }),
                    h('input', {
                      className: 'td-in', type: 'time', value: parsed?.time ?? '',
                      onChange: (event) => {
                        const value = event.target.value
                        if (value === '') patch({ due: parsed ? parsed.date : null })
                        else setDue(parsed?.date ?? state.today, value)
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: `td-btn sm${parsed?.time ? ' on' : ''}`,
                      title: '切换为定时/全天',
                      onClick: () => {
                        if (parsed === null) return
                        patch({ due: parsed.time ? parsed.date : `${parsed.date}T09:00` })
                      },
                    }, parsed?.time ? '定时' : '全天'),
                    parsed === null
                      ? null
                      : h('button', { type: 'button', className: 'td-btn sm', onClick: () => patch({ due: null }) }, '清除')))),

              task.recurrence !== null && parsed !== null
                ? h('div', { className: 'td-hint', style: { paddingTop: 8 } },
                  `重复系列锚点：${task.seriesAnchor ?? parsed.date}（改动截止时间会重新锚定系列）`)
                : null,

              h('div', { className: 'td-sect' },
                h('label', null, '重复'),
                h(RecurrenceEditor, { rule: task.recurrence, onChange: (rule) => patch({ recurrence: rule }) }),
                task.recurrence !== null
                  ? h('div', { className: 'td-rowline', style: { marginTop: 8 } },
                    h('span', { className: 'td-hint' }, `已完成 ${task.completedCount} 次`),
                    h('button', {
                      type: 'button', className: 'td-btn sm', title: '跳过本次，直接滚动到下一次',
                      onClick: () => props.onSkip(task.id),
                    }, '跳过本次'))
                  : null),

              h('div', { className: 'td-sect' },
                h('label', null, '备注'),
                h('textarea', {
                  className: 'td-in td-ta',
                  value: draftNote,
                  placeholder: '任何补充信息。任务和子任务都可以写备注。',
                  onChange: (event) => setDraftNote(event.target.value),
                  onBlur: commitNote,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitNote()
                  },
                })),

              h('div', { className: 'td-sect' },
                h('label', null, `子任务 ${kids.length > 0 ? `(${kids.filter((k) => k.done).length}/${kids.length})` : ''}`),
                kids.length === 0
                  ? null
                  : h('div', null, ...kids.map((kid) => h('div', { className: `td-sub-row${kid.done ? ' done' : ''}`, key: kid.id },
                    h(Check, { done: kid.done, priority: kid.priority, onToggle: () => props.onToggle(kid.id) }),
                    h('span', { className: 'td-t', onClick: () => props.onOpen(kid.id), title: '点击编辑（含备注）' }, kid.title),
                    kid.note ? h('span', { className: 'td-chip', title: kid.note.slice(0, 200) }, h(Glyph, { name: 'note', size: 11 })) : null,
                    h('button', {
                      type: 'button', className: 'td-icon', title: '删除子任务',
                      onClick: () => props.askDelete(kid.id, kid.title),
                    }, h(Glyph, { name: 'close', size: 12 }))))),
                h('div', { className: 'td-rowline', style: { marginTop: 6 } },
                  h('input', {
                    className: 'td-in', style: { flex: 1 }, value: newSub,
                    placeholder: '添加子任务，回车确认',
                    onChange: (event) => setNewSub(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const value = newSub.trim()
                      if (!value) return
                      setNewSub('')
                      props.onAddSubtask(task.id, value)
                    },
                  }),
                  h('button', {
                    type: 'button', className: 'td-btn',
                    onClick: () => {
                      const value = newSub.trim()
                      if (!value) return
                      setNewSub('')
                      props.onAddSubtask(task.id, value)
                    },
                  }, '添加'))),

              h('div', { className: 'td-sect' },
                h('label', null, '标签'),
                h('div', { className: 'td-rowline' },
                  ...task.tags.map((tag) => h('span', { className: 'td-chip', key: tag },
                    `#${tag}`,
                    h('button', {
                      type: 'button', className: 'td-icon', style: { width: 18, height: 18, marginLeft: 2 },
                      title: `移除标签 ${tag}`,
                      onClick: () => patch({ tags: task.tags.filter((x) => x !== tag) }),
                    }, h(Glyph, { name: 'close', size: 10 })))),
                  h('input', {
                    className: 'td-in', style: { width: 110 }, value: tagDraft, placeholder: '输入后回车',
                    onChange: (event) => setTagDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return
                      const value = tagDraft.trim().replace(/^#/, '')
                      if (!value || task.tags.includes(value)) { setTagDraft(''); return }
                      setTagDraft('')
                      patch({ tags: [...task.tags, value] })
                    },
                  }))),

              h('div', { className: 'td-sect' },
                h('label', null, '挂到其他任务下（成为子任务）'),
                h('div', { className: 'td-rowline' },
                  h('button', {
                    type: 'button', className: 'td-btn sm', onClick: () => setMoveOpen(!moveOpen),
                  }, moveOpen ? '收起' : '选择父任务'),
                  task.parentId === null
                    ? null
                    : h('button', {
                      type: 'button', className: 'td-btn sm', onClick: () => patch({ parentId: null }),
                    }, '提升为顶层任务')),
                moveOpen
                  ? h('div', { className: 'td-pop', style: { position: 'relative', maxHeight: 200, overflow: 'auto', marginTop: 6 } },
                    ...byId.size === 0
                      ? [h('div', { className: 'td-hint', key: 'none' }, '没有其他任务')]
                      : [...byId.values()]
                        .filter((t) => t.id !== task.id && t.parentId === null)
                        .slice(0, 60)
                        .map((t) => h('button', {
                          key: t.id,
                          type: 'button',
                          onClick: () => { setMoveOpen(false); patch({ parentId: t.id }) },
                        }, t.title)))
                  : null),

              h('div', { className: 'td-hint', style: { paddingTop: 16 } },
                `创建于 ${task.createdAt.replace('T', ' ').slice(0, 16)} · 更新于 ${task.updatedAt.replace('T', ' ').slice(0, 16)}`)),

            h('div', { className: 'td-modal-f' },
              h('button', {
                type: 'button', className: 'td-btn danger',
                onClick: () => props.askDelete(task.id, task.title),
              }, '删除任务'),
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn primary', onClick: props.onClose }, '完成'))))
      }

      // ---------------------------------------------------------------------
      // the app (shared by the panel host and the fullscreen host)
      // ---------------------------------------------------------------------

      /**
       * The in-page question, drawn by the overlay seat.
       *
       * Same reason as the task dialog: the overlay is frame-wide, so this appears
       * above whichever host asked, and the fullscreen host gets the identical
       * dialog. It is the replacement for window.confirm, which a host may block
       * outright and which can never say what exactly is about to be lost.
       */
      function ConfirmLayer() {
        const state = useApp()
        const request = state.confirm
        if (request === null || request === undefined) return null
        return h('div', {
          className: 'td-seat td-modal-layer',
          role: 'presentation',
          onClick: () => settleConfirm(false),
        },
          h('div', {
            className: 'td-modal',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-label': request.title,
            style: { width: 'min(420px,100%)' },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-modal-kind' }, request.title),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '取消（Esc）',
                'aria-label': '取消', onClick: () => settleConfirm(false),
              }, h(Glyph, { name: 'close', size: 13 }))),
            h('div', { className: 'td-modal-b' },
              h('div', { className: 'td-hint', style: { fontSize: 12.5, lineHeight: 1.7 } }, request.body)),
            h('div', { className: 'td-modal-f' },
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-btn',
                onClick: () => settleConfirm(false),
              }, '取消'),
              h('button', {
                type: 'button',
                className: `td-btn${request.danger === true ? ' danger-solid' : ' primary'}`,
                onClick: () => settleConfirm(true),
              }, request.ok ?? '确定'))))
      }

      /**
       * The list settings dialog: rename, recolour, reorder, delete.
       *
       * It sits in the overlay seat for exactly the reason the task dialog does --
       * one dialog for both hosts, never trapped inside the rail column -- and it
       * replaces window.prompt, which a host may block outright. That block is why
       * "新建清单" once appeared to do nothing at all.
       *
       * Ordering is offered twice on purpose: the buttons here are precise and
       * keyboard-reachable, the drag in the rail is direct. Both call `moveListTo`.
       */
      function ListEditor({ list, lists, palette, byList, onClose, onDelete }) {
        const [name, setName] = useState(list.name)
        // A mutation replaces every list object, so the draft has to follow the
        // canonical value back or the field would show a stale name after a save.
        useEffect(() => { setName(list.name) }, [list.id, list.name])

        const index = Math.max(0, lists.findIndex((l) => l.id === list.id))
        const current = String(list.color).toLowerCase()
        const preset = Array.isArray(palette) ? palette.map((c) => String(c).toLowerCase()) : []
        // Colours are PICKED FROM THE PALETTE, never typed: a list colour is a
        // label, and a colour wheel turns "file a task" into a branding exercise.
        // A colour that is not in the palette (data from an older version) is
        // still shown first, so it can be kept rather than silently rewritten.
        const swatches = preset.includes(current) ? preset : [current, ...preset]
        const entry = (byList ?? []).find((b) => b.id === list.id)
        const open = Number(entry?.open ?? 0)
        const total = Number(entry?.total ?? 0)
        const isSystem = list.system === true

        const commitName = async () => {
          const value = name.trim()
          if (value === '' || value === list.name) { setName(list.name); return }
          const result = await mutate('updateList', { id: list.id, name: value })
          if (result === null || result === undefined) { setName(list.name); return }
          setName(result.list.name)
          toast(`清单已改名为「${result.list.name}」`)
        }

        const paint = async (color) => {
          if (String(color).toLowerCase() === current) return
          await mutate('updateList', { id: list.id, color })
        }

        const step = (delta) => { moveListTo(list.id, index + delta) }

        return h('div', {
          className: 'td-seat td-modal-layer',
          role: 'presentation',
          onClick: onClose,
        },
          h('div', {
            className: 'td-modal td-narrow',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': `清单设置：${list.name}`,
            style: { '--td-tint': list.color },
            onClick: (event) => event.stopPropagation(),
          },
            h('div', { className: 'td-modal-h' },
              h('span', { className: 'td-dot', style: { background: list.color } }),
              h('span', { className: 'td-modal-kind' }, '清单'),
              h('span', { className: 'td-grow' }),
              h('button', {
                type: 'button', className: 'td-modal-close', title: '关闭（Esc）',
                'aria-label': '关闭清单设置', onClick: onClose,
              }, h(Glyph, { name: 'close', size: 13 }))),

            h('div', { className: 'td-modal-b' },
              // A section rather than a bare field: on the recessed body every block
              // is a card, and the name is the first of them.
              h('div', { className: 'td-sect' },
                h('label', null, '名称'),
                h('input', {
                  className: 'td-in',
                  autoFocus: true,
                  value: name,
                  'aria-label': '清单名称',
                  placeholder: '清单名称',
                  onChange: (event) => setName(event.target.value),
                  onBlur: commitName,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); event.target.blur() }
                  },
                })),

              h('div', { className: 'td-sect' },
                h('label', null, '颜色'),
                h('div', { className: 'td-swatches' },
                  ...swatches.map((color) => h('button', {
                    key: color,
                    type: 'button',
                    className: `td-swatch${String(color).toLowerCase() === current ? ' on' : ''}`,
                    style: { background: color },
                    title: color,
                    'aria-label': `颜色 ${color}`,
                    onClick: () => paint(color),
                  }))),
                h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                  '点一下即生效。这个颜色出现在清单圆点、看板列顶边、日历胶囊和甘特条上。')),

              h('div', { className: 'td-sect' },
                h('label', null, '位置'),
                h('div', { className: 'td-posline' },
                  h('button', {
                    type: 'button', className: 'td-btn sm', disabled: index === 0,
                    title: '上移一位', onClick: () => step(-1),
                  }, h(Glyph, { name: 'up', size: 12 }), ' 上移'),
                  h('button', {
                    type: 'button', className: 'td-btn sm', disabled: index >= lists.length - 1,
                    title: '下移一位', onClick: () => step(1),
                  }, h(Glyph, { name: 'down', size: 12 }), ' 下移'),
                  h('span', { className: 'td-hint' }, `第 ${index + 1} / ${lists.length} 位`)),
                h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                  '也可以直接在左侧栏拖动清单换位置；顺序同时决定看板里各列的先后。')),

              h('div', { className: 'td-sect' },
                h('label', null, '内容'),
                h('div', { className: 'td-posline' },
                  h('span', { className: 'td-preview' },
                    h('span', { className: 'td-dot', style: { background: list.color } }),
                    h('span', { className: 'td-side-l' }, list.name)),
                  h('span', { className: 'td-hint' }, `${open} 个未完成 · 共 ${total} 个任务`)),
                isSystem
                  ? h('div', { className: 'td-hint', style: { paddingTop: 7 } },
                    '「收集箱」是系统清单：可以改名、换色、挪位置，但不能删除 —— 删掉的清单里的任务都会落到这里。')
                  : null)),

            h('div', { className: 'td-modal-f' },
              isSystem
                ? null
                : h('button', {
                  type: 'button', className: 'td-btn danger',
                  onClick: () => onDelete(list),
                }, h(Glyph, { name: 'trash', size: 12 }), ' 删除清单'),
              h('span', { className: 'td-grow' }),
              h('button', { type: 'button', className: 'td-btn primary', onClick: onClose }, '完成'))))
      }

      function TodoApp({ mode, drag }) {
        const state = useApp()
        // The floating window is the same app: it only drops the rail (the view
        // switcher, the smart lists and the data block), because a small box is
        // there to show the list and nothing else. `drag` is the window's own
        // pointer plumbing, handed to the header, which doubles as its handle.
        const floating = mode === 'float'
        const data = state.data
        const [dragId, setDragId] = useState(null)
        const [dropTarget, setDropTarget] = useState(null)
        const [listDragId, setListDragId] = useState(null)
        const [listDropId, setListDropId] = useState(null)
        const [menu, setMenu] = useState(null)
        const [newList, setNewList] = useState('')
        // The search box `/` jumps to, and the subtree the row-focus lookup runs
        // against. Both are per-instance: up to three seats can be mounted, and a
        // shared handle would always point at whichever mounted last.
        const searchRef = useRef(null)
        const myRoot = useRef(null)

        // First mount of any seat loads the shared data.
        useEffect(() => { if (app.data === null && app.loading === false) refresh({}, true) }, [])

        // Opening a seat is the moment to put the caret in the add box: the
        // first thing anyone does with a task list is write something down, and
        // "click the sidebar, then click the box" was a click too many. The
        // request is consumed by CaptureBar, which owns the DOM node.
        useEffect(() => { setApp({ quickFocus: floating ? 'float' : 'panel' }) }, [])

        // Re-query the host whenever the view context changes.
        useEffect(() => {
          if (app.data === null) return
          refresh({}, true)
        }, [state.view, state.filter, state.listId, state.tag, state.includeDone, state.calMonth, state.ganttAnchor])

        // Esc is handled by the overlay seat, which is mounted whether this host is
        // visible or not -- registering it here as well would close the dialog AND
        // leave fullscreen on the same keypress.

        const tasks = data?.tasks ?? []
        const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [data])
        const childrenOf = useMemo(() => {
          const map = new Map()
          for (const t of tasks) {
            if (t.parentId === null) continue
            if (!map.has(t.parentId)) map.set(t.parentId, [])
            map.get(t.parentId).push(t.id)
          }
          return map
        }, [data])
        const listNames = useMemo(() => {
          const map = new Map()
          for (const l of data?.lists ?? []) map.set(l.id, l.name)
          return map
        }, [data])
        const listColors = useMemo(() => {
          const map = new Map()
          for (const l of data?.lists ?? []) map.set(l.id, l.color)
          return map
        }, [data])

        if (data === null) {
          return h('div', { className: `td-seat td-root${mode === 'fullscreen' ? ' td-overlay' : ''}${floating ? ' td-floatapp' : ''}` },
            h('div', { className: 'td-empty' }, state.error === null ? '正在载入待办任务…' : `载入失败：${state.error}`))
        }

        const view = data.view ?? { kind: state.view }
        const groups = view.kind === 'list' ? (view.groups ?? []) : []
        const columns = view.kind === 'board' ? (view.columns ?? []) : []
        const openTask = state.openId === null ? null : byId.get(state.openId)
        const counts = data.counts

        const common = {
          // The floating window shows the list as a checklist: the same rows, with
          // only the name and the checkbox left in them (see `.td-cmp`).
          compact: mode === 'float',
          // Two different things are called "view" in this app: the app store's
          // `view` is the selected kind ('list' | 'board' | ...), while the host's
          // `data.view` is that view's payload. Views read `props.view` for the
          // payload so the two can never be confused again.
          view,
          state: {
            ...state,
            today: data.today,
            settings: data.settings,
            counts,
            calMonth: state.calMonth,
            day: state.day,
          },
          byId,
          childrenOf,
          // Calendar chips have no column to carry the list, so the list colour is
          // what tells two tasks of the same day apart. Both helpers take a TASK id
          // because that is what every view already has in hand.
          listColor: (id) => {
            const task = byId.get(id)
            const color = task === undefined ? undefined : listColors.get(task.listId)
            return typeof color === 'string' && color !== '' ? color : 'var(--td-brand)'
          },
          listName: (id) => {
            const task = byId.get(id)
            const name = task === undefined ? undefined : listNames.get(task.listId)
            return typeof name === 'string' && name !== '' ? name : undefined
          },
        }

        // The same question the add box asks ("did my syntax land?") is answered by
        // the host, not by a second copy of the parser here: the preview IS what
        // `quickAdd` will do, because it is the same function. Typing is debounced
        // and the reply is dropped unless the text still matches, so a fast typist
        // never sees the parse of a prefix they have already changed.
        //
        // The draft is read from (and the answer written to) the app store rather
        // than this component's state, because the seat that is typing is not
        // always the seat that is mounted.
        useEffect(() => {
          const text = String(state.quick ?? '').trim()
          if (text === '') {
            if (app.qPreview !== null) setApp({ qPreview: null })
            return undefined
          }
          let live = true
          const timer = setTimeout(async () => {
            try {
              const result = await call('preview', { text })
              if (live && result !== null && result !== undefined) setApp({ qPreview: { text, result } })
            } catch { if (live) setApp({ qPreview: null }) }
          }, 180)
          return () => { live = false; clearTimeout(timer) }
        }, [state.quick])

        const onToggle = (id) => mutate('toggle', { id })
        const onOpen = (id) => setApp({ openId: id })
        const onDelete = (id) => mutate('remove', { id })
        const onPatch = (id, fields) => mutate('update', { id, ...fields })
        const onSkip = (id) => mutate('skip', { id })
        const toggleCollapsed = (id) => setApp({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })

        // Creating a list is an inline row, not window.prompt: the host may block
        // the native dialog outright -- which is exactly why the button appeared to
        // do nothing -- and the dot in the row previews the colour the new list
        // will actually get (the host decides it, this only reports it back).
        const submitList = async () => {
          const name = newList.trim()
          setNewList('')
          setApp({ creatingList: false })
          if (name === '') return
          const result = await mutate('createList', { name })
          if (result !== null && result !== undefined) {
            toast(`已创建清单「${result.list?.name ?? name}」`)
          }
        }

        const openView = (kind) => setApp({
          view: kind,
          day: null,
          calMonth: state.calMonth ?? monthOf(data.today),
          ganttAnchor: state.ganttAnchor ?? data.today,
        })

        // The order the arrow keys walk: depth-first over the groups, skipping
        // collapsed subtrees -- exactly the order the eye reads on screen.
        const flatRows = []
        {
          const walk = (id) => {
            flatRows.push(id)
            if (state.collapsed[id] === true) return
            for (const child of (childrenOf.get(id) ?? [])) walk(child)
          }
          for (const group of groups) for (const id of group.ids) walk(id)
        }

        const focusRow = (id) => {          if (id === null || id === undefined) return
          setApp({ focusId: id })
          // The node exists already (every row is in the DOM); a row is
          // focusable at tabIndex -1, so this needs no wait for the re-render.
          const root = myRoot.current
          if (root === null || typeof root.querySelector !== 'function') return
          const node = root.querySelector(`[data-row-id="${id}"]`)
          if (node === null || typeof node.focus !== 'function') return
          try {
            node.focus({ preventScroll: true })
            if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
          } catch { /* a host without layout still navigates */ }
        }

        const stepRow = (delta) => {
          if (flatRows.length === 0) return
          const at = state.focusId === null ? -1 : flatRows.indexOf(state.focusId)
          const next = at < 0
            ? (delta > 0 ? 0 : flatRows.length - 1)
            : Math.min(flatRows.length - 1, Math.max(0, at + delta))
          focusRow(flatRows[next])
        }

        /**
         * The list's keyboard cursor.
         *
         * Two delivery paths reach this one function, and it has to stay a single
         * function because they can BOTH fire for the same key:
         *
         *  - the native document listener below. It is the path that actually runs
         *    in a real host: measured there, a keydown on a row (or on `.td-root`,
         *    or on any container in between) never invoked this component's
         *    onKeyDown prop, while a native listener attached to `.td-root` itself
         *    was called on every key. Since the event demonstrably arrives at the
         *    element, the handler never being called means the event stops
         *    propagating somewhere between this subtree and the React root
         *    container, where delegation dispatches from -- inside the host's own
         *    keydown handling. A capture-phase listener on `document` runs BEFORE
         *    any bubble-phase stopper, so it cannot be starved that way.
         *  - the React `onKeyDown` prop, kept because it is the declarative wiring
         *    and because the fake DOM gate can only exercise this shape ). If a host does deliver
         *    it, the marker below keeps the key from being handled twice.
         *
         * It reads the store (`app`) rather than the render's `state` snapshot: the
         * listener outlives any single render, and a captured snapshot would step
         * through the row list of whichever render registered it.
         */
        const onRootKey = (event) => {
          if (event.__tdListKey === true) return
          event.__tdListKey = true
          // A layer above owns the keyboard while it is open.
          if (app.cmdk === true || app.capture === true) return
          if (app.openId !== null || app.confirm !== null || app.listEditor !== null) return
          const target = event.target ?? null
          // Keys aimed at a control belong to that control.
          if (target !== null && typeof target.closest === 'function'
            && target.closest('input,textarea,select,[contenteditable="true"],button') !== null) return
          const key = event.key
          if (key === 'n') {
            stopEvent(event)
            setApp({ quickFocus: floating ? 'float' : 'panel' })
            return
          }
          if (key === '/') {
            const node = searchRef.current
            if (node === null || typeof node.focus !== 'function') return
            stopEvent(event)
            try { node.focus({ preventScroll: true }) } catch { /* not focusable */ }
            return
          }
          if (app.view !== 'list') return
          if (key === 'ArrowDown' || key === 'j') { stopEvent(event); stepRow(1); return }
          if (key === 'ArrowUp' || key === 'k') { stopEvent(event); stepRow(-1); return }
          if (key === 'Home') { stopEvent(event); focusRow(flatRows[0] ?? null); return }
          if (key === 'End') { stopEvent(event); focusRow(flatRows[flatRows.length - 1] ?? null); return }
          const id = app.focusId
          if (id === null) return
          if (key === 'ArrowRight') { stopEvent(event); if (app.collapsed[id] === true) toggleCollapsed(id); return }
          if (key === 'ArrowLeft') { stopEvent(event); if (app.collapsed[id] !== true) toggleCollapsed(id); return }
          if (key === ' ' || key === 'Spacebar') { stopEvent(event); onToggle(id); return }
          if (key === 'Enter') { stopEvent(event); onOpen(id); return }
          if (key === 'x') { stopEvent(event); askDelete(id, byId.get(id)?.title ?? '') }
        }

        // The latest handler, reached through a ref so the listener below can stay
        // registered for the life of the seat while still seeing this render's rows.
        const rootKeyRef = useRef(onRootKey)
        useEffect(() => { rootKeyRef.current = onRootKey })

        // The delivery path that works in a real host (see onRootKey). Capture
        // phase, and filtered by containment: this is a focusable subtree, not a
        // global key grabber, so the host's own keys and the chat box never see it.
        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onKey = (event) => {
            const root = myRoot.current
            if (root === null || typeof root.contains !== 'function') return
            const target = event.target ?? null
            if (target === null || !root.contains(target)) return
            const handler = rootKeyRef.current
            if (typeof handler === 'function') handler(event)
          }
          document.addEventListener('keydown', onKey, true)
          return () => document.removeEventListener('keydown', onKey, true)
        }, [])

        // The badge counts what the current view is actually showing, and the
        // muted line keeps the triage numbers; previously both said "未完成".
        const visible = view.kind === 'list'
          ? groups.reduce((sum, group) => sum + group.ids.length, 0)
          : view.kind === 'board'
            ? columns.reduce((sum, column) => sum + column.ids.length, 0)
            : view.kind === 'calendar'
              ? (view.days ?? []).reduce((sum, day) => sum + day.ids.length, 0)
              : (view.rows ?? []).length
        const headSummary = `今天 ${counts.dueToday} · 逾期 ${counts.overdue}`

        // The list the floating window's switcher shows a colour for.
        const currentList = (data.lists ?? []).find((l) => l.id === state.listId) ?? null

        // One source for the six smart lists, because two surfaces show them now:
        // the rail (full rows with a count pill) and the window's chips.
        const smartLists = [
          ['today', '今天', counts.dueToday + counts.overdue],
          ['week', '最近 7 天', counts.upcoming],
          ['overdue', '已逾期', counts.overdue],
          ['inbox', '未安排', counts.inbox],
          ['all', '全部任务', counts.open],
          ['done', '已完成', counts.done],
        ]

        // One state, two seats. The search box belongs in the rail -- it filters
        // what the selected view shows, and the rail is where that view is chosen
        // -- but the rail is dropped wholesale under the container query, and a
        // search that disappears on a narrow sidebar is worse than one in the
        // wrong corner. So the identical input is rendered twice and CSS shows
        // exactly one, the same trade the view switcher already makes.
        // The search box: a magnifier inside the field, and the tag filter as a
        // chip you can click off. The placeholder used to spell out the whole
        // syntax -- 28 CJK characters in a 214px field, so it was truncated at
        // exactly the point where it started being useful. The syntax now lives
        // in the tooltip and in the empty state, where there is room for it.
        const searchField = (extra, refTarget) => h('div', { className: `td-searchbox${extra}` },
          h('span', { className: 'td-search-ico', 'aria-hidden': 'true' }, h(Glyph, { name: 'search', size: 13 })),
          h('input', {
            className: 'td-in td-search',
            ref: refTarget ?? null,
            value: state.query,
            placeholder: '搜索…',
            'aria-label': '搜索任务 / 备注 / 标签',
            title: '搜索任务 / 备注 / 标签；输入 #标签 只看该标签',
            onChange: (event) => {
              const next = event.target.value
              // `#工作` is the one syntax the search box shares with the add box, and
              // it means the same thing in both: that tag, exactly.
              const asTag = /^#(\S+)$/.exec(next.trim())
              setApp({
                query: next,
                tag: asTag === null ? '' : asTag[1],
                ...(asTag === null ? {} : { filter: 'all', listId: null }),
              })
              reloadSoon()
            },
          }),
          // The tag filter is a mode of the search box, so it is shown IN the box
          // and removed from the box -- not as a row somewhere else that the user
          // has to find before they can undo what they typed.
          state.tag === ''
            ? null
            : h('button', {
              type: 'button',
              className: 'td-search-tag',
              title: `清除 #${state.tag} 筛选`,
              'aria-label': `清除 #${state.tag} 筛选`,
              onClick: () => setApp({ tag: '', query: '' }),
            }, `#${state.tag}`, h(Glyph, { name: 'close', size: 11 })))

        return h('div', {
          className: `td-seat td-root${mode === 'fullscreen' ? ' td-overlay' : ''}${floating ? ' td-floatapp' : ''}`,
          ref: myRoot,
          // The list's keyboard cursor lives here, not on `document`: see onRootKey.
          onKeyDown: onRootKey,
        },
          h('div', {
            // The header doubles as the floating window's drag handle; in the
            // panel and in fullscreen it stays an ordinary header.
            className: `td-head${floating ? ' td-dragh' : ''}`,
            onPointerDown: floating ? drag?.onPointerDown : undefined,
            onPointerMove: floating ? drag?.onPointerMove : undefined,
            onPointerUp: floating ? drag?.onPointerUp : undefined,
            onPointerCancel: floating ? drag?.onPointerUp : undefined,
          },
            // The one colour mark in the window: an origin for the eye, right
            // before the title. The panel does not need it -- the host already
            // names that seat -- so it is drawn only in the floating window.
            floating ? h('span', { className: 'td-flogo', 'aria-hidden': 'true' }) : null,
            h('h3', { className: 'td-h1' }, '待办任务'),
            h('span', { className: 'td-countbadge', title: '当前视图中的任务数' }, String(visible)),
            h('span', { className: 'td-sub' }, headSummary),
            h('span', { className: 'td-grow' }),
            h('div', { className: 'td-headtools' },
              // The floating window swaps the container controls for its own two:
              // 停靠 hands the app back to the sidebar panel, ✕ closes the window.
              // The list stays reachable either way, so nothing here is a loss.
              floating ? null : searchField(' td-headsearch'),
              // The same switcher the rail carries, shown only when the rail has
              // been hidden by the container query -- so the view is reachable at
              // every width with exactly one control visible.
              floating ? null : h('div', { className: 'td-seg td-headviews' }, ...VIEW_KINDS.map(([kind, label]) => h('button', {
                key: kind,
                type: 'button',
                className: `${state.view === kind ? 'on' : ''}`,
                onClick: () => openView(kind),
              }, label))),
              floating ? null : h('button', {
                type: 'button',
                className: 'td-btn',
                title: state.fullscreen ? '退出全屏（Esc）' : '全屏显示',
                onClick: () => setApp({ fullscreen: !state.fullscreen }),
              }, state.fullscreen ? '⛶ 退出全屏' : '⛶ 全屏'),
              floating
                ? h('button', {
                  type: 'button', className: 'td-icon', title: '停靠回侧边栏面板',
                  'aria-label': '停靠回侧边栏面板',
                  onClick: () => { setFloat(false); selectTodoPanel('todo') },
                }, '⇤')
                : h('button', {
                  type: 'button', className: 'td-btn', title: '浮动小窗口（可拖到页面任意位置）',
                  onClick: () => setFloat(true),
                }, '⇱ 浮动'),
              floating
                ? h('button', {
                  type: 'button', className: 'td-icon', title: '关闭浮动窗口',
                  'aria-label': '关闭浮动窗口', onClick: () => setFloat(false),
                }, h(Glyph, { name: 'close', size: 14 }))
                : null)),

          // The window keeps the controls that answer "which tasks am I looking at",
          // in the order the questions come: triage, then which list, then what to
          // add. The view switcher, list management and the data block stay in the
          // panel, which is what keeps the box a list and nothing else.
          floating
            ? h('div', { className: 'td-float-bar' },
              h('div', { className: 'td-seg td-float-tabs' }, ...smartLists.map(([key, label, badge]) => h('button', {
                key,
                type: 'button',
                className: state.filter === key && state.listId === null ? 'on' : '',
                onClick: () => setApp({ filter: key, listId: null, includeDone: key === 'done' }),
              }, badge > 0 ? `${label} ${badge}` : label))),
              // The search box that stood here is gone: it answered a question the
              // window cannot ask twice (the panel still has one), and the room is
              // worth more as the list switcher -- without it, the window could only
              // ever show whichever list the panel happened to have selected.
              h('div', { className: 'td-float-lists' },
                currentList === null
                  ? h('span', {
                    className: 'td-dot',
                    style: { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--td-line-2)' },
                  })
                  : h('span', { className: 'td-dot', style: { background: currentList.color } }),
                h('select', {
                  className: 'td-in td-float-sel',
                  'aria-label': '切换清单',
                  value: state.listId ?? '',
                  onChange: (event) => setApp({
                    listId: event.target.value === '' ? null : event.target.value,
                    filter: 'all',
                  }),
                },
                  h('option', { value: '' }, '全部清单'),
                  ...(data.lists ?? []).map((list) => h('option', {
                    key: list.id,
                    value: list.id,
                  }, `${list.name}（${(counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0}）`)))))
            : null,

          // The narrow tier's second header line. Below ~680px the rail is gone
          // entirely, which used to take the smart lists and the list switcher with
          // it: a narrow sidebar could not change which slice it was showing at all.
          // The row is hidden by CSS at every wider width, so nothing is paid for it
          // where the rail is right there, and the floating window keeps its own
          // copy (td-float-bar) instead of this one.
          floating ? null : h('div', { className: 'td-head2' },
            h('div', { className: 'td-head2-tabs' }, ...smartLists.map(([key, label, badge]) => h('button', {
              key,
              type: 'button',
              className: `td-head2-tab${state.filter === key && state.listId === null ? ' on' : ''}`,
              onClick: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
            }, badge > 0 ? `${label} ${badge}` : label))),
            h('select', {
              className: 'td-in td-head2-sel',
              'aria-label': '切换清单',
              value: state.listId ?? '',
              onChange: (event) => setApp({
                listId: event.target.value === '' ? null : event.target.value,
                filter: 'all',
                tag: '',
              }),
            },
              h('option', { value: '' }, '全部清单'),
              ...(data.lists ?? []).map((list) => h('option', {
                key: list.id,
                value: list.id,
              }, list.name)))),

          // One capture input for every seat. The preview slot travels with it
          // (see CaptureBar), which is what stopped the list from jumping down
          // when the first character was typed.
          h(CaptureBar, { mode: floating ? 'float' : 'panel' }),

          state.error !== null ? h('div', { style: { padding: '8px 14px 0' } }, h('div', { className: 'td-err' }, state.error)) : null,
          data.loadError !== null && data.loadError !== undefined
            ? h('div', { style: { padding: '8px 14px 0' } }, h('div', { className: 'td-warn' }, data.loadError))
            : null,

          h('div', { className: 'td-body' },
            // The floating window shows the list alone: no rail, which is where
            // the other views, the smart lists and the data block live.
            floating ? null : h('div', { className: 'td-rail' },
              // The rail is ordered by how often a thing is used, not by how
              // structural it is: what to show (smart lists, lists, tags) comes
              // first, how to show it (the view switcher) after, and the data
              // block -- read once, if ever -- last and folded away.
              h('div', { className: 'td-railsearch' }, searchField('', searchRef)),
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '智能清单'),
                ...smartLists.map(([key, label, badge]) => h('button', {
                  key,
                  type: 'button',
                  className: `td-side${state.filter === key && state.listId === null && state.tag === '' ? ' on' : ''}`,
                  onClick: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
                },
                  h('span', { className: 'td-side-l' }, label),
                  h('span', { className: 'td-side-n' }, String(badge))))),
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '清单'),
                // One row per list: the row selects, the trailing button opens the
                // settings dialog, and dragging the row reorders. The drag payload
                // is set because Firefox refuses to start a drag without one.
                ...(data.lists ?? []).map((list) => h('div', {
                  key: list.id,
                  className: `td-lrow${state.listId === list.id ? ' on' : ''}`
                    + `${listDragId === list.id ? ' dragging' : ''}${listDropId === list.id ? ' drop' : ''}`,
                  draggable: 'true',
                  onDragStart: (event) => {
                    setListDragId(list.id)
                    if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
                      try { event.dataTransfer.setData('text/plain', list.id) } catch { /* not fatal */ }
                      event.dataTransfer.effectAllowed = 'move'
                    }
                  },
                  onDragEnd: () => { setListDragId(null); setListDropId(null) },
                  onDragOver: (event) => {
                    if (listDragId === null || listDragId === list.id) return
                    event.preventDefault()
                    setListDropId(list.id)
                  },
                  onDragLeave: () => { if (listDropId === list.id) setListDropId(null) },
                  onDrop: (event) => {
                    event.preventDefault()
                    // The state is the primary source; the payload is the fallback,
                    // the same pair the board uses for a task drop.
                    const dragged = listDragId ?? (() => {
                      try { return event.dataTransfer.getData('text/plain') } catch { return null }
                    })()
                    setListDragId(null)
                    setListDropId(null)
                    if (dragged === null || dragged === list.id) return
                    const wanted = (data.lists ?? []).findIndex((l) => l.id === list.id)
                    moveListTo(dragged, wanted)
                  },
                },
                  h('button', {
                    type: 'button',
                    className: `td-side${state.listId === list.id ? ' on' : ''}`,
                    onClick: () => setApp({ listId: state.listId === list.id ? null : list.id, filter: 'all', tag: '' }),
                  },
                    h('span', { className: 'td-dot', style: { background: list.color } }),
                    h('span', { className: 'td-side-l' }, list.name),
                    h('span', { className: 'td-side-n' },
                      String((counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0))),
                  h('button', {
                    type: 'button',
                    className: 'td-icon td-lcfg',
                    title: `清单设置：${list.name}`,
                    'aria-label': `清单设置 ${list.name}`,
                    onClick: () => setApp({ listEditor: list.id }),
                  }, h(Glyph, { name: 'more', size: 14 })))),
                // Creating a list is an inline row, not window.prompt: the host may
                // block the native dialog outright -- which is exactly why the
                // button appeared to do nothing -- and the dot in front previews
                // the colour this list will actually be created with.
                state.creatingList
                  ? h('div', { className: 'td-create' },
                    h('span', { className: 'td-dot', style: { background: data.nextListColor } }),
                    h('input', {
                      className: 'td-in',
                      autoFocus: true,
                      value: newList,
                      placeholder: '清单名称，回车创建',
                      onChange: (event) => setNewList(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') { event.preventDefault(); submitList() }
                        if (event.key === 'Escape') { setNewList(''); setApp({ creatingList: false }) }
                      },
                      onBlur: () => { setNewList(''); setApp({ creatingList: false }) },
                    }))
                  : h('button', {
                    type: 'button',
                    className: 'td-side',
                    onClick: () => setApp({ creatingList: true }),
                  },
                    h('span', { className: 'td-glyph' }, h(Glyph, { name: 'plus', size: 13 })),
                    h('span', { className: 'td-side-l' }, '新建清单'))),

              // Tags, which until now existed only inside tasks: nothing could list
              // them, so a typo was permanent and "what do I actually tag things
              // with" had no answer. The row filters exactly (`tag`), which is a
              // different question from typing the tag into the search box.
              (data.tags ?? []).length > 0
                ? h('div', { className: 'td-rail-g' },
                  h('div', { className: 'td-rail-t' }, '标签'),
                  // Eight rows, then a fold. A rail that grows with every tag
                  // pushes the view switcher and the lists off the screen, and
                  // the tenth tag is not what anyone is looking for.
                  ...(data.tags ?? []).slice(0, state.tagExpanded === true ? undefined : 8).map((row) => h('button', {
                    key: row.tag,
                    type: 'button',
                    className: `td-side${state.tag !== '' && state.tag.toLowerCase() === row.tag.toLowerCase() ? ' on' : ''}`,
                    title: `只看 #${row.tag}`,
                    onClick: () => setApp({
                      tag: state.tag !== '' && state.tag.toLowerCase() === row.tag.toLowerCase() ? '' : row.tag,
                      filter: 'all',
                      listId: null,
                      includeDone: false,
                    }),
                  },
                    h('span', { className: 'td-side-l' }, `#${row.tag}`),
                    h('span', { className: 'td-side-n' }, String(row.open)))),
                  (data.tags ?? []).length > 8
                    ? h('button', {
                      type: 'button',
                      className: 'td-rail-more',
                      onClick: () => setApp({ tagExpanded: state.tagExpanded !== true }),
                    }, state.tagExpanded === true
                      ? '收起'
                      : `更多 (${(data.tags ?? []).length - 8})`)
                    : null)
                : null,

              // How the tasks are shown. It sits below what they are: a view is
              // a lens on a selection, and the selection is what people change.
              h('div', { className: 'td-rail-g' },
                h('div', { className: 'td-rail-t' }, '视图'),
                ...VIEW_KINDS.map(([kind, label, glyph]) => h('button', {
                  key: kind,
                  type: 'button',
                  className: `td-side${state.view === kind ? ' on' : ''}`,
                  onClick: () => openView(kind),
                },
                  h('span', { className: 'td-glyph' }, h(Glyph, { name: glyph, size: 13 })),
                  h('span', { className: 'td-side-l' }, label)))),

              // Where the data lives, and how to keep a copy -- answered here rather
              // than only in the README, because this is where a user looks. Folded
              // to one line by default: it is read once and then never again, and
              // unfolded it was 96px of a 680px rail.
              h('div', { className: 'td-rail-g' },
                h('button', {
                  type: 'button',
                  className: 'td-rail-t td-rail-toggle',
                  'aria-expanded': state.dataOpen === true ? 'true' : 'false',
                  onClick: () => setApp({ dataOpen: state.dataOpen !== true }),
                },
                  h('span', { className: `td-caret${state.dataOpen === true ? ' open' : ''}` }, '▸'),
                  h('span', null, '数据')),
                state.dataOpen === true
                  ? h('div', { className: 'td-rail-data' },
                    // The file name IS the copy button: the same discoverability
                    // the three buttons offered, without a row of them.
                    h('button', {
                      type: 'button', className: 'td-rail-file', title: `复制路径：${data.dataFile}`,
                      onClick: () => { copyText(data.dataFile) },
                    }, fileNameOf(data.dataFile)),
                    h('div', { className: 'td-rail-note' }, '任务都存在本机这个文件里，复制它就是一份备份。'),
                    h('div', { className: 'td-rail-acts' },
                      h('button', {
                        type: 'button', className: 'td-btn sm', title: '下载一份 JSON 备份',
                        onClick: () => { exportBackup() },
                      }, '导出备份'),
                      h('label', {
                        className: 'td-btn sm', title: '从 JSON 备份恢复（会覆盖当前数据）',
                        style: { cursor: 'pointer' },
                      },
                        '导入',
                        h('input', {
                          type: 'file',
                          accept: '.json,application/json',
                          style: { display: 'none' },
                          onChange: (event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ''
                            if (file) importBackup(file)
                          },
                        })),
                      h('button', {
                        type: 'button', className: 'td-btn sm', title: data.dataFile,
                        onClick: () => { copyText(data.dataFile) },
                      }, '复制路径')))
                  : null)),

            h('div', { className: 'td-main' },
              view.kind === 'board'
                ? h(BoardView, {
                  ...common,
                  columns,
                  dragId,
                  dropTarget,
                  onOpen,
                  onToggle,
                  onDragStart: setDragId,
                  onDragEnd: () => { setDragId(null); setDropTarget(null) },
                  onDragOver: setDropTarget,
                  // The column's own box: the card lands in THAT column, and the
                  // caret never leaves it (it used to prefill the global line).
                  newColumn: state.colNew,
                  onAddHere: (id) => setApp({ colNew: id }),
                  onDrop: async (id, listId) => {
                    setDragId(null)
                    setDropTarget(null)
                    await mutate('move', { id, listId, index: 0 })
                  },
                  onMoveMenu: (id, event) => {
                    const rect = event?.currentTarget?.getBoundingClientRect?.()
                    setMenu({
                      id,
                      top: rect ? rect.bottom + 4 : 120,
                      left: rect ? Math.max(8, rect.left - 130) : 120,
                    })
                  },
                })
                : view.kind === 'calendar'
                  ? h(CalendarView, {
                    ...common,
                    onOpen,
                    onToggle,
                    onDelete,
                    onAddSubtask: (parentId, title) => mutate('addSubtask', { parentId, title }),
                    askDelete,
                    toggleCollapsed,
                    onMonth: (month) => setApp({ calMonth: month, day: null }),
                    onSelectDay: (date) => setApp({ day: date }),
                    onAddOnDay: (date) => {
                      setApp({ day: date, quickFocus: floating ? 'float' : 'panel' })
                      seedQuick(`${date} `)
                    },
                  })
                  : view.kind === 'gantt'
                    ? h(GanttView, { ...common, onOpen, onAnchor: (date) => setApp({ ganttAnchor: date }) })
                    : h('div', { className: 'td-scroll' },
                      h(ListView, {
                        ...common,
                        groups,
                        onOpen,
                        onToggle,
                        onDelete,
                        onAddSubtask: async (parentId) => {
                          const result = await mutate('addSubtask', { parentId, title: '新子任务' })
                          if (result !== null && result.created) setApp({ openId: result.created.id })
                        },
                        askDelete,
                        showList: state.listId === null,
                        toggleCollapsed,
                        // The row whose dialog is open wears the same selected
                        // language a rail row does -- otherwise the only way to
                        // tell which card the centred dialog belongs to is to read
                        // the title twice.
                        openId: state.openId,
                        // Keyboard navigation state, and the group's own "+".
                        focusId: state.focusId,
                        onFocusRow: (id) => setApp({ focusId: id }),
                        newGroup: state.grpNew,
                        onAddHere: (key) => setApp({ grpNew: key }),
                      }))),
          ),

          menu === null ? null : h('div', { className: 'td-pop', style: { position: 'fixed', top: menu.top, left: menu.left } },
            h('div', { className: 'td-hint', style: { padding: '4px 8px' } }, '移动到清单'),
            ...(data.lists ?? []).map((list) => h('button', {
              key: list.id,
              type: 'button',
              onClick: async () => { setMenu(null); await mutate('move', { id: menu.id, listId: list.id, index: 0 }) },
            }, list.name)),
            h('button', {
              type: 'button',
              onClick: () => { const id = menu.id; const title = byId.get(id)?.title ?? ''; setMenu(null); askDelete(id, title) },
            }, '删除任务'),
            h('button', { type: 'button', onClick: () => setMenu(null) }, '取消')),

          // The task dialog is NOT rendered here: it belongs to the overlay seat, so
          // that the panel host and the fullscreen host show exactly one dialog and
          // it is never confined to this column.
          state.toast === null ? null : h('div', { className: 'td-toast' }, state.toast))
      }

      /**
       * The floating window: the app in a box the user drags around the page.
       *
       * The box is a SIBLING of the dialogs, not their ancestor, so the centred
       * task dialog is never clipped by it. Dragging is pointer-based rather than
       * HTML5 drag-and-drop (which a host can veto), the header is the handle, and
       * the grab skips anything inside a control so the buttons stay clickable.
       * Dragging moves the box; grabbing the corner resizes it.
       */
      function FloatTodo() {
        const [box, setBox] = useState(() => loadFloatBox() ?? floatBoxDefault())
        const [grabbing, setGrabbing] = useState(null)
        const boxRef = useRef(box)
        const origin = useRef(null)

        // The ref is the truth, not the state: the pointerup handler saves the box
        // and a batched state update may not have landed in the render yet.
        const apply = (next) => { boxRef.current = next; setBox(next) }

        useEffect(() => {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          const onResize = () => apply(floatClamp(boxRef.current))
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [])

        const start = (kind) => (event) => {
          if (event.button !== undefined && event.button !== 0) return
          const target = event.target
          if (kind === 'move' && target !== null && target !== undefined
            && typeof target.closest === 'function'
            && target.closest('button,input,select,label,a') !== null) return
          origin.current = { kind, id: event.pointerId, x: event.clientX, y: event.clientY, base: boxRef.current }
          setGrabbing(kind)
          const node = event.currentTarget
          if (node !== null && node !== undefined && typeof node.setPointerCapture === 'function') {
            // Capture is what keeps the box following a fast pointer that has left
            // the header; a host without it still drags, just less smoothly.
            try { node.setPointerCapture(event.pointerId) } catch { /* not fatal */ }
          }
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }

        const move = (event) => {
          const current = origin.current
          if (current === null || event.pointerId !== current.id) return
          const dx = event.clientX - current.x
          const dy = event.clientY - current.y
          apply(floatClamp(current.kind === 'move'
            ? { ...current.base, left: current.base.left + dx, top: current.base.top + dy }
            : { ...current.base, width: current.base.width + dx, height: current.base.height + dy }))
        }

        const end = () => {
          if (origin.current === null) return
          origin.current = null
          setGrabbing(null)
          saveFloatBox(boxRef.current)
        }

        const handle = {
          onPointerDown: start('move'),
          onPointerMove: move,
          onPointerUp: end,
          onPointerCancel: end,
        }

        return h('div', {
          className: `td-seat td-float${grabbing === null ? '' : ' dragging'}`,
          style: {
            left: `${box.left}px`, top: `${box.top}px`,
            width: `${box.width}px`, height: `${box.height}px`,
          },
          role: 'dialog',
          'aria-label': '待办任务浮动窗口',
        },
          h(TodoApp, { mode: 'float', drag: handle }),
          h('div', {
            className: 'td-float-grip',
            title: '拖动调整窗口大小',
            onPointerDown: start('size'),
            onPointerMove: move,
            onPointerUp: end,
            onPointerCancel: end,
          }))
      }

      /**
       * The global capture layer: the capture bar, reachable from anywhere.
       *
       * It reuses CaptureBar rather than mounting a second copy of the input, so
       * the draft, the preview and the parser are the same ones the panel uses --
       * a shortcut that opened a different box would be a second implementation
       * of the same feature.
       */
      function CaptureLayer() {
        return h('div', {
          className: 'td-seat td-cap-layer',
          onClick: () => closeCapture(),
        },
          h('div', {
            className: 'td-cap',
            role: 'dialog',
            'aria-label': '快速记录',
            onClick: (event) => { if (typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('div', { className: 'td-cap-h' }, 'Esc 丢弃 · 回车添加 · 语法见输入框提示'),
            h(CaptureBar, { mode: 'overlay' })))
      }

      /** Everything the command palette can do, derived from the current state. */
      function buildCommands(state) {
        const data = state.data
        const counts = data?.counts ?? {}
        const items = [
          { id: 'act:capture', label: '快速记录（唤起捕获）', hint: 'Ctrl+Shift+K', run: () => openCapture() },
          ...VIEW_KINDS.map(([kind, label]) => ({
            id: `view:${kind}`,
            label: `视图：${label}`,
            run: () => setApp({ view: kind, day: null }),
          })),
          ...[
            ['today', '今天', counts.dueToday + counts.overdue],
            ['week', '最近 7 天', counts.upcoming],
            ['overdue', '已逾期', counts.overdue],
            ['inbox', '未安排', counts.inbox],
            ['all', '全部任务', counts.open],
            ['done', '已完成', counts.done],
          ].map(([key, label, badge]) => ({
            id: `filter:${key}`,
            label: `智能清单：${label}`,
            hint: String(badge ?? ''),
            run: () => setApp({ filter: key, listId: null, tag: '', includeDone: key === 'done' }),
          })),
          ...(data?.lists ?? []).map((list) => ({
            id: `list:${list.id}`,
            label: `清单：${list.name}`,
            hint: String((counts.byList ?? []).find((b) => b.id === list.id)?.open ?? 0),
            run: () => setApp({ listId: list.id, filter: 'all', tag: '' }),
          })),
          ...(data?.tags ?? []).map((row) => ({
            id: `tag:${row.tag}`,
            label: `只看 #${row.tag}`,
            hint: String(row.open),
            run: () => setApp({ tag: row.tag, filter: 'all', listId: null }),
          })),
          { id: 'act:fullscreen', label: state.fullscreen ? '退出全屏' : '全屏显示', run: () => setApp({ fullscreen: !state.fullscreen }) },
          { id: 'act:float', label: state.float ? '停靠回面板' : '浮动窗口', run: () => setFloat(!state.float) },
          { id: 'act:reload', label: '重新载入', run: () => refresh({}, true) },
          { id: 'act:export', label: '导出备份', run: () => { exportBackup() } },
          { id: 'act:newlist', label: '新建清单', run: () => setApp({ creatingList: true }) },
          { id: 'help:syntax', label: '快速添加语法', hint: '?', run: () => setApp({ toast: '明天 15:00 交报告 !高 #工作 @紧要 · 每周一三五 晨跑 · 每月5日 交房租' }) },
        ]
        return items
      }

      /** Substring beats subsequence; ties keep the source order. */
      function rankCommands(items, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return items
        const scored = []
        items.forEach((item, index) => {
          const label = item.label.toLowerCase()
          const at = label.indexOf(needle)
          if (at >= 0) { scored.push({ item, score: 0, at, index }); return }
          let cursor = 0
          let gaps = 0
          for (const ch of needle) {
            const found = label.indexOf(ch, cursor)
            if (found < 0) return
            gaps += found - cursor
            cursor = found + 1
          }
          scored.push({ item, score: 1, at: gaps, index })
        })
        scored.sort((a, b) => a.score - b.score || a.at - b.at || a.index - b.index)
        return scored.map((s) => s.item)
      }

      /**
       * The command palette: every action, view, list and tag as one searchable
       * line.
       *
       * It is built from the same data the rail renders, so a list that exists is
       * a command that exists -- nothing here is a hand-written menu that can fall
       * out of step with the app.
       */
      function CommandPalette() {
        const state = useApp()
        const [query, setQuery] = useState('')
        const [index, setIndex] = useState(0)
        const items = useMemo(() => buildCommands(state), [state.data, state.view, state.filter, state.float, state.fullscreen])
        const shown = rankCommands(items, query)
        const active = shown.length === 0 ? 0 : Math.min(index, shown.length - 1)

        const run = (item) => {
          if (item === undefined) return
          setApp({ cmdk: false })
          item.run()
          restoreFocus()
        }

        const onPaletteKey = (event) => {
          if (event.key === 'ArrowDown' || (event.ctrlKey === true && String(event.key).toLowerCase() === 'n')) {
            stopEvent(event)
            setIndex(shown.length === 0 ? 0 : (active + 1) % shown.length)
            return
          }
          if (event.key === 'ArrowUp' || (event.ctrlKey === true && String(event.key).toLowerCase() === 'p')) {
            stopEvent(event)
            setIndex(shown.length === 0 ? 0 : (active - 1 + shown.length) % shown.length)
            return
          }
          if (event.key === 'Home') { stopEvent(event); setIndex(0); return }
          if (event.key === 'End') { stopEvent(event); setIndex(Math.max(0, shown.length - 1)); return }
          if (event.key === 'Enter') { stopEvent(event); run(shown[active]); return }
          if (event.key === 'Escape') {
            stopEvent(event)
            // Same discipline as the capture box: throw away what was typed
            // before closing the thing that holds it.
            if (query !== '') { setQuery(''); setIndex(0); return }
            closeCommandPalette()
          }
        }

        return h('div', { className: 'td-seat td-cmdk-layer', onClick: () => closeCommandPalette() },
          h('div', {
            className: 'td-cmdk',
            role: 'dialog',
            'aria-label': '命令面板',
            onClick: (event) => { if (typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('input', {
              className: 'td-in td-cmdk-in',
              autoFocus: true,
              value: query,
              placeholder: '输入命令、视图、清单或标签…',
              'aria-label': '命令面板',
              onChange: (event) => { setQuery(event.target.value); setIndex(0) },
              onKeyDown: onPaletteKey,
            }),
            h('div', { className: 'td-cmdk-list', role: 'listbox' },
              ...(shown.length === 0
                ? [h('div', { key: 'none', className: 'td-cmdk-hint' }, '没有匹配的命令。')]
                : shown.map((item, i) => h('button', {
                  key: item.id,
                  type: 'button',
                  role: 'option',
                  'aria-selected': i === active ? 'true' : 'false',
                  'data-cmd': item.id,
                  className: `td-cmdk-item${i === active ? ' on' : ''}`,
                  onMouseEnter: () => setIndex(i),
                  onClick: () => run(item),
                },
                  h('span', { className: 'td-cmdk-lab' }, item.label),
                  item.hint === undefined || item.hint === ''
                    ? null
                    : h('span', { className: 'td-cmdk-hint' }, item.hint))))),
            h('div', { className: 'td-cmdk-foot' },
              h('span', null, '↑↓ 选择 · Enter 执行 · Esc 关闭'),
              h('span', { className: 'td-kbd' }, 'Ctrl+K'))))
      }

      /** The central page. Renders nothing visible while fullscreen owns the app.
       *  The placeholder is a seat too: it paints the canvas, so without the marker
       *  it would have no --td-canvas and no --td-text at all and the panel slot
       *  would flash a transparent page with the host's ink. */
      function TodoMain() {        const state = useApp()
        if (state.fullscreen) {
          return h('div', { className: 'td-seat td-root' },
            h('div', { className: 'td-empty' }, '待办任务正在全屏显示。按 Esc 退出全屏。'))
        }
        return h(TodoApp, { mode: 'panel' })
      }

      /**
       * The overlay seat owns two frame-wide things: the fullscreen host and the
       * centred task dialog.
       *
       * The dialog lives here rather than inside the panel so that it looks and
       * behaves identically in both hosts, and so it is never confined to a column
       * that creates a containing block for fixed positioning.
       */
      function TodoOverlay() {
        const state = useApp()

        // The one keyboard entry point for the whole overlay seat: the global
        // shortcuts, then the Escape chain. Registered on `document` because it
        // must work when nothing of ours has focus -- and this seat is mounted
        // whether or not the panel is, which is what makes "record a task from
        // anywhere" possible at all.
        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const settings = app.data?.settings ?? {}
          const captureKey = settings.hotkey?.capture ?? 'Ctrl+Shift+K'
          const paletteKey = settings.hotkey?.palette ?? 'Ctrl+K'
          const onKey = (event) => {
            // Someone closer to the event has already dealt with it. Without this
            // the capture box's Escape also unwound the layer beneath it.
            if (event.defaultPrevented === true) return
            // Mid-composition the key belongs to the IME: Ctrl+Shift+K while
            // picking characters must not open anything.
            if (isComposingEvent(event)) return
            if (hotkeyMatches(event, captureKey) || hotkeyMatches(event, paletteKey)) {
              const target = event.target ?? null
              // A key aimed at something the user is typing into is theirs --
              // unless it is inside our own subtree, where the shortcut is the
              // documented way to jump between our own boxes. `.td-root` is asked
              // of the DOM rather than remembered in a ref, because up to three
              // seats are mounted at once and a single ref would only know the
              // last one to mount.
              const inside = target !== null && typeof target.closest === 'function'
                && target.closest('.td-root') !== null
              if (isEditableTarget(target) && !inside) return
              stopEvent(event)
              if (hotkeyMatches(event, captureKey)) openCapture()
              else if (app.cmdk === true) closeCommandPalette()
              else openCommandPalette()
              return
            }
            if (event.key !== 'Escape') return
            // One keypress, one layer -- outermost first, and only the layer that
            // actually handled it stops the event.
            if (app.cmdk === true) { stopEvent(event); closeCommandPalette(); return }
            if (app.capture === true) {
              stopEvent(event)
              // Level 2 is "the layer is open but the caret is not in its box"
              // (the box handles its own Escape at level 0), so this one both
              // throws the draft away and closes: Escape on a layer nobody is
              // typing into means "get rid of it".
              setApp({ quick: '', qPreview: null })
              closeCapture()
              return
            }
            if (app.confirm !== null) { stopEvent(event); settleConfirm(false); return }
            if (app.listEditor !== null) { stopEvent(event); setApp({ listEditor: null }); return }
            if (app.openId !== null) { stopEvent(event); setApp({ openId: null }); return }
            if (app.float) { stopEvent(event); setFloat(false); return }
            if (app.fullscreen) { stopEvent(event); setApp({ fullscreen: false }) }
          }
          // The same chain, one phase earlier -- and deliberately one task later.
          //
          // Measured on the real host: at `--only 09-confirm` (modal:2, confirm:1,
          // fullscreen:1) three Escape presses changed nothing, because the event
          // arrives at `document` already `prevented:true, stopped:true` -- the host
          // stops it in the bubble path between our layers and `document`, so the
          // listener above never ran at all (its first guard is `defaultPrevented`).
          // A capture-phase listener on `document` runs BEFORE any bubble-phase
          // stopper, so it cannot be starved that way.
          //
          // It must not jump the queue, though: the capture box, the inline add boxes
          // and the rail's new-list box handle Escape themselves and call
          // `preventDefault` when they do (see the comment in the capture box -- one
          // keypress must not unwind two layers). So this pass does not ACT during
          // the capture phase; it defers one task and then acts only if nobody
          // consumed the key. `defaultPrevented` is the same signal the chain's own
          // first guard uses, which is what makes the two passes idempotent: in a
          // host without a stopper the bubble pass handles the key, and this one
          // wakes up, sees the flag and does nothing.
          //
          // With none of OUR layers open, the chain's Escape branches all fail and
          // the event is left alone -- the host keeps every key that belongs to it.
          const mayOwn = (event) => event.key === 'Escape'
            || hotkeyMatches(event, captureKey) || hotkeyMatches(event, paletteKey)
          // Which events the bubble pass saw. A WeakSet rather than a flag, and the
          // reason is not tidiness: `defaultPrevented` is not enough on its own,
          // because an event can arrive with no `preventDefault` to call (a stand-in
          // in a test document), and then the two passes would each close a layer.
          const reachedDocument = new WeakSet()
          const onKeyBubble = (event) => {
            if (event !== null && typeof event === 'object') reachedDocument.add(event)
            onKey(event)
          }
          const onKeyCapture = (event) => {
            if (!mayOwn(event)) return
            setTimeout(() => {
              if (reachedDocument.has(event)) return
              if (event.defaultPrevented === true) return
              onKey(event)
            }, 0)
          }
          document.addEventListener('keydown', onKeyBubble)
          document.addEventListener('keydown', onKeyCapture, true)
          return () => {
            document.removeEventListener('keydown', onKeyBubble)
            document.removeEventListener('keydown', onKeyCapture, true)
          }
        }, [])

        const data = state.data
        const tasks = data?.tasks ?? []
        const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [data])
        const childrenOf = useMemo(() => {
          const map = new Map()
          for (const t of tasks) {
            if (t.parentId === null) continue
            if (!map.has(t.parentId)) map.set(t.parentId, [])
            map.get(t.parentId).push(t.id)
          }
          return map
        }, [data])

        const stack = []
        if (state.fullscreen) stack.push(h(TodoApp, { key: 'fullscreen', mode: 'fullscreen' }))
        // The window outranks the fullscreen host (its z-index is higher) and
        // yields to the dialogs, which are pushed last for exactly that reason.
        if (state.float) stack.push(h(FloatTodo, { key: 'float' }))

        const openTask = state.openId === null ? null : byId.get(state.openId)
        if (openTask !== undefined && openTask !== null) {
          stack.push(h(TaskEditor, {
            key: 'dialog',
            task: openTask,
            state: { ...state, today: data?.today },
            byId,
            childrenOf,
            lists: data?.lists ?? [],
            onClose: () => setApp({ openId: null }),
            onOpen: (id) => setApp({ openId: id }),
            onToggle: (id) => mutate('toggle', { id }),
            onPatch: (id, fields) => mutate('update', { id, ...fields }),
            onSkip: (id) => mutate('skip', { id }),
            onDelete: (id) => mutate('remove', { id }),
            onAddSubtask: (parentId, title) => mutate('addSubtask', { parentId, title }),
            askDelete,
          }))
        }
        // The question is pushed LAST, because these layers all share one z-index
        // and fixed positioning: the document order is the paint order, so the
        // entry pushed last is the one the user can actually see and click. It can
        // be asked from the dialog, from a row, or from the rail.
        const editingList = state.listEditor === null
          ? null
          : (data?.lists ?? []).find((l) => l.id === state.listEditor) ?? null
        if (editingList !== null) {
          stack.push(h(ListEditor, {
            key: 'list-editor',
            list: editingList,
            lists: data?.lists ?? [],
            palette: data?.palette ?? [],
            byList: data?.counts?.byList ?? [],
            onClose: () => setApp({ listEditor: null }),
            onDelete: askDeleteList,
          }))
        }
        if (state.confirm !== null) stack.push(h(ConfirmLayer, { key: 'confirm' }))
        // The capture layer and the palette are pushed last: they are the two
        // surfaces that must be reachable from anywhere, so nothing else may end
        // up painted over them.
        if (state.capture) stack.push(h(CaptureLayer, { key: 'capture' }))
        if (state.cmdk) stack.push(h(CommandPalette, { key: 'cmdk' }))
        if (stack.length === 0) return null
        // An array return keeps both entries as direct children of the overlay
        // layer, so neither one is wrapped in a box that could trap it.
        return stack
      }

      // ---------------------------------------------------------------------
      // sidebar seats
      // ---------------------------------------------------------------------

      /** Select the todo panel, or pass null to return to the Conversation. */
      function selectTodoPanel(panelId = 'todo') {
        const layout = ctx.get('layout')
        if (layout === undefined || typeof layout.selectPanel !== 'function') return
        try { layout.selectPanel(panelId) } catch (e) { console.warn('[todo] cannot select the panel:', e) }
      }

      /** Today's badge count, honouring the user's chosen measure. */
      function badgeCount(state) {
        const counts = state.data?.counts
        if (counts === undefined || counts === null) return 0
        const mode = state.data?.settings?.badgeCount ?? 'today'
        return mode === 'overdue' ? counts.overdue : mode === 'open' ? counts.open : counts.dueToday + counts.overdue
      }

      /**
       * The sidebar's global panel row: the shell owns the row, the label and the
       * click. Three things are ours:
       *   - the glyph and the count badge,
       *   - the SECOND click, which hides the panel again (the shell only ever
       *     selects, so re-clicking an open panel would otherwise be a no-op).
       *
       * The toggle is intercepted in the capture phase on `document`, because the
       * click has to be stopped before the shell's own handler turns it into a
       * selection. It stays inert while the panel is closed, so opening the panel
       * remains the shell's job.
       */
      function PanelIcon({ size, active }) {
        const state = useApp()
        const nodeRef = useRef(null)
        const activeRef = useRef(active)
        activeRef.current = active

        // This glyph is present in the sidebar from the first paint, before the
        // panel is ever opened, so it also warms the shared data.
        useEffect(() => { if (app.data === null && app.loading === false) refresh({}, true) }, [])

        useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onCapture = (event) => {
            if (activeRef.current !== true) return
            const node = nodeRef.current
            if (node === null || node === undefined) return
            const target = event.target
            if (target === null || typeof target.closest !== 'function') return
            const row = target.closest('button')
            // Only our own row: the button that contains this glyph.
            if (row === null || typeof row.contains !== 'function' || !row.contains(node)) return
            event.preventDefault()
            event.stopPropagation()
            setApp({ fullscreen: false })
            selectTodoPanel(null)
          }
          document.addEventListener('click', onCapture, true)
          return () => document.removeEventListener('click', onCapture, true)
        }, [])

        const edge = Number(size) || 18
        const badge = badgeCount(state)
        return h('span', {
          ref: nodeRef,
          className: 'td-seat td-glyphwrap',
          style: { position: 'relative', display: 'inline-flex' },
        },
          h('svg', {
            width: edge, height: edge, viewBox: '0 0 20 20', fill: 'none',
            stroke: active ? 'var(--td-brand)' : 'currentColor',
            strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
            h('path', { d: 'M3 5.5h1.6M3 10h1.6M3 14.5h1.6' }),
            h('path', { d: 'M7.5 5.5H17M7.5 10H17M7.5 14.5H13.5' })),
          badge <= 0
            ? null
            : h('span', {
              className: 'td-glyphbadge',
              title: '待办任务',
            }, badge > 99 ? '99+' : String(badge)))
      }

      // ---------------------------------------------------------------------
      // registration
      // ---------------------------------------------------------------------

      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const tagId = 'dsh-task-todo/todo.css'
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-task-todo'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      })

      try {
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'todo', order: 30, label: '待办任务' },
          PanelIcon,
        ))
      } catch (e) {
        console.error('[todo] sidebar.panellist registration failed:', e)
      }

      try {
        slots.inject('main', () => slots.register(
          { name: 'main', key: 'todo' },
          TodoMain,
        ))
      } catch (e) {
        console.error('[todo] main panel registration failed:', e)
      }

      try {
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'todo-overlay', order: 60 },
          TodoOverlay,
        ))
      } catch (e) {
        console.error('[todo] overlay registration failed:', e)
      }
    },

    /**
     * Pure display helpers exposed for the render/assert test harness. The browser
     * never reads this: it exists so the calendar arithmetic can be asserted
     * directly, against the very functions the UI calls.
     */
    __internals: {
      parseDue,
      dayIndexOf,
      dateFromIndex,
      addDaysStr,
      monthOf,
      addMonthsStr,
      monthGrid,
      weekdayHeaders,
      fmtDue,
      fmtDateFull,
      recurrenceRuleText,
      todayStr,
    },
    }
  },
})

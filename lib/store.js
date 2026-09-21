/**
 * dsh-task-todo -- the todo data model and its persistence.
 *
 * Storage is one JSON document (default `<DSH_HOME>/todo/tasks.json`) written
 * atomically. A task list is small, human-readable and diff-friendly: a user can
 * read it, back it up with the rest of ~/.dsh, or hand-edit it, none of which is
 * true of a binary database. Writes go through a temp file + rename so a crash
 * mid-write can never truncate the live document.
 *
 * Every task that leaves this module is passed through `normalizeTask`. That is
 * not tidiness: DSH validates every crossing value against lossless JSON, and a
 * field that is `undefined` (or a `Date`, or `NaN`) discards the ENTIRE reply.
 * Normalising on the way out makes the JSON contract structural rather than
 * something each call site has to remember.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addDays, compareDates, dateOnly, describeRecurrence, diffDays, dueLabel,
  expandOccurrences, formatDate, monthDays, nextDueOnComplete, normalizeRecurrence,
  nowStamp, parseTime, seriesExhausted, startOfWeek, toDateStr,
  today as todayStr,
} from './recurrence.js'

export const SCHEMA_VERSION = 1

/** Lists the plugin guarantees to exist. */
export const SYSTEM_LISTS = [
  { id: 'l_inbox', name: '收集箱', color: '#4f8cff', order: 0, system: true },
]

/** The inbox id, which is a contract: a task always has a real list to land in. */
export const INBOX_ID = SYSTEM_LISTS[0].id

/**
 * The colour a new list gets, and the swatches the editor offers.
 *
 * One source of truth: the host picks from this list when a list is created
 * without an explicit colour, and ships it to the client as `palette`, so the
 * swatch the rail previews before you press Enter is the colour you actually
 * get. The hexes are literal because a semantic HUE cannot be derived from the
 * theme's greyscale tokens -- the same reason the priority colours are literal.
 *
 * Deliberately SHORT and picked for distance from each other: a list colour is a
 * one-glance label, not a design decision. A free-form picker lived here for one
 * revision and made "file a task" feel like configuring a brand palette.
 */
export const LIST_PALETTE = [
  '#4f8cff', '#7c5cf0', '#c85cd8', '#e0584f',
  '#e08a2e', '#c9a227', '#3fa662', '#22a89a',
]

const PRIORITY_NAMES = { 0: '无', 1: '低', 2: '中', 3: '高' }

export function priorityName(p) {
  return PRIORITY_NAMES[Number(p) || 0] ?? '无'
}

/** Where the plugin keeps its data, honouring DSH_HOME like the rest of DSH. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function defaultDataFile() {
  return path.join(dshHome(), 'todo', 'tasks.json')
}

let counter = 0
/** Short, sortable, collision-resistant id. */
export function newId(prefix) {
  counter = (counter + 1) % 100000
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')
  return `${prefix}_${t}${counter.toString(36)}${r}`
}

// ---------------------------------------------------------------------------
// normalisation -- the JSON contract lives here
// ---------------------------------------------------------------------------

function str(value, fallback = '') {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value)
}

function bool(value) {
  return value === true
}

function int(value, fallback, min, max) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function tags(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const t of value) {
    const s = str(t).trim()
    if (s && !out.includes(s) && out.length < 20) out.push(s)
  }
  return out
}

function dateList(value, cap = 120) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const v of value) {
    const d = dateOnly(toDateStr(v))
    if (d !== null && !out.includes(d) && out.length < cap) out.push(d)
  }
  return out.sort(compareDates)
}

/** A task, canonicalised. Unknown fields are dropped, never passed through. */
export function normalizeTask(raw, lists) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const known = new Set((lists ?? []).map((l) => l.id))
  const listId = known.has(str(src.listId)) ? str(src.listId) : (known.has('l_inbox') ? 'l_inbox' : [...known][0] ?? 'l_inbox')
  const due = toDateStr(src.due)
  const start = toDateStr(src.start)
  const rec = normalizeRecurrence(src.recurrence)
  const history = Array.isArray(src.history)
    ? src.history
      .slice(-100)
      .map((h) => ({
        at: str(h?.at) || null,
        due: dateOnly(toDateStr(h?.due)),
      }))
      .filter((h) => h.due !== null)
    : []
  return {
    id: str(src.id) || newId('t'),
    title: str(src.title).slice(0, 500),
    note: str(src.note).slice(0, 20000),
    done: bool(src.done),
    completedAt: str(src.completedAt) || null,
    priority: int(src.priority, 0, 0, 3),
    listId,
    parentId: src.parentId === null || src.parentId === undefined || src.parentId === '' ? null : str(src.parentId),
    order: Number.isFinite(Number(src.order)) ? Number(src.order) : 0,
    tags: tags(src.tags),
    due,
    start,
    recurrence: rec.ok ? rec.value : null,
    // The series' fixed phase. Kept apart from `due` because completing a
    // repeating task moves `due`, and moving it must not move the rule.
    seriesAnchor: dateOnly(toDateStr(src.seriesAnchor)) ?? due,
    completedCount: int(src.completedCount, 0, 0, 1000000),
    seriesFinished: bool(src.seriesFinished),
    skipped: dateList(src.skipped),
    history,
    createdAt: str(src.createdAt) || nowStamp(),
    updatedAt: str(src.updatedAt) || nowStamp(),
  }
}

/** A list, canonicalised. */
export function normalizeList(raw, index = 0) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || newId('l'),
    name: str(src.name).slice(0, 60) || '未命名清单',
    color: /^#[0-9a-fA-F]{6}$/.test(str(src.color)) ? str(src.color) : '#8a8f98',
    order: Number.isFinite(Number(src.order)) ? Number(src.order) : index,
    system: bool(src.system),
  }
}

// ---------------------------------------------------------------------------
// quick add -- "明天 15:00 交报告 !高 #工作"
// ---------------------------------------------------------------------------

const CN_WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/**
 * Extract structured intent from one line of text.
 *
 * Deliberately conservative: every token it recognises is REMOVED from the
 * title, and anything ambiguous is left alone. A parser that eats half of a
 * sentence is worse than no parser, so dates must be anchored (今天 / 周三 /
 * 3月5日 / 2026-03-05) and a bare number is never treated as a date.
 */
export function parseQuickAdd(text, opts = {}) {
  const today = opts.today ?? todayStr()
  let rest = str(text)
  const matched = []
  const result = { title: '', due: null, priority: 0, tags: [], listName: null, recurrence: null, matched }
  const eat = (re) => {
    const m = re.exec(rest)
    if (m === null) return null
    matched.push(m[0].trim())
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)
    return m
  }

  // priority: !高 / !1 / !p1
  const pri = eat(/(?:^|\s)!((?:高|中|低)|[0-3]|p[0-3])(?=\s|$)/)
  if (pri !== null) {
    const v = pri[1]
    result.priority = v === '高' ? 3 : v === '中' ? 2 : v === '低' ? 1 : Number(v.replace('p', ''))
  }

  // tags: @tag
  for (;;) {
    const tag = eat(/(?:^|\s)@([^\s@#!]{1,20})(?=\s|$)/)
    if (tag === null) break
    const t = tag[1].trim()
    if (t && !result.tags.includes(t)) result.tags.push(t)
  }

  // list: #清单
  const list = eat(/(?:^|\s)#([^\s@#!]{1,30})(?=\s|$)/)
  if (list !== null) result.listName = list[1].trim()

  // A monthly series pinned to a day number ("每月5日") carries its own due
  // date, so it is matched before the generic 每月 token.
  let monthlyDay = null
  const monthlyMatch = eat(/(?:^|\s)每(?:个)?月\s*(\d{1,2})\s*[日号](?=\s|$)/)
  if (monthlyMatch !== null) {
    monthlyDay = int(monthlyMatch[1], 1, 1, 31)
    const normalized = normalizeRecurrence({ freq: 'monthly', interval: 1 })
    if (normalized.ok) result.recurrence = normalized.value
  }

  // recurrence: 每天 / 每日 / 每周 / 每月 / 每周一三五
  if (result.recurrence === null) {
    const rec = eat(/(?:^|\s)(每\s*[0-9一二三四五六七八九十]+\s*(?:天|日|周|月)|每天|每日|每周[一二三四五六日天]*|每月|every\s+(?:day|week|month))(?=\s|$)/)
    if (rec !== null) {
      const token = rec[1].replace(/\s+/g, '')
      const num = token.match(/^每([0-9一二三四五六七八九十]+)(天|日|周|月)/)
      const cnNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
      const interval = num === null ? 1 : (cnNum[num[1]] ?? int(num[1], 1, 1, 365))
      let freq = 'daily'
      if (/周|week/.test(token)) freq = 'weekly'
      else if (/月|month/.test(token)) freq = 'monthly'
      let weekdays = null
      const wd = token.match(/^每周([一二三四五六日天]+)$/)
      if (freq === 'weekly' && wd !== null) {
        weekdays = [...wd[1]].map((c) => CN_WEEKDAYS[c]).filter((n) => n !== undefined)
      }
      const normalized = normalizeRecurrence({ freq, interval, weekdays })
      if (normalized.ok) result.recurrence = normalized.value
    }
  }

  // time: 上午/下午/晚上/中午 + N点[M分] / N:MM
  let time = null
  const tm = eat(/(?:^|\s)(上午|早上|早晨|中午|下午|傍晚|晚上|晚)?\s*(\d{1,2})[:：点](\d{1,2})?(?:分)?(?=\s|$)/)
  if (tm !== null) {
    let hour = int(tm[2], 0, 0, 23)
    const minute = tm[3] === undefined || tm[3] === '' ? 0 : int(tm[3], 0, 0, 59)
    const period = tm[1] ?? ''
    if (/下午|傍晚|晚上|晚/.test(period) && hour < 12) hour += 12
    if (/中午/.test(period) && hour < 12) hour += 4
    time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  // date
  let date = null
  const abs = eat(/(?:^|\s)(\d{4})-(\d{1,2})-(\d{1,2})(?=\s|$)/)
  if (abs !== null) {
    date = formatDate(int(abs[1], 1970, 1970, 2999), int(abs[2], 1, 1, 12), int(abs[3], 1, 1, 31))
    if (dateOnly(date) === null) date = null
  }
  if (date === null) {
    const md = eat(/(?:^|\s)(\d{1,2})[月/](\d{1,2})日?(?=\s|$)/)
    if (md !== null) {
      const y = Number(today.slice(0, 4))
      const candidate = `${y}-${String(int(md[1], 1, 1, 12)).padStart(2, '0')}-${String(int(md[2], 1, 1, 31)).padStart(2, '0')}`
      // A month/day already past this year means next year.
      date = dateOnly(candidate) === null ? null
        : compareDates(candidate, today) < 0 ? `${y + 1}${candidate.slice(4)}` : candidate
    }
  }
  if (date === null) {
    // Weekday phrases must be matched as a WHOLE ("下周三", "本周日"): matching
    // the bare "周三" inside "下周三" would leave the 下 behind in the title.
    const rel = eat(/(?:^|\s)(大后天|后天|明天|今天|昨天|今日|明日|(\d{1,3})\s*天[后之]?后|下(?:个)?周[一二三四五六日天]|下(?:个)?星期[一二三四五六日天]|本(?:周|星期)[一二三四五六日天]|这(?:周|星期)[一二三四五六日天]|下周|下星期|下个星期|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天])(?=\s|$)/)
    if (rel !== null) {
      const token = rel[1]
      if (token === '今天' || token === '今日') date = today
      else if (token === '明天' || token === '明日') date = addDays(today, 1)
      else if (token === '后天') date = addDays(today, 2)
      else if (token === '大后天') date = addDays(today, 3)
      else if (token === '昨天') date = addDays(today, -1)
      else if (rel[2] !== undefined) date = addDays(today, int(rel[2], 0, 0, 999))
      else {
        const wdChar = token.replace(/^(下(?:个)?周|下(?:个)?星期|本(?:周|星期)|这(?:周|星期)|周|星期)/, '')
        const target = CN_WEEKDAYS[wdChar]
        if (target !== undefined) {
          const monday = startOfWeek(today, 1)
          // Monday-based offset of the requested weekday (Sun = 6).
          const offset = (target - 1 + 7) % 7
          if (/^下/.test(token)) date = addDays(monday, 7 + offset)
          else if (/^(本|这)/.test(token)) date = addDays(monday, offset)
          else {
            // A bare weekday means the coming one; today counts as "today".
            const todayWd = new Date(`${today}T00:00:00`).getDay()
            date = addDays(today, (target - todayWd + 7) % 7)
          }
        }
      }
    }
  }

  // A day-numbered monthly series supplies its own first due date: the next
  // time that day comes round, clamped for short months.
  if (date === null && monthlyDay !== null) {
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7))
    const clampDay = (y, m) => Math.min(monthlyDay, monthDays(y, m))
    let candidate = formatDate(year, month, clampDay(year, month))
    if (compareDates(candidate, today) < 0) {
      const nextMonth = month === 12 ? 1 : month + 1
      const nextYear = month === 12 ? year + 1 : year
      candidate = formatDate(nextYear, nextMonth, clampDay(nextYear, nextMonth))
    }
    date = candidate
  }

  if (date !== null && time !== null) result.due = `${date}T${time}`
  else if (date !== null) result.due = date
  else if (time !== null) result.due = `${today}T${time}`

  result.title = rest.replace(/\s+/g, ' ').trim()
  return result
}

/**
 * What a quick-add line WILL do, as a plain plan -- the one place the priority
 * between "what the user typed" and "which bucket they typed it in" is decided.
 *
 * The inline `+` in a group/column has to seed the date and the list, but the
 * user's own `#清单` / `明天` must win over the seed: typing `#装修` inside the
 * 今天 group means 装修, not 今天. Keeping this rule here (rather than in the
 * browser) is what makes the preview and the actual insert agree by construction
 * -- `quickAdd` and `previewQuick` both call it.
 *
 * `seed.due === undefined` means "no opinion" (fall through to the create
 * default), while an explicit `null` means "leave it unscheduled", which is what
 * the 未安排 group asks for.
 */
export function planQuickAdd(text, opts = {}) {
  const today = opts.today ?? todayStr()
  const seed = opts.seed ?? {}
  const parsed = parseQuickAdd(text, { today })
  const explicitList = parsed.listName !== null && parsed.listName !== ''
  return {
    parsed,
    explicitList,
    // Text wins, seed is the fallback -- for the date and for the list alike.
    due: parsed.due !== null ? parsed.due : (seed.due === undefined ? undefined : seed.due),
    priority: parsed.priority,
    listName: explicitList ? parsed.listName : null,
    listId: explicitList ? null : (seed.listId ?? null),
    listFromSeed: !explicitList && seed.listId !== undefined && seed.listId !== null,
  }
}

/** The seeds the inline `+` needs, derived from the bucket a group represents. */
export function groupSeed(key, today) {
  switch (key) {
    case 'overdue': return { due: addDays(today, -1), listId: null, addable: true }
    case 'today': return { due: today, listId: null, addable: true }
    case 'tomorrow': return { due: addDays(today, 1), listId: null, addable: true }
    case 'week': return { due: addDays(today, 7), listId: null, addable: true }
    case 'later': return { due: addDays(today, 8), listId: null, addable: true }
    case 'none': return { due: null, listId: null, addable: true }
    default: return { due: null, listId: null, addable: false }
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class TodoStore {
  constructor(opts = {}) {
    this.file = opts.dataFile || defaultDataFile()
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {}
    this.lists = []
    this.tasks = []
    this.meta = { version: SCHEMA_VERSION, createdAt: nowStamp(), updatedAt: nowStamp() }
    this.loaded = false
    this.loadError = null
    this.dirty = false
    // Coalesced persistence. Ticking ten checkboxes in a row used to mean ten
    // full-document stringifies and ten renames; the document only has to reach
    // the disk once after the burst, and `flush()` is the guarantee that it does
    // before the process goes away.
    this.saveTimer = null
    this.saveDelay = Number.isFinite(opts.saveDelay) ? opts.saveDelay : 200
  }

  // -- persistence ---------------------------------------------------------

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const doc = JSON.parse(raw)
      this.applyDocument(doc)
      this.loaded = true
      this.loadError = null
      return this
    } catch (e) {
      if (e?.code === 'ENOENT') {
        // First run: create the file so the user can see where data lives.
        this.lists = SYSTEM_LISTS.map((l, i) => normalizeList(l, i))
        this.tasks = []
        this.loaded = true
        this.loadError = null
        this.save()
        return this
      }
      // Never silently discard a document we failed to parse: keep it aside and
      // start clean, so the user can inspect or restore it by hand.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try { fs.copyFileSync(this.file, backup) } catch { /* best effort */ }
      this.lists = SYSTEM_LISTS.map((l, i) => normalizeList(l, i))
      this.tasks = []
      this.loaded = true
      this.loadError = `数据文件无法解析（${String(e?.message ?? e)}），已备份到 ${backup}，本次以空清单启动。`
      this.log(`[todo] ${this.loadError}`)
      return this
    }
  }

  applyDocument(doc) {
    // Nothing queued may outlive the state it was written from: a pending write
    // replayed after an import would put the pre-import document back on disk.
    this.cancelSave()
    const src = doc !== null && typeof doc === 'object' ? doc : {}
    const lists = Array.isArray(src.lists) ? src.lists : []
    const normalized = lists.map((l, i) => normalizeList(l, i))
    // The inbox is a contract, not a convention: every task needs a real list.
    for (const sys of SYSTEM_LISTS) {
      if (!normalized.some((l) => l.id === sys.id)) normalized.unshift(normalizeList(sys, -1))
    }
    // Preserve list order as stored, then normalise the sequence.
    normalized.sort((a, b) => a.order - b.order)
    normalized.forEach((l, i) => { l.order = i })
    this.lists = normalized
    const ids = new Set()
    const tasks = Array.isArray(src.tasks) ? src.tasks : []
    const out = []
    for (const t of tasks) {
      const n = normalizeTask(t, this.lists)
      if (ids.has(n.id)) continue
      ids.add(n.id)
      out.push(n)
    }
    // Drop dangling parents rather than leaving subtrees orphaned.
    for (const t of out) {
      if (t.parentId !== null && !ids.has(t.parentId)) t.parentId = null
    }
    this.tasks = out
    this.meta = {
      version: SCHEMA_VERSION,
      createdAt: str(src.meta?.createdAt) || nowStamp(),
      updatedAt: str(src.meta?.updatedAt) || nowStamp(),
    }
  }

  cancelSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    return this
  }

  /**
   * Queue a write, replacing any write already queued.
   *
   * Reads never wait for the disk (the in-memory document is the truth), and a
   * burst of mutations costs one write. `save({ immediate: true })` is the
   * synchronous path, used by the import (which must land before the caller is
   * told it succeeded) and by `flush()`.
   */
  scheduleSave() {
    this.dirty = true
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try { this.save() } catch (e) { this.log(`[todo] deferred save failed: ${String(e?.message ?? e)}`) }
    }, this.saveDelay)
    if (typeof this.saveTimer?.unref === 'function') this.saveTimer.unref()
    return this
  }

  /** Write now if anything is queued. Safe to call when nothing is. */
  flush() {
    if (this.saveTimer === null && !this.dirty) return this
    this.cancelSave()
    this.save()
    return this
  }

  dispose() {
    try { this.flush() } catch { /* the host is going down; nothing left to report to */ }
    this.cancelSave()
    return this
  }

  save() {
    try {
      this.cancelSave()
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const doc = {
        meta: { ...this.meta, version: SCHEMA_VERSION, updatedAt: nowStamp() },
        lists: this.lists,
        tasks: this.tasks,
      }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
      this.meta.updatedAt = doc.meta.updatedAt
      this.dirty = false
      return true
    } catch (e) {
      this.log(`[todo] save failed: ${String(e?.message ?? e)}`)
      throw new Error(`保存失败：${String(e?.message ?? e)}`)
    }
  }

  // -- reads ---------------------------------------------------------------

  /** All tasks, normalised, parents before their children, ordered. */
  all() {
    return sortTasks(this.tasks.filter((t) => t.parentId === null))
      .flatMap((t) => [t, ...this.childrenOf(t.id)])
  }

  raw() {
    return this.tasks
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) ?? null
  }

  childrenOf(parentId) {
    return sortTasks(this.tasks.filter((t) => t.parentId === parentId))
  }

  /**
   * Every tag in use, with the counts the rail shows.
   *
   * Tags were write-only until now: they could be typed into a task and they
   * matched a search, but nothing could list them, so a typo was permanent and
   * the rail could not offer "what do I actually tag things with".
   */
  tagCounts() {
    const byTag = new Map()
    for (const t of this.tasks) {
      for (const tag of t.tags) {
        const key = tag.toLowerCase()
        const row = byTag.get(key) ?? { tag, open: 0, total: 0 }
        row.total++
        if (!t.done) row.open++
        byTag.set(key, row)
      }
    }
    return [...byTag.values()].sort((a, b) => (b.open - a.open) || (b.total - a.total) || a.tag.localeCompare(b.tag))
  }

  /** A task plus its descendants, depth first. */
  subtree(id) {
    const out = []
    const walk = (tid) => {
      const t = this.get(tid)
      if (t === null) return
      out.push(t)
      for (const c of this.childrenOf(tid)) walk(c.id)
    }
    walk(id)
    return out
  }

  listById(id) {
    return this.lists.find((l) => l.id === id) ?? null
  }

  listByname(name) {
    const low = str(name).trim().toLowerCase()
    return this.lists.find((l) => l.name.toLowerCase() === low) ?? null
  }

  /**
   * Compact stat block for the UI badge and the tools.
   *
   * The actionable counts (overdue / today / upcoming / inbox / open) cover
   * top-level tasks only: a subtask is worked inside its parent's row, and
   * counting both would double every number the user sees. `total` reports the
   * whole document so nothing is hidden.
   */
  stats(opts = {}) {
    const today = opts.today ?? todayStr()
    const weekEnd = addDays(today, 7)
    const top = this.tasks.filter((t) => t.parentId === null)
    let overdue = 0
    let dueToday = 0
    let upcoming = 0
    let inbox = 0
    let done = 0
    let open = 0
    let repeating = 0
    for (const t of top) {
      if (t.done) { done++; continue }
      open++
      if (t.recurrence !== null) repeating++
      const due = dateOnly(t.due)
      if (due === null) { inbox++; continue }
      if (compareDates(due, today) < 0) overdue++
      else if (due === today) dueToday++
      else if (weekEnd !== null && compareDates(due, weekEnd) <= 0) upcoming++
    }
    const byList = this.lists.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      open: top.filter((t) => t.listId === l.id && !t.done).length,
      total: this.tasks.filter((t) => t.listId === l.id).length,
    }))
    return {
      today,
      total: this.tasks.length,
      topLevel: top.length,
      open,
      overdue,
      dueToday,
      upcoming,
      inbox,
      done,
      repeating,
      byList,
    }
  }

  // -- writes --------------------------------------------------------------

  create(input = {}) {
    const lists = this.lists
    // The fallback is the INBOX BY ID, not "whichever list is first": list order
    // is a per-user preference (the rail is reorderable), and dragging the inbox
    // down must not silently change where an unassigned task lands.
    const fallback = lists.find((l) => l.id === INBOX_ID)?.id ?? (lists[0]?.id ?? INBOX_ID)
    const listId = input.listId && this.listById(input.listId) !== null
      ? input.listId
      : (this.listByname(input.listName ?? '')?.id ?? fallback)
    const rec = normalizeRecurrence(input.recurrence)
    if (!rec.ok) throw new Error(rec.error)
    const now = nowStamp()
    const createdAt = str(input.createdAt) || now
    const parentId = input.parentId ? str(input.parentId) : null
    if (parentId !== null && this.get(parentId) === null) throw new Error('父任务不存在')
    // Dates are defaulted as a PAIR, never one end at a time.
    //
    // `due` alone carries meaning: a task with no due date is invisible to the
    // 今天 / 逾期 triage the whole UI is built around, so "I just typed this" -- no
    // date information at all -- means today, at both ends. That much is unchanged.
    //
    // What must NOT happen is defaulting `start` independently. A caller that named
    // a due date has already answered "when is this"; filling `start` in with today
    // draws 「今天 → 明天」 for "明天 15:00 交报告" instead of the one-day bar it is,
    // and stamps a start date onto the markdown import of historical records, whose
    // explicit `due: null` means 「未安排」 -- a gap is a fact about the old data, not
    // something to paper over. So `start` falls back to the creation moment only when
    // NEITHER end was given, and a named end suppresses the other one's default:
    // a due-only task is a single-day (milestone) bar, a start-only task is one too.
    const hasDue = input.due !== undefined
    const hasStart = input.start !== undefined
    const named = hasDue || hasStart
    const due = hasDue ? toDateStr(input.due) : (named ? null : toDateStr(createdAt))
    const start = hasStart ? toDateStr(input.start) : (named ? null : toDateStr(createdAt))
    // An explicit id is honoured when it is free, which is what makes an import
    // of records that already have ids idempotent (and traceable back to their
    // source). A taken id is NOT an error: generating a fresh one keeps the
    // document's "one task per id" invariant, which the rest of the store --
    // and every `resolveId` call -- depends on.
    const wanted = str(input.id).trim()
    const id = wanted !== '' && this.get(wanted) === null ? wanted : newId('t')
    // `done` at creation time is a statement about history, not a completion
    // event: nothing here rolls a recurrence series or resets subtasks. Only
    // `toggle()` does that, because only `toggle()` means "I just finished it".
    // A missing completion time stays missing -- an import must not invent one.
    const done = bool(input.done)
    const task = normalizeTask({
      id,
      title: str(input.title).trim() || '未命名任务',
      note: str(input.note),
      done,
      completedAt: done ? (str(input.completedAt) || null) : null,
      priority: input.priority ?? 0,
      listId,
      parentId,
      order: this.nextOrder(parentId, listId),
      tags: input.tags ?? [],
      due,
      start,
      recurrence: rec.value,
      seriesAnchor: rec.value === null ? null : (dateOnly(due) ?? todayStr()),
      completedCount: 0,
      skipped: [],
      history: [],
      createdAt,
      updatedAt: now,
    }, this.lists)
    this.tasks.push(task)
    this.scheduleSave()
    return this.get(task.id)
  }

  nextOrder(parentId, listId) {
    const siblings = this.tasks.filter((t) => t.parentId === parentId && t.listId === listId)
    if (!siblings.length) return 0
    return Math.max(...siblings.map((t) => t.order)) + 1
  }

  update(id, patch = {}) {
    const t = this.get(id)
    if (t === null) throw new Error('任务不存在')
    const before = { due: t.due, recurrence: t.recurrence === null ? null : { ...t.recurrence } }
    if ('title' in patch && patch.title !== undefined) {
      const title = str(patch.title).trim()
      if (!title) throw new Error('任务标题不能为空')
      t.title = title.slice(0, 500)
    }
    if ('note' in patch && patch.note !== undefined) t.note = str(patch.note).slice(0, 20000)
    if ('priority' in patch && patch.priority !== undefined) t.priority = int(patch.priority, 0, 0, 3)
    if ('listId' in patch && patch.listId !== undefined) {
      if (this.listById(str(patch.listId)) === null) throw new Error('清单不存在')
      t.listId = str(patch.listId)
      // A task and its subtasks live in one list; that invariant is what makes
      // the board's "column = list" meaningful.
      for (const child of this.childrenOf(t.id)) child.listId = t.listId
    }
    if ('tags' in patch && patch.tags !== undefined) t.tags = tags(patch.tags)
    if ('due' in patch) t.due = patch.due === null || patch.due === '' ? null : toDateStr(patch.due)
    if ('start' in patch) t.start = patch.start === null || patch.start === '' ? null : toDateStr(patch.start)
    if ('recurrence' in patch) {
      const rec = normalizeRecurrence(patch.recurrence)
      if (!rec.ok) throw new Error(rec.error)
      t.recurrence = rec.value
      // Re-anchoring a series restarts its counters; keeping a stale count would
      // make "共 10 次" end early on a rule the user just changed.
      if (rec.value !== null && (before.recurrence === null || before.recurrence.freq !== rec.value.freq)) {
        t.completedCount = 0
        t.seriesFinished = false
      }
      t.seriesAnchor = rec.value === null ? null : (dateOnly(t.due) ?? todayStr())
    } else if ('due' in patch && t.recurrence !== null && t.due !== before.due) {
      // Editing the date of a repeating task by hand is the user re-phasing the
      // series, so the anchor follows. (The completion roll is internal and does
      // NOT come through here, which is exactly why the anchor survives it.)
      t.seriesAnchor = dateOnly(t.due)
    }
    if ('parentId' in patch && patch.parentId !== undefined) {
      const pid = patch.parentId === null || patch.parentId === '' ? null : str(patch.parentId)
      if (pid !== null) {
        if (this.get(pid) === null) throw new Error('父任务不存在')
        if (pid === t.id || this.subtree(t.id).some((s) => s.id === pid)) {
          throw new Error('不能把任务挂到自己的子任务下')
        }
        // A subtask always lives in its parent's list.
        t.listId = this.get(pid).listId
      }
      t.parentId = pid
      for (const child of this.childrenOf(t.id)) child.listId = t.listId
    }
    if ('order' in patch && patch.order !== undefined) t.order = Number.isFinite(Number(patch.order)) ? Number(patch.order) : t.order
    // Completion runs LAST: it must see the final due/rule, because completing a
    // repeating task rolls the due date forward from exactly those values.
    if ('done' in patch && patch.done !== undefined) {
      const want = bool(patch.done)
      if (want !== t.done) {
        const rolled = this.toggle(id, { today: patch.today })
        return rolled
      }
    }
    t.updatedAt = nowStamp()
    this.scheduleSave()
    return t
  }

  /** Add a subtask to an existing task (the UI's "+ 子任务" path). */
  addSubtask(parentId, input = {}) {
    const parent = this.get(parentId)
    if (parent === null) throw new Error('父任务不存在')
    // A subtask belongs to its parent's schedule, so it inherits the parent's due
    // date -- INCLUDING the parent's "no date at all", which is a real answer here
    // and not a missing one. Only a caller that passes its own date overrides it.
    const due = input.due === undefined ? parent.due : input.due
    return this.create({ ...input, due, parentId, listId: parent.listId })
  }

  /**
   * Move a task between lists / positions, and keep subtasks with their parent.
   */
  move(id, opts = {}) {
    const t = this.get(id)
    if (t === null) throw new Error('任务不存在')
    if (opts.listId !== undefined && opts.listId !== null) {
      if (this.listById(str(opts.listId)) === null) throw new Error('清单不存在')
      t.listId = str(opts.listId)
      for (const child of this.childrenOf(t.id)) child.listId = t.listId
    }
    if (opts.parentId !== undefined) {
      const pid = opts.parentId === null || opts.parentId === '' ? null : str(opts.parentId)
      if (pid !== null) {
        if (this.get(pid) === null) throw new Error('父任务不存在')
        if (pid === t.id || this.subtree(t.id).some((s) => s.id === pid)) throw new Error('不能把任务挂到自己的子任务下')
        t.listId = this.get(pid).listId
      }
      t.parentId = pid
    }
    // Position among the destination's siblings. Re-numbering the whole sibling
    // set on each drop keeps the stored order dense and deterministic.
    const siblings = sortTasks(this.tasks.filter((s) => s.parentId === t.parentId && s.listId === t.listId && s.id !== t.id))
    const idx = Number.isFinite(Number(opts.index)) ? int(opts.index, siblings.length, 0, siblings.length) : null
    if (idx !== null) siblings.splice(idx, 0, t)
    else siblings.push(t)
    siblings.forEach((s, i) => { s.order = i })
    t.updatedAt = nowStamp()
    this.scheduleSave()
    return t
  }

  /**
   * Complete or un-complete a task.
   *
   * Completing a repeating task does NOT mark it done: it records the
   * completion and rolls the due date to the next occurrence, exactly like
   * ticking a box on a paper recurring checklist. Its subtasks reset, because
   * they belong to one occurrence, not to the whole series.
   */
  toggle(id, opts = {}) {
    const t = this.get(id)
    if (t === null) throw new Error('任务不存在')
    const today = opts.today ?? todayStr()
    const now = nowStamp()
    if (!t.done) {
      const rec = t.recurrence
      if (rec !== null && rec.finished !== true) {
        const completed = t.completedCount + 1
        const next = nextDueOnComplete(rec, t.seriesAnchor ?? t.due ?? today, t.due ?? today, today)
        const reachedCount = rec.count !== null && rec.count !== undefined && completed >= rec.count
        t.history = [...t.history, { at: now, due: dateOnly(t.due) ?? today }].slice(-100)
        t.completedCount = completed
        if (next === null || reachedCount) {
          t.done = true
          t.completedAt = now
          t.seriesFinished = true
        } else {
          t.done = false
          t.completedAt = null
          t.due = next
          t.seriesFinished = false
          for (const child of this.childrenOf(t.id)) {
            child.done = false
            child.completedAt = null
            child.updatedAt = now
          }
        }
      } else {
        t.done = true
        t.completedAt = now
      }
    } else {
      t.done = false
      t.completedAt = null
    }
    t.updatedAt = now
    this.scheduleSave()
    return t
  }

  /** Skip the current occurrence of a repeating task without completing it. */
  skipOccurrence(id, opts = {}) {
    const t = this.get(id)
    if (t === null) throw new Error('任务不存在')
    if (t.recurrence === null) throw new Error('该任务不是重复任务')
    const today = opts.today ?? todayStr()
    const current = dateOnly(t.due) ?? today
    const next = nextDueOnComplete(t.recurrence, t.seriesAnchor ?? current, current, current)
    t.skipped = [...t.skipped, current].slice(-120)
    if (next === null) {
      t.done = true
      t.completedAt = nowStamp()
      t.seriesFinished = true
    } else {
      t.due = next
    }
    t.updatedAt = nowStamp()
    this.scheduleSave()
    return t
  }

  /** Delete a task and everything under it. */
  remove(id) {
    const t = this.get(id)
    if (t === null) throw new Error('任务不存在')
    const doomed = new Set(this.subtree(id).map((s) => s.id))
    this.tasks = this.tasks.filter((s) => !doomed.has(s.id))
    this.scheduleSave()
    return { deleted: doomed.size, ids: [...doomed] }
  }

  /** Clear completed tasks; repeating parents are never removed by accident. */
  clearCompleted(opts = {}) {
    const doomed = new Set()
    for (const t of this.tasks) {
      if (!t.done) continue
      for (const s of this.subtree(t.id)) doomed.add(s.id)
    }
    const n = this.tasks.filter((t) => doomed.has(t.id)).length
    this.tasks = this.tasks.filter((t) => !doomed.has(t.id))
    this.scheduleSave()
    return { deleted: n }
  }

  createList(input = {}) {
    const name = str(input.name).trim()
    if (!name) throw new Error('清单名称不能为空')
    if (this.listByname(name) !== null) throw new Error(`清单「${name}」已存在`)
    const index = this.lists.length
    // A new list is never grey by default: the rail previews a colour before you
    // press Enter, so the value has to be decided here and nowhere else.
    const color = input.color ?? LIST_PALETTE[this.lists.filter((l) => !l.system).length % LIST_PALETTE.length]
    const list = normalizeList({
      id: newId('l'),
      name,
      color,
      order: index,
      system: false,
    }, index)
    this.lists.push(list)
    this.lists.sort((a, b) => a.order - b.order)
    this.lists.forEach((l, i) => { l.order = i })
    this.scheduleSave()
    return list
  }

  /** The colour a list created right now would get (the rail previews it). */
  nextListColor() {
    return LIST_PALETTE[this.lists.filter((l) => !l.system).length % LIST_PALETTE.length]
  }

  updateList(id, patch = {}) {
    const list = this.listById(id)
    if (list === null) throw new Error('清单不存在')
    if (patch.name !== undefined && patch.name !== null) {
      const name = str(patch.name).trim().slice(0, 60)
      if (!name) throw new Error('清单名称不能为空')
      // Two lists with one name make `#工作` and "唯一标题" resolution ambiguous,
      // so a rename onto an existing name is refused rather than silently merged.
      const clash = this.listByname(name)
      if (clash !== null && clash.id !== id) throw new Error(`清单「${name}」已存在`)
      list.name = name
    }
    if (patch.color !== undefined && patch.color !== null
      && /^#[0-9a-fA-F]{6}$/.test(str(patch.color))) list.color = str(patch.color).toLowerCase()
    if (patch.order !== undefined) {
      const n = Number(patch.order)
      if (Number.isFinite(n)) list.order = n
    }
    this.lists.sort((a, b) => a.order - b.order)
    this.lists.forEach((l, i) => { l.order = i })
    this.scheduleSave()
    return list
  }

  /**
   * Put a list at an absolute position, which is what a drag expresses.
   *
   * The order is renormalised to 0..n-1 afterwards, so an index can never go
   * stale: the rail, the board columns and the calendar all read `store.lists`,
   * and a gap in the sequence would order them differently in each place.
   */
  moveList(id, opts = {}) {
    const list = this.listById(id)
    if (list === null) throw new Error('清单不存在')
    const ordered = [...this.lists].sort((a, b) => a.order - b.order)
    const from = ordered.indexOf(list)
    const last = ordered.length - 1
    const wanted = opts.index === undefined ? from : int(opts.index, from, 0, last)
    ordered.splice(from, 1)
    ordered.splice(wanted, 0, list)
    ordered.forEach((l, i) => { l.order = i })
    this.lists = ordered
    this.scheduleSave()
    return { list: { ...list }, from, to: this.lists.indexOf(list), order: this.lists.map((l) => l.id) }
  }

  removeList(id) {
    const list = this.listById(id)
    if (list === null) throw new Error('清单不存在')
    if (list.system) throw new Error('系统清单不能删除')
    // Resolve the inbox by ID first: renaming 收集箱 is allowed, and the tasks of
    // a deleted list must still land somewhere predictable.
    const fallback = this.listById(INBOX_ID)?.id ?? this.listByname('收集箱')?.id
      ?? this.lists.find((l) => l.id !== id)?.id ?? INBOX_ID
    let moved = 0
    for (const t of this.tasks) {
      if (t.listId === id) { t.listId = fallback; moved++ }
    }
    this.lists = this.lists.filter((l) => l.id !== id)
    this.lists.forEach((l, i) => { l.order = i })
    this.scheduleSave()
    return {
      deleted: true,
      name: list.name,
      moved,
      movedTo: fallback,
      movedToName: this.listById(fallback)?.name ?? null,
    }
  }

  /** Create from a quick-add line; returns the parsed intent and the task. */
  quickAdd(text, opts = {}) {
    const today = opts.today ?? todayStr()
    const plan = planQuickAdd(text, {
      today,
      // Only the inline `+` passes a seed; a bare quick-add line has no opinion,
      // which keeps every existing caller on exactly the old behaviour.
      seed: { due: opts.due, listId: opts.listId },
    })
    const parsed = plan.parsed
    if (!parsed.title) throw new Error('没有解析出任务标题')
    let listId = plan.listId
    let listCreated = false
    if (plan.explicitList) {
      const existing = this.listByname(plan.listName)
      if (existing !== null) listId = existing.id
      else {
        // Typing `#装修` in the quick-add line is how a list gets made; forcing
        // a separate settings trip for it would break the flow.
        listId = this.createList({ name: plan.listName }).id
        listCreated = true
      }
    }
    const task = this.create({
      title: parsed.title,
      // `parseQuickAdd` always answers with a key, so "no date typed" is an
      // explicit null here; passing it through would bypass the create default and
      // land every quick-added task in 「未安排」. Undefined means "no opinion" --
      // which is also what a missing seed means.
      due: plan.due,
      priority: parsed.priority,
      tags: parsed.tags,
      recurrence: parsed.recurrence,
      listId,
      parentId: opts.parentId ?? null,
    })
    return { task, parsed, listCreated }
  }

  /** Occurrences of every repeating task inside a range (calendar / gantt). */
  occurrences(opts = {}) {
    const from = toDateStr(opts.from) ?? todayStr()
    const to = toDateStr(opts.to) ?? from
    const items = []
    for (const t of this.tasks) {
      if (t.recurrence === null) continue
      if (t.parentId !== null) continue
      // The series is described by its anchor, and the occurrence currently on
      // the board is added back in so an overdue repeating task stays visible.
      const anchor = dateOnly(t.seriesAnchor ?? t.due)
      if (anchor === null) continue
      const dates = expandOccurrences(t.recurrence, anchor, t.due, from, to)
      if (dates.length) items.push({ id: t.id, dates })
    }
    return { from, to, items }
  }

  /** The whole document, for backup / hand inspection. */
  document() {
    return {
      meta: { ...this.meta, version: SCHEMA_VERSION },
      lists: this.lists.map((l) => ({ ...l })),
      tasks: this.tasks.map((t) => ({ ...t })),
    }
  }
}

/**
 * Ordering: unfinished before finished, then by due date (undated last), then
 * priority, then manual order. Doing this in the store means every view agrees.
 */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    const ad = dateOnly(a.due)
    const bd = dateOnly(b.due)
    if (ad !== bd) {
      if (ad === null) return 1
      if (bd === null) return -1
      if (ad < bd) return -1
      if (ad > bd) return 1
    }
    if (a.priority !== b.priority) return b.priority - a.priority
    if (a.order !== b.order) return a.order - b.order
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// presentation helpers shared by the tools and the HTTP API
// ---------------------------------------------------------------------------

export const SMART_FILTERS = ['today', 'week', 'overdue', 'inbox', 'all', 'done']

/**
 * The projection the UI renders: the raw task plus the display fields it needs.
 *
 * The raw fields win, because `taskView` renders `recurrence` as a human sentence
 * while the editor needs the rule object back. Everything `taskView` adds but the
 * raw task lacks (subtask counts, list name, overdue, due label) survives the
 * merge -- so the browser never has to recompute "is this overdue".
 */
export function taskDisplay(task, store, opts = {}) {
  return { ...taskView(task, store, opts), ...task }
}

/** One task as flat, JSON-safe text data (no live references). */
export function taskView(task, store, opts = {}) {
  const today = opts.today ?? todayStr()
  const children = store.childrenOf(task.id)
  const due = dateOnly(task.due)
  const parent = task.parentId === null ? null : store.get(task.parentId)
  return {
    id: task.id,
    title: task.title,
    note: task.note,
    done: task.done,
    completedAt: task.completedAt,
    priority: task.priority,
    priorityName: priorityName(task.priority),
    listId: task.listId,
    listName: store.listById(task.listId)?.name ?? '收集箱',
    parentId: task.parentId,
    parentTitle: parent === null ? null : parent.title,
    subtaskTotal: children.length,
    subtaskDone: children.filter((c) => c.done).length,
    due: task.due,
    dueLabel: dueLabel(task.due),
    start: task.start,
    overdue: !task.done && due !== null && compareDates(due, today) < 0,
    isToday: due === today,
    tags: [...task.tags],
    recurrence: task.recurrence === null ? null : describeRecurrence(task.recurrence),
    recurrenceRule: task.recurrence === null ? null : { ...task.recurrence },
    completedCount: task.completedCount,
    seriesFinished: task.seriesFinished,
    skipped: [...task.skipped],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * Filter tasks by a smart filter / list / query.
 *
 * Only TOP-LEVEL tasks are returned by default: a subtask is part of its
 * parent's row (and its due date is the parent's business), so counting it as a
 * separate item would double every badge. Pass `includeSubtasks` to get the
 * flat set. A query that matches a subtask keeps its parent, so searching never
 * hides the task the user is looking for.
 */
export function filterTasks(store, opts = {}) {
  const today = opts.today ?? todayStr()
  const weekEnd = addDays(today, 7)
  const query = str(opts.query).trim().toLowerCase()
  const filter = opts.filter ?? 'all'
  const topOnly = opts.includeSubtasks !== true
  // A tag filter is exact (`tag=工作`), while a typed `#工作` in the search box
  // means the same thing: both arrive here as `tag`.
  const tag = str(opts.tag).trim().replace(/^#/, '').toLowerCase()
  // One pass builds the child index the query path used to rebuild for every
  // candidate parent: `childrenOf()` filters the whole task list each call, so a
  // search over N parents cost N full scans of N tasks.
  const childrenByParent = new Map()
  for (const t of store.tasks) {
    if (t.parentId === null) continue
    const bucket = childrenByParent.get(t.parentId)
    if (bucket === undefined) childrenByParent.set(t.parentId, [t])
    else bucket.push(t)
  }
  const hay = (t) => `${t.title} ${t.note} ${t.tags.join(' ')}`.toLowerCase()
  const tagOf = (t) => t.tags.map((x) => x.toLowerCase())

  const out = []
  for (const t of store.tasks) {
    if (topOnly && t.parentId !== null) continue
    // A subtask is part of its parent's row, so the parent answers for the whole
    // row: filtering by `#工作` must not hide a task whose subtask carries it.
    const kids = topOnly ? (childrenByParent.get(t.id) ?? []) : []
    if (tag !== '' && !tagOf(t).includes(tag) && !kids.some((c) => tagOf(c).includes(tag))) continue
    if (filter !== 'done' && t.done && !opts.includeDone) continue
    if (filter === 'done' && !t.done) continue
    const due = dateOnly(t.due)
    if (opts.listId && t.listId !== opts.listId) continue
    if (filter === 'today') {
      if (t.done) continue
      if (due === null || compareDates(due, today) > 0) continue
    }
    if (filter === 'overdue') {
      if (t.done || due === null || compareDates(due, today) >= 0) continue
    }
    if (filter === 'week') {
      // Overdue tasks belong to "this week" as much as today's do: a window that
      // hides the most urgent items is worse than no window at all. This is why
      // `week` and `today` both keep overdue, and `overdue` exists to isolate it.
      if (t.done) continue
      if (due === null) continue
      if (weekEnd !== null && compareDates(due, weekEnd) > 0) continue
    }
    if (filter === 'inbox') {
      if (t.done || due !== null) continue
    }
    if (query) {
      if (!hay(t).includes(query) && !kids.some((c) => hay(c).includes(query))) continue
    }
    out.push(t)
  }
  return sortTasks(out)
}

/** Group tasks the way the list view renders them. */
export function groupTasks(tasks, opts = {}) {
  const today = opts.today ?? todayStr()
  const groups = [
    { key: 'overdue', label: '已逾期', tasks: [] },
    { key: 'today', label: '今天', tasks: [] },
    { key: 'tomorrow', label: '明天', tasks: [] },
    { key: 'week', label: '本周内', tasks: [] },
    { key: 'later', label: '以后', tasks: [] },
    { key: 'none', label: '未安排', tasks: [] },
    { key: 'done', label: '已完成', tasks: [] },
  ]
  const tomorrow = addDays(today, 1)
  const weekEnd = addDays(today, 7)
  for (const t of tasks) {
    const due = dateOnly(t.due)
    let bucket
    if (t.done) bucket = groups[6]
    else if (due === null) bucket = groups[5]
    else if (compareDates(due, today) < 0) bucket = groups[0]
    else if (due === today) bucket = groups[1]
    else if (due === tomorrow) bucket = groups[2]
    else if (weekEnd !== null && compareDates(due, weekEnd) <= 0) bucket = groups[3]
    else bucket = groups[4]
    bucket.tasks.push(t)
  }
  return groups.filter((g) => g.tasks.length > 0)
}

export { diffDays, parseTime, seriesExhausted }

// ---------------------------------------------------------------------------
// view payloads
// ---------------------------------------------------------------------------
//
// The browser half renders; it does not decide. Bucket boundaries, which day a
// repeating task lands on, and whether a bar is overdue are all computed here,
// from the same engine the host used to store the task. A second implementation
// in the browser would drift the moment either side was edited -- and the
// calendar is the view where a wrong date is most visible.

/** The list view: ordered buckets, each holding task ids. */
export function viewGroups(store, opts = {}) {
  const today = opts.today ?? todayStr()
  const tasks = filterTasks(store, { ...opts, today })
  return groupTasks(tasks, { today }).map((g) => ({
    key: g.key,
    label: g.label,
    ids: g.tasks.map((t) => t.id),
    // The bucket carries its own "what would a task added HERE look like" seed.
    // It is view semantics -- which bucket is which -- so it is decided here and
    // shipped as data (strings/booleans/null only), never re-derived in the
    // browser. `addable:false` is the 已完成 group: creating a task that is
    // already done is not a thing the user can mean.
    seed: groupSeed(g.key, today),
  }))
}

/**
 * The board view: one column per list.
 *
 * Selecting a single list narrows the board to that column rather than showing
 * an empty board, which is what a user clicking a list in the sidebar means.
 */
export function boardColumns(store, opts = {}) {
  const today = opts.today ?? todayStr()
  const tasks = filterTasks(store, { ...opts, today })
  const lists = opts.listId ? store.lists.filter((l) => l.id === opts.listId) : store.lists
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
    system: l.system,
    ids: tasks.filter((t) => t.listId === l.id).map((t) => t.id),
    // A card added in this column belongs to this list. There is deliberately no
    // `due` key: a column is a list, not a date bucket, and "no opinion" has to
    // stay distinguishable from the 未安排 group's explicit `due: null`.
    seed: { listId: l.id, addable: true },
  }))
}

/**
 * The calendar view: which tasks belong to which day in a range.
 *
 * A repeating task appears on EVERY occurrence in the range, which is the whole
 * point of keeping the series anchor separate from the standing due date.
 */
export function calendarView(store, opts = {}) {
  const today = opts.today ?? todayStr()
  const from = toDateStr(opts.from) ?? today
  const to = toDateStr(opts.to) ?? from
  const tasks = filterTasks(store, { ...opts, today })
  const days = new Map()
  const occurrences = []
  const unscheduled = []
  const push = (date, id) => {
    if (date === null || date < from || date > to) return
    if (!days.has(date)) days.set(date, [])
    days.get(date).push(id)
  }
  for (const t of tasks) {
    if (t.recurrence !== null) {
      const anchor = dateOnly(t.seriesAnchor ?? t.due)
      if (anchor === null) { unscheduled.push(t.id); continue }
      const dates = expandOccurrences(t.recurrence, anchor, t.due, from, to)
      if (dates.length) occurrences.push({ id: t.id, dates })
      for (const d of dates) push(d, t.id)
    } else {
      const due = dateOnly(t.due)
      if (due === null) unscheduled.push(t.id)
      else push(due, t.id)
    }
  }
  return {
    from,
    to,
    occurrences,
    days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, ids]) => ({ date, ids })),
    unscheduled,
  }
}

/**
 * The gantt view: one bar per schedulable task, over a day range.
 *
 * A task with only a due date is a one-day (milestone) bar; a task with a start
 * date spans start → due. A task with neither cannot be drawn anywhere, so it is
 * reported in `undated` for the view to count instead of silently vanishing.
 */
export function ganttView(store, opts = {}) {
  const today = opts.today ?? todayStr()
  const from = toDateStr(opts.from) ?? addDays(today, -7) ?? today
  const to = toDateStr(opts.to) ?? addDays(today, 30) ?? today
  const tasks = filterTasks(store, { ...opts, today, includeDone: opts.includeDone === true })
  const rows = []
  const undated = []
  for (const t of tasks) {
    const due = dateOnly(t.due)
    const start = dateOnly(t.start)
    if (due === null && start === null) { undated.push(t.id); continue }
    let barStart = start ?? due
    let barEnd = due ?? start
    if (compareDates(barStart, barEnd) > 0) { const swap = barStart; barStart = barEnd; barEnd = swap }
    rows.push({
      id: t.id,
      start: barStart,
      end: barEnd,
      listId: t.listId,
      priority: t.priority,
      milestone: barStart === barEnd,
      recurrence: t.recurrence === null ? null : describeRecurrence(t.recurrence),
      overdue: due !== null && compareDates(due, today) < 0,
      done: t.done,
    })
  }
  rows.sort((a, b) => compareDates(a.start, b.start))
  const occurrences = []
  for (const t of tasks) {
    if (t.recurrence === null) continue
    const anchor = dateOnly(t.seriesAnchor ?? t.due)
    if (anchor === null) continue
    const dates = expandOccurrences(t.recurrence, anchor, t.due, from, to)
    if (dates.length) occurrences.push({ id: t.id, dates })
  }
  return { from, to, rows, undated, occurrences }
}

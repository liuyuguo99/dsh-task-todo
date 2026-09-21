/**
 * dsh-task-todo -- date + recurrence engine (pure, dependency-free, host-side only).
 *
 * Dates are stored as LOCAL calendar strings, never UTC instants:
 *
 *   'YYYY-MM-DD'           all-day task
 *   'YYYY-MM-DDTHH:mm'     timed task
 *
 * That choice is deliberate. A task "due 2026-07-02" means the 2nd of July
 * wherever the user is; converting it through UTC (the usual Date/toISOString
 * round trip) silently moves tasks by a day for anyone east of Greenwich.
 *
 * All arithmetic runs on a UTC day index derived from the calendar fields, so
 * no daylight-saving transition can ever turn "add one day" into 23 or 25 hours.
 *
 * This module is the SINGLE authority for recurrence. The browser half never
 * recomputes a series: it asks the host for the occurrences of a visible range
 * (`occurrences` API). Two implementations of the same calendar rule drift the
 * moment one of them is edited.
 */

const DAY_MS = 86400000

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/
const TIME_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/

/** A frequency's unit in months, used for the generic interval math. */
export const FREQUENCIES = ['daily', 'weekly', 'monthly']

// ---------------------------------------------------------------------------
// calendar primitives
// ---------------------------------------------------------------------------

/** Parse the leading `YYYY-MM-DD` of a stored date/datetime string. */
export function parseDate(value) {
  if (typeof value !== 'string') return null
  const m = DATE_RE.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  // Reject impossible calendar days (2026-02-30) instead of silently rolling over.
  if (d > monthDays(y, mo)) return null
  return { y, m: mo, d }
}

/** `HH:mm` of a timed value, or null for an all-day date. */
export function parseTime(value) {
  if (typeof value !== 'string') return null
  const m = TIME_RE.exec(value)
  return m ? `${m[1]}:${m[2]}` : null
}

/** Render calendar fields back to the stored form. */
export function formatDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Normalise any accepted input to a stored date, or null. */
export function toDateStr(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const p = parseDate(value)
    if (p === null) return null
    const time = parseTime(value)
    return time === null ? formatDate(p.y, p.m, p.d) : `${formatDate(p.y, p.m, p.d)}T${time}`
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value.getFullYear(), value.getMonth() + 1, value.getDate())
  }
  return null
}

/** The date part of a stored value (`YYYY-MM-DD`), or null. */
export function dateOnly(value) {
  const p = parseDate(value)
  return p === null ? null : formatDate(p.y, p.m, p.d)
}

/** Days in a month; month is 1-based. */
export function monthDays(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Days since the epoch for a calendar date -- the basis of all arithmetic. */
export function dayIndex(value) {
  const p = parseDate(value)
  if (p === null) return null
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS)
}

/** Inverse of dayIndex. */
export function fromDayIndex(index) {
  const dt = new Date(index * DAY_MS)
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(value) {
  const idx = dayIndex(value)
  if (idx === null) return null
  return ((idx + 3) % 7 + 7) % 7 + 1
}

/** Whole weeks since the epoch, weeks starting Monday. */
export function weekIndex(value) {
  const idx = dayIndex(value)
  if (idx === null) return null
  const wd = ((idx + 3) % 7 + 7) % 7 + 1
  return Math.floor((idx - (wd - 1)) / 7)
}

/** Months since year 0 -- used for interval math on monthly series. */
export function monthIndex(value) {
  const p = parseDate(value)
  return p === null ? null : p.y * 12 + (p.m - 1)
}

/** Add days to a stored date, preserving any time part. */
export function addDays(value, n) {
  const idx = dayIndex(value)
  if (idx === null) return null
  const out = fromDayIndex(idx + n)
  const time = parseTime(value)
  return time === null ? out : `${out}T${time}`
}

/**
 * Add months, clamping the day to the target month's length.
 *
 * Clamping is what makes a monthly series anchored on the 31st behave: it lands
 * on 2026-02-28 rather than skipping February or spilling into March.
 */
export function addMonths(value, n) {
  const p = parseDate(value)
  if (p === null) return null
  const total = p.y * 12 + (p.m - 1) + n
  const y = Math.floor(total / 12)
  const m = total % 12 + 1
  const d = Math.min(p.d, monthDays(y, m))
  const out = formatDate(y, m, d)
  const time = parseTime(value)
  return time === null ? out : `${out}T${time}`
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a, b) {
  const ia = dayIndex(a)
  const ib = dayIndex(b)
  if (ia === null || ib === null) return null
  return ib - ia
}

/** Compare two stored dates; null sorts last. Returns -1 | 0 | 1. */
export function compareDates(a, b) {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  const sa = String(a)
  const sb = String(b)
  // 'YYYY-MM-DD' < 'YYYY-MM-DDTHH:mm' lexicographically, which is exactly the
  // ordering we want (an all-day task precedes a timed one on the same day).
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Local "today" as `YYYY-MM-DD`. */
export function today(now = new Date()) {
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** Local "now" as `YYYY-MM-DDTHH:mm:ss` (what createdAt/updatedAt store). */
export function nowStamp(now = new Date()) {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return `${today(now)}T${hh}:${mm}:${ss}`
}

/** The Monday (or `weekStart` weekday) starting the week containing `value`. */
export function startOfWeek(value, weekStart = 1) {
  const idx = dayIndex(value)
  if (idx === null) return null
  const wd = ((idx + 3) % 7 + 7) % 7 + 1 // 1..7, Monday-based
  const shift = (wd - weekStart + 7) % 7
  return fromDayIndex(idx - shift)
}

/** Inclusive list of dates from `from` to `to`, capped for safety. */
export function dateRange(from, to, limit = 400) {
  const a = dayIndex(from)
  const b = dayIndex(to)
  if (a === null || b === null || b < a) return []
  const out = []
  for (let i = a; i <= b && out.length < limit; i++) out.push(fromDayIndex(i))
  return out
}

/** Human label for a due value: `07-02` / `07-02 15:00`. */
export function dueLabel(value) {
  const p = parseDate(value)
  if (p === null) return ''
  const time = parseTime(value)
  const base = `${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  return time === null ? base : `${base} ${time}`
}

// ---------------------------------------------------------------------------
// recurrence
// ---------------------------------------------------------------------------

/**
 * Validate and canonicalise a recurrence rule.
 *
 * Returns `{ok: true, value}` with a normalised rule, or `{ok: false, error}`.
 * A rule is always a whole object or null -- never a partial one, because the
 * store, the API and the tools all treat `recurrence != null` as "this task
 * repeats" and a half-built rule would repeat unpredictably.
 */
export function normalizeRecurrence(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: true, value: null }
  }
  const raw = typeof input === 'string' ? { freq: input } : input
  if (typeof raw !== 'object') return { ok: false, error: '重复规则必须是对象' }
  const freq = String(raw.freq ?? raw.frequency ?? '').toLowerCase()
  const aliases = {
    day: 'daily', days: 'daily', daily: 'daily', 每天: 'daily', 每日: 'daily',
    week: 'weekly', weeks: 'weekly', weekly: 'weekly', 每周: 'weekly',
    month: 'monthly', months: 'monthly', monthly: 'monthly', 每月: 'monthly',
  }
  const normalizedFreq = aliases[freq]
  if (normalizedFreq === undefined) {
    return { ok: false, error: `不支持的重复频率：${raw.freq ?? ''}（可用 daily / weekly / monthly）` }
  }
  const interval = Math.trunc(Number(raw.interval ?? 1))
  if (!Number.isFinite(interval) || interval < 1 || interval > 365) {
    return { ok: false, error: '重复间隔必须是 1..365 之间的整数' }
  }
  let weekdays = null
  if (Array.isArray(raw.weekdays) && raw.weekdays.length > 0) {
    const set = new Set()
    for (const w of raw.weekdays) {
      const n = Math.trunc(Number(w))
      if (!Number.isFinite(n) || n < 0 || n > 6) {
        return { ok: false, error: 'weekdays 必须是 0..6（0 = 周日）' }
      }
      set.add(n)
    }
    weekdays = [...set].sort((a, b) => a - b)
  }
  const until = raw.until === null || raw.until === undefined || raw.until === ''
    ? null
    : toDateStr(raw.until)
  if (raw.until !== null && raw.until !== undefined && raw.until !== '' && until === null) {
    return { ok: false, error: 'until 必须是 YYYY-MM-DD' }
  }
  let count = null
  if (raw.count !== null && raw.count !== undefined && raw.count !== '') {
    const n = Math.trunc(Number(raw.count))
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      return { ok: false, error: 'count 必须是正整数' }
    }
    count = n
  }
  return {
    ok: true,
    value: {
      freq: normalizedFreq,
      interval,
      // Weekday selection is meaningless for daily/monthly; drop it rather than
      // storing a field the engine will ignore (it would lie in the UI).
      weekdays: normalizedFreq === 'weekly'
        ? (weekdays ?? null)
        : null,
      until,
      count,
      // Set only when a bounded series has run out; not part of the user's rule
      // but persisted next to it so the UI can explain "已结束".
      finished: raw.finished === true,
    },
  }
}

/** Chinese summary of a rule, used by tools and the UI. */
export function describeRecurrence(rec) {
  if (rec === null || rec === undefined) return '不重复'
  const n = Number(rec.interval ?? 1)
  const unit = rec.freq === 'daily' ? '天' : rec.freq === 'weekly' ? '周' : '个月'
  let text = n === 1
    ? (rec.freq === 'daily' ? '每天' : rec.freq === 'weekly' ? '每周' : '每月')
    : `每 ${n} ${unit}`
  if (rec.freq === 'weekly' && Array.isArray(rec.weekdays) && rec.weekdays.length > 0) {
    const names = ['日', '一', '二', '三', '四', '五', '六']
    text += ' ' + rec.weekdays.map((w) => `周${names[w]}`).join('、')
  }
  if (rec.until) text += `，直到 ${rec.until}`
  else if (rec.count) text += `，共 ${rec.count} 次`
  if (rec.finished === true) text += '（已结束）'
  return text
}

/**
 * The frequency's step in its own unit -- the piece a series is anchored on.
 * `anchor` is the task's due value; `weekdays` resolves the weekly case.
 */
function stepUnit(rec) {
  return rec.freq === 'daily' ? 'day' : rec.freq === 'weekly' ? 'week' : 'month'
}

/** Every `interval` units between the anchor and `candidate`, and not before it. */
function inSeries(rec, anchorDate, candidate) {
  const unit = stepUnit(rec)
  const interval = Number(rec.interval ?? 1)
  if (compareDates(candidate, anchorDate) < 0) return false
  if (unit === 'day') {
    const n = diffDays(anchorDate, candidate)
    return n !== null && n % interval === 0
  }
  if (unit === 'week') {
    if (diffDays(anchorDate, candidate) === 0) return true
    const wa = weekIndex(anchorDate)
    const wc = weekIndex(candidate)
    if (wa === null || wc === null) return false
    if ((wc - wa) % interval !== 0) return false
    // Same week as the anchor: only the anchor's own weekday qualifies unless
    // the rule names weekdays, which the caller checks separately.
    return true
  }
  const ma = monthIndex(anchorDate)
  const mc = monthIndex(candidate)
  if (ma === null || mc === null) return false
  if ((mc - ma) % interval !== 0) return false
  const p = parseDate(anchorDate)
  const c = parseDate(candidate)
  return c.d === Math.min(p.d, monthDays(c.y, c.m))
}

/**
 * Is `date` an occurrence of the series anchored at `anchorDate`?
 *
 * `count` cannot be decided from the date alone (it depends on how many
 * occurrences have already been completed), so it is checked by the caller
 * through `seriesExhausted`.
 */
export function isOccurrence(rec, anchorDate, date) {
  if (rec === null || rec === undefined) return false
  const a = dateOnly(anchorDate)
  const c = dateOnly(date)
  if (a === null || c === null) return false
  if (rec.until !== null && rec.until !== undefined && compareDates(c, rec.until) > 0) return false
  if (!inSeries(rec, a, c)) return false
  if (rec.freq === 'weekly') {
    // Weekdays use the JavaScript convention (0 = Sunday .. 6 = Saturday), which
    // is also what the quick-add parser produces. `isoWeekday` is 1..7 with
    // Monday first, so `% 7` maps Sunday's 7 onto 0.
    const weekdays = Array.isArray(rec.weekdays) && rec.weekdays.length > 0
      ? rec.weekdays
      : [(isoWeekday(a) ?? 1) % 7]
    const wd = (isoWeekday(c) ?? 1) % 7
    return weekdays.includes(wd)
  }
  return true
}

/**
 * The next occurrence strictly after `after`, starting the search at `from`.
 * Returns null when the series is finished (past `until`, or `limit` reached).
 */
export function nextOccurrence(rec, anchorDate, after, limit = 4000) {
  if (rec === null || rec === undefined) return null
  const a = dateOnly(anchorDate)
  if (a === null) return null
  // The series begins at its anchor: anything asked for before the anchor gets
  // the anchor itself, which is the first occurrence after it.
  if (compareDates(a, after) > 0) return a
  if (rec.freq === 'daily') {
    // Straight arithmetic: no need to walk day by day.
    const interval = rec.interval ?? 1
    const gap = diffDays(a, after)
    if (gap === null) return null
    let steps = Math.floor(gap / interval) + 1
    let candidate = addDays(a, steps * interval)
    while (candidate !== null && compareDates(candidate, after) <= 0) {
      steps += 1
      candidate = addDays(a, steps * interval)
    }
    if (candidate === null) return null
    return rec.until && compareDates(candidate, rec.until) > 0 ? null : dateOnly(candidate)
  }
  // Weekly and monthly series are walked forward FROM THE ANCHOR, never from the
  // previous candidate. Stepping a monthly series by adding one month to the
  // previous result is a trap: a rule anchored on the 31st clamps to the 28th in
  // February, and every later step would then inherit the 28th and stop matching
  // the anchor's day entirely (the series silently skips the rest of the year).
  for (let k = 1; k <= limit; k++) {
    const candidate = rec.freq === 'weekly' ? addDays(a, k) : addMonths(a, k)
    if (candidate === null) return null
    if (compareDates(candidate, after) <= 0) continue
    if (isOccurrence(rec, a, candidate)) return dateOnly(candidate)
    if (rec.until && compareDates(candidate, rec.until) > 0) return null
    // Monthly rules must not walk forever past a far-future `until`.
    if (rec.freq === 'monthly' && (diffDays(a, candidate) ?? 0) > 366 * 20) return null
  }
  return null
}

/**
 * Where a repeating task's due date lands after the user completes it.
 *
 * `anchorDate` is the series' fixed phase (the date the rule was set on) and
 * `standing` is the occurrence currently on the board; the result is the first
 * occurrence strictly after both the standing due date and today. Completing a
 * daily task three days late therefore lands tomorrow rather than scheduling
 * three catch-up instances, which is how a paper checklist behaves.
 *
 * Keeping the anchor separate from the standing date is what protects a rule
 * like "每月 31 日": February clamps to the 28th, but the next occurrence is
 * still computed from the 31st, so March comes back as the 31st rather than the
 * whole series silently sliding to the 28th.
 */
export function nextDueOnComplete(rec, anchorDate, standing, todayStr) {
  if (rec === null || rec === undefined) return null
  const a = dateOnly(anchorDate)
  if (a === null) return null
  const floor = compareDates(standing, todayStr) > 0 ? standing : todayStr
  // `count` is a whole-series budget checked by the caller, not a per-step bound.
  return nextOccurrence({ ...rec, count: null }, a, floor)
}

/**
 * Whether a bounded series has run out.
 *
 * `count` is the total number of occurrences the series is allowed; the number
 * already recorded lives on the task (`completedCount`).
 */
export function seriesExhausted(rec, task) {
  if (rec === null || rec === undefined) return false
  if (rec.finished === true) return true
  if (rec.until) {
    const due = dateOnly(task?.due ?? null)
    if (due !== null && compareDates(due, rec.until) > 0) return true
  }
  if (rec.count) {
    const done = Number(task?.completedCount ?? 0)
    if (done >= rec.count) return true
  }
  return false
}

/**
 * Every occurrence of the series inside `[from, to]`, for the calendar and
 * gantt views. Returns bare `YYYY-MM-DD` strings.
 *
 * `standing` is the series' current due date: an occurrence that already
 * happened and has not been completed is still shown on the day it was due, so
 * an overdue repeating task stays visible instead of silently disappearing.
 */
export function expandOccurrences(rec, anchorDate, standing, from, to, limit = 200) {
  if (rec === null || rec === undefined) return []
  const a = dateOnly(anchorDate)
  if (a === null) return []
  const out = []
  const push = (d) => { if (d !== null && !out.includes(d) && out.length < limit) out.push(d) }
  if (compareDates(a, from) >= 0) push(a)
  let cursor = a
  for (let i = 0; i < limit * 2 + 8; i++) {
    const next = nextOccurrence(rec, a, cursor)
    if (next === null) break
    cursor = next
    if (compareDates(cursor, to) > 0) break
    if (compareDates(cursor, from) >= 0) push(cursor)
  }
  const standingDate = dateOnly(standing ?? null)
  if (standingDate !== null && compareDates(standingDate, from) >= 0 && compareDates(standingDate, to) <= 0) {
    push(standingDate)
  }
  return out.sort(compareDates)
}

/** Whether a rule already produced its last date (nothing left to schedule). */
export function isDeadSeries(rec, task, todayStr) {
  if (rec === null || rec === undefined) return false
  if (seriesExhausted(rec, task)) return true
  const due = dateOnly(task?.due ?? null)
  if (due === null) return false
  return nextOccurrence(rec, due, todayStr) === null
}

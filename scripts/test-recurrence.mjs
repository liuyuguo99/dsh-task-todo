// Recurrence engine + quick-add parser: the two pieces of pure logic that decide
// what a task's date IS. Both are asserted against fixed calendars, never
// against "today", so they cannot start passing/failing with the clock.
import {
  addDays, addMonths, compareDates, dateOnly, dayIndex, describeRecurrence,
  expandOccurrences, isoWeekday, monthDays, nextDueOnComplete, nextOccurrence,
  normalizeRecurrence, seriesExhausted, startOfWeek, today, weekIndex,
} from '../lib/recurrence.js'
// The user-facing parser lives with the store (it needs list lookup semantics),
// so it is imported from there and asserted here.
import { parseQuickAdd } from '../lib/store.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const rec = (spec) => {
  const r = normalizeRecurrence(spec)
  if (!r.ok) throw new Error('test rule rejected: ' + r.error)
  return r.value
}

console.log('--- calendar primitives ---')
eq('month lengths', [monthDays(2026, 1), monthDays(2026, 2), monthDays(2024, 2), monthDays(2026, 4)], [31, 28, 29, 30])
eq('addDays across a month end', addDays('2026-01-30', 3), '2026-02-02')
eq('addDays keeps the time part', addDays('2026-01-30T09:30', 2), '2026-02-01T09:30')
eq('addMonths clamps 31 → 28', addMonths('2026-01-31', 1), '2026-02-28')
eq('addMonths clamps back up', addMonths('2026-02-28', 1), '2026-03-28')
eq('addMonths from the anchor keeps the 31st', addMonths('2026-01-31', 2), '2026-03-31')
eq('addMonths across a year', addMonths('2026-11-15', 3), '2027-02-15')
eq('dayIndex round trip', dateOnly(addDays('2026-03-01', -1)), '2026-02-28')
ok('2026-07-01 is a Wednesday', isoWeekday('2026-07-01') === 3, isoWeekday('2026-07-01'))
eq('weekIndex is stable inside a week', weekIndex('2026-07-06') - weekIndex('2026-07-12'), 0)
eq('startOfWeek (Monday)', startOfWeek('2026-07-01', 1), '2026-06-29')
eq('startOfWeek (Sunday)', startOfWeek('2026-07-01', 0), '2026-06-28')
ok('compareDates puts an all-day task before a timed one', compareDates('2026-07-01', '2026-07-01T09:00') < 0)
ok('compareDates sorts null last', compareDates(null, '2026-07-01') > 0)
ok('today() is a calendar date', /^\d{4}-\d{2}-\d{2}$/.test(today()))

console.log('--- rule validation ---')
ok('empty rule is null', normalizeRecurrence(undefined).value === null)
ok('frequency aliases', normalizeRecurrence({ freq: '每日' }).value.freq === 'daily')
ok('interval defaults to 1', rec({ freq: 'daily' }).interval === 1)
ok('weekly keeps weekdays', rec({ freq: 'weekly', weekdays: [5, 1, 1] }).weekdays.join() === '1,5')
ok('weekdays are dropped for daily', rec({ freq: 'daily', weekdays: [1] }).weekdays === null)
ok('bad frequency is rejected', normalizeRecurrence({ freq: 'hourly' }).ok === false)
ok('interval 0 is rejected', normalizeRecurrence({ freq: 'daily', interval: 0 }).ok === false)
ok('weekday 7 is rejected', normalizeRecurrence({ freq: 'weekly', weekdays: [7] }).ok === false)
eq('describeRecurrence daily', describeRecurrence(rec({ freq: 'daily' })), '每天')
eq('describeRecurrence every 2 weeks', describeRecurrence(rec({ freq: 'weekly', interval: 2 })), '每 2 周')
eq('describeRecurrence weekly days', describeRecurrence(rec({ freq: 'weekly', weekdays: [1, 3, 5] })), '每周 周一、周三、周五')
eq('describeRecurrence bounded', describeRecurrence(rec({ freq: 'daily', count: 3 })), '每天，共 3 次')

console.log('--- daily series ---')
const daily = rec({ freq: 'daily' })
eq('next after the anchor', nextOccurrence(daily, '2026-07-01', '2026-07-01'), '2026-07-02')
eq('next is the anchor when asked before the series', nextOccurrence(daily, '2026-07-01', '2026-06-20'), '2026-07-01')
eq('asking far ahead stays on stride', nextOccurrence(daily, '2026-07-01', '2026-07-30'), '2026-07-31')
const every3 = rec({ freq: 'daily', interval: 3 })
eq('every 3 days keeps phase', nextOccurrence(every3, '2026-07-01', '2026-07-08'), '2026-07-10')
eq('completing on time rolls one interval', nextDueOnComplete(every3, '2026-07-01', '2026-07-01', '2026-07-01'), '2026-07-04')
eq('completing 4 days late rolls forward, not three catch-ups',
  nextDueOnComplete(every3, '2026-07-01', '2026-07-01', '2026-07-05'), '2026-07-07')
const untilRec = rec({ freq: 'daily', until: '2026-07-03' })
eq('until is inclusive', nextOccurrence(untilRec, '2026-07-01', '2026-07-02'), '2026-07-03')
ok('until ends the series', nextOccurrence(untilRec, '2026-07-01', '2026-07-03') === null)

console.log('--- weekly series (0 = Sunday, JS convention) ---')
const monWedFri = rec({ freq: 'weekly', weekdays: [1, 3, 5] })
// 2026-07-01 is a Wednesday, so the next Mon/Wed/Fri occurrences are the 3rd, 6th, 8th.
eq('after a Wednesday', nextOccurrence(monWedFri, '2026-07-01', '2026-07-01'), '2026-07-03')
eq('skips the weekend', nextOccurrence(monWedFri, '2026-07-01', '2026-07-03'), '2026-07-06')
const sunday = rec({ freq: 'weekly', weekdays: [0] })
eq('Sunday-only rule', nextOccurrence(sunday, '2026-07-01', '2026-07-01'), '2026-07-05')
const fortnight = rec({ freq: 'weekly', interval: 2 })
eq('every 2 weeks keeps the weekday', nextOccurrence(fortnight, '2026-07-01', '2026-07-01'), '2026-07-15')
eq('every 2 weeks from completion', nextDueOnComplete(fortnight, '2026-07-01', '2026-07-01', '2026-07-01'), '2026-07-15')

console.log('--- monthly series (the 31st must not degrade) ---')
const monthly = rec({ freq: 'monthly' })
eq('31st clamps into February', nextOccurrence(monthly, '2026-01-31', '2026-01-31'), '2026-02-28')
eq('and returns to the 31st in March', nextOccurrence(monthly, '2026-01-31', '2026-02-28'), '2026-03-31')
eq('through the 30-day months', [
  nextOccurrence(monthly, '2026-01-31', '2026-03-31'),
  nextOccurrence(monthly, '2026-01-31', '2026-04-30'),
  nextOccurrence(monthly, '2026-01-31', '2026-05-31'),
], ['2026-04-30', '2026-05-31', '2026-06-30'])
const quarterly = rec({ freq: 'monthly', interval: 3 })
eq('quarterly occurrences', expandOccurrences(quarterly, '2026-01-15', '2026-01-15', '2026-01-01', '2026-12-31'),
  ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])
eq('completing late still lands on the anchor day',
  nextDueOnComplete(monthly, '2026-01-31', '2026-01-31', '2026-03-05'), '2026-03-31')

console.log('--- series expansion (calendar / gantt input) ---')
eq('expandOccurrences is inclusive and ordered',
  expandOccurrences(rec({ freq: 'daily' }), '2026-07-01', '2026-07-01', '2026-07-01', '2026-07-04'),
  ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'])
eq('an overdue standing occurrence is kept visible',
  expandOccurrences(rec({ freq: 'daily' }), '2026-06-20', '2026-06-20', '2026-06-25', '2026-06-27'),
  ['2026-06-25', '2026-06-26', '2026-06-27'])
const capped = expandOccurrences(rec({ freq: 'daily' }), '2026-01-01', '2026-01-01', '2020-01-01', '2030-01-01', 50)
ok('expansion is capped', capped.length <= 50, capped.length)

console.log('--- series exhaustion ---')
ok('count bound is honoured', seriesExhausted(rec({ freq: 'daily', count: 3 }), { completedCount: 3, due: '2026-07-01' }) === true)
ok('count bound is not premature', seriesExhausted(rec({ freq: 'daily', count: 3 }), { completedCount: 2, due: '2026-07-01' }) === false)
ok('past-until is exhausted', seriesExhausted(rec({ freq: 'daily', until: '2026-07-01' }), { completedCount: 0, due: '2026-07-05' }) === true)

console.log('--- quick add: Chinese shorthand ---')
const T = '2026-09-17' // a Thursday
const qa = (text) => parseQuickAdd(text, { today: T })
const qa2 = (text) => parseQuickAdd(text, { today: T })
eq('relative day + time + priority + list + tag', (() => {
  const r = qa('明天 15:00 交报告 !高 #工作 @紧要')
  return { t: r.title, due: r.due, p: r.priority, tags: r.tags, list: r.listName }
})(), { t: '交报告', due: '2026-09-18T15:00', p: 3, tags: ['紧要'], list: '工作' })
eq('every-day rule', (() => { const r = qa('每天 8:00 吃药'); return { t: r.title, due: r.due, freq: r.recurrence.freq } })(),
  { t: '吃药', due: '2026-09-17T08:00', freq: 'daily' })
eq('weekday list rule', (() => { const r = qa('每周一三五 晨跑'); return { t: r.title, wd: r.recurrence.weekdays } })(),
  { t: '晨跑', wd: [1, 3, 5] })
eq('monthly on a day number', (() => {
  const r = qa('每月5日 交房租 #个人')
  return { t: r.title, due: r.due, freq: r.recurrence.freq, list: r.listName }
})(), { t: '交房租', due: '2026-10-05', freq: 'monthly', list: '个人' })
eq('monthly day still ahead this month', qa('每月20日 对账').due, '2026-09-20')
eq('afternoon marker', qa('下午3点 打电话').due, '2026-09-17T15:00')
eq('noon marker', qa('中午12点 吃饭').due, '2026-09-17T12:00')
eq('absolute date', qa('2026-12-25 圣诞').due, '2026-12-25')
eq('month/day rolls to next year when past', qa('3月5日 报名').due, '2027-03-05')
eq('this month, still ahead', qa('9月30日 结算').due, '2026-09-30')
eq('next weekday', qa('下周三 述职').due, '2026-09-23')
eq('bare weekday means the coming one', qa('周三 述职').due, '2026-09-23')
eq('N days later', qa('3天后 复查').due, '2026-09-20')
eq('every 3 days', (() => { const r = qa('每3天 浇花'); return { t: r.title, n: r.recurrence.interval, f: r.recurrence.freq } })(),
  { t: '浇花', n: 3, f: 'daily' })
eq('priority by number', qa('写周报 !2').priority, 2)
eq('plain text is untouched', (() => { const r = qa('买牛奶'); return { t: r.title, due: r.due, rec: r.recurrence } })(),
  { t: '买牛奶', due: null, rec: null })
eq('a bare number is not a date', qa('提交 3 份材料').title, '提交 3 份材料')
eq('the store parser agrees with the engine parser', qa2('明天 15:00 交报告 !高').due, '2026-09-18T15:00')
eq('matched tokens are reported', qa('明天 交报告 !高').matched.includes('明天'), true)

console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)

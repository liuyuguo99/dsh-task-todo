// The data model: persistence, subtrees, completion semantics (including the
// repeating-task roll-over), lists, filters and grouping. Runs against a real
// temporary file, so the atomic write and the reload path are exercised too.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LIST_PALETTE, TodoStore, filterTasks, groupTasks, normalizeTask,
  parseQuickAdd, priorityName, sortTasks, taskView, boardColumns, calendarView,
  ganttView, viewGroups,
} from '../lib/store.js'
import { normalizeRecurrence, today as todayStr } from '../lib/recurrence.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const T = '2026-09-17'
// Workspace-local scratch space (see test-json-gate.mjs).
const dir = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.tmp-store-'))
const file = path.join(dir, 'tasks.json')
const open = () => new TodoStore({ dataFile: file }).load()
let store = open()

console.log('--- first run ---')
ok('creates the data file', fs.existsSync(file))
eq('starts with the inbox only', store.lists.map((l) => l.name), ['收集箱'])
ok('inbox is a system list', store.lists[0].system === true)

console.log('--- create / read ---')
const report = store.create({ title: '交季度报告', due: '2026-09-20', priority: 3, tags: ['工作', '工作', '报告'], note: '先拉数据' })
ok('id is generated', /^t_/.test(report.id), report.id)
eq('tags are de-duplicated', report.tags, ['工作', '报告'])
eq('order starts at 0', report.order, 0)
// A due date, because a task created without one is now dated today, and this
// fixture is about sibling order rather than about the default.
const second = store.create({ title: '买牛奶', due: '2026-09-22' })
eq('sibling order increments', second.order, 1)
eq('default list is the inbox', second.listId, 'l_inbox')
eq('all() is parent-first', store.all().map((t) => t.title), ['交季度报告', '买牛奶'])
ok('get() returns the task', store.get(report.id).title === '交季度报告')
ok('get() of a stranger is null', store.get('t_nope') === null)

console.log('--- subtasks ---')
const s1 = store.addSubtask(report.id, { title: '拉数据' })
const s2 = store.addSubtask(report.id, { title: '画图' })
eq('subtask inherits the parent list', s1.listId, report.listId)
store.update(s2.id, { note: '备注：柱状图' })
ok('a subtask can carry its own note', store.get(s2.id).note === '备注：柱状图')
eq('childrenOf returns both', store.childrenOf(report.id).map((t) => t.title), ['拉数据', '画图'])
eq('subtree is depth first', store.subtree(report.id).map((t) => t.title), ['交季度报告', '拉数据', '画图'])
ok('a cycle is refused', (() => {
  try { store.update(report.id, { parentId: s1.id }); return false } catch { return true }
})())
ok('a missing parent is refused', (() => {
  try { store.update(report.id, { parentId: 't_nope' }); return false } catch { return true }
})())

console.log('--- completion ---')
const done = store.toggle(report.id)
ok('one-shot task becomes done', done.done === true)
ok('completedAt is stamped', typeof done.completedAt === 'string' && done.completedAt.length > 10)
ok('subtasks are NOT auto-completed', store.childrenOf(report.id).every((c) => !c.done))
ok('un-completing clears the stamp', store.toggle(report.id).completedAt === null)
store.toggle(report.id)

console.log('--- repeating tasks roll instead of completing ---')
const daily = store.create({ title: '每日站会', due: '2026-09-10', recurrence: { freq: 'daily' } })
const rolledOnce = store.toggle(daily.id, { today: T })
ok('a repeating task stays open', rolledOnce.done === false)
eq('it rolls to the next occurrence', rolledOnce.due, '2026-09-18')
eq('completions are counted', rolledOnce.completedCount, 1)
eq('history records the occurrence', rolledOnce.history.map((h) => h.due), ['2026-09-10'])
ok('the series anchor is untouched', rolledOnce.seriesAnchor === '2026-09-10')

const monthly = store.create({ title: '月度对账', due: '2026-01-31', recurrence: { freq: 'monthly' } })
store.toggle(monthly.id, { today: '2026-01-31' })
eq('February clamps', store.get(monthly.id).due, '2026-02-28')
store.toggle(monthly.id, { today: '2026-02-28' })
eq('March returns to the 31st (anchor preserved)', store.get(monthly.id).due, '2026-03-31')

// Sub-checklists belong to one occurrence, not to the series.
const checklist = store.create({ title: '每周复盘', due: '2026-09-14', recurrence: { freq: 'weekly' } })
const c1 = store.addSubtask(checklist.id, { title: '看数据' })
store.toggle(c1.id)
ok('subtask is done before the roll', store.get(c1.id).done === true)
store.toggle(checklist.id, { today: '2026-09-14' })
ok('the roll resets subtasks', store.get(c1.id).done === false)

const bounded = store.create({ title: '连续三天', due: '2026-09-17', recurrence: { freq: 'daily', count: 2 } })
store.toggle(bounded.id, { today: '2026-09-17' })
ok('count 2, first completion stays open', store.get(bounded.id).done === false)
const finish = store.toggle(bounded.id, { today: '2026-09-18' })
ok('count 2, second completion finishes the series', finish.done === true)
ok('seriesFinished is recorded', finish.seriesFinished === true)

const untilTask = store.create({ title: '到月底', due: '2026-09-29', recurrence: { freq: 'daily', until: '2026-09-30' } })
const lastOne = store.toggle(untilTask.id, { today: '2026-09-29' })
eq('within until it rolls', lastOne.due, '2026-09-30')
const afterUntil = store.toggle(untilTask.id, { today: '2026-09-30' })
ok('past until the series ends', afterUntil.done === true && afterUntil.seriesFinished === true)

console.log('--- skipping an occurrence ---')
const skippable = store.create({ title: '每日晨跑', due: '2026-09-17', recurrence: { freq: 'daily' } })
const skipped = store.skipOccurrence(skippable.id, { today: '2026-09-17' })
eq('skip advances the due date', skipped.due, '2026-09-18')
eq('skip is recorded', skipped.skipped, ['2026-09-17'])
ok('skip does not complete', skipped.done === false && skipped.completedCount === 0)
ok('skipping a non-repeating task is refused', (() => {
  try { store.skipOccurrence(second.id); return false } catch { return true }
})())

console.log('--- update ---')
const target = store.create({ title: '临时任务', due: '2026-09-20' })
store.update(target.id, { title: '改名任务', note: '备注', priority: 2, tags: ['a'] })
const updated = store.get(target.id)
eq('fields update together', [updated.title, updated.note, updated.priority, updated.tags], ['改名任务', '备注', 2, ['a']])
ok('an empty title is refused', (() => {
  try { store.update(target.id, { title: '   ' }); return false } catch { return true }
})())
store.update(target.id, { due: null })
ok('due can be cleared', store.get(target.id).due === null)
store.update(target.id, { done: true })
ok('done through update() still completes', store.get(target.id).done === true)
store.update(target.id, { done: false })
ok('and can be undone', store.get(target.id).done === false)

console.log('--- lists ---')
const work = store.createList({ name: '工作', color: '#ff8800' })
eq('list is created', work.name, '工作')
ok('duplicate list names are refused', (() => {
  try { store.createList({ name: '工作' }); return false } catch { return true }
})())
const moveme = store.create({ title: '开会', listId: work.id })
const sub = store.addSubtask(moveme.id, { title: '准备材料' })
store.move(moveme.id, { listId: store.lists[0].id })
eq('moving a task carries its subtasks', store.get(sub.id).listId, store.get(moveme.id).listId)
store.updateList(work.id, { name: '工作台' })
eq('list rename works', store.listById(work.id).name, '工作台')
ok('the system inbox cannot be deleted', (() => {
  try { store.removeList('l_inbox'); return false } catch { return true }
})())
const doomed = store.createList({ name: '临时清单' })
const orphan = store.create({ title: '孤儿任务', listId: doomed.id })
const removal = store.removeList(doomed.id)
eq('deleting a list moves its tasks to the inbox', store.get(orphan.id).listId, removal.movedTo)
ok('and reports the move', removal.moved === 1)
eq('and names where they went', removal.movedToName, '收集箱')

console.log('--- list colour and order ---')
const fresh = store.createList({ name: '有颜色' })
ok('a new list is not the fallback grey', fresh.color !== '#8a8f98', fresh.color)
ok('a new list takes the next palette colour',
  fresh.color === LIST_PALETTE[store.lists.filter((l) => !l.system).length - 1], fresh.color)
eq('the previewed colour is the one it gets', store.nextListColor(),
  LIST_PALETTE[store.lists.filter((l) => !l.system).length % LIST_PALETTE.length])
eq('an explicit colour still wins', store.createList({ name: '指定色', color: '#123456' }).color, '#123456')

const orderNow = () => store.lists.map((l) => l.name)
const headList = store.lists[0]
const nextList = store.lists[1]
store.moveList(nextList.id, { index: 0 })
eq('moving a list to the front reorders the sequence', orderNow().slice(0, 2), [nextList.name, headList.name])
eq('the order column is renumbered 0..n-1', store.lists.map((l) => l.order),
  store.lists.map((_, i) => i))
store.moveList(nextList.id, { index: 99 })
eq('an out-of-range index is clamped to the last position', orderNow().at(-1), nextList.name)
store.moveList(nextList.id, { index: -5 })
eq('a negative index is clamped to the first position', orderNow()[0], nextList.name)
ok('moving an unknown list is refused', (() => {
  try { store.moveList('l_missing', { index: 0 }); return false } catch { return true }
})())
ok('a list cannot be renamed onto another list\'s name', (() => {
  try { store.updateList(fresh.id, { name: store.lists[0].name }); return false } catch { return true }
})())
eq('renaming a list to its own name is allowed',
  store.updateList(fresh.id, { name: fresh.name }).name, fresh.name)
const colourBefore = fresh.color
eq('a bad colour is ignored, not stored',
  store.updateList(fresh.id, { color: 'red' }).color, colourBefore)
ok('and really was not stored', store.listById(fresh.id).color === colourBefore)

// The position of the inbox is a preference; where an unassigned task lands is a
// contract. Reordering must not silently change the second one.
const inbox = store.listById('l_inbox')
store.moveList(inbox.id, { index: store.lists.length - 1 })
ok('the inbox is no longer first', store.lists[0].id !== 'l_inbox', orderNow())
eq('an unassigned task still lands in the inbox',
  store.create({ title: '不带清单' }).listId, 'l_inbox')
store.updateList(inbox.id, { name: '收件夹' })
const doomedRenamed = store.createList({ name: '待删' })
const strayTask = store.create({ title: '落在待删里', listId: doomedRenamed.id })
const renamedRemoval = store.removeList(doomedRenamed.id)
eq('deletion still finds the inbox after it was renamed', renamedRemoval.movedTo, 'l_inbox')
eq('and reports the new name', renamedRemoval.movedToName, '收件夹')
eq('the stray task moved there', store.get(strayTask.id).listId, 'l_inbox')
store.updateList(inbox.id, { name: '收集箱' })
store.moveList(inbox.id, { index: 0 })

console.log('--- delete ---')
const withKids = store.create({ title: '要被删的' })
const kidA = store.addSubtask(withKids.id, { title: '子1' })
const kidB = store.addSubtask(kidA.id, { title: '孙1' })
const removed = store.remove(withKids.id)
eq('the whole subtree goes', removed.deleted, 3)
ok('and is really gone', store.get(kidB.id) === null)

console.log('--- quick add through the store ---')
const quick = store.quickAdd('明天 15:00 交周报 !高 #新清单 @紧要', { today: T })
eq('title/due/priority parsed', [quick.task.title, quick.task.due, quick.task.priority], ['交周报', '2026-09-18T15:00', 3])
ok('a missing list is created', quick.listCreated === true && store.listByname('新清单') !== null)
ok('an existing list is reused', store.quickAdd('#新清单 再一条', { today: T }).listCreated === false)
ok('an empty title is refused', (() => {
  try { store.quickAdd('!高', { today: T }); return false } catch { return true }
})())

console.log('--- the inline "+" seed: what the group/column says vs what was typed ---')
// The seed is how the inline add says "this one goes in MY bucket". Three cases
// matter, and the difference between the last two is the whole reason the seed
// is a separate plan rather than a default: `undefined` is "no opinion" (the task
// keeps the create default) and `null` is "explicitly unscheduled".
const seedStore = new TodoStore({ dataFile: path.join(dir, 'seed.json') }).load()
const seeded = seedStore.quickAdd('记一笔', { today: T, due: '2026-09-25' })
eq('a seeded due date is used when the text has none', seeded.task.due, '2026-09-25')
const textWins = seedStore.quickAdd('明天 记一笔', { today: T, due: '2026-09-25' })
eq('but the text always wins over the seed', textWins.task.due, '2026-09-18')
const explicitNull = seedStore.quickAdd('记一笔', { today: T, due: null })
eq('an explicit null seed means unscheduled', explicitNull.task.due, null)
const noOpinion = seedStore.quickAdd('记一笔', { today: T })
ok('no seed at all keeps the create default (a task created now is due now)',
  typeof noOpinion.task.due === 'string' && noOpinion.task.due.includes('T'), noOpinion.task.due)
const otherList = seedStore.createList({ name: '工作' })
const seedList = seedStore.quickAdd('记一笔', { today: T, listId: otherList.id })
eq('a seeded list is honoured', seedList.task.listId, otherList.id)
ok('and it did not create a list', seedList.listCreated === false)
// A seeded list plus a `#name` in the text: the text names the list, so the text
// wins there too -- otherwise the box would fight the person typing in it.
const textListWins = seedStore.quickAdd('#另一个 记一笔', { today: T, listId: otherList.id })
eq('a list named in the text beats the seeded list',
  seedStore.lists.find((l) => l.id === textListWins.task.listId)?.name, '另一个')

console.log('--- the group/column seed the host hands the client ---')
// Its own store: the groups are only emitted when they have something in them, so
// the seed assertions need one task in each bucket they talk about.
const gstore = new TodoStore({ dataFile: path.join(dir, 'gseeds.json') }).load()
gstore.create({ title: '逾期', due: '2026-09-16' })
gstore.create({ title: '今天', due: T })
gstore.create({ title: '无期', due: null })
const gdone = gstore.create({ title: '完成', due: T })
gstore.toggle(gdone.id, { today: T })
const gseeds = viewGroups(gstore, { filter: 'all', today: T })
eq('every group carries a seed', gseeds.every((g) => g.seed !== undefined), true)
const overdueSeed = gseeds.find((g) => g.key === 'overdue')?.seed
eq('the overdue group seeds yesterday', overdueSeed?.due, '2026-09-16')
eq('the overdue group can be added to', overdueSeed?.addable, true)
eq('the today group seeds today', gseeds.find((g) => g.key === 'today')?.seed.due, T)
eq('the 未安排 group seeds an explicit null', gseeds.find((g) => g.key === 'none')?.seed.due, null)
const dseeds = viewGroups(gstore, { filter: 'done', today: T })
eq('the 已完成 group cannot be added to', dseeds.find((g) => g.key === 'done')?.seed.addable, false)
const cseeds = boardColumns(gstore, { today: T })
eq('a board column seeds its own list', cseeds.every((c) => c.seed.listId === c.id), true)
eq('and expresses no opinion about the date',
  cseeds.every((c) => Object.prototype.hasOwnProperty.call(c.seed, 'due') === false), true)

console.log('--- filters and grouping ---')
const fstore = new TodoStore({ dataFile: path.join(dir, 'filters.json') }).load()
fstore.create({ title: '今天到期', due: T })
fstore.create({ title: '昨天逾期', due: '2026-09-16' })
fstore.create({ title: '本周内', due: '2026-09-20' })
fstore.create({ title: '下个月', due: '2026-10-20' })
// `due: null` is now the only way to say "no date at all": a task created without
// one is dated today, which is the default the other fixtures rely on.
fstore.create({ title: '没有日期', due: null })
const parentF = fstore.create({ title: '父任务无日期', due: null })
fstore.addSubtask(parentF.id, { title: '子任务带关键词 特殊词' })
const archive = fstore.create({ title: '已完成任务', due: T })
fstore.toggle(archive.id, { today: T })
eq('today includes overdue', filterTasks(fstore, { filter: 'today', today: T }).map((t) => t.title), ['昨天逾期', '今天到期'])
eq('overdue only', filterTasks(fstore, { filter: 'overdue', today: T }).map((t) => t.title), ['昨天逾期'])
eq('inbox is undated', filterTasks(fstore, { filter: 'inbox', today: T }).map((t) => t.title), ['没有日期', '父任务无日期'])
eq('week window', filterTasks(fstore, { filter: 'week', today: T }).map((t) => t.title), ['昨天逾期', '今天到期', '本周内'])
eq('done filter', filterTasks(fstore, { filter: 'done', today: T }).map((t) => t.title), ['已完成任务'])
eq('subtasks are not listed as top-level rows',
  filterTasks(fstore, { filter: 'all', today: T }).some((t) => t.title === '子任务带关键词 特殊词'), false)
eq('a subtask hit keeps its parent', filterTasks(fstore, { filter: 'all', query: '特殊词', today: T }).map((t) => t.title), ['父任务无日期'])
eq('query matches notes', (() => {
  const t = fstore.create({ title: '有备注的', due: null })
  fstore.update(t.id, { note: '内部备注 独有词' })
  return filterTasks(fstore, { filter: 'all', query: '独有词', today: T }).map((x) => x.title)
})(), ['有备注的'])
eq('includeSubtasks returns the flat set',
  filterTasks(fstore, { filter: 'all', includeSubtasks: true, today: T }).length > filterTasks(fstore, { filter: 'all', today: T }).length, true)
eq('grouping buckets', groupTasks(filterTasks(fstore, { filter: 'all', includeDone: true, today: T }), { today: T }).map((g) => `${g.key}:${g.tasks.length}`),
  ['overdue:1', 'today:1', 'week:1', 'later:1', 'none:3', 'done:1'])

console.log('--- counts ---')
const counts = fstore.stats({ today: T })
eq('overdue count', counts.overdue, 1)
eq('today count', counts.dueToday, 1)
eq('inbox count is top-level only', counts.inbox, 3)
eq('open is top-level only', counts.open, fstore.tasks.filter((t) => t.parentId === null && !t.done).length)

console.log('--- normalization defends the JSON contract ---')
const dirty = normalizeTask({
  id: 't_dirty', title: 42, note: { a: 1 }, done: 'yes', priority: 99, order: Number.NaN,
  tags: ['ok', '', null, 5], due: '2026-02-30', start: new Date(), parentId: '', recurrence: { freq: 'nope' },
  history: [{ at: 1 }, { at: '2026-01-01T00:00:00', due: '2026-01-01' }, 'junk'],
  skipped: ['2026-01-01', 'bogus'], completedAt: undefined, completedCount: -5,
}, [{ id: 'l_inbox', name: '收集箱' }])
eq('title is stringified', dirty.title, '42')
eq('note object becomes [object Object]', typeof dirty.note, 'string')
eq('done requires a real boolean', dirty.done, false)
eq('priority is clamped', dirty.priority, 3)
eq('NaN order becomes 0', dirty.order, 0)
eq('tags drop empties and non-strings', dirty.tags, ['ok', '5'])
eq('an impossible date is dropped', dirty.due, null)
eq('a Date instance never survives', typeof dirty.start === 'string' && dirty.start.startsWith('20'), true)
eq('empty parentId becomes null', dirty.parentId, null)
eq('a bad rule becomes null', dirty.recurrence, null)
eq('history keeps only usable entries', dirty.history.length, 1)
eq('skipped drops garbage', dirty.skipped, ['2026-01-01'])
eq('undefined completedAt becomes null', dirty.completedAt, null)
eq('negative counts clamp to 0', dirty.completedCount, 0)
ok('no undefined survives anywhere', JSON.stringify(dirty) === JSON.stringify(JSON.parse(JSON.stringify(dirty))))

console.log('--- persistence ---')
// Writes are coalesced, so the file on disk is only guaranteed to be current
// after a flush -- which is exactly what the host does before it goes away.
store.flush()
store = open()
const reloaded = new TodoStore({ dataFile: file }).load()
ok('reload keeps every task', reloaded.tasks.length === store.tasks.length, `${reloaded.tasks.length} vs ${store.tasks.length}`)
ok('reload keeps subtask links', reloaded.get(s1.id).parentId === report.id)
ok('reload keeps recurrence rules', reloaded.get(monthly.id).recurrence.freq === 'monthly')
ok('reload keeps the series anchor', reloaded.get(monthly.id).seriesAnchor === '2026-01-31')
ok('reload keeps lists', reloaded.lists.length === store.lists.length)
eq('reload keeps the list order the user dragged',
  reloaded.lists.map((l) => l.name), store.lists.map((l) => l.name))
eq('reload keeps the list colours',
  reloaded.lists.map((l) => l.color), store.lists.map((l) => l.color))

// A burst of writes is coalesced, and `flush()` is what makes the file current
// again: this is the contract that replaced "one full write per mutation".
const burstFile = path.join(dir, 'burst.json')
const burst = new TodoStore({ dataFile: burstFile, saveDelay: 5000 }).load()
burst.create({ title: '合并一', due: '2026-03-01' })
burst.create({ title: '合并二', due: '2026-03-02' })
burst.create({ title: '合并三', due: '2026-03-03' })
eq('a burst is not written while it is still arriving',
  JSON.parse(fs.readFileSync(burstFile, 'utf8')).tasks.length, 0)
burst.flush()
eq('flush lands every queued mutation at once',
  JSON.parse(fs.readFileSync(burstFile, 'utf8')).tasks.length, 3)
burst.create({ title: '合并四', due: '2026-03-04' })
burst.dispose()
eq('dispose flushes before letting go',
  JSON.parse(fs.readFileSync(burstFile, 'utf8')).tasks.length, 4)

// A corrupt document must be preserved, not discarded.
const corrupt = path.join(dir, 'corrupt.json')
fs.writeFileSync(corrupt, '{ this is not json', 'utf8')
const recovered = new TodoStore({ dataFile: corrupt }).load()
ok('a corrupt file is backed up', fs.readdirSync(dir).some((f) => f.startsWith('corrupt.json.corrupt-')))
ok('and reported, not swallowed', typeof recovered.loadError === 'string' && recovered.loadError.includes('备份'))
eq('and starts from a usable empty state', recovered.tasks.length, 0)

console.log('--- document export ---')
const doc = store.document()
ok('document has meta/lists/tasks', Array.isArray(doc.tasks) && Array.isArray(doc.lists) && typeof doc.meta.version === 'number')
ok('document is plain JSON', JSON.stringify(doc) === JSON.stringify(JSON.parse(JSON.stringify(doc))))

console.log('--- helpers ---')
eq('priorityName', [priorityName(0), priorityName(3), priorityName(9)], ['无', '高', '无'])
eq('sortTasks puts done last', sortTasks([
  { done: true, due: '2026-01-01', priority: 3, order: 0, createdAt: 'a' },
  { done: false, due: null, priority: 0, order: 0, createdAt: 'b' },
  { done: false, due: '2026-01-02', priority: 0, order: 0, createdAt: 'c' },
]).map((t) => t.done), [false, false, true])
const view = taskView(store.get(report.id), store, { today: T })
ok('taskView reports the subtask tally', view.subtaskTotal === 2)
ok('taskView reports the parent title for a child', taskView(store.get(s1.id), store, { today: T }).parentTitle === '交季度报告')
ok('taskView is JSON-safe', JSON.stringify(view) === JSON.stringify(JSON.parse(JSON.stringify(view))))
eq('parseQuickAdd is re-exported for callers', typeof parseQuickAdd, 'function')
eq('normalizeRecurrence is re-exported by the store module', normalizeRecurrence({ freq: 'daily' }).ok, true)

console.log('--- occurrences ---')
const occ = store.occurrences({ from: '2026-02-01', to: '2026-05-31' })
const monthlyItem = occ.items.find((i) => i.id === monthly.id)
eq('a monthly series expands off its anchor, not its standing date',
  monthlyItem.dates, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])

console.log('--- clear completed ---')
store.create({ title: '待清理', due: T })
const toClear = store.tasks.find((t) => t.title === '待清理')
store.addSubtask(toClear.id, { title: '子任务也走' })
store.toggle(toClear.id, { today: T })
const cleared = store.clearCompleted()
ok('clearCompleted removes every done group and its subtasks', cleared.deleted === 7, cleared.deleted)
ok('and leaves open tasks alone', store.tasks.some((t) => t.title === '每日站会' && !t.done))

console.log('--- create() dates: the two ends default as a PAIR, not one at a time ---')
// The bug this locks down: `start` used to fall back to the creation day on its
// own, so a quick-added 「明天 15:00 交报告」 became a 「今天 → 明天」 span bar, and
// the markdown import of a dateless historical note appeared on the gantt under
// today's date. A named end now suppresses the other end's default.
const dstore = new TodoStore({ dataFile: path.join(dir, 'dates.json') }).load()
const nowDay = todayStr()
const plus = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const tomorrow = plus(nowDay, 1)

// "I just typed this" -- no date information at all -- is the ONLY case that
// means today at both ends. (The creation stamp carries a time, which is what
// "now" means; only its calendar day matters to the views.)
const bare = dstore.create({ title: '刚敲进来的' })
ok('a task with no dates at all is dated today at both ends',
  bare.due === bare.start && String(bare.due).slice(0, 10) === nowDay, bare)

// A typed date must not grow a start date of its own.
const typed = dstore.quickAdd('明天 15:00 交报告', { today: nowDay }).task
eq('a quick-add line keeps the date it named', typed.due, `${tomorrow}T15:00`)
eq('and gains no start date', typed.start, null)

// An explicit `due: null` is 「未安排」 and stays that way.
const historical = dstore.create({ title: '历史记录', due: null })
eq('an explicit due:null is left unscheduled', [historical.due, historical.start], [null, null])

// A start with no due is the mirror image: one end named, no phantom other end.
const started = dstore.create({ title: '只要开始', start: plus(nowDay, 3) })
eq('a start-only task gains no due date', [started.due, started.start], [null, plus(nowDay, 3)])

const dgantt = ganttView(dstore, { today: nowDay, from: plus(nowDay, -1), to: plus(nowDay, 8) })
const barOf = (id) => dgantt.rows.find((r) => r.id === id)
ok('a due-only task is drawn as a one-day milestone, not a span',
  barOf(typed.id).milestone === true && barOf(typed.id).start === tomorrow && barOf(typed.id).end === tomorrow,
  barOf(typed.id))
ok('a start-only task is drawn as a one-day milestone too',
  barOf(started.id).milestone === true && barOf(started.id).start === plus(nowDay, 3), barOf(started.id))
ok('a task created with no dates is today\'s one-day bar',
  barOf(bare.id).milestone === true && barOf(bare.id).start === nowDay, barOf(bare.id))
eq('an unscheduled historical record stays off the gantt', dgantt.undated, [historical.id])

console.log('--- view payloads (the browser renders, it does not decide) ---')
const vstore = new TodoStore({ dataFile: path.join(dir, 'views.json') }).load()
const vT = '2026-09-17'
vstore.create({ title: '逾期项', due: '2026-09-10' })
vstore.create({ title: '今天到期', due: vT })
vstore.create({ title: '明天到期', due: '2026-09-18' })
vstore.create({ title: '本周内', due: '2026-09-21' })
vstore.create({ title: '以后', due: '2026-10-30' })
// A task with NO dates at all is dated today (see the section above), so a
// fixture that means 「未安排」 has to say so; the gantt/calendar undated paths
// need exactly one such task to stay covered.
vstore.create({ title: '无日期', start: null, due: null })
const vWork = vstore.createList({ name: '工作' })
vstore.create({ title: '工作项', due: '2026-09-19', listId: vWork.id })
const vDaily = vstore.create({ title: '每日站会', due: '2026-09-01', recurrence: { freq: 'daily' } })
const vSpan = vstore.create({ title: '跨度任务', start: '2026-09-15', due: '2026-09-22' })
const vOpts = { today: vT, filter: 'all' }
eq('list groups are bucketed and ordered',
  viewGroups(vstore, vOpts).map((g) => `${g.key}:${g.ids.length}`),
  ['overdue:2', 'today:1', 'tomorrow:1', 'week:3', 'later:1', 'none:1'])
ok('the list view can be narrowed by filter',
  viewGroups(vstore, { ...vOpts, filter: 'today' }).every((g) => g.key === 'overdue' || g.key === 'today'))
eq('board has one column per list',
  boardColumns(vstore, vOpts).map((c) => c.name), ['收集箱', '工作'])
eq('board columns carry their task ids',
  boardColumns(vstore, vOpts).find((c) => c.name === '工作').ids.length, 1)
eq('board narrows to a single list when asked',
  boardColumns(vstore, { ...vOpts, listId: vWork.id }).map((c) => c.name), ['工作'])
vstore.moveList(vWork.id, { index: 0 })
eq('the board follows the order the rail was dragged into',
  boardColumns(vstore, vOpts).map((c) => c.name), ['工作', '收集箱'])
vstore.moveList(vWork.id, { index: 1 })
eq('and follows it back',
  boardColumns(vstore, vOpts).map((c) => c.name), ['收集箱', '工作'])
const vcal = calendarView(vstore, { ...vOpts, from: '2026-09-15', to: '2026-09-20' })
eq('calendar covers every day in range', vcal.days.map((d) => d.date),
  ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'])
eq('a repeating task lands on every occurrence in range',
  vcal.days.find((d) => d.date === '2026-09-16').ids.length, 1)
eq('a day holding two tasks holds both',
  vcal.days.find((d) => d.date === '2026-09-18').ids.length, 2)
ok('calendar reports the series it expanded',
  vcal.occurrences.some((o) => o.id === vDaily.id && o.dates.length === 6), vcal.occurrences)
ok('calendar lists undated tasks separately', Array.isArray(vcal.unscheduled) && vcal.unscheduled.length === 1)
const vgantt = ganttView(vstore, { ...vOpts, from: '2026-09-10', to: '2026-10-01' })
const spanRow = vgantt.rows.find((r) => r.id === vSpan.id)
eq('a spanned task keeps its start and end', [spanRow.start, spanRow.end], ['2026-09-15', '2026-09-22'])
ok('a spanned task is not a milestone', spanRow.milestone === false)
const oneDay = vgantt.rows.find((r) => r.id === vstore.tasks.find((t) => t.title === '明天到期').id)
ok('a task with only a due date is a one-day bar', oneDay.milestone === true && oneDay.start === oneDay.end)
ok('overdue bars are flagged',
  vgantt.rows.find((r) => r.id === vstore.tasks.find((t) => t.title === '逾期项').id).overdue === true)
ok('unschedulable tasks are reported, not dropped', vgantt.undated.length === 1)
ok('a reversed span is normalised', (() => {
  const t = vstore.create({ title: '反了的', start: '2026-09-25', due: '2026-09-20' })
  const row = ganttView(vstore, { ...vOpts, from: '2026-09-10', to: '2026-10-01' }).rows.find((r) => r.id === t.id)
  return row.start === '2026-09-20' && row.end === '2026-09-25'
})())
ok('gantt rows are ordered by start date', (() => {
  const starts = vgantt.rows.map((r) => r.start)
  return starts.every((s, i) => i === 0 || starts[i - 1] <= s)
})())

fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)

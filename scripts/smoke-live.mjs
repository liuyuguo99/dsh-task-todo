/**
 * Live smoke test against a RUNNING dsh web that has this plugin mounted.
 *
 * Everything else in this package proves contracts against a host the test
 * process built itself. That is not the same as the real process: the real one
 * composes the plugin through the bundle layer, resolves the package by name, and
 * serves the route over real HTTP. This script is the only check that exercises
 * that path, and it is where a silent view-shape fallback was found (the host had
 * a mutation echo the default list view when the caller sent a view *payload*
 * instead of a view *context*).
 *
 *   node scripts/smoke-live.mjs                     # http://127.0.0.1:6317
 *   node scripts/smoke-live.mjs --base http://127.0.0.1:4006
 *
 * It writes one task and removes it again, plus any list it created, so it leaves
 * the data file as it found it. Requires the plugin to be loaded: restart `dsh
 * web` after installing.
 */
const args = process.argv.slice(2)
const baseArg = args.indexOf('--base')
const base = (baseArg >= 0 ? args[baseArg + 1] : 'http://127.0.0.1:6317').replace(/\/+$/, '')
const api = `${base}/todo/api/`

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); return }
  fail++
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)))
}

async function call(method, body) {
  const res = await fetch(api + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await res.json().catch(() => null)
  return { status: res.status, body: payload, data: payload?.data }
}

// ---------------------------------------------------------------------------

let reachable = true
try {
  const probe = await fetch(api + 'status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = await probe.json().catch(() => null)
  if (probe.status !== 200 || payload?.ok !== true) reachable = false
} catch {
  reachable = false
}
if (!reachable) {
  console.log(`LIVE SMOKE: skipped -- no dsh web with the todo plugin at ${base}`)
  console.log('  install with:  dsh plugin --profile web add "<path to dsh-task-todo>"')
  console.log('  then restart dsh web (the bundle layer is read at startup).')
  process.exit(0)
}

console.log(`live smoke against ${base}`)
const start = await call('state', { view: 'list', filter: 'all', includeDone: true })
ok('state answers', start.status === 200 && start.body?.ok === true, start.status)
ok('state carries the real data file', typeof start.data?.dataFile === 'string', start.data?.dataFile)
const listsBefore = start.data.lists.map((l) => l.id)
const today = start.data.today

// --- write a task through the real parser ---------------------------------
const added = await call('quickAdd', {
  text: '明天 10:00 冒烟测试任务 !高 #冒烟测试清单 @冒烟',
  view: { view: 'list', filter: 'today' },
})
ok('quickAdd answers', added.body?.ok === true, added.body)
const task = added.data?.task
ok('quickAdd parsed the title', task?.title === '冒烟测试任务', task?.title)
ok('quickAdd parsed the due date and time', typeof task?.due === 'string' && /T10:00$/.test(task.due), task?.due)
ok('quickAdd parsed the priority', task?.priority === 3, task?.priority)
ok('quickAdd parsed the tag', Array.isArray(task?.tags) && task.tags.includes('冒烟'), task?.tags)
ok('the list did not exist before and had to be created', added.data?.listCreated === true, added.data?.listCreated)
ok('the echo is the view the caller asked for', added.data?.state?.view?.kind === 'list', added.data?.state?.view?.kind)
ok('the created task is visible in the echoed state',
  added.data.state.tasks.some((t) => t.id === task.id), added.data.state.tasks.length)

// --- subtasks, completion, recurrence, and the view-shape tolerance -------
const sub = await call('addSubtask', { parentId: task.id, title: '冒烟子任务', note: '备注', view: { view: 'board' } })
ok('addSubtask answers', sub.body?.ok === true, sub.body)
const parentAfterSub = sub.data.state.tasks.find((t) => t.id === task.id)
ok('the parent counts its subtask', parentAfterSub?.subtaskTotal === 1, parentAfterSub?.subtaskTotal)
ok('a board view context still echoes a board', sub.data.state.view.kind === 'board', sub.data.state.view.kind)
ok('the board has columns', Array.isArray(sub.data.state.view.columns) && sub.data.state.view.columns.length > 0)

const done = await call('toggle', { id: task.id, view: { view: 'gantt' } })
ok('toggle answers and completes the task', done.body?.ok === true && done.data.task.done === true, done.data?.task?.done)
ok('a gantt view context still echoes a gantt', done.data.state.view.kind === 'gantt', done.data.state.view.kind)
const subAfter = done.data.state.tasks.find((t) => t.id === sub.data.created.id)
ok('completing the parent resets the subtask', subAfter?.done === false, subAfter?.done)

// The client sends a flat context; a HTTP caller may send {kind}. Both must
// resolve to the same view -- the regression this script was written for.
const byKind = await call('update', { id: task.id, repeat: 'daily', repeatInterval: 3, view: { kind: 'calendar' } })
ok('update answers', byKind.body?.ok === true, byKind.body)
ok('the recurrence rule was stored', byKind.data?.updated?.recurrence?.freq === 'daily'
  && byKind.data.updated.recurrence.interval === 3, byKind.data?.updated?.recurrence)
ok('a payload-shaped view context echoes that view, not a list',
  byKind.data.state.view.kind === 'calendar', byKind.data.state.view.kind)
const byString = await call('toggle', { id: task.id, undone: true, view: 'board' })
ok('a bare kind string echoes that view', byString.data?.state?.view?.kind === 'board', byString.data?.state?.view?.kind)
const byNone = await call('state', {})
ok('a missing view context falls back to the list', byNone.data?.view?.kind === 'list', byNone.data?.view?.kind)

// --- list management against the real process ------------------------------
// Same reasoning as the rest of this file: the store tests prove the model, this
// proves the route, the registry and the JSON envelope that the browser uses.
const smoke = await call('createList', { name: '冒烟清单', color: '#7c5cf0' })
ok('createList answers', smoke.body?.ok === true, smoke.body)
ok('the palette colour was stored', smoke.data?.list?.color === '#7c5cf0', smoke.data?.list)
const renamed = await call('updateList', { id: smoke.data.list.id, name: '冒烟清单改名' })
ok('updateList renames the list', renamed.data?.list?.name === '冒烟清单改名', renamed.data?.list?.name)
const recoloured = await call('updateList', { id: smoke.data.list.id, color: '#e0584f' })
ok('updateList recolours the list', recoloured.data?.list?.color === '#e0584f', recoloured.data?.list?.color)
const toFront = await call('moveList', { id: smoke.data.list.id, index: 0 })
ok('moveList answers with the new position', toFront.body?.ok === true && toFront.data?.to === 0, toFront.data)
ok('the echoed order really changed',
  toFront.data.state.lists[0].id === smoke.data.list.id, toFront.data.state.lists.map((l) => l.name))
const nudged = await call('moveList', { id: smoke.data.list.id, delta: 1 })
ok('a relative move works too', nudged.data?.to === 1, nudged.data?.to)
const doomed = await call('createList', { name: '冒烟待删' })
const deleted = await call('removeList', { id: doomed.data.list.id })
ok('removeList answers and names where the tasks went',
  deleted.body?.ok === true && typeof deleted.data?.movedToName === 'string', deleted.data)
const protectedList = await call('removeList', { id: 'l_inbox' })
ok('the system inbox refuses to be deleted', protectedList.body?.ok === false, protectedList.body)
const deletedSmoke = await call('removeList', { id: smoke.data.list.id })
ok('removeList deletes the list this run created', deletedSmoke.body?.ok === true, deletedSmoke.body)

// --- clean up exactly what this run created -------------------------------
const removed = await call('remove', { id: task.id, view: { view: 'list' } })
ok('remove answers', removed.body?.ok === true, removed.body)
const after = await call('state', { view: 'list', filter: 'all', includeDone: true })
ok('the task is gone', !after.data.tasks.some((t) => t.id === task.id), after.data.tasks.length)
for (const list of after.data.lists) {
  if (listsBefore.includes(list.id)) continue
  const used = after.data.tasks.filter((t) => t.listId === list.id).length
  if (used === 0) await call('removeList', { id: list.id })
}
const final = await call('state', { view: 'list', filter: 'all', includeDone: true })
ok('the data file is back to the lists it started with',
  final.data.lists.length === listsBefore.length, { before: listsBefore.length, after: final.data.lists.length })

const bad = await call('noSuchMethod', {})
ok('an unknown method 404s', bad.status === 404, bad.status)
ok('an unknown method keeps the lossless-JSON envelope', bad.body?.ok === false && typeof bad.body.error === 'string', bad.body)

console.log('')
console.log(fail === 0 ? `LIVE SMOKE: ALL PASS (${pass})` : `LIVE SMOKE FAILING: ${fail} of ${pass + fail}`)
console.log(`(today = ${today}, base = ${base})`)
process.exit(fail === 0 ? 0 : 1)

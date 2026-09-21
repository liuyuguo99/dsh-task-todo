// The lossless-JSON gate.
//
// DSH runs EVERY tool return value and every HTTP reply through the real
// validator (`snapshotJsonValue`), which discards the whole payload when any
// node is undefined / NaN / -0 / a Date / a class instance. A single forgotten
// optional field therefore turns a working tool into a 100%-failing one — that
// is a recorded incident in this workspace, not a hypothetical.
//
// So: exercise every outward surface, in its empty state, its hit state and its
// error state, and validate with the REAL validator rather than a copy of it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

// Workspace-local scratch space: the system temp directory is not reliably
// writable under the file sandbox, and a run must not depend on its ACLs.
const scratch = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.tmp-gate-'))
process.env.DSH_HOME = scratch

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}

/** Validate with the real runtime validator; report the exact path on failure. */
function gate(name, value) {
  let detail = null
  try {
    snapshotJsonValue(value)
  } catch (e) {
    detail = String(e?.message ?? e)
  }
  ok(`JSON gate: ${name}`, detail === null && isJsonValue(value), detail)
}

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'index.js')).href)

const tools = []
let route = null
const commands = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (def) => { tools.push(def); return () => {} } },
  settings: { register: () => ({ get: () => ({}), watch: () => () => {} }) },
  provide: () => () => {},
  effect: (fn) => { fn(); return () => {} },
  get: (key) => {
    if (key === 'webServer') return { register: (r) => { route = r; return () => {} } }
    if (key === 'commands') return { register: (c) => { commands.push(c); return () => {} } }
    return undefined
  },
}
mod.apply(ctx)

console.log('--- wiring ---')
ok('six tools registered', tools.length === 6, tools.map((t) => t.name))
ok('every tool has an output schema and a renderer',
  tools.every((t) => t.output?.schema !== undefined && typeof t.output.render === 'function'))
ok('the HTTP route is registered', route !== null && route.path === '/todo')
ok('the /todo command is registered', commands.length === 1 && commands[0].name === 'todo')

const call = (name, args) => {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error('no such tool: ' + name)
  return tool.execute(args ?? {}, {})
}

console.log('--- empty state ---')
gate('task_list on an empty document', await call('task_list', {}))
gate('task_list with a done filter', await call('task_list', { filter: 'done' }))
gate('task_list with a query that matches nothing', await call('task_list', { query: 'zzz-nothing' }))

console.log('--- populated state ---')
const added = await call('task_add', {
  title: '交季度报告', due: '2026-09-20', priority: 3, list: '工作', tags: ['重要'],
  note: '备注：先拉数据', repeat: 'weekly', repeatWeekdays: [5], repeatUntil: '2026-12-31',
})
gate('task_add (with every field set)', added)
const withRule = await call('task_add', { title: '每日站会', due: '2026-09-17', repeat: 'daily', repeatInterval: 2 })
gate('task_add (interval rule)', withRule)
const plain = await call('task_add', { title: '没有日期的任务' })
const plainId = plain.created.id
gate('task_add (minimum fields)', plain)
const sub = await call('task_add', { title: '拉数据', parent: '交季度报告' })
gate('task_add (as a subtask)', sub)

const listed = await call('task_list', { filter: 'all' })
gate('task_list (populated)', listed)
ok('task_list returns views with ids', listed.tasks.every((t) => typeof t.id === 'string' && t.id.length > 0))
gate('task_list filtered by list', await call('task_list', { list: '工作' }))
gate('task_list filtered by query', await call('task_list', { query: '拉数据' }))
gate('task_list with includeDone', await call('task_list', { includeDone: true }))

gate('task_update (title + note)', await call('task_update', { id: plainId, title: '改名了', note: '有新备注' }))
gate('task_update (clear the note)', await call('task_update', { id: plainId, note: '' }))
gate('task_update (cancel the repeat rule)', await call('task_update', { id: '每日站会', repeat: '' }))
gate('task_update (re-add a repeat rule)', await call('task_update', { id: '每日站会', repeat: 'monthly', repeatCount: 3 }))
gate('task_update (move list and set tags)', await call('task_update', { id: '改名了', list: '收集箱', tags: ['a', 'b'] }))
gate('task_update (promote a subtask)', await call('task_update', { id: '拉数据', parent: '' }))

gate('task_done (one-shot)', await call('task_done', { id: '改名了' }))
gate('task_done (undo)', await call('task_done', { id: '改名了', undone: true }))
gate('task_done (repeating task rolls)', await call('task_done', { id: '交季度报告' }))

gate('task_delete', await call('task_delete', { id: plainId }))

console.log('--- list_manage: the list surface ---')
const listState = await call('list_manage', { action: 'list' })
gate('list_manage (list)', listState)
ok('list_manage reports the inbox and its colour',
  listState.lists.some((l) => l.system === true && typeof l.color === 'string'),
  listState.lists)
const madeList = await call('list_manage', { action: 'create', name: '装修', color: '#c85cd8' })
gate('list_manage (create with a colour)', madeList)
ok('a created list keeps its colour', madeList.list.color === '#c85cd8', madeList.list)
gate('list_manage (create without a colour still gets one)',
  await call('list_manage', { action: 'create', name: '健身' }))
const renamed = await call('list_manage', { action: 'update', id: madeList.list.id, newName: '装修计划' })
gate('list_manage (rename)', renamed)
ok('the rename landed', renamed.list.name === '装修计划', renamed.list)
gate('list_manage (recolour)', await call('list_manage', { action: 'update', name: '装修计划', color: '#3fa662' }))
const movedList = await call('list_manage', { action: 'move', id: madeList.list.id, index: 0 })
gate('list_manage (move to the front)', movedList)
ok('the moved list is first', movedList.to === 0, { from: movedList.from, to: movedList.to })
gate('list_manage (move by delta)', await call('list_manage', { action: 'move', id: madeList.list.id, delta: 1 }))
// Deleting a list must never delete its tasks: they move to the inbox.
await call('task_add', { title: '买地板', list: '装修计划' })
const inboxList = (await call('list_manage', { action: 'list' })).lists.find((l) => l.system === true)
const deletedList = await call('list_manage', { action: 'delete', id: madeList.list.id })
gate('list_manage (delete)', deletedList)
ok('the list\'s tasks were moved, not deleted',
  deletedList.moved === 1 && deletedList.movedTo === inboxList.id, deletedList)
ok('the deleted list is gone',
  (await call('list_manage', { action: 'list' })).lists.every((l) => l.id !== madeList.list.id))
ok('the moved task is still there',
  (await call('task_list', { filter: 'all' })).tasks.some((t) => t.title === '买地板'))
for (const [label, args] of [
  ['create without a name', { action: 'create' }],
  ['update an unknown list', { action: 'update', id: 'l_missing', newName: 'x' }],
  ['delete an unknown list', { action: 'delete', id: 'l_missing' }],
  ['delete the system inbox', { action: 'delete', id: 'l_inbox' }],
  ['rename onto an existing name', { action: 'update', name: '健身', newName: '收集箱' }],
  ['an unknown action', { action: 'frobnicate' }],
  ['a move with no target', { action: 'move' }],
]) {
  let value = null
  let threw = null
  try { value = await call('list_manage', args) } catch (e) { threw = e }
  ok(`list_manage rejects ${label}`, threw !== null || (value !== null && value.error !== undefined),
    { threw: threw?.message, value })
  if (value !== null) gate(`list_manage error payload (${label})`, value)
}

console.log('--- error paths must be lossless too ---')
for (const [name, args] of [
  ['task_update', { id: 't_missing', title: 'x' }],
  ['task_done', { id: 't_missing' }],
  ['task_delete', { id: 't_missing' }],
  ['task_update', { id: '', title: 'x' }],
  ['task_add', { title: '坏规则', repeat: 'hourly' }],
  ['task_add', { title: '坏日期', due: '2026-02-30' }],
  ['task_list', { list: '不存在的清单' }],
]) {
  const tool = tools.find((t) => t.name === name)
  let value = null
  let threw = null
  try { value = await tool.execute(args, {}) } catch (e) { threw = e }
  ok(`${name} rejects bad input (${JSON.stringify(args).slice(0, 46)})`, threw !== null || value !== null)
  if (value !== null) gate(`${name} error payload ${JSON.stringify(args).slice(0, 40)}`, value)
}

// Ambiguous titles must refuse, not guess.
await call('task_add', { title: '重名任务' })
await call('task_add', { title: '重名任务' })
let ambiguous = null
try { await call('task_done', { id: '重名任务' }) } catch (e) { ambiguous = e }
ok('an ambiguous title is refused with candidates', ambiguous !== null && ambiguous.message.includes('id'), ambiguous?.message)

console.log('--- HTTP API surfaces ---')
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith(route.path)) return route.handler(req, res)
  res.writeHead(404).end('nope')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/todo/api`
const api = async (method, args) => {
  const res = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  })
  return { status: res.status, body: await res.json() }
}

const state = await api('state')
ok('state succeeds', state.body.ok === true, state.body.error)
gate('API state', state.body)

for (const [method, args] of [
  ['status', {}],
  ['state', {}],
  ['occurrences', { from: '2026-09-01', to: '2026-10-31' }],
  ['exportDocument', {}],
  ['quickAdd', { text: '明天 15:00 交周报 !高 #工作 @紧要' }],
  ['createList', { name: '第四清单' }],
  ['updateList', { id: 'l_inbox', name: '收集箱' }],
  ['create', { title: 'API 创建', due: '2026-09-25' }],
  ['addSubtask', { parentId: listed.tasks[0].id, title: 'API 子任务' }],
  ['clearCompleted', {}],
]) {
  const res = await api(method, args)
  if (res.body.ok !== true) {
    ok(`API ${method} succeeds`, false, res.body.error)
    continue
  }
  gate(`API ${method}`, res.body)
}

const created = await api('create', { title: '用于更新的任务' })
const createdId = created.body.data.created.id
gate('API update', (await api('update', { id: createdId, note: 'x', priority: 1 })).body)
gate('API toggle', (await api('toggle', { id: createdId })).body)
gate('API toggle back', (await api('toggle', { id: createdId, done: false })).body)
gate('API move', (await api('move', { id: createdId, index: 0 })).body)
gate('API remove', (await api('remove', { id: createdId })).body)
const repeating = await api('create', { title: '用于跳过的', due: '2026-09-17', recurrence: { freq: 'daily' } })
gate('API skip', (await api('skip', { id: repeating.body.data.created.id })).body)

const fourth = (await api('state')).body.data.lists.find((l) => l.name === '第四清单')
gate('API updateList (recolour by id)', (await api('updateList', { id: fourth.id, color: '#22a89a' })).body)
gate('API updateList (rename by id)', (await api('updateList', { id: fourth.id, name: '第四清单改名' })).body)
ok('the rename took',
  (await api('state')).body.data.lists.some((l) => l.name === '第四清单改名'))

const newList = (await api('createList', { name: '第五清单' })).body.data.list
gate('API moveList (absolute index)', (await api('moveList', { id: newList.id, index: 0 })).body)
gate('API moveList (relative delta)', (await api('moveList', { id: newList.id, delta: 1 })).body)
const ordered = (await api('state')).body.data.lists
ok('the stored order is a clean 0..n-1 sequence',
  ordered.map((l) => l.order).join(',') === ordered.map((_, i) => i).join(','),
  ordered.map((l) => l.order))
ok('moveList really moved it off the front', ordered.length > 1 && ordered[0].id !== newList.id,
  ordered.map((l) => l.name))
gate('API removeList (real id)', (await api('removeList', { id: newList.id })).body)
const doomedList = (await api('createList', { name: '第六清单' })).body.data.list
const removedList = (await api('removeList', { id: doomedList.id })).body
ok('removeList reports where the tasks went',
  removedList.ok === true && removedList.data.movedToName === '收集箱', removedList)

console.log('--- the state payload follows the requested view ---')
for (const [kind, extra, check] of [
  ['list', {}, (v) => Array.isArray(v.groups)],
  ['board', {}, (v) => Array.isArray(v.columns) && v.columns.length > 0],
  ['calendar', { from: '2026-09-01', to: '2026-09-30' }, (v) => Array.isArray(v.days) && Array.isArray(v.occurrences)],
  ['gantt', { from: '2026-09-01', to: '2026-10-31' }, (v) => Array.isArray(v.rows) && Array.isArray(v.undated)],
]) {
  const payload = (await api('state', { view: kind, filter: 'all', ...extra })).body.data
  ok(`state answers with the ${kind} payload`, payload.view.kind === kind && check(payload.view), payload.view)
  gate(`state payload (${kind})`, payload)
}
const echoed = (await api('create', {
  title: '日历里创建的',
  due: '2026-09-20',
  // A mutation carries the caller's view context, so the echoed state is the
  // calendar the user is looking at -- not the default list payload.
  view: { view: 'calendar', from: '2026-09-01', to: '2026-09-30' },
})).body.data
ok('a mutation echoes the caller\'s view',
  echoed.state.view.kind === 'calendar' && echoed.state.view.days.some((d) => d.date === '2026-09-20'),
  echoed.state.view.kind)

// Every accepted shape of the view context must echo the SAME view. A shape that
// silently degrades to the list view is how a calendar gets swapped for a list
// mid-interaction, so tolerance here is a correctness requirement, not a nicety.
const viewShapes = [
  ['flat context (what the client sends)', { view: 'board' }],
  ['payload-shaped {kind}', { kind: 'board' }],
  ['bare kind string', 'board'],
  ['nested payload-shaped {kind} in a context', { view: { kind: 'board' }, filter: 'all' }],
]
for (const [label, shape] of viewShapes) {
  const res = (await api('toggle', { id: 't_nope', view: shape })).body
  // t_nope does not resolve, so this is an error path: it must stay lossless JSON
  // and must not be mistaken for a view echo. The echo itself is checked below.
  gate(`view shape rejected cleanly: ${label}`, res)
}
const shaped = (await api('create', { title: '形状检查', due: '2026-09-20', view: { kind: 'board' } })).body.data
ok('a payload-shaped view context still echoes the board', shaped.state.view.kind === 'board',
  shaped.state.view.kind)
const bareKind = (await api('create', { title: '形状检查2', view: 'gantt' })).body.data
ok('a bare kind string still echoes the gantt', bareKind.state.view.kind === 'gantt',
  bareKind.state.view.kind)
const absent = (await api('create', { title: '形状检查3' })).body.data
ok('a missing view context falls back to the list', absent.state.view.kind === 'list',
  absent.state.view.kind)
const bad = await api('update', { id: 't_nope', title: 'x' })
ok('API errors use ok:false', bad.body.ok === false && typeof bad.body.error === 'string')
gate('API error payload', bad.body)
const missing = await api('noSuchMethod', {})
ok('unknown methods 404', missing.status === 404, missing.status)
gate('API unknown-method payload', missing.body)

console.log('--- the capture line: preview, seeds, and the hotkey the client reads ---')
// The preview is what the capture box shows before Enter, so it must be lossless
// JSON like every other reply -- and it must agree with what quickAdd will do.
const previewed = await api('preview', { text: '明天 15:00 交报告 !高 #工作 @紧要' })
gate('API preview', previewed.body)
const plan = previewed.body.data.plan
ok('the preview ships a plan the client can render',
  plan !== null && typeof plan === 'object' && 'due' in plan && 'priority' in plan, plan)
ok('the preview names the list it will use', typeof plan.listName === 'string' && plan.listName.length > 0, plan.listName)
ok('the preview says whether that list exists', typeof plan.listExists === 'boolean', plan.listExists)
// The seed is the inline "+" contract: text wins, an explicit null means
// unscheduled, and an absent key keeps the create default.
const seededDue = await api('quickAdd', { text: '种子日期', due: '2026-09-25' })
gate('API quickAdd (seeded due)', seededDue.body)
ok('a seeded due date is used', seededDue.body.data.task.due === '2026-09-25', seededDue.body.data.task.due)
const gateToday = (await api('state')).body.data.today
const gateTomorrow = new Date(Date.parse(`${gateToday}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
const textWinsDue = await api('quickAdd', { text: '明天 文本优先', due: '2026-09-25' })
ok('the text beats the seed', textWinsDue.body.data.task.due === gateTomorrow,
  { got: textWinsDue.body.data.task.due, want: gateTomorrow })
const nullDue = await api('quickAdd', { text: '明确不安排', due: null })
ok('an explicit null seed is unscheduled', nullDue.body.data.task.due === null, nullDue.body.data.task.due)
const noDue = await api('quickAdd', { text: '没有种子' })
ok('an absent seed keeps the create default', typeof noDue.body.data.task.due === 'string'
  && noDue.body.data.task.due.includes('T'), noDue.body.data.task.due)
const seedTarget = (await api('state')).body.data.lists[0]
const seededList = await api('quickAdd', { text: '种子清单', listId: seedTarget.id })
ok('a seeded list is honoured', seededList.body.data.task.listId === seedTarget.id,
  seededList.body.data.task.listId)
// The client renders the shortcut hints from this payload, so an unset or broken
// value has to arrive as a usable one.
const settingsPayload = (await api('state')).body.data.settings
ok('the state payload carries the hotkeys', settingsPayload.hotkey !== undefined
  && typeof settingsPayload.hotkey.capture === 'string' && typeof settingsPayload.hotkey.palette === 'string',
  settingsPayload.hotkey)
gate('state payload settings', settingsPayload)

console.log('--- backup: export then import ---')
// Placed last on purpose: importing an older document legitimately rewinds the
// store, which every assertion above would rightly object to.
const exported = await api('exportDocument', {})
gate('API exportDocument', exported.body)
const imported = await api('importDocument', { document: exported.body.data.document })
ok('API importDocument succeeds', imported.body.ok === true, imported.body.error)
gate('API importDocument', imported.body)
ok('the round trip keeps every task',
  imported.body.data.tasks === exported.body.data.document.tasks.length,
  { after: imported.body.data.tasks, before: exported.body.data.document.tasks.length })
ok('importing copies the old file aside first',
  typeof imported.body.data.backup === 'string' && imported.body.data.backup.includes('before-import'),
  imported.body.data.backup)
const notABackup = await api('importDocument', { document: { hello: 'world' } })
ok('importing something else is refused',
  notABackup.body.ok === false && String(notABackup.body.error).includes('tasks'),
  notABackup.body.error)

console.log('--- command surfaces ---')
const command = commands[0]
for (const [label, rawInput] of [
  ['bare (today overview)', ''],
  ['help', 'help'],
  ['ls', 'ls 全部'],
  ['ls 已完成', 'ls 已完成'],
  ['add', 'add 明天 10:00 站会 !中 #工作'],
  ['add (bad)', 'add'],
  ['done', 'done 交季度报告'],
  ['bare text (quick add)', '买牛奶 !低'],
  ['unknown-looking text', 'frobnicate'],
]) {
  const result = await command.handler({ rawInput, commandId: 'todo' })
  ok(`/todo ${label} answers`, typeof result?.text === 'string' && result.text.length > 0)
  ok(`/todo ${label} returns a valid kind`, result.kind === 'success' || result.kind === 'error')
}
// Bare arguments are the quick-add line now, not a usage error: `/todo 买牛奶`
// and `/todo add 买牛奶` are the same sentence, and requiring the keyword made the
// feature discoverable only by reading --help.
const bareAdd = await command.handler({ rawInput: '买牛奶 !低', commandId: 'todo' })
ok('a bare argument is a quick add', bareAdd.kind === 'success' && bareAdd.text.includes('买牛奶'), bareAdd.text)
const bareTask = (await call('task_list', { filter: 'all' })).tasks.find((t) => t.title === '买牛奶')
ok('and the task really landed', bareTask !== undefined && bareTask.priority === 1, bareTask)
const unknownAdd = await command.handler({ rawInput: 'frobnicate', commandId: 'todo' })
ok('so is a word that looks like nothing else',
  unknownAdd.kind === 'success' && unknownAdd.text.includes('frobnicate'), unknownAdd.text)

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (fail ? `FAILING: ${fail} of ${pass + fail}` : `JSON GATE: ALL PASS (${pass})`))
process.exit(fail ? 1 : 0)

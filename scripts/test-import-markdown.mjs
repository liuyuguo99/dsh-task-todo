// The markdown importer, against a fixture that carries every shape the real
// export contains: a project, a done task with subtasks and a tag, a repeating
// task without a due date, a status that has no home in this model, a project id
// that cannot be resolved, a file with no frontmatter, and a non-task file that
// happens to share the folder.
//
// The importer is a script, so it is exercised the way a user runs it (a child
// process) and asserted through the DOCUMENT it produced -- the file is the
// deliverable, not the log.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const pkgRoot = path.join(here, '..')
const scratch = fs.mkdtempSync(path.join(pkgRoot, '.tmp-import-'))
const fromDir = path.join(scratch, '待办')
const projectsDir = path.join(scratch, '项目')
fs.mkdirSync(fromDir, { recursive: true })
fs.mkdirSync(projectsDir, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); return }
  fail++
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected),
  { actual, expected })

/** The same local-wall-clock rule the importer uses, so this stays timezone-safe. */
const localStamp = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text, 'utf8')

// --- fixture ---------------------------------------------------------------

write(projectsDir, '回流数据优化.md', `---
id: "p_ref"
type: project
color: "#2E7D5B"
due: null
archived: false
---

# 回流数据优化
`)

write(fromDir, '已完成带子任务.md', `---
id: "src-1"
type: task
status: "done"
priority: "high"
due: "2026-08-18"
project_id: "p_ref"
tags:
  - "各单位问题"
repeat: null
repeat_day: null
remind: null
subtasks:
  - id: "sub-1"
    title: "子任务一"
    done: true
  - id: "sub-2"
    title: "子任务二"
    done: false
created_at: "2026-08-01T00:00:00.000Z"
completed_at: "2026-08-24T01:57:03.565Z"
---

# 已完成带子任务

正文第一行
正文第二行
`)

write(fromDir, '未完成重复任务.md', `---
id: "src-2"
type: task
status: "todo"
priority: "mid"
due: null
project_id: null
repeat: "daily"
repeat_day: null
remind: "10:00"
created_at: "2026-09-08T07:20:53.831Z"
completed_at: null
---

# 未完成重复任务
`)

write(fromDir, '进行中无期限.md', `---
id: "src-3"
type: task
status: "doing"
priority: "mid"
due: null
project_id: null
repeat: null
repeat_day: null
remind: null
created_at: "2026-09-03T07:31:35.629Z"
completed_at: null
---

# 进行中无期限
`)

write(fromDir, '未知项目.md', `---
id: "src-4"
type: task
status: "block"
priority: "mid"
due: "2026-08-26"
project_id: "p_missing"
repeat: null
repeat_day: null
remind: null
created_at: "2026-08-25T01:08:43.644Z"
completed_at: null
---

# 未知项目
`)

write(fromDir, '没有任何结构.md', '# 没有任何结构\n\n就是一段说明文字。\n')
write(fromDir, '项目文件混进来.md', `---
id: "p_ref"
type: project
---

# 回流数据优化
`)

// --- run -------------------------------------------------------------------

const file = path.join(scratch, 'tasks.json')
const run = (extraArgs) => spawnSync(process.execPath, [
  path.join(here, 'import-markdown-todos.mjs'),
  '--from', fromDir, '--projects', projectsDir, '--data-file', file, ...extraArgs,
], { cwd: pkgRoot, stdio: 'inherit' })

console.log('--- 导入 ---')
const first = run([])
ok('导入以 0 退出', first.status === 0, first.status)

const { TodoStore } = await import(pathToFileURL(path.join(pkgRoot, 'lib', 'store.js')).href)
let store = new TodoStore({ dataFile: file }).load()
const ids = store.tasks.map((t) => t.id)

ok('四个任务文件都进来了，非任务文件没有被当成任务',
  ids.filter((id) => id.startsWith('src-')).length === 4, ids)
eq('一共只导入了 4 条顶层任务', store.tasks.filter((t) => t.parentId === null).length, 4)
ok('没有 frontmatter 的文件被跳过', store.get('没有任何结构') === null)
ok('项目文件没有变成任务', store.get('p_ref') === null, ids)

const done = store.get('src-1')
ok('已完成的任务是 done', done !== null && done.done === true, done?.done)
// The export stores UTC; the plugin stores local wall-clock. Asserting the RAW
// ISO here would pass on a UTC machine and lie about the other 23 hours.
eq('完成时间按本地时间落地', done.completedAt, localStamp('2026-08-24T01:57:03.565Z'))
eq('创建时间同样按本地时间落地', done.createdAt, localStamp('2026-08-01T00:00:00.000Z'))
eq('优先级 high 映射为 3', done.priority, 3)
eq('截止日期保留', done.due, '2026-08-18')
eq('标签保留', done.tags, ['各单位问题'])
eq('正文成为备注', done.note, '正文第一行\n正文第二行')
const projectList = store.listByname('回流数据优化')
ok('项目变成了同名清单', projectList !== null)
eq('清单颜色按最接近的预设色落地', projectList.color, '#3fa662')
eq('任务的归属是老项目', done.listId, projectList.id)

const subs = [...store.childrenOf('src-1')].sort((a, b) => (a.id < b.id ? -1 : 1))
eq('两个子任务都挂上了', subs.map((s) => s.id), ['sub-1', 'sub-2'])
eq('子任务的完成状态保留', subs.map((s) => s.done), [true, false])
ok('子任务沿用父任务的创建时间', subs.every((s) => s.createdAt === done.createdAt),
  subs.map((s) => s.createdAt))
ok('没有凭空给子任务编一个完成时间', subs[0].completedAt === null, subs[0].completedAt)
eq('子任务沿用父任务的清单', subs.map((s) => s.listId), [projectList.id, projectList.id])
ok('子任务的 id 也来自源文件', store.get('sub-1').parentId === 'src-1')

const repeating = store.get('src-2')
eq('每日重复被映射成真实规则',
  [repeating.recurrence.freq, repeating.recurrence.interval, repeating.recurrence.weekdays],
  ['daily', 1, null])
ok('重复规则没有凭空带上结束条件',
  repeating.recurrence.until === null && repeating.recurrence.count === null, repeating.recurrence)
ok('没有截止时间的重复任务有一个系列锚点', typeof repeating.seriesAnchor === 'string', repeating.seriesAnchor)
ok('提醒时间写进备注，而不是被丢掉或假装支持', repeating.note.includes('提醒 10:00'), repeating.note)

const doing = store.get('src-3')
eq('doing 变成标签，而不是被吞掉', doing.tags, ['进行中'])
eq('doing 的任务本身不算完成', doing.done, false)

const blocked = store.get('src-4')
eq('block 也变成标签', blocked.tags, ['受阻'])
eq('解析不到的项目落到收集箱', blocked.listId, 'l_inbox')

// --- a second run must be a no-op ------------------------------------------

console.log('--- 重复导入 ---')
const before = fs.readFileSync(file, 'utf8')
const afterFirst = JSON.parse(before).tasks.length
const second = run([])
ok('重复导入以 0 退出', second.status === 0, second.status)
store = new TodoStore({ dataFile: file }).load()
eq('重复导入没有新增任务', store.tasks.length, afterFirst)
eq('重复导入没有新增清单', store.lists.filter((l) => !l.system).length, 1)
ok('第二次导入前把原文件备份了',
  fs.readdirSync(scratch).some((f) => f.startsWith('tasks.json.before-import-')),
  fs.readdirSync(scratch))

// --- dry run writes nothing ------------------------------------------------

console.log('--- 预演 ---')
const snapshot = fs.readFileSync(file, 'utf8')
const dry = run(['--dry-run'])
ok('预演以 0 退出', dry.status === 0, dry.status)
eq('预演没有写文件', fs.readFileSync(file, 'utf8'), snapshot)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILING: ${fail} of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)

/**
 * Import markdown todos (the "案台" export format: one `.md` per task) into the
 * plugin's own document.
 *
 *   node scripts/import-markdown-todos.mjs --from "<待办 dir>" [--projects "<项目 dir>"]
 *                                          [--data-file <tasks.json>] [--dry-run]
 *                                          [--push http://127.0.0.1:43129]
 *
 * `--push` exists because of one specific hazard: a running `dsh web` keeps the
 * whole document in MEMORY and writes it back on the next edit, so importing the
 * file underneath a live instance means the first checkbox the user ticks can
 * wipe the import. `--push` hands the merged document to that instance's own
 * import route, so the running copy and the file agree and no restart is needed
 * for the data (the plugin code itself still needs a restart to be re-read).

 * The source format is one file per task: a YAML frontmatter block (`id`,
 * `status`, `priority`, `due`, `repeat`, `tags`, `subtasks`, …) followed by an
 * H1 title and an optional free-text body. Its two-level model maps onto this
 * plugin's model nearly one-to-one:
 *
 *   project_id      -> 清单 (a project becomes a list, reused by name)
 *   status: done    -> the done flag, not a list; the 已完成 smart list shows them
 *   status: doing/block/workflow -> a tag (进行中 / 受阻 / 流程中), because this
 *                      plugin has no third state and a tag survives moves
 *   priority        -> high/mid/low becomes 3/2/1
 *   repeat          -> a real recurrence rule (daily / weekly / monthly)
 *   remind          -> a line in the note (v1 has no reminders; see the README)
 *   tags, subtasks  -> tags, subtasks
 *   id              -> KEPT, so a re-run is idempotent and every task stays
 *                      traceable to the file it came from
 *
 * Safety: the target file is copied aside before the first write, the import
 * never deletes or rewrites anything, and `--dry-run` prints the whole plan
 * without touching disk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { LIST_PALETTE, TodoStore, defaultDataFile } from '../lib/store.js'

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const DRY = process.argv.includes('--dry-run')
const FROM = argOf('from', null)
const PROJECTS = argOf('projects', null)
const PUSH = argOf('push', null)
const DATA_FILE = path.resolve(argOf('data-file', defaultDataFile()))

if (FROM === null) {
  console.error('usage: node scripts/import-markdown-todos.mjs --from "<dir>" [--projects "<dir>"] [--data-file <file>] [--dry-run]')
  process.exit(2)
}
if (!fs.existsSync(FROM)) {
  console.error(`no such folder: ${FROM}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// a parser for the small YAML subset this format actually uses
// ---------------------------------------------------------------------------

function scalar(value) {
  if (value === '' || value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return quoted === null ? value : quoted[1]
}

/**
 * Frontmatter + body. Deliberately narrow: scalars, a string list (`tags`) and
 * an object list (`subtasks`). Anything else is ignored rather than guessed at.
 */
function parseMarkdown(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (match === null) return null
  const meta = { tags: [], subtasks: [] }
  let block = null
  let current = null
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const indented = rawLine.length !== rawLine.trimStart().length
    if (!indented) {
      current = null
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (kv === null) continue
      const value = kv[2].trim()
      if (value === '') { block = kv[1]; continue }
      block = null
      meta[kv[1]] = scalar(value)
      continue
    }
    if (block === 'tags') {
      const item = /^-\s*(.*)$/.exec(line)
      if (item !== null) {
        const value = scalar(item[1])
        if (typeof value === 'string' && value.trim() !== '' && !meta.tags.includes(value)) meta.tags.push(value)
      }
      continue
    }
    if (block === 'subtasks') {
      const start = /^-\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (start !== null) {
        current = { [start[1]]: scalar(start[2].trim()) }
        meta.subtasks.push(current)
        continue
      }
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (kv !== null && current !== null) current[kv[1]] = scalar(kv[2].trim())
    }
  }
  return { meta, body: match[2] }
}

/** The export's timestamps are ISO/UTC; the plugin stores local wall-clock. */
function localStamp(value) {
  if (typeof value !== 'string' || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function nearestPalette(hex) {
  const rgb = (h) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(h))
    return m === null ? null : [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  }
  const want = rgb(hex)
  if (want === null) return null
  let best = null
  let bestGap = Infinity
  for (const candidate of LIST_PALETTE) {
    const have = rgb(candidate)
    const gap = (have[0] - want[0]) ** 2 + (have[1] - want[1]) ** 2 + (have[2] - want[2]) ** 2
    if (gap < bestGap) { bestGap = gap; best = candidate }
  }
  return best
}

// ---------------------------------------------------------------------------
// read the source
// ---------------------------------------------------------------------------

const PROJECT_STATUS_TAGS = { doing: '进行中', block: '受阻', workflow: '流程中' }
const PRIORITIES = { high: 3, mid: 2, low: 1 }
const REPEATS = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' }

/** id -> { name, color } from the export's 项目 folder, when it is available. */
function readProjects(dir) {
  const map = new Map()
  if (dir === null || !fs.existsSync(dir)) return map
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const parsed = parseMarkdown(fs.readFileSync(path.join(dir, name), 'utf8'))
    if (parsed === null || parsed.meta.type !== 'project') continue
    const h1 = /^#\s+(.*)$/m.exec(parsed.body)
    const title = h1 === null ? name.replace(/\.md$/, '') : h1[1].trim()
    if (typeof parsed.meta.id === 'string' && parsed.meta.id !== '') {
      map.set(parsed.meta.id, { name: title, color: nearestPalette(parsed.meta.color) })
    }
  }
  return map
}

const projects = readProjects(PROJECTS)

const records = []
const problems = []
for (const fileName of fs.readdirSync(FROM).sort()) {
  if (!fileName.endsWith('.md')) continue
  const parsed = parseMarkdown(fs.readFileSync(path.join(FROM, fileName), 'utf8'))
  if (parsed === null) { problems.push(`${fileName}: 没有 frontmatter，跳过`); continue }
  const { meta, body } = parsed
  if (meta.type !== undefined && meta.type !== null && meta.type !== 'task') continue

  const h1 = /^#\s+(.*)$/m.exec(body)
  const title = (h1 === null ? fileName.replace(/\.md$/, '') : h1[1]).trim()
  const noteParts = []
  const rest = body.replace(/^#\s+.*$/m, '').trim()
  if (rest !== '') noteParts.push(rest)
  if (typeof meta.remind === 'string' && meta.remind !== '') {
    noteParts.push(`（原记录设有提醒 ${meta.remind}，本插件 v1 不做提醒）`)
  }

  const done = meta.status === 'done'
  const statusTag = PROJECT_STATUS_TAGS[String(meta.status)]
  const tags = [...meta.tags, ...(statusTag === undefined ? [] : [statusTag])]
  const freq = REPEATS[String(meta.repeat)]
  const repeatDay = Number(meta.repeat_day)
  const project = meta.project_id === null || meta.project_id === undefined
    ? null
    : projects.get(String(meta.project_id)) ?? 'MISSING'

  records.push({
    file: fileName,
    id: typeof meta.id === 'string' && meta.id.trim() !== '' ? meta.id.trim() : null,
    title,
    note: noteParts.join('\n\n'),
    due: typeof meta.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.due) ? meta.due : null,
    priority: PRIORITIES[String(meta.priority)] ?? 0,
    done,
    completedAt: done ? localStamp(meta.completed_at) : null,
    createdAt: localStamp(meta.created_at),
    tags,
    recurrence: freq === undefined
      ? null
      : { freq, interval: 1, weekdays: freq === 'weekly' && Number.isInteger(repeatDay) ? [repeatDay] : null },
    projectId: meta.project_id === null || meta.project_id === undefined ? null : String(meta.project_id),
    projectName: project === null ? null : (project === 'MISSING' ? null : project.name),
    projectColor: project === null || project === 'MISSING' ? null : project.color,
    subtasks: meta.subtasks
      .filter((s) => typeof s.title === 'string' && s.title.trim() !== '')
      .map((s) => ({
        id: typeof s.id === 'string' && s.id.trim() !== '' ? s.id.trim() : null,
        title: s.title.trim(),
        done: s.done === true,
      })),
  })
  if (project === 'MISSING') problems.push(`${fileName}: 项目 ${meta.project_id} 不在项目目录里，落到收集箱`)
}

if (records.length === 0) {
  console.error(`no tasks found in ${FROM}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

const store = new TodoStore({ dataFile: DATA_FILE }).load()

/** Projects become lists, reused by name, so a re-run cannot duplicate them. */
const newLists = []
const listIdFor = new Map()
for (const record of records) {
  if (record.projectId === null) continue
  if (listIdFor.has(record.projectId)) continue
  const existing = record.projectName === null ? null : store.listByname(record.projectName)
  if (existing !== null) { listIdFor.set(record.projectId, existing.id); continue }
  if (record.projectName === null) { listIdFor.set(record.projectId, null); continue }
  const planned = { name: record.projectName, color: record.projectColor }
  newLists.push(planned)
  listIdFor.set(record.projectId, `pending:${record.projectName}`)
}

const inbox = store.listById('l_inbox')
const inboxId = inbox === null ? (store.lists[0]?.id ?? 'l_inbox') : inbox.id

const summary = {
  file: DATA_FILE,
  from: FROM,
  tasks: records.length,
  open: records.filter((r) => !r.done).length,
  done: records.filter((r) => r.done).length,
  subtasks: records.reduce((n, r) => n + r.subtasks.length, 0),
  tags: records.filter((r) => r.tags.length > 0).length,
  recurring: records.filter((r) => r.recurrence !== null).length,
  lists: newLists.map((l) => l.name),
  inbox: records.filter((r) => r.projectId === null).length,
  skippedExisting: 0,
  renamedIds: 0,
}

// ---------------------------------------------------------------------------
// dry run: the whole plan, no writes
// ---------------------------------------------------------------------------

if (DRY) {
  console.log(`DRY RUN — nothing will be written (${DATA_FILE})\n`)
  console.log(`源目录: ${FROM}`)
  console.log(`项目目录: ${PROJECTS ?? '(未提供，所有任务归收集箱)'}`)
  console.log(`要新建的清单: ${newLists.length ? newLists.map((l) => `${l.name} ${l.color}`).join('、') : '(无)'}\n`)
  for (const record of records) {
    const flags = [
      record.done ? '已完成' : '未完成',
      record.due === null ? '无期限' : `截止 ${record.due}`,
      record.priority > 0 ? `优先级${record.priority}` : null,
      record.recurrence === null ? null : `重复 ${record.recurrence.freq}`,
      record.tags.length > 0 ? `#${record.tags.join(' #')}` : null,
      record.subtasks.length > 0 ? `子任务 ${record.subtasks.length}` : null,
      record.projectName === null ? '收集箱' : record.projectName,
      store.get(record.id) === null ? null : '已存在，将跳过',
    ].filter((x) => x !== null)
    console.log(`- ${record.title}\n    ${flags.join(' · ')}`)
  }
  console.log(`\n共 ${records.length} 条（未完成 ${summary.open} / 已完成 ${summary.done}），子任务 ${summary.subtasks} 个`)
  if (problems.length) console.log(`\n注意:\n  ${problems.join('\n  ')}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

if (fs.existsSync(DATA_FILE)) {
  const backup = `${DATA_FILE}.before-import-${Date.now()}`
  try {
    fs.copyFileSync(DATA_FILE, backup)
    summary.backup = backup
  } catch (e) {
    console.error(`cannot back up ${DATA_FILE}: ${e.message}`)
    process.exit(1)
  }
}

for (const planned of newLists) {
  const created = store.createList({ name: planned.name, color: planned.color ?? undefined })
  for (const [key, value] of listIdFor) {
    if (value === `pending:${planned.name}`) listIdFor.set(key, created.id)
  }
}

for (const record of records) {
  if (record.id !== null && store.get(record.id) !== null) { summary.skippedExisting++; continue }
  const wantedId = record.id
  const created = store.create({
    id: record.id ?? undefined,
    title: record.title,
    note: record.note,
    due: record.due,
    priority: record.priority,
    tags: record.tags,
    done: record.done,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    // The source format has no start date, and `create` would otherwise default it
    // to "now" -- which would draw a 2026 bar for a task written down in 2024. An
    // explicit null is the opt-out, and it keeps the import honest: a gap is a
    // fact about the old data, not something to paper over.
    start: null,
    recurrence: record.recurrence,
    listId: listIdFor.get(record.projectId) ?? inboxId,
  })
  if (wantedId !== null && created.id !== wantedId) summary.renamedIds++
  for (const sub of record.subtasks) {
    if (sub.id !== null && store.get(sub.id) !== null) { summary.skippedExisting++; continue }
    // The source records neither a subtask's own creation time nor its completion
    // time, so it borrows the parent's creation time and leaves completion empty
    // rather than stamping "now" onto history.
    store.addSubtask(created.id, {
      id: sub.id ?? undefined,
      title: sub.title,
      done: sub.done,
      createdAt: record.createdAt ?? undefined,
      start: null,
    })
  }
}

store.save()

// Hand the result to a live instance so its in-memory copy cannot clobber it.
if (PUSH !== null) {
  const url = `${String(PUSH).replace(/\/+$/, '')}/todo/api/importDocument`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: store.document() }),
    })
    const body = await response.json()
    if (body.ok !== true) throw new Error(String(body.error ?? 'unknown error'))
    summary.pushed = `${body.data.tasks} 条任务 / ${body.data.lists} 个清单`
  } catch (e) {
    summary.pushError = `${url} → ${String(e?.message ?? e)}`
  }
}

console.log('imported markdown todos')
console.log('='.repeat(60))
console.log(`  数据文件    ${summary.file}`)
console.log(`  源目录      ${summary.from}`)
if (summary.backup !== undefined) console.log(`  导入前备份  ${summary.backup}`)
console.log(`  任务        ${summary.tasks}（未完成 ${summary.open} / 已完成 ${summary.done}）`)
console.log(`  子任务      ${summary.subtasks}`)
console.log(`  进收集箱    ${summary.inbox}`)
console.log(`  带标签      ${summary.tags} · 带重复 ${summary.recurring}`)
console.log(`  新建清单    ${summary.lists.length ? summary.lists.join('、') : '(无)'}`)
if (summary.skippedExisting > 0) console.log(`  已存在跳过  ${summary.skippedExisting}`)
if (summary.renamedIds > 0) console.log(`  id 被占用改用新 id  ${summary.renamedIds}`)
if (summary.pushed !== undefined) console.log(`  已同步到运行中的实例  ${summary.pushed}`)
if (summary.pushError !== undefined) {
  console.log(`\n!! 没能同步到运行中的实例：${summary.pushError}`)
  console.log('   文件已经写好，但那边的内存副本仍是旧的——请重启 dsh web 再操作界面，')
  console.log('   否则它的下一次保存会覆盖这次导入。')
}
if (problems.length) console.log(`\n注意:\n  ${problems.join('\n  ')}`)
console.log(`\n现有 ${store.lists.length} 个清单 · ${store.tasks.length} 条任务`)

/**
 * Write a realistic demo data file for screenshots.
 *
 * The screenshot loop must never touch the user's own `~/.dsh/todo/tasks.json`,
 * so `shot.mjs` starts its throwaway `dsh web` with a `--patch` overlay that
 * points the plugin's `dataFile` at whatever this script writes (default:
 * `scripts/.shot/demo-tasks.json`, which is gitignored).
 *
 * Dates are computed from today so the seed keeps producing overdue / today /
 * upcoming buckets on any day it is regenerated.
 *
 *   node scripts/demo-seed.mjs [--out <file>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Everything this script writes stays under `scripts/.shot/` (gitignored).
const SHOT_ROOT = path.join(HERE, '.shot')
const shotHome = path.join(SHOT_ROOT, 'home')

const argOut = (() => {
  const i = process.argv.indexOf('--out')
  // The store's default path inside the isolated home -- so the demo data is
  // what the throwaway reads with no plugin setting involved at all.
  return i === -1 ? path.join(shotHome, 'todo', 'tasks.json') : process.argv[i + 1]
})()

// --- local date helpers (mirrors the plugin's own local-day convention) ------

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function shift(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  return iso(d)
}

const at = (dayOffset, hhmm) => `${shift(dayOffset)}T${hhmm}`

const now = new Date()
const stamp = `${iso(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

// --- lists ------------------------------------------------------------------

const lists = [
  { id: 'l_inbox', name: '收集箱', color: '#4f8cff', order: 0, system: true },
  { id: 'l_work', name: '工作', color: '#e5484d', order: 1, system: false },
  { id: 'l_life', name: '生活', color: '#22a06b', order: 2, system: false },
  { id: 'l_study', name: '学习', color: '#a855f7', order: 3, system: false },
]

// --- tasks ------------------------------------------------------------------

let seq = 0
const id = () => `t_demo${String(++seq).padStart(3, '0')}`

/** A task with every field defaulted, so the seed stays readable. */
function task(title, patch) {
  return {
    id: id(),
    title,
    note: '',
    done: false,
    completedAt: null,
    priority: 0,
    listId: 'l_inbox',
    parentId: null,
    order: seq,
    tags: [],
    due: null,
    start: null,
    recurrence: null,
    seriesAnchor: null,
    completedCount: 0,
    seriesFinished: false,
    skipped: [],
    history: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  }
}

const tasks = []

// -- overdue ---------------------------------------------------------------
tasks.push(task('修复登录页验证码不刷新的问题', {
  listId: 'l_work', priority: 3, due: `${shift(-2)}T18:00`,
  tags: ['工作', '缺陷'],
  note: '复现路径：退出登录 → 连续输错 3 次 → 验证码图片不重新请求。\n怀疑是前端缓存了 blob URL，先看 network 面板。',
}))
tasks.push(task('把上季度报销单补齐寄出', {
  listId: 'l_life', priority: 2, due: shift(-1), tags: ['家庭'],
}))

// -- today -----------------------------------------------------------------
const report = task('写 Q3 复盘报告', {
  listId: 'l_work', priority: 3, due: `${shift(0)}T17:30`, tags: ['工作', '汇报'],
  start: shift(-1),
  note: '结构：目标回顾 → 数据对比 → 三个关键决策 → 下季度赌注。\n控制在 6 页以内，先写文字再配图。',
})
tasks.push(report)
tasks.push(task('整理会议纪要并同步给项目组', {
  listId: 'l_work', priority: 2, due: `${shift(0)}T11:00`, tags: ['工作'],
}))
tasks.push(task('下午四点对接设计稿评审', {
  listId: 'l_work', priority: 1, due: `${shift(0)}T16:00`,
}))
tasks.push(task('买菜：西兰花、鸡胸、牛奶', {
  listId: 'l_life', priority: 0, due: shift(0),
}))

// -- upcoming --------------------------------------------------------------
tasks.push(task('准备下周技术分享的讲稿', {
  listId: 'l_study', priority: 2, due: `${shift(3)}T20:00`, start: shift(1), tags: ['学习'],
  note: '主题：从零实现一个插件系统。\n重点讲清楚「注册 → 解析 → 生命周期」三段。',
}))
tasks.push(task('预约牙科复诊', {
  listId: 'l_life', priority: 1, due: shift(4), tags: ['健康'],
}))
tasks.push(task('整理知识库里的散落笔记', {
  listId: 'l_study', priority: 0, due: shift(6), start: shift(2),
}))
tasks.push(task('给父母订下个月的体检套餐', {
  listId: 'l_life', priority: 1, due: shift(9), tags: ['家庭'],
}))

// -- undated ---------------------------------------------------------------
tasks.push(task('调研一下本地优先的同步方案', {
  listId: 'l_study', priority: 1, tags: ['学习'], note: 'CRDT 还是快照 + 冲突留痕？先看两个成熟实现再定。',
}))
tasks.push(task('换掉书房那盏总是闪的台灯', { listId: 'l_life', priority: 0 }))

// -- recurring -------------------------------------------------------------
tasks.push(task('晨跑 5 公里', {
  listId: 'l_life', priority: 2, due: `${shift(0)}T06:30`, start: `${shift(0)}T06:30`,
  recurrence: { freq: 'daily', interval: 1, weekdays: null, until: null, count: null },
  seriesAnchor: shift(0), completedCount: 12, tags: ['健康'],
}))
tasks.push(task('周会同步进度', {
  listId: 'l_work', priority: 1, due: `${shift(1)}T10:00`, start: `${shift(1)}T10:00`,
  recurrence: { freq: 'weekly', interval: 1, weekdays: [1], until: null, count: null },
  seriesAnchor: shift(1), completedCount: 4,
}))
tasks.push(task('每月 5 日交房租', {
  listId: 'l_life', priority: 2, due: shift(5),
  recurrence: { freq: 'monthly', interval: 1, weekdays: null, until: null, count: null },
  seriesAnchor: shift(5), completedCount: 8, tags: ['家庭'],
}))

// -- done ------------------------------------------------------------------
tasks.push(task('把旧项目的依赖升到 Node 20', {
  listId: 'l_work', priority: 1, done: true, completedAt: `${shift(-1)}T15:20`, due: shift(-1),
}))
tasks.push(task('备份照片到移动硬盘', {
  listId: 'l_life', priority: 0, done: true, completedAt: `${shift(-3)}T21:05`,
}))

// -- subtasks (nested under real parents) ----------------------------------
const sub = (parent, title, patch) => tasks.push(task(title, { parentId: parent.id, listId: parent.listId, ...patch }))

sub(report, '拉取 Q3 全部核心指标', { done: true, completedAt: `${shift(0)}T09:40` })
sub(report, '写成三页文字稿', { priority: 1 })
sub(report, '找设计同学配图', {})

const share = tasks.find((t) => t.title.includes('技术分享'))
sub(share, '列出大纲和示例代码', { done: true, completedAt: `${shift(-1)}T22:10` })
sub(share, '准备一个可运行的最小 demo', { priority: 2 })
sub(share, '提前一天发通知', { due: `${shift(2)}T12:00` })

const doc = {
  meta: { version: 1, createdAt: stamp, updatedAt: stamp },
  lists,
  tasks,
}

// ---------------------------------------------------------------------------
// an isolated DSH_HOME for the screenshot run
// ---------------------------------------------------------------------------
//
// `dsh` honours $DSH_HOME, so the throwaway instance can live in a throwaway
// home. That is strictly better than the tempting alternatives: pointing the
// plugin's `dataFile` setting at the demo file would edit the user's real
// `settings.yaml`, and swapping `~/.dsh/todo/tasks.json` in place would put the
// user's own tasks behind a temporary file.
//
// No settings are needed to relocate the data: the store's default path is
// `$DSH_HOME/todo/tasks.json`, so inside this home it is already throwaway. The
// only setting written is a pinned light theme, so the PNGs are reproducible.
// The profile's `node_modules` is a junction, so building the home costs
// milliseconds instead of a pnpm install.
//
// The home is rebuilt BEFORE the demo document is written -- the demo file lives
// inside it, so wiping afterwards would delete exactly what this script exists
// to produce (which it did, once).

const realHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const realProfile = path.join(realHome, 'profiles', 'web')
const shotProfile = path.join(shotHome, 'profiles', 'web')

if (!fs.existsSync(path.join(realProfile, 'package.json'))) {
  console.error(`no web profile at ${realProfile}`)
  process.exit(1)
}

fs.rmSync(shotHome, { recursive: true, force: true })
fs.mkdirSync(shotProfile, { recursive: true })

for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) {
  const src = path.join(realProfile, name)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(shotProfile, name))
}
// The bundles' dependencies are read-only for this run, so a junction is right:
// it cannot go stale and it never duplicates the install.
fs.symlinkSync(path.join(realProfile, 'node_modules'), path.join(shotProfile, 'node_modules'), 'junction')

fs.writeFileSync(path.join(shotHome, 'settings.yaml'), [
  '# generated by scripts/demo-seed.mjs for the screenshot run',
  'ui-theme:',
  '  preference: light',
  '',
].join('\n'), 'utf8')

// Last, so the rebuilt home cannot wipe it.
fs.mkdirSync(path.dirname(argOut), { recursive: true })
fs.writeFileSync(argOut, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

const open = tasks.filter((t) => !t.done).length
console.log(`demo seed:  ${argOut}`)
console.log(`shot home:  ${shotHome}`)
console.log(`  ${lists.length} lists · ${tasks.length} tasks (${open} open, ${tasks.length - open} done) · today ${shift(0)}`)
console.log(`\nstart the throwaway with:\n  $env:DSH_HOME="${shotHome}"\n  dsh --profile web --port 4188 --no-open`)

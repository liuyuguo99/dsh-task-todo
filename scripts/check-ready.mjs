/**
 * The delivery gate: run every check this package has, in order, and report one
 * verdict.
 *
 * Child processes use `stdio: 'inherit'`. Under the DSH file sandbox a child
 * whose stdio is piped cannot open the pipe (EPERM), so capturing output here
 * would make the gate fail for a reason that has nothing to do with the plugin.
 * Each script prints its own summary and owns its own exit code.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const pkgRoot = path.join(here, '..')

const GATES = [
  ['form audit (bundle vs dynamic API, injection, plain JS)', 'audit-shape.mjs'],
  ['stylesheet covers every class the JSX uses', 'audit-css.mjs'],
  ['recurrence engine', 'test-recurrence.mjs'],
  ['store, filters and view payloads', 'test-store.mjs'],
  ['markdown todo import (mapping, idempotency, dry run)', 'test-import-markdown.mjs'],
  ['lossless JSON over every tool / HTTP / command surface', 'test-json-gate.mjs'],
  ['client render, registration and interactions', 'verify-client-render.mjs'],
]

console.log('dsh-task-todo delivery gate')
console.log('='.repeat(72))

const results = []
for (const [label, script] of GATES) {
  const file = path.join(here, script)
  if (!fs.existsSync(file)) {
    results.push({ label, script, status: 'missing', code: -1 })
    continue
  }
  console.log(`\n### ${label}  (${script})`)
  const started = Date.now()
  const run = spawnSync(process.execPath, [file], { cwd: pkgRoot, stdio: 'inherit' })
  results.push({
    label,
    script,
    code: run.status ?? 1,
    ms: Date.now() - started,
  })
}

console.log('\n' + '='.repeat(72))
console.log('summary')
for (const result of results) {
  const mark = result.code === 0 ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${String(result.script).padEnd(28)} ${result.ms === undefined ? '' : result.ms + 'ms'}  ${result.label}`)
}

// A package that passes every gate but cannot be installed is not ready.
console.log('\ninstall readiness')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const checks = [
  ['package.json declares dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string'],
  ['package.json declares a web client', pkg.dsh?.client?.platform === 'web'],
  ['package.json exports ./client', pkg.exports?.['./client'] !== undefined],
  ['the host entry exists', fs.existsSync(path.join(pkgRoot, String(pkg.main).replace(/^\.\//, '')))],
  ['the client entry exists', fs.existsSync(path.join(pkgRoot, String(pkg.exports?.['./client'] ?? '').replace(/^\.\//, '')))],
  ['the patch file exists', fs.existsSync(path.join(pkgRoot, String(pkg.dsh?.bundle?.patch ?? '').replace(/^\.\//, '')))],
  // The row `name` is the resolvable package; the row `id` is the short Cordis
  // identity (the sibling plugin uses `knowledge-base` for `dsh-knowledge-base`).
  ['the patch mounts this package by name',
    fs.readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8').includes(`name: '${pkg.name}'`)],
]
let ready = true
for (const [label, condition] of checks) {
  if (!condition) ready = false
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
}

const failed = results.filter((result) => result.code !== 0)
console.log('\n' + '='.repeat(72))
if (failed.length === 0 && ready) {
  console.log('READY: all gates pass and the package is installable.')
  console.log('Install with:  dsh plugin --profile web add "' + pkgRoot + '"')
  console.log('Then restart dsh web; the bundle layer is only read at startup.')
  process.exit(0)
}
console.log(`NOT READY: ${failed.length} gate(s) failing; package shape ready: ${ready}`)
process.exit(1)

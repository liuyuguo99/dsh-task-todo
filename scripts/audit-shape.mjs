/**
 * Form-consistency audit.
 *
 * Every check here exists because that exact mistake was made in this workspace
 * and cost real debugging time. They are cheap regression guards, not style
 * preferences:
 *
 *   1. `styles.insert` in a bundle-plugin client   -> the whole DSH boot dies
 *   2. a client factory that ignores `require`     -> no React, blank UI
 *   3. `ctx.harness` / `host.call` in a bundle     -> silently does nothing
 *   4. `undocumented service method` calls         -> throws at the user, not at boot
 *   5. a service used but not declared in `inject` -> strict injection refuses it
 *   6. JSX / TypeScript in a client half           -> the bundle never parses
 *   7. the bundle id drifting from package.json    -> the module never mounts
 */
import fs from 'node:fs'
import path from 'node:path'

const pkgRoot = path.join(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(pkgRoot, rel))

let pass = 0
let fail = 0
const problems = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); return }
  fail++
  problems.push(name)
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
}

/** Strip comments so prose about a banned API does not trip its own check. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
}

const pkg = JSON.parse(read('package.json'))
const client = read('lib/client.js')
const host = read('lib/index.js')
const store = read('lib/store.js')
const recurrence = read('lib/recurrence.js')
const patch = read('cordis.patch.yml')
const clientCode = stripComments(client)
const hostCode = stripComments(host)

console.log('--- package contract ---')
ok('the package declares a name', typeof pkg.name === 'string' && pkg.name.length > 0, pkg.name)
ok('the bundle patch is declared', typeof pkg.dsh?.bundle?.patch === 'string')
ok('the declared patch file exists', exists(String(pkg.dsh.bundle.patch).replace(/^\.\//, '')), pkg.dsh?.bundle?.patch)
ok('the client half is declared for web', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client)
ok('the client entry is exported', pkg.exports?.['./client'] !== undefined, Object.keys(pkg.exports ?? {}))
ok('the skills entry points at a real file',
  Array.isArray(pkg.dsh?.skills) && pkg.dsh.skills.every((rel) => exists(String(rel).replace(/^\.\//, ''))),
  pkg.dsh?.skills)
ok('the host entry exists', exists(String(pkg.main).replace(/^\.\//, '')), pkg.main)
ok('engine and type are declared', pkg.type === 'module' && typeof pkg.version === 'string')

console.log('--- cordis.patch.yml ---')
ok('the patch inserts a row for this package', patch.includes('insert:') && patch.includes(`name: '${pkg.name}'`)
  || patch.includes(`name: ${pkg.name}`), patch.trim().split('\n').slice(-4))
ok('the patch row carries an id', /(^|\s)id:\s*\S+/m.test(patch))

console.log('--- the two plugin forms must not be mixed ---')
ok('the client obtains React through require', /require\(\s*['"]react['"]\s*\)/.test(clientCode))
ok('the client never uses window.React', !/window\.React\b/.test(clientCode))
ok('the client injects the slots service', /inject:\s*\[[^\]]*['"]slots['"]/.test(clientCode))
ok('the client factory accepts require', /factory:\s*\(\s*require\s*\)\s*=>/.test(clientCode))
ok('the client registers under the package name',
  new RegExp(`id:\\s*['"]${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(clientCode))
ok('the client never calls styles.insert', !/styles\s*\.\s*insert/.test(clientCode))
ok('the client never calls host.call', !/\bhost\s*\.\s*call\b/.test(clientCode))
ok('the client never touches ctx.harness', !/ctx\s*\.\s*harness/.test(clientCode))
ok('the host never touches ctx.harness', !/ctx\s*\.\s*harness/.test(hostCode))
ok('the host never calls harness.handle', !/harness\s*\.\s*handle/.test(hostCode))
ok('the client injects its stylesheet with a real element',
  /document\.createElement\(\s*['"]style['"]\s*\)/.test(clientCode)
  && /head\.appendChild/.test(clientCode))
ok('the stylesheet tag carries a stable key for idempotent injection',
  /dataset\.pluginCss\s*=/.test(clientCode) && /querySelector\(\s*`style\[data-plugin-css=/.test(clientCode))

console.log('--- plain JavaScript only ---')
for (const [name, source] of [['client', clientCode], ['host', hostCode], ['store', stripComments(store)]]) {
  ok(`${name}: no import statements in the client form`, name !== 'client' || !/^\s*import\s/m.test(source))
  ok(`${name}: no JSX closing tag`, !/<\/[A-Za-z][A-Za-z0-9.]*\s*>/.test(source))
  ok(`${name}: no JSX self-closing tag`, !/<[A-Z][A-Za-z0-9]*\s*\/>/.test(source))
  ok(`${name}: no TypeScript as-assertion`, !/\bas\s+(string|number|boolean|unknown|any|never)\b/.test(source))
  ok(`${name}: no type annotation on a declaration`,
    !/\b(?:const|let|function)\s+\w+\s*(?::\s*\w|\)\s*:\s*\w)/.test(source))
}
ok('the client has no import statement', !/^\s*import\s/m.test(clientCode))
ok('the client uses createElement aliased to h', /const h = React\.createElement/.test(clientCode))

console.log('--- strict injection ---')
const injectMatch = /export const inject = \[([^\]]*)\]/.exec(hostCode)
const declared = injectMatch === null
  ? []
  : injectMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
ok('the host declares an inject list', injectMatch !== null, injectMatch?.[1])
const usedServices = [...hostCode.matchAll(/ctx\.get\(\s*['"]([a-zA-Z]+)['"]\s*\)/g)].map((m) => m[1])
const usedAsProperty = [...hostCode.matchAll(/ctx\.([a-zA-Z]+)\s*\.\s*\w+\s*\(/g)].map((m) => m[1])
const needed = [...new Set([...usedServices, ...usedAsProperty])]
  .filter((name) => !['logger', 'effect', 'on', 'get', 'emit', 'provide'].includes(name))
const missing = needed.filter((name) => !declared.includes(name))
ok('every service read through ctx.get is injected', missing.length === 0, { needed, declared, missing })
ok('the HTTP route is registered through the webServer service', declared.includes('webServer'))
ok('tools are registered through the tools service', declared.includes('tools'))
ok('the slash command registers through the commands service', declared.includes('commands'))
ok('registration happens inside a lifecycle effect',
  /ctx\.effect\(\(\) =>/.test(hostCode) && /register\(/.test(hostCode))

console.log('--- service method audit (the "invented method" incident) ---')
const classStart = hostCode.indexOf('class TodoService')
// The class ends where the apply()/tool section begins; slice defensively so a
// missing marker fails loudly instead of silently auditing zero methods.
const classEnd = hostCode.indexOf('export function apply')
const classBody = classStart < 0 || classEnd < classStart ? '' : hostCode.slice(classStart, classEnd)
ok('the service class was located for auditing', classBody.length > 1000, classBody.length)
const definedMethods = new Set(
  [...classBody.matchAll(/^ {2}(?:async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*\(/gm)].map((m) => m[1]),
)
const calledMethods = new Set([...hostCode.matchAll(/\bthis\.([\w$]+)\s*\(/g)].map((m) => m[1]))
const builtins = new Set(['require', 'constructor', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof'])
const invented = [...calledMethods].filter((name) => !definedMethods.has(name) && !builtins.has(name))
ok('every this.<method>() called in the host is defined on the service', invented.length === 0,
  { invented, defined: [...definedMethods].length })

const storeMethods = new Set([...stripComments(store).matchAll(/^ {2}(?:async\s+)?([\w$]+)\s*\(/gm)].map((m) => m[1]))
const storeCalls = new Set([...hostCode.matchAll(/\bstore\.([\w$]+)\s*\(/g)].map((m) => m[1]))
const inventedStore = [...storeCalls].filter((name) => !storeMethods.has(name))
ok('every store.<method>() called in the host exists on TodoStore', inventedStore.length === 0,
  { inventedStore })

console.log('--- lossless JSON discipline (static hints) ---')
const hostLines = hostCode.split('\n')
const suspicious = hostLines
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  // Returning an undefined-valued key is the classic 100%-failure bug.
  .filter(({ line }) => /(?:^|[{,\s])[\w$]+:\s*[^,}]*\?\s*undefined/.test(line))
  .filter(({ line }) => !line.startsWith('//'))
ok('no ternary returns undefined into an object literal', suspicious.length === 0, suspicious)
ok('no NaN/Infinity literal flows into a reply', !/\bNaN\b/.test(hostCode) || !/return\s+\{[^}]*NaN/.test(hostCode))
ok('the host sanitizes every reply',
  /function sanitize\(/.test(hostCode) && /sanitize\(/.test(hostCode))
ok('the HTTP handler routes every reply through the sanitizer',
  /send\(\s*res[^)]*sanitize\(/.test(hostCode) || /sanitize\(\s*\{[\s\S]{0,200}?send\(/.test(hostCode))

console.log('--- surfaces the tests cover ---')
for (const tool of ['task_list', 'task_add', 'task_update', 'task_done', 'task_delete']) {
  ok(`the host defines the ${tool} tool`, host.includes(`name: '${tool}'`))
}
ok('the slash command is registered', /name: 'todo'/.test(hostCode) && /commands/.test(hostCode))
ok('the recurrence engine is host-only', !/recurrence\.js/.test(clientCode) && exists('lib/recurrence.js'))
ok('the client never re-implements recurrence math',
  !/nextOccurrence|expandOccurrences|isOccurrence/.test(clientCode))

console.log('--- files expected in the package ---')
for (const rel of ['lib/index.js', 'lib/client.js', 'lib/store.js', 'lib/recurrence.js',
  'scripts/check-ready.mjs', 'scripts/test-store.mjs', 'scripts/test-recurrence.mjs',
  'scripts/test-json-gate.mjs', 'scripts/test-import-markdown.mjs',
  'scripts/verify-client-render.mjs', 'scripts/audit-shape.mjs',
  'scripts/import-markdown-todos.mjs', 'scripts/smoke-live.mjs',
  'skills/todo/SKILL.md', 'README.md']) {
  ok(`present: ${rel}`, exists(rel))
}

console.log('')
console.log(fail === 0 ? `AUDIT: ALL PASS (${pass})` : `AUDIT FAILING: ${fail} of ${pass + fail}`)
for (const name of problems) console.log('   - ' + name)
process.exit(fail === 0 ? 0 : 1)

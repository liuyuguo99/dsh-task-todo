/**
 * Stylesheet coverage: every class the client's JSX asks for must have a rule.
 *
 * This is deliberately a static check, not a rendering one. `verify-client-render.mjs`
 * proves behaviour, but nothing there notices a class that simply has no CSS -- an
 * unstyled element still renders and still passes every behavioural assertion. The
 * user-visible symptom is "the UI looks broken", which is exactly the failure this
 * gate exists to prevent.
 *
 * The CDN class names are still checked with the real cascade in the browser; this
 * gate only checks that the RULE exists, never what it says.
 */
import fs from 'node:fs'
import path from 'node:path'

const pkgRoot = path.join(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) { pass++; return }
  fail++
  failures.push(name)
  console.log(`  FAIL ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`)
}
function section(title) { console.log('--- ' + title + ' ---') }

// ---------------------------------------------------------------------------
section('the stylesheet is where the checker thinks it is')
// ---------------------------------------------------------------------------

const cssStart = source.indexOf('const CSS = `')
ok('the client declares one stylesheet literal', cssStart >= 0)
const cssEnd = source.indexOf('\n`', cssStart)
ok('the stylesheet literal is terminated', cssEnd > cssStart)
const css = source.slice(cssStart, cssEnd)
ok('the stylesheet is non-trivial', css.length > 2000, css.length)

// A backtick typed inside the stylesheet ends the template literal right there,
// and the damage is invisible from the outside: `css` simply looks like a shorter
// sheet and every check below still passes. An unterminated comment at the cut
// point is the fingerprint -- a closed comment cannot be the last thing in the
// literal, so if it is, the text after it was swallowed by the JavaScript parser.
const lastOpen = css.lastIndexOf('/*')
const lastClose = css.lastIndexOf('*/')
ok('the stylesheet literal is not cut short by a stray backtick',
  lastOpen < 0 || lastOpen < lastClose, { lastOpen, lastClose })

// The two silent killers of an embedded stylesheet, checked directly because
// `node --check` is NOT enough: a backtick inside the literal closes it early, and
// whether the rest still parses is luck -- one shape leaves a syntax error, another
// (a backtick pair in a comment) leaves syntactically valid JavaScript that reads
// the comment as an expression and blows up at runtime, in the client, in the
// browser. Both were hit in t12, the second one AFTER node --check reported 0.
// `${` is the same trap from the other side: the template would interpolate it and
// quietly delete a chunk of the sheet.
//
// Checked on the sheet BODY: `css` starts at the `const CSS = ` marker, so the
// opening delimiter is part of the slice by construction.
const sheetBody = css.replace(/^[^`]*`/, '')
ok('the extracted stylesheet contains no backtick', !sheetBody.includes('`'),
  (sheetBody.match(/.{0,40}`.{0,40}/g) ?? []).slice(0, 3))
ok('the extracted stylesheet contains no interpolation sequence', !sheetBody.includes('${'),
  (sheetBody.match(/.{0,40}\$\{.{0,40}/g) ?? []).slice(0, 3))
// A sheet cut mid-rule loses its balance, which no amount of downstream parsing
// notices; every brace in the sheet is a rule delimiter, so the counts must agree.
const braces = sheetBody.replace(/\/\*[\s\S]*?\*\//g, ' ')
ok('the extracted stylesheet has balanced braces',
  (braces.match(/\{/g) ?? []).length === (braces.match(/\}/g) ?? []).length,
  { open: (braces.match(/\{/g) ?? []).length, close: (braces.match(/\}/g) ?? []).length })

// The components come AFTER the stylesheet literal, so exclude the CSS body
// (matching its own class names out of `className` would be circular). The `+ 2`
// steps over the closing backtick as well: leaving it in makes this file's own
// template literals pair up one backtick out of phase from here on.
const jsx = stripComments(source.slice(0, cssStart) + source.slice(cssEnd + 2))

/** Comments are prose, and prose quotes words -- drop them before scanning. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Trailing comments count too: `// 'YYYY-MM' for ...` leaves a stray
    // apostrophe behind, which pairs with the next one hours later in the file
    // and turns a whole block of code into one bogus "string".
    .replace(/(^|\s)\/\/.*$/gm, ' ')
}

// ---------------------------------------------------------------------------
section('classes asked for by the JSX')
// ---------------------------------------------------------------------------

// Every string literal in the components is a candidate class list, because a
// class list reaches `className` through more shapes than one: a plain literal, a
// template with interpolations, a concatenation of both, or a local variable that
// a `className` then points at (TaskRow's class list is built that way). Scanning
// only `className:` expressions silently stopped seeing a class the moment it
// moved into a helper, so the shapes are handled here instead of in the callers.
const pieces = []
for (const match of jsx.matchAll(/'([^']*)'/g)) pieces.push(match[1])
for (const match of jsx.matchAll(/`([^`]*)`/g)) pieces.push(match[1])

const STRUCTURAL = /^td-[a-z0-9-]+$/
const BARE_WORD = /^[a-z][a-z0-9-]{0,15}$/
const used = new Set()
for (const raw of pieces) {
  // `td-item${x} done` names two tokens; drop the interpolation before splitting.
  for (const piece of raw.split(/\$\{[^}]*\}/)) {
    const tokens = piece.split(/\s+/).filter((token) => token !== '')
    const isClassList = tokens.some((token) => STRUCTURAL.test(token))
    // `' done'` / `' p1'` are conditional modifiers, not literals: they are only
    // ever read as such when the whole string is one bare word with leading
    // space, so a value like `${a} / span ${b}` (a grid-column range) is not
    // mistaken for a class list.
    const isModifier = /^\s+[a-z][a-z0-9-]{0,15}\s*$/.test(piece)
    for (const token of tokens) {
      if (STRUCTURAL.test(token)) { used.add(token); continue }
      if (!BARE_WORD.test(token)) continue
      // A bare word counts when it sits in a class list ('td-btn sm ghost') or
      // is one of those conditional modifiers.
      if (isClassList || isModifier) used.add(token)
    }
  }
}
ok('the JSX does use class names', used.size > 40, used.size)

const defined = new Set()
for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(match[1])

const unstyled = [...used].filter((name) => !defined.has(name)).sort()
ok('every class in the JSX has at least one rule', unstyled.length === 0, unstyled)

// A rule for a class nobody uses is dead weight, but it is not a defect: report it
// without failing, so a deliberate hook for a future variant is not policed.
const unused = [...defined].filter((name) => !used.has(name)).sort()
if (unused.length > 0) console.log(`  note: rules with no className usage: ${unused.join(', ')}`)

// ---------------------------------------------------------------------------
section('one token map, no second palette')
// ---------------------------------------------------------------------------

// The sheet aliases the host tokens once, in one block, and every rule below
// speaks `--td-*`. So the question is not how many `var(--dsw-*)` calls appear --
// that number goes DOWN when the indirection is added -- but whether there is
// exactly one mapping and whether anything bypasses it.
//
// The block is found by what it DECLARES, not by a copy of its selector text: the
// selector list has to grow every time the shell gains a surface (it did in t12),
// and an audit pinned to the literal `.td-root,.td-modal-layer{` would fail on the
// fix instead of on the defect.
const topRules = []
{
  // `css` starts at the `const CSS = ` marker, so the opening backtick and the JS
  // before it have to go: left in, the FIRST rule's selector reads
  // "const CSS = ` .td-seat" and quietly stops matching anything.
  const text = css.replace(/^[^`]*`/, '').replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = match[1].trim()
    // At-rules and keyframe stops are not element rules.
    if (head === '' || head.startsWith('@') || !head.includes('.')) continue
    topRules.push({ head, body: match[2] })
  }
}
ok('the sheet parses into top-level rules', topRules.length > 100, topRules.length)

/** The classes a selector list applies to, `:not(...)` excluded (a guarded element
 *  is exactly the one that must NOT be counted as covered). */
const selectorClasses = (head) => head
  .replace(/:not\([^)]*\)/g, ' ')
  .split(',')
  .map((one) => (one.trim().match(/\.([\w-]+)/) ?? [])[1])
  .filter((cls) => cls !== undefined)

const aliasRule = topRules.find((rule) => !/data-ds-dark-theme/.test(rule.head)
  && /--td-card\s*:/.test(rule.body) && /--td-canvas\s*:/.test(rule.body))
const aliased = new Set(aliasRule === undefined ? [] : selectorClasses(aliasRule.head))
const aliasBlock = aliasRule === undefined ? '' : aliasRule.body
// A value may reach the host through a colour function as well as a bare var(),
// so each declaration is asked whether it mentions a host token at all.
const declarations = aliasBlock.split(';')
const mapped = declarations.filter((d) => /--td-[\w-]+\s*:/.test(d) && d.includes('var(--dsw-alias-')).length
ok('the token map is declared once, on the seat marker', aliased.has('td-seat') && aliased.size === 1, [...aliased])
ok('the aliases resolve to host tokens', mapped >= 10, mapped)

// Literal colours are the listed exceptions: two priority hues, the success green
// and the warm accent have no host token (a semantic HUE cannot be derived from a
// greyscale theme), the shadows are black at low alpha (rgba, so they are not hex
// at all), and everything else must come through the alias map. Each of them is
// declared exactly once, in the alias block, and is only ever used *mixed into a
// surface*, which is what keeps it legible in both themes.
// White used to be on this list as "the foreground on a brand fill" -- which is
// exactly wrong in the dark theme, where the brand fill IS white and the label
// vanished. The contrast token is --td-card / --dsw-alias-bg-base instead.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
const LITERAL_COLOURS = new Set([
  '#8b97a6', '#e0a53c', '#1f9d61', '#e56d24',
  // 奶白 + 蓝, the floating window's skin: a semantic HUE pair, plus the two ink
  // tones that keep a light card readable under the dark theme. Same rule as the
  // four above -- declared once, in the alias block, and only ever used as a
  // surface or mixed into one.
  '#fffaf1', '#f6eedd', '#2f6bff', '#16233a', '#4d6076',
])
const literals = [...new Set((cssRules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((c) => c.toLowerCase()))]
const stray = literals.filter((c) => !LITERAL_COLOURS.has(c)).sort()
ok('nothing in the rules bypasses the alias map', stray.length === 0, stray)

// A brand-filled control needs a foreground that inverts with the fill. The host's
// accent is near-black in the light theme and near-white in the dark one, so a
// hard-coded white there is invisible half the time.
ok('no foreground is hard-coded white on a brand fill',
  !/var\(--td-brand\)[^;}]*color:#fff/.test(cssRules),
  (cssRules.match(/[^;{]*var\(--td-brand\)[^;}]*color:#fff[^;}]*/g) ?? []).slice(0, 3))

ok('the modal layer is frame-wide', /\.td-modal-layer\{position:fixed;inset:0/.test(css))
ok('the modal card is centred by flex, not by column position',
  /\.td-modal-layer\{[^}]*align-items:center/.test(css) && /\.td-modal-layer\{[^}]*justify-content:center/.test(css))
ok('the old side drawer is gone', !source.includes('td-drawer'))

// ---------------------------------------------------------------------------
section('the seat marker reaches every element the shell mounts')
// ---------------------------------------------------------------------------

// The trap this section exists for: two elements mounted side by side by the same
// slot do NOT inherit from each other. The shell renders every shell.overlay entry
// as a SIBLING of the panel, and the sidebar's own panel row is not inside the panel
// at all -- so an element the plugin hands to a host slot has to carry the shared
// rules ITSELF. When it does not, every var(--td-*) inside it resolves to nothing
// and the box loses its background, its radius, its shadow and its mask.
//
// Nothing behavioural can see that: an unstyled element still renders, still
// focuses, still clicks. The trap was sprung three times -- .td-float (v2), then
// .td-cap-layer/.td-cmdk-layer and the sidebar badge, then the box model, the type
// baseline and the focus ring (t12) -- and every fix before this one was a longer
// copy of the selector list, which is exactly why each fix missed the next rule.
// So the fix is a MARKER: one class, `.td-seat`, carrying the map and everything
// else a surface needs to exist. The assertions below check the COVERAGE RELATION
// (which elements carry the marker, derived from the JSX) and never a copy of a
// selector string, so a new surface cannot be added without the marker, and the
// marker cannot be added without the rules.

/** One element's class expression as the JSX writes it: the className value plus
 *  any conditional modifier literals interpolated into it. A template such as
 *  `td-seat td-root${fullscreen ? ' td-overlay' : ''}` is ONE element's class list,
 *  so the window is read whole -- reading each literal on its own would see the
 *  modifier `td-floatapp` without the marker next to it. */
const classWindowsIn = (text) => [...text.matchAll(/className\s*:\s*([^,\n]{0,200})/g)]
  .map((match) => {
    const tokens = []
    // The template's own text (interpolations dropped), then every quoted literal
    // inside the window -- which is where the conditional modifiers live.
    for (const tpl of match[1].matchAll(/`([^`]*)`/g)) {
      tokens.push(...tpl[1].split(/\$\{[^}]*\}/).flatMap((part) => part.split(/\s+/)))
    }
    for (const lit of match[1].matchAll(/'([^']*)'/g)) tokens.push(...lit[1].split(/\s+/))
    for (const lit of match[1].matchAll(/"([^"]*)"/g)) tokens.push(...lit[1].split(/\s+/))
    return new Set(tokens.filter((token) => /^td-[\w-]+$/.test(token)))
  })
  .filter((set) => set.size > 0)
const classWindows = classWindowsIn(jsx)
const MARKER = 'td-seat'
/** Every class that shares a class expression with the marker: the marked surfaces. */
const marked = new Set(classWindows.filter((set) => set.has(MARKER)).flatMap((set) => [...set]))
ok('the JSX marks the shared surfaces', marked.size >= 6, [...marked].sort())

const seatRule = (test) => topRules.filter((rule) => rule.head.split(',')
  .some((one) => new RegExp('^\\.' + MARKER + '(?![\\w-])').test(one.trim()))).filter(test)

// 1. the mechanism itself: the marker carries map + box model + focus ring + baseline.
ok('the marker declares the token map', seatRule((rule) => /--td-card\s*:/.test(rule.body) && /--td-canvas\s*:/.test(rule.body)).length === 1)
ok('the marker resets the box model for its subtree',
  seatRule((rule) => /\*/.test(rule.head) && /box-sizing\s*:\s*border-box/.test(rule.body)).length >= 1)
ok('the marker draws the focus ring for its subtree',
  seatRule((rule) => /:focus-visible/.test(rule.head) && /outline\s*:/.test(rule.body)).length >= 1)
ok('the marker sets the type baseline (which a token-only fix would have missed)',
  seatRule((rule) => /font-size\s*:/.test(rule.body) && /line-height\s*:/.test(rule.body)).length >= 1)

// 2. the shape net: the classes that have to be seats are read out of the SHEET (a
//    frame-wide rule, or a class named *-layer), and any class expression that names
//    one of them must carry the marker. This is deliberately not how root POSITION is
//    decided -- that is net 3, which reads the render path -- but it is the net that
//    still sees a surface rendered from somewhere the render path cannot be followed.
const surfaceClasses = new Set()
for (const rule of topRules) {
  if (/data-ds-dark-theme/.test(rule.head)) continue
  const cls = (rule.head.match(/\.([\w-]+)/) ?? [])[1]
  // Frame-wide: a root by position. (Only `.td-root.td-overlay` earns this by
  // composite selector, which is why the class is taken from the first compound --
  // every td-root site must carry the marker anyway.)
  if (cls !== undefined && /position\s*:\s*fixed/.test(rule.body)) surfaceClasses.add(cls)
}
for (const name of defined) if (/-layer$/.test(name)) surfaceClasses.add(name)
ok('the sheet names the classes that must be seats', surfaceClasses.size >= 5, [...surfaceClasses].sort())

const unmarkedSites = classWindows
  .filter((set) => [...set].some((cls) => surfaceClasses.has(cls)) && !set.has(MARKER))
  .map((set) => [...set].sort().join(' '))
ok('every class expression that names a surface class also carries the marker',
  unmarkedSites.length === 0, unmarkedSites)
ok('every class named *-layer carries the marker',
  [...defined].filter((name) => /-layer$/.test(name)).every((name) => marked.has(name)),
  [...defined].filter((name) => /-layer$/.test(name) && !marked.has(name)))

// 3. the coverage relation, resolved STRUCTURALLY. Which elements are roots is read
//    off the render path -- what a component returns, the members of an array it
//    returns (a literal, or a local array filled with push()), and the roots of the
//    components those nodes instantiate -- and never off a class name that looks
//    root-ish. Two earlier versions of this net failed in opposite directions: one
//    guessed from the sheet ("a class with a fixed-position rule"), which reported
//    six nested elements as unmarked roots, and one read a hand-written table, which
//    was blind to the root that actually broke (TodoMain's fullscreen placeholder --
//    the same class was marked at another site, so a class-level check stayed green).
//    A component that cannot be expanded is counted and printed instead of passing
//    silently.
const componentBody = (name) => {
  const decl = source.search(new RegExp('(?:function|const|let|var)\\s+' + name + '\\s*[=(]'))
  if (decl < 0) return null
  // Skip the parameter list first: `function PanelIcon({ size, active }) {` would
  // otherwise end the body at the destructuring brace and report an empty component.
  let i = source.indexOf('(', decl)
  if (i >= 0 && i - decl < 120) {
    let depth = 0
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') { depth--; if (depth === 0) break }
    }
  }
  let depth = 0
  for (i = source.indexOf('{', i); i >= 0 && i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(decl, i + 1) }
  }
  return null
}

/** What a render path RETURNS: a `return` in the component's own body scope, not the
 *  one inside a row callback (which is why the depth is bounded). */
const returnedExpressions = (body) => {
  const out = []
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '{') { depth++; continue }
    if (ch === '}') { depth--; continue }
    if (depth > 2 || !body.startsWith('return', i) || /[\w$]/.test(body[i - 1] ?? ' ')) continue
    let nest = 0
    let text = ''
    let j = i + 6
    for (; j < body.length; j++) {
      const c = body[j]
      if (c === '(' || c === '[' || c === '{') nest++
      else if (c === ')' || c === ']' || c === '}') { if (nest === 0) break; nest-- }
      else if (nest === 0 && (c === '\n' || c === ';')) break
      text += c
    }
    out.push(text.trim())
    i = j
  }
  return out
}

/** The OUTERMOST `h(...)` calls of a region: one for a plain return, one per member
 *  of a returned array, one per branch of a ternary. */
const outermostCalls = (region) => {
  const starts = []
  for (const match of region.matchAll(/\bh\(/g)) {
    let depth = 0
    for (let i = 0; i < match.index; i++) {
      const c = region[i]
      if (c === '(' || c === '[') depth++
      else if (c === ')' || c === ']') depth--
    }
    starts.push({ at: match.index, depth })
  }
  if (starts.length === 0) return []
  const outer = Math.min(...starts.map((row) => row.depth))
  return starts.filter((row) => row.depth === outer).map((row) => region.slice(row.at))
}

const callTarget = (call) => {
  const element = /^h\(\s*'([^']*)'/.exec(call)
  if (element !== null) return { element: element[1] }
  const component = /^h\(\s*([A-Za-z_$][\w$]*)/.exec(call)
  return component === null ? null : { component: component[1] }
}

/** The root element's OWN class expression: the first className before any nested
 *  call, so a child's class list is never mistaken for the root's. */
const rootClassWindow = (call) => {
  const nested = call.indexOf('h(', 2)
  const scope = nested < 0 ? call : call.slice(0, nested)
  const found = /className\s*:\s*([^,\n]{0,200})/.exec(scope)
  return found === null ? null : classWindowsIn('className: ' + found[1])[0] ?? null
}

/** A returned array: literal members, or the entries a local array was filled with. */
const arrayEntries = (body, expression) => {
  if (expression.startsWith('[')) return [expression]
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return [expression]
  const pushes = [...body.matchAll(new RegExp('\\b' + expression + '\\.push\\(', 'g'))].map((m) => m.index)
  if (pushes.length === 0) return null
  return pushes.map((at) => {
    let depth = 0
    let text = ''
    for (let i = body.indexOf('(', at); i < body.length; i++) {
      const c = body[i]
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) break }
      if (depth >= 1) text += c
    }
    return text
  })
}

const inspected = new Set()
const tree = { roots: 0, rootsWithoutClass: 0, skipped: [], findings: [] }
/** The components the plugin hands to a slot: read from the registration sites, so a
 *  fourth seat is scanned without anyone remembering to add it to a list here. */
const registeredComponents = [...source.matchAll(/slots\.register\([\s\S]{0,220}?,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/g)]
  .map((match) => match[1])
const inspectRoots = (name) => {
  if (inspected.has(name)) return
  inspected.add(name)
  const body = componentBody(name)
  if (body === null) { tree.skipped.push(name + ' (declaration not found)'); return }
  const returns = returnedExpressions(body)
  for (const expression of returns) {
    const entries = arrayEntries(body, expression)
    if (entries === null) {
      if (expression.includes('h(')) tree.skipped.push(name + ' -> ' + expression.slice(0, 24))
      continue
    }
    for (const entry of entries) {
      for (const call of outermostCalls(entry)) {
        const target = callTarget(call)
        if (target === null) { tree.skipped.push(name + ' -> dynamic call'); continue }
        if (target.component !== undefined) {
          if (componentBody(target.component) === null) tree.skipped.push(name + ' -> ' + target.component)
          else inspectRoots(target.component)
          continue
        }
        const window = rootClassWindow(call)
        if (window === null) { tree.rootsWithoutClass++; continue }
        tree.roots++
        if (!window.has(MARKER)) {
          tree.findings.push(name + ' -> <' + target.element + ' class="' + [...window].sort().join(' ') + '">')
        }
      }
    }
  }
}
for (const name of new Set(registeredComponents)) inspectRoots(name)
// The counters are printed, not implied: "all pass" must not be able to mean "nothing
// was looked at", and a skipped root has to be visible instead of silent.
console.log(`  note: ${inspected.size} components inspected, ${tree.roots} roots checked`
  + (tree.rootsWithoutClass > 0 ? `, ${tree.rootsWithoutClass} root(s) with no class attribute` : '')
  + (tree.skipped.length > 0 ? `, skipped: ${tree.skipped.join('; ')}` : ', nothing skipped'))
ok(`every root the registered components mount carries the seat marker (${inspected.size} components, `
  + `${tree.roots} roots checked, ${tree.rootsWithoutClass} without a class, ${tree.skipped.length} skipped)`,
registeredComponents.length >= 3 && tree.roots >= 6 && tree.findings.length === 0,
{ findings: tree.findings, skipped: tree.skipped.slice(0, 4) })

// 4. the surfaces this audit documents, checked as surfaces rather than as a list: they
//    must exist, the JSX must ask for them, and each must be marked. (The coverage
//    claim itself is net 3 above, which is structural; this one keeps the documented
//    names honest.)
const DOCUMENTED_ROOTS = ['td-root', 'td-modal-layer', 'td-cap-layer', 'td-cmdk-layer', 'td-float', 'td-glyphwrap']
ok('the documented seat roots are real classes in the sheet',
  DOCUMENTED_ROOTS.every((cls) => defined.has(cls)), DOCUMENTED_ROOTS.filter((cls) => !defined.has(cls)))
ok('the documented seat roots are the classes the JSX asks for',
  DOCUMENTED_ROOTS.every((cls) => used.has(cls)), DOCUMENTED_ROOTS.filter((cls) => !used.has(cls)))
ok('every documented seat root carries the seat marker',
  DOCUMENTED_ROOTS.every((cls) => marked.has(cls)), DOCUMENTED_ROOTS.filter((cls) => !marked.has(cls)))

// 5. no surface re-patches what the marker already does. That IS the recurrence: every
//    previous fix was a new rule on a specific element, so this fails on the PATTERN,
//    not on a particular missing rule. (.td-float is the one deliberate exception --
//    it brings its own skin -- and its ordering and pinning are asserted below.)
const repatched = topRules
  .filter((rule) => rule.head.split(',').some((one) => surfaceClasses.has((one.trim().match(/\.([\w-]+)/) ?? [])[1])))
  .filter((rule) => !/\.td-float/.test(rule.head))
  .filter((rule) => /--td-[\w-]+\s*:|box-sizing\s*:|outline\s*:/.test(rule.body))
  .map((rule) => rule.head)
ok('no seat root re-declares the map, the box model or the focus ring',
  repatched.length === 0, repatched)

// 3. the same hole one rename away: a token nothing declares resolves to nothing
//    just as quietly as one that is declared in an unreachable place.
//
// Two names are per-ELEMENT values the JSX writes inline rather than theme tokens:
// the row's staggered entrance delay and the column's list colour. They are kept as
// an explicit whitelist whose writers are asserted to exist, so this stays a net
// for orphans instead of a hole in it.
const LOCAL_TOKENS = ['--td-delay', '--td-tint']
const inlineWriters = LOCAL_TOKENS.filter((name) => jsx.includes("'" + name + "'"))
ok('the per-element tokens are really set inline by the JSX',
  inlineWriters.length === LOCAL_TOKENS.length, LOCAL_TOKENS.filter((n) => !inlineWriters.includes(n)))
const declaredNames = new Set([...aliasBlock.matchAll(/--td-[\w-]+/g)].map((m) => m[0]))
const consumed = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/var\((--td-[\w-]+)/g)].map((m) => m[1]))
const orphans = [...consumed].filter((name) => !declaredNames.has(name) && !LOCAL_TOKENS.includes(name)).sort()
ok('every consumed token is either mapped or an inline per-element value', orphans.length === 0, orphans)

// 5. the two global layers keep a real surface: a mask, a card, a radius, a shadow.
ok('the capture layer paints a mask, a card, a radius and a shadow',
  /\.td-cap-layer\{[^}]*background:color-mix\(in srgb,var\(--td-ink\)/.test(css)
  && /\.td-cap\{[^}]*background:var\(--td-card\)/.test(css)
  && /\.td-cap\{[^}]*border-radius:var\(--td-r-lg\)/.test(css)
  && /\.td-cap\{[^}]*box-shadow:var\(--td-sh-2\)/.test(css))
ok('the command palette paints a mask, a card, a radius and a shadow',
  /\.td-cmdk-layer\{[^}]*background:color-mix\(in srgb,var\(--td-ink\)/.test(css)
  && /\.td-cmdk\{[^}]*background:var\(--td-card\)/.test(css)
  && /\.td-cmdk\{[^}]*border-radius:var\(--td-r-lg\)/.test(css)
  && /\.td-cmdk\{[^}]*box-shadow:var\(--td-sh-2\)/.test(css))

// 6. the dark theme re-points the SAME marked surfaces: one selector on the marker,
//    with the cream window guarded out. The old sheet listed the elements twice and
//    the two lists had to agree by hand -- which is how a theme ends up applied to
//    one surface and not another.
const darkRule = topRules.find((rule) => /data-ds-dark-theme/.test(rule.head) && /--td-card\s*:/.test(rule.body))
const darkHead = darkRule === undefined ? '' : darkRule.head
const darkClasses = new Set(selectorClasses(darkHead))
ok('the dark override is declared on the seat marker', darkClasses.has(MARKER), darkHead)
ok('the dark override keeps the cream floating window out, both guards intact',
  /:not\(\.td-floatapp\)/.test(darkHead) && /:not\(\.td-float\)/.test(darkHead), darkHead)
// Anything else the dark list names has to be marked as well, so the list cannot
// grow into the place a new surface gets added: a redundant selector is tolerable
// (verify-client-render V4 pins one legacy line), a coverage hole is not.
ok('everything the dark override names is also marked',
  [...darkClasses].every((cls) => marked.has(cls)), [...darkClasses].filter((cls) => !marked.has(cls)))
ok('the dark override does not spread to unmarked classes',
  [...darkClasses].every((cls) => cls === MARKER || cls === 'td-root'), [...darkClasses].sort())
const skinRule = topRules.find((rule) => /--td-canvas:var\(--td-cream-2\)/.test(rule.body))
ok('the floating window re-declares its own colours after the shared map',
  skinRule !== undefined && aliasRule !== undefined && topRules.indexOf(aliasRule) < topRules.indexOf(skinRule))
ok('the floating window pins the colours the shared map would otherwise win',
  skinRule !== undefined && /--td-card\s*:\s*var\(--td-cream\)/.test(skinRule.body)
  && /--td-text\s*:\s*var\(--td-ink\)/.test(skinRule.body) && /--td-brand\s*:\s*var\(--td-accent\)/.test(skinRule.body))
// The frame and the interior are two elements: the window's own box is .td-float, the
// app inside it is .td-root.td-floatapp. Both must stay cream, which needs both guards
// above AND the marker on both elements.
ok('both elements of the floating window are marked and both stay out of the dark map',
  marked.has('td-float') && marked.has('td-floatapp') && !darkClasses.has('td-floatapp'), [...marked].sort())

console.log('')
if (fail > 0) {
  console.log(`FAILING: ${fail} of ${pass + fail}`)
  for (const name of failures) console.log('   - ' + name)
} else {
  console.log(`CSS AUDIT: ALL PASS (${pass})`)
}
process.exit(fail ? 1 : 0)

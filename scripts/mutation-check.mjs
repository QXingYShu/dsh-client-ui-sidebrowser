/**
 * Mutation harness: copies the project to a scratch directory, applies a small
 * textual mutation to one source file there, and runs the suite in the copy.
 *
 * The point is to prove the suite is not vacuous. A test that passes against the
 * real code proves nothing; a test that *fails* when the behaviour it names is
 * removed is the only evidence worth having.
 *
 * Run it manually; it is not part of `pnpm test`.
 *
 *   node scripts/mutation-check.mjs
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Mutations to try: a name, the file, the search, and its replacement. */
const mutations = [
  {
    name: 'screenshot change detection always reports changed',
    file: 'src/browser/screenshot-stream.ts',
    find: 'previous.data === data',
    replace: 'false',
  },
  {
    name: 'screenshot stream advances the frame id on every capture',
    file: 'src/browser/screenshot-stream.ts',
    find: 'id: this.nextFrameId++',
    replace: 'id: 99',
  },
  {
    name: 'screenshot capture swallows the no-tab error',
    file: 'src/browser/screenshot-stream.ts',
    find: "if (tab === undefined) throw new Error('there is no page open to screenshot')",
    replace: 'if (tab === undefined) return \'AAAA\'',
  },
  {
    name: 'driver accepts any url scheme',
    file: 'src/browser/driver.ts',
    find: "if (url.protocol !== 'http:' && url.protocol !== 'https:') {",
    replace: 'if (false) {',
  },
  {
    name: 'driver allows a click with neither selector nor coordinates',
    file: 'src/browser/driver.ts',
    find: 'if (bySelector === byPoint) {',
    replace: 'if (false) {',
  },
  {
    name: 'driver drops the serialized-argument boundary (string interpolation)',
    file: 'src/browser/driver.ts',
    find: 'arguments: args.map(value => ({ value })),',
    replace: 'arguments: [],',
  },
  {
    name: 'selection popup stops flipping above the viewport edge',
    file: 'src/client/selection.ts',
    find: 'const flipped = preferredTop + popupHeight + margin > viewportHeight && rect.top - gap - popupHeight - margin >= 0',
    replace: 'const flipped = false',
  },
  {
    name: 'selection detection stops rejecting over-long selections',
    file: 'src/client/selection.ts',
    find: 'if (raw === \'\' || raw.length > MAX_SELECTION_CHARS) return undefined',
    replace: 'if (raw === \'\') return undefined',
  },
  {
    // Both call sites of the text-entry guard are removed together, so neither
    // can keep the behaviour alive on its own. This is the mutation that proves
    // the input/textarea/contenteditable cases genuinely pin the guard.
    name: 'selection detection stops rejecting text-entry controls at every call site',
    file: 'src/client/selection.ts',
    find: 'if (isTextEntry(target) || isOwnSurface(target)) return undefined\n    // A selection made inside a text-entry control is reported by the control,\n    // not by the document: bail rather than opening over someone\'s draft.\n    if (target.closest(\'input, textarea, [contenteditable]:not([contenteditable="false"])\') !== null) return undefined',
    replace: 'if (isOwnSurface(target)) return undefined',
  },
  {
    name: 'routes stop enforcing the cross-site fence',
    file: 'src/host/routes.ts',
    find: 'if (!guard(req, res)) return',
    replace: 'if (false) return',
  },
  {
    name: 'routes accept a form post, reopening simple-request CSRF',
    file: 'src/host/routes.ts',
    find: "if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {",
    replace: 'if (false) {',
  },
  {
    name: 'routes report a missing browser as 400 instead of 503',
    file: 'src/host/routes.ts',
    find: "error.code === 'no-browser' || error.code === 'launch-failed'",
    replace: 'false',
  },
  {
    name: 'agent tools throw instead of returning a readable refusal',
    file: 'src/host/agent-tools.ts',
    find: '  if (error instanceof BrowserError) {\n    return refused(error.code, error.message)',
    replace: '  if (error instanceof BrowserError) {\n    throw error',
  },
  {
    name: 'agent tools accept a click with neither selector nor coordinates',
    file: 'src/host/agent-tools.ts',
    find: "return refused('bad-click', 'click needs either a selector or both x and y coordinates')",
    replace: "void 0",
  },
  {
    name: 'config reader returns the fallback even for a committed volatile',
    file: 'src/index.ts',
    find: 'return (field as Volatile<T>).get() as T',
    replace: 'return fallback',
  },
  {
    name: 'mount guard never releases the lease',
    file: 'src/index.ts',
    find: 'mounted.delete(packageName)',
    replace: 'void packageName',
  },
]

let survivors = 0
let unexpected = 0
let equivalentSurvivors = 0
for (const mutation of mutations) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sidebrowser-mutation-'))
  try {
    cpSync(projectRoot, scratch, {
      recursive: true,
      filter: (source) => !source.includes('node_modules') && !source.includes(`${join('src', 'browser')}.bak`),
    })
    // A junction keeps pnpm's symlinked store resolvable without copying it.
    spawnSync('cmd', ['/c', 'mklink', '/J', join(scratch, 'node_modules'), join(projectRoot, 'node_modules')], { stdio: 'ignore' })
    const target = join(scratch, mutation.file)
    const original = readFileSync(target, 'utf8')
    if (!original.includes(mutation.find)) {
      console.log(`SKIP  (anchor not found) ${mutation.name}`)
      unexpected += 1
      continue
    }
    writeFileSync(target, original.replace(mutation.find, mutation.replace), 'utf8')
    const result = spawnSync(process.execPath, [join(scratch, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], {
      cwd: scratch,
      encoding: 'utf8',
    })
    const caught = result.status !== 0
    if (caught) {
      console.log(`CAUGHT  ${mutation.name}`)
    } else if (mutation.equivalent === true) {
      // A survivor that is supposed to survive: the mutation leaves the pinned
      // behaviour intact, so a green suite is the correct outcome.
      console.log(`EQUIV   ${mutation.name}`)
      equivalentSurvivors += 1
    } else {
      console.log(`SURVIVED  ${mutation.name}`)
      survivors += 1
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
const total = mutations.length
console.log(`\n${total - survivors - equivalentSurvivors}/${total - equivalentSurvivors} behavioural mutations caught`)
console.log(`${equivalentSurvivors} equivalent mutant(s) survived, as expected`)
if (survivors > 0 || unexpected > 0) process.exit(1)
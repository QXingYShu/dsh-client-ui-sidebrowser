/**
 * Verify the built client bundle really is a loadable DSH client plugin.
 *
 * The Web GUI never `import()`s a client half: it hands the file to
 * `window.__ModuleLoader__.load(...)`, calls `factory(require)` with a limited
 * `require`, and composes the returned module's `inject` / `apply`. This script
 * reproduces exactly that, with a stub `window`, a stub `require` that only
 * resolves `react` and `react/jsx-runtime`, and no DOM, so a bundle that
 * depends on anything else fails here instead of silently in the browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** The module loader recorded what the bundle handed it. */
let loaded = null

/**
 * The narrow `require` the GUI provides: GUI-owned modules only.
 *
 * The set is not a guess. These are exactly the specifiers the shipped DSH
 * client bundles require at their top level — `react` and `react/jsx-runtime`
 * everywhere, and `react-dom` / `react-dom/client` in dsh-pet, dsh-usage,
 * dsh-remote-web-ui, dsh-update and dsh-web-all. Anything else throws here, so
 * an undeclared dependency is caught on the build machine instead of silently
 * breaking the plugin in the browser.
 */
const GUI_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

const guiRequire = specifier => {
  if (GUI_MODULES.has(specifier)) return createRequire(import.meta.url)(specifier)
  throw new Error(`client bundle requested a module the GUI does not provide: ${specifier}`)
}

/** Minimal window/document surface: enough for module top-level code. */
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(descriptor) {
        loaded = descriptor
      },
    },
  },
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, append() {}, dataset: {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} } },
  },
  navigator: { userAgent: 'node', language: 'en' },
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
  fetch: async () => { throw new Error('network is not available in this harness') },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortSignal,
  console,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

runInNewContext(source, sandbox, { filename: bundlePath })

assert.ok(loaded !== null, 'the bundle never called window.__ModuleLoader__.load()')
assert.equal(loaded.id, '@dsh-external/dsh-client-ui-sidebrowser', 'loader id mismatch')

const pluginModule = loaded.factory(guiRequire)
assert.ok(pluginModule !== null && typeof pluginModule === 'object', 'factory did not return the plugin module')

assert.equal(typeof pluginModule.apply, 'function', 'the bundle must export apply()')
assert.ok(Array.isArray(pluginModule.inject), 'the bundle must export an inject array')
assert.ok(pluginModule.inject.includes('slots'), `inject must include 'slots', got ${JSON.stringify(pluginModule.inject)}`)
assert.ok(
  pluginModule.inject.includes('sidebarRight') && pluginModule.inject.includes('sidebarRightTabs'),
  `inject must include the right-Sidebar services, got ${JSON.stringify(pluginModule.inject)}`,
)
assert.equal(pluginModule[Symbol.toStringTag], 'Module', 'the returned module must be tagged as a Module')

// The tab identity the loader will key the tab body on.
assert.equal(pluginModule.SIDEBROWSER_TAB_KIND, 'sidebrowser-cdp', 'the tab kind must not collide with the shipped browser tab')
assert.equal(pluginModule.SIDEBROWSER_TAB_ID, '@dsh-external/dsh-client-ui-sidebrowser', 'the tab id must match the loader id')

process.stdout.write('client bundle OK: loader envelope, module shape, inject list and tab identity verified\n')
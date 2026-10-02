import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'tsdown'

/** The package name the Web GUI's module loader keys this bundle under. */
const CLIENT_ID = '@dsh-external/dsh-client-ui-sidebrowser'

/**
 * Wrap the client chunk in the loader envelope the Web GUI expects.
 *
 * The GUI does not `import()` a plugin's client half. It hands each bundle to
 * `window.__ModuleLoader__`, which invokes `factory(require)` with a `require`
 * limited to the modules the GUI already owns (`react`, `react/jsx-runtime`).
 * What the factory returns is the plugin module, whose `inject` and `apply`
 * exports the loader composes like any other client plugin.
 *
 * The client half is emitted as CommonJS for exactly this reason: that puts the
 * `require("react")` calls and the trailing `module.exports` inside a factory
 * body the loader can wrap. The Host half stays ESM because it runs in the
 * Host's own ES module graph and is loaded by the Loader, not the browser.
 *
 * The transform matches on the *entry* module rather than any file whose name
 * ends in `client.js`: rolldown wraps lazily-imported modules in
 * `__commonJSMin(...)` thunks, and wrapping one of those would bury the loader
 * call inside a function that never runs at load time.
 *
 * The wrapper is emitted through `renderChunk` rather than `transform` because
 * the envelope has to sit OUTSIDE the whole module — it needs to own the
 * `require` that the chunk's own `require("react")` calls resolve against, and
 * a `transform` result is just another module body in the graph, not a new
 * scope around it.
 *
 * The `var module = { exports: {} }` prologue is load-bearing: rolldown emits
 * CommonJS chunks that assign to a *free* `exports` binding, so the enclosing
 * scope has to provide `module.exports` for the loader's return value to be the
 * plugin module. `Object.defineProperty(exports, Symbol.toStringTag, ...)`
 * inside the body is what makes the GUI treat the returned object as a Module,
 * and that only works once `exports` resolves to this `module.exports`.
 */
function clientModuleLoaderWrapper(): Plugin {
  return {
    name: 'dsh-client-module-loader',
    enforce: 'post',
    renderChunk(code) {
      return (
        `window.__ModuleLoader__.load({\n` +
        `  id: ${JSON.stringify(CLIENT_ID)},\n` +
        `  factory: (require) => {\n` +
        `    var module = { exports: {} };\n` +
        `    var exports = module.exports;\n` +
        `${code}\n` +
        `    return module.exports;\n` +
        `  },\n` +
        `});\n`
      )
    },
  }
}

/** Where {@link clientModuleLoaderWrapper} opens the factory body it emits. */
const FACTORY_MARKER = 'factory: (require) => {'

/** Output directory shared by both builds; the client chunk and CSS land here. */
const OUT_DIR = 'lib'

/**
 * Inline the emitted stylesheet into the client bundle.
 *
 * `@tsdown/css` collects `*.module.css` into `lib/style.css` and rewrites the
 * class names in the JS, but it does not put the stylesheet in front of the
 * browser: the file is written next to the bundle and nothing ever loads it. The
 * GUI hands each client bundle to `window.__ModuleLoader__` and only ever
 * evaluates the factory body, so a plugin has to install its own styles as a
 * side effect of that body — which is exactly what the shipped packages do
 * (see `dsh-client-ui-sidebar-browser/lib/client.js`, which creates a
 * `<style data-plugin-css=...>` tag holding the CSS text).
 *
 * `closeBundle` rather than `renderChunk`, because the stylesheet does not exist
 * on disk until the CSS plugin has emitted it, and that plugin's hooks run after
 * every user plugin's. So the bundle is rewritten as a final pass once all writes
 * are done. The rewrite is idempotent: a second build that finds its own marker
 * already present leaves the file alone.
 */
function clientCssInjection(cssFileName = 'style.css'): Plugin {
  return {
    name: 'dsh-client-css-injection',
    enforce: 'post',
    async closeBundle() {
      let css: string
      try {
        css = await readFile(join(OUT_DIR, cssFileName), 'utf8')
      } catch {
        return // no stylesheet emitted; nothing to inline
      }
      if (css.trim() === '') return

      const chunkPath = join(OUT_DIR, 'client.js')
      let code: string
      try {
        code = await readFile(chunkPath, 'utf8')
      } catch {
        return
      }
      // Only the wrapped client chunk carries the loader call, and only once.
      if (!code.includes('__ModuleLoader__.load') || code.includes('data-plugin-css')) return

      const at = code.indexOf(FACTORY_MARKER)
      if (at === -1) return
      const insertAt = at + FACTORY_MARKER.length

      const tagId = `${CLIENT_ID}/${cssFileName}`
      const prologue = [
        '',
        '// --- dsh-sidebrowser: inline stylesheet (see tsdown.config.ts) ---',
        `    (() => {`,
        `      const tagId = ${JSON.stringify(tagId)};`,
        `      if (typeof document === "undefined") return;`,
        `      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;`,
        `      const tag = document.createElement("style");`,
        `      tag.dataset.plugin = ${JSON.stringify(CLIENT_ID)};`,
        `      tag.dataset.pluginCss = tagId;`,
        `      tag.textContent = ${JSON.stringify(css)};`,
        `      document.head.appendChild(tag);`,
        `    })();`,
      ].join('\n')

      await writeFile(chunkPath, code.slice(0, insertAt) + prologue + code.slice(insertAt), 'utf8')
    },
  }
}

export default defineConfig([
  {
    // Host half: plain ESM, loaded by the Host process through the Loader.
    // `outExtensions` pins the filename to the one `package.json` advertises
    // (`main: lib/index.js`); the default ESM name would be `index.mjs`, which
    // nothing resolves.
    //
    // Everything is bundled in except `ws`, which must stay a real runtime
    // dependency: it is a native-over-TCP WebSocket client and the profile
    // already installs it. The `@deepseek-ai/*` Host packages are inlined
    // because they resolve out of the desktop app's own asar, not out of the
    // profile's `node_modules` — a bare `import` of them works under Electron's
    // asar loader and fails under plain Node, so inlining is what makes the
    // bundle self-contained and testable off the app.
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: ['ws'],
    },
  },
  {
    // Client half: CommonJS so the loader wrapper has a factory body to wrap.
    // The entry is named `client` rather than left as `index` because both
    // configs share `lib/`, and two entries called `index` would race for the
    // same output filename — the ESM host build would overwrite the client one.
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    sourcemap: true,
    clean: false,
    // The GUI resolves these itself and hands them to the factory's `require`;
    // inlining any of them breaks the bundle. `react-dom/client` in particular
    // reads `process.env.NODE_ENV` on load, and a browser has no `process` —
    // so an inlined copy throws before `apply` ever runs. Several shipped DSH
    // plugins (dsh-pet, dsh-usage, dsh-remote-web-ui) require `react-dom/client`
    // the same way, which is the proof the loader provides it.
    deps: {
      neverBundle: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@deepseek-ai/cordis',
      ],
    },
    plugins: [clientModuleLoaderWrapper(), clientCssInjection()],
  },
])
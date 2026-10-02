# dsh-sidebrowser

English | [中文](README.zh.md)

A **controllable real browser** in the DeepSeek Harness (dsh) Web GUI right sidebar: open the DeepSeek web app, Bing, 百度/有道 translation, or any URL beside your conversation and make the page you are looking at **the page your model can read and operate**; and when you select a word or a sentence in a conversation, a small popup appears beside the selection offering **AI explain**, **Translate**, and **Copy**.

> TODO: screenshot

---

## Why

State the load-bearing technical fact first, because it dictates the shape of this plugin:

**The DeepSeek web app, Bing and Google all refuse to be embedded in a cross-origin `<iframe>`.** They send `X-Frame-Options`, or a CSP `frame-ancestors` directive, and any `<iframe>` gets a blank frame or a refused connection. "Embed the web version of DeepSeek inside the GUI" therefore does not exist under the browser security model — this is not a vendor toggle.

So this plugin **does not embed a webview in the GUI**. Instead:

- The Host process **launches a real Chrome on your own machine**, with `--remote-debugging-port`, and drives it over the Chrome DevTools Protocol (CDP).
- The right-sidebar tab is therefore a **remote control surface**: a live view of the browser's current page, a URL bar, back/forward/reload, a tab strip, and a page-text view.
- That live view is an **image stream, not an embedded browser.** The panel polls the Host for a fresh screenshot on an interval; you steer the page with the URL bar and the navigation buttons, and the model steers it with the tools. The panel is not an interactive page — it is a picture of one, refreshed on a timer.

Several consequences, stated plainly:

- **No window appears by default.** `headless` is on, so the page lives in the sidebar and nothing pops up in front of the conversation. This is still a real local browser — it is not a separate application you must install, you need Chrome or Edge already present — you just do not see it unless you ask.
- **You can raise the real window on demand.** `POST /api/sidebrowser/window` with `{"show": true}` brings a Chrome window onto your desktop; `{"show": false}` puts it away again. Chrome cannot add or remove its window at runtime, so the toggle **relaunches the browser against the same profile directory** — your login survives it, and up to three pages you had open are re-opened by URL afterwards. The `headless` setting does the same thing, but needs a DSH restart to apply. The panel draws no button for either today.
- **It launches lazily.** Only the first time you actually use it (opening the tab, calling a tool, hitting a route) pulls the browser up; installing the plugin never pops a window on every Host start.
- **A dedicated profile directory.** The plugin gives Chrome its own `--user-data-dir`, so you **log into DeepSeek by hand once**, in a window you raised for the purpose, and the session persists. That login is the foundation the whole feature rests on.
- **This is why the model can read the DeepSeek web page at all.** The model needs the page's text, which a cross-origin frame could never give it. A Host-driven real Chrome can.

### How it differs from the built-in `browser` tab

| | Shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` | This plugin, `dsh-sidebrowser` |
| --- | --- | --- |
| Tab kind | `browser` | `sidebrowser-cdp` |
| Rendering | An in-app **iframe** (Web) / Electron `<webview>` (Desktop) | A **real Chrome on the host**, driven over CDP; the sidebar shows its live view |
| Can load DeepSeek / Bing / Google | **No** — those sites refuse to be framed cross-origin | **Yes** — it does not use a frame at all |
| Model can read and operate the page | No | Yes: `browser_read`, `browser_act`, … |
| Selection AI-explain / Translate | None | Yes |

The two **coexist**: they are separate tab kinds under separate implementation ids, neither shadows the other, and both can be open at once. The shipped package's own documentation says the same thing — when a site refuses iframe framing, or you need a browser capability that package deliberately does not grant, use an explicit external-browser route.

If all you need is ordinary web browsing, the built-in tab may already be enough. This plugin targets the different need: "let the model read, and operate, the page I am looking at."

---

## Features

1. **A right-sidebar browser.** A tab beside your conversation (tab kind `sidebrowser-cdp`) opens the DeepSeek web app, Bing, 百度 translation, 有道 translation, or any http(s) URL. The panel provides: a live view, a URL bar (accepts a URL or a search term), back / forward / reload, a tab strip (new / close / switch), shortcut buttons, and a **page text** view. The live view is a polled screenshot fitted to the panel, not an interactive embed, and the panel holds a minimum height so a narrow sidebar shows a small page rather than nothing at all. The tab chip title follows the current page title.
2. **Agent tools.** The model in a session gets five `browser_*` tools to read the page, click, type, press keys, scroll, navigate, manage tabs and take screenshots. The tools and the sidebar **share one driver**: a page you opened by hand is the very page the model reads, and a page the model opened appears in your sidebar. `agentTools` in the settings turns this surface off on its own while leaving the sidebar intact.
3. **A selected-text mini-popup.** Select any word or sentence in a conversation and a small box appears beside it: **AI explain** (through the DeepSeek web app, spending no API quota and using your web conversation history), **Translate** (a translation site, chosen by the shape of your selection — see below — and only falling back to the DeepSeek web page when the site renders nothing readable at all), and **Copy**. `selectionPopup` in the settings turns it off.

---

## Installation

### Step 1: register the package (both lists)

`dsh plugin add` forwards to pnpm and writes **only the profile's `dependencies`**.
A second registration is required: the package name must also appear in the
profile's `dsh.profile.bundles` list. Both live in
`~/.dsh/profiles/<profile>/package.json`:

```jsonc
{
  "dependencies": {
    "dsh-sidebrowser": "link:<path-to-this-repo>"   // ← how pnpm links the directory
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@dsh-external/dsh-client-ui-sidebrowser"   // ← which package the Host activates
      ]
    }
  }
}
```

You can set both up with either:

```bash
# CLI: writes dependencies only — you must add the bundles entry by hand afterwards
dsh plugin --profile <profile> add link:<path-to-this-repo>

# or the repo script: writes both entries and syncs the build output
pwsh -File scripts/install-local.ps1
```

- `<profile>` is your dsh profile name, usually `desktop` or `web`;
- a git URL works too (the repository is published):
  `dsh plugin --profile desktop add git+https://github.com/QXingYShu/dsh-client-ui-sidebrowser.git`.
  The package has a `prepare` script, so the bundles are built automatically on
  install — but pnpm may block lifecycle scripts by default and prompt you to
  approve them (`pnpm approve-builds`); if `lib/` ends up empty, activation
  fails loudly.

**No manual `cordis.patch.yml` edit is needed — do not add an insert row
yourself.** The Host reads `dsh.profile.bundles`, resolves each bundle's
`dsh.bundle.patch` (this package's `cordis.patch.yml`) and applies its
`insert:` rows automatically. The plugin table is keyed by id: a hand-written row
with a *different* id than the package's own would load the package **twice**
(two sets of agent tools, two client factories, two Chrome drivers).

**A DSH restart is required afterwards.** The Host half — Chrome driver, control routes and the `browser_*` tools — runs in the Host process, and a package that has landed in the profile's `node_modules` is only claimed when that process restarts. Refreshing the Web GUI page is not enough; the page refresh only matters for the client half.

### Manual install (equivalent — the flow used in development)

1. **Build first**: `pnpm install && pnpm build`, producing `lib/index.js` (the Host half, ESM) and `lib/client.js` (the client half, a **lazy CommonJS factory** for the Web GUI's module loader: the served file only calls `window.__ModuleLoader__.load({ id, factory })`, and every module body — including the CSS injection — runs when the loader materializes the factory).
2. Copy the **whole built package directory** into the profile's `node_modules/@dsh-external/dsh-client-ui-sidebrowser/`:

   ```
   ~/.dsh/profiles/<profile>/node_modules/@dsh-external/dsh-client-ui-sidebrowser/
   ```

   That is the full package under its `@dsh-external/` scope directory — it must carry `package.json`, `lib/`, `cordis.patch.yml` and `icon.svg` — not the repository root. (`pnpm install` in the repo creates this as a `link:` junction instead, which needs no copying.)
3. **Make sure `ws` resolves.** It is the Host half's only runtime dependency. Most profiles already carry it, as does this repository's own `node_modules`. If it does not resolve, add `node_modules/ws` inside the package directory or install it into the profile.
4. **Register both lists** exactly as in step 1 above (`dependencies` + `dsh.profile.bundles`). The plugin row itself comes from the package's own `cordis.patch.yml` automatically; if you ever need to override its config (disable it, change a field), write that override into the **profile's own** `cordis.patch.yml` — keeping the same id (`ui-sidebrowser`), since ids are the table's keys.
5. **Restart DSH. This step is not optional.** The Chrome driver, the control routes and the `browser_*` tools all live in the **Host process**; copying the package into `node_modules` does not make a running Host claim it. Refreshing the browser tab is not a substitute.

The package is dual-faced: the node half (exports `.`) runs in the Host process — browser driver, control routes and the `browser_*` tools — while the `dsh.client` declaration in `package.json` makes the browser half (exports `./client`) load in the Web GUI, where it contributes the right-sidebar tab and the selection popup.

### Requirements

- The only runtime dependency is `ws`, the CDP WebSocket client. No Puppeteer, no Playwright.
- Chrome or Chromium must be installed locally; Edge is used as a fallback, and a custom executable path can be configured in settings.
  - `C:\Program Files\Google\Chrome\Application\chrome.exe`
  - `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

---

## Usage

### Opening the sidebar browser

Pick **Side browser** from the right sidebar's guide page, or use it in a cell that already exists. The Host launches Chrome the first time you do, headless: nothing appears on your desktop, and the page shows up in the panel.

**To log into DeepSeek by hand, raise the real window first.** Set `headless: false` in the plugin's row (see [Configuration](#configuration)) and restart DSH, or post `{"show": true}` to `POST /api/sidebrowser/window` to toggle it live without a restart. Sign in there; the profile directory keeps the session, so you normally do not log in again. Put the window away afterwards and the page stays in the sidebar either way — the toggle relaunches the browser against the same profile rather than throwing the session away.

The URL bar accepts a full URL and also these shortcut names: `deepseek`, `bing`, `baidu`, `youdao`, `google`, `googleTranslate`.

### Agent tools

The tools register into the session's tool registry when the deployment provides one; without it the sidebar still works and only the model-facing surface is missing.

| Tool | What it does | Main parameters |
| --- | --- | --- |
| `browser_open` | Opens a URL in a new tab and returns tabId / title / url. Always a new tab, so your current page is never navigated out from under you. | `url` (a full http(s) URL or a shortcut name) |
| `browser_read` | Reads the current page's **rendered text** (`document.body.innerText`) plus title and URL. Optionally returns headings, links and form-field selectors so the model aims at real selectors instead of guessing. | `tabId`, `maxChars` (default 8000, ceiling 200000), `includeInventory` |
| `browser_act` | Performs one action and returns a confirmation plus the resulting URL and title. Actions: `navigate` / `click` / `type` / `key` / `scroll` / `back` / `forward` / `reload`. | `action`, `url`, `selector`, `text`, `key`, `x`, `y`, `deltaY`, `tabId` |
| `browser_tabs` | Lists, opens, closes or selects tabs. | `action` (`list` by default / `open` / `close` / `select`), `url`, `tabId` |
| `browser_screenshot` | Captures the current page as a PNG on the Host and returns the **file path** (not inlined base64). | `tabId`, `fullPage`, `scale` (0.2–1, default 0.5) |

A few deliberate choices:

- **There is no raw `eval` tool and no route that accepts arbitrary JavaScript.** The only evaluation endpoint is `POST /api/sidebrowser/eval-safe`, and it accepts exactly one of five named operations: `click`, `type`, `key`, `scroll`, `read`. Each maps onto a driver method whose page function is a **literal written by this plugin**, and caller-supplied values arrive as serialized arguments through `Runtime.evaluate`'s `args`, never concatenated into code. Executing arbitrary JS inside the user's logged-in browser would turn page content into an injection vector, and this plugin does not cross that line.
- **Refusals are return values, not exceptions.** "This page needs a login" comes back as a structured `ok:false` result the model should report to you rather than retry as an internal fault. The codes worth knowing: `no-browser`, `bad-url`, `selector-not-found`, `tab-not-found`, `no-tab`.
- **Only http/https.** Schemes such as `file:` and `javascript:` are refused.
- **Screenshots return a path, not image data.** A base64 PNG is megabytes and would bloat every later context window carrying the session; the file is written to disk and the model reads it if it needs the pixels.

### The selected-text popup

Select text in a conversation and the popup beside it offers:

- **AI explain** — asks through the DeepSeek **web page**, not an API. The plugin confirms the host browser is attached, navigates to `chat.deepseek.com`, waits for the page to mount, types the prompt into the first composer selector that matches, presses Enter, then polls the page text until the answer stops growing and cuts out the last assistant turn. A single word and a longer passage are prompted differently, and the selection is wrapped in `<selection>` so selected text is not read as part of the instruction.
- **Translate** — a translation site, routed by the shape of the selection. With the default `translationEngine: auto`, a single **word** goes to **有道词典** (`dict.youdao.com`, which answers a word with entries, phonetics and examples) and a **sentence** goes to **Bing 翻译**; 有道's sentence translator does not carry a whole sentence usefully through its URL form. Pinning `youdao`, `bing` or `baidu` in the settings uses that one site for everything.

  If the site renders, that is the end of the path: the result is on screen in the sidebar and the popup says which site it is on. This is deliberate — the page used to be judged by a length heuristic, so a site that had rendered but did not parse to a long enough string was treated as a failure and the fallback **navigated away from the page you were reading** and replaced it with a DeepSeek login screen. Only a site that produces no readable text at all now falls back to the DeepSeek web page.
- **Copy**.

The popup is defensive by construction: no browser attached, signed out, composer missing, no answer within 90 seconds and host-route failure are each reported as one honest line you can act on, never as an empty answer box. A logged-out chat is caught in **about six seconds**, not at the deadline: such a page still renders a composer, so the prompt can be typed and Enter swallowed without complaint, and the bridge watches for the prompt ever becoming a turn — when it does not, that is reported as login-required rather than leaving you watching a dead button. **"I could not read an answer" is never presented as though it were the model's reply** — the difference matters, because the first is you fixing a login and the second is misinformation.

---

## Configuration

Settings live in **this plugin's own row in the profile** (entry id `ui-sidebrowser`) — Host-side config, not browser localStorage: settings follow the profile to another machine, and one value — the target language, the translation engine — is therefore read by both the DeepSeek-web bridge and the translation-site path.

**These values really reach the panel now.** The Host serves its resolved settings at `GET /api/sidebrowser/config` and the client reads them once at startup. The client used to take them from a `configForms` service that no shipped DSH package provides, so every setting silently fell back to the client's own compiled-in defaults — a translation site you had chosen and an interval you had set both did nothing. The route below is the channel that actually exists: the Host owns the schema and the volatile fields.

The plugin also registers a **settings card** into a `settings.section` seat. No shipped DSH package (as of `dsh-client-ui-*` 0.2.0-rc.2) declares that seat, so today the card does not render — configure the row through the profile's `cordis.patch.yml` (see below). The registration is a safe contribution: the moment a Host declares the seat, the card appears without any code change.

The card is staged: what you type stays in a draft until you press **Save**, which commits everything as one revision-fenced atomic mutation. Nothing lands in the settings document keystroke by keystroke.

The Host-side `Config` in `src/index.ts` is the single source of truth for these fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When false the routes and the tools are not mounted at all. |
| `executablePath` | string | `''` | Custom browser executable. Empty probes the standard Chrome / Chromium / Edge locations. |
| `port` | number | `0` | Fixed CDP debugging port. `0` means the OS assigns a free port (the default, avoiding collisions with a second dsh profile or an existing debug browser). |
| `userDataDir` | string | `''` | Chrome profile directory. Empty uses a stable per-user path under the temp directory. |
| `headless` | boolean | `true` | Run without a window. On by default: the page lives in the sidebar and nothing pops up in front of the conversation. Set it to `false` to get the real window back (signing in by hand, for instance); that needs a DSH restart, and `POST /api/sidebrowser/window` is the same switch without one. |
| `captureIntervalMs` | number | `1000` | Capture interval in **milliseconds**, 250–10000. |
| `captureScale` | number | `0.5` | Screenshot downsample factor, 0.2–1. |
| `selectionPopup` | boolean | `true` | Whether the selection mini-popup appears. Real: turn it off and no box appears beside your selection. |
| `agentTools` | boolean | `true` | Whether the `browser_*` tools are registered. Real: turn it off and the model loses browser control while the sidebar keeps working — exactly the "I want the browser but not model control" case. |
| `defaultUrl` | string | `https://chat.deepseek.com/` | The address a fresh tab opens. Must be http(s). |
| `shortcuts` | string | `''` | Quick-launch shortcuts, one `name url` per line. |
| `targetLanguage` | string | `zh-Hans` | Target language for the translation action, as a BCP 47 tag. |
| `translationEngine` | string | `auto` | Which translation site **Translate** prefers. `auto` is not one site: a single word goes to 有道词典 and a sentence to Bing 翻译. `youdao` / `bing` / `baidu` pin one site for every selection. |

**The interval's unit trap.** The Host stores `captureIntervalMs` in **milliseconds**; the settings card displays and edits **seconds**. The card converts at its own two boundaries so no other code has to know — but if you edit `settings.yaml` by hand, you are writing milliseconds.

**When changes take effect:** every field is volatile, so an edit commits in place instead of remounting the plugin, which would kill the Chrome you are using. But the four launch-affecting fields — `executablePath`, `port`, `userDataDir`, `headless` — are read when the driver is constructed, so they need a **DSH restart** to matter. That is deliberate: changing them under a live Chrome would orphan your window. `headless` has the `POST /api/sidebrowser/window` escape hatch — it relaunches the browser in the other mode against the same profile directory, which is safe because the session lives in the profile rather than in the window.

### Host control routes

The plugin registers routes under `/api/sidebrowser` for the client's same-origin calls. Every one of them passes a trust fence: **the socket must be loopback**, the **Host header must name loopback**, `Origin` must match (or `sec-fetch-site` must not be `cross-site`), and at least one browser-origin marker must be present (`sec-fetch-site: same-origin`, an `Origin`, or the Host's browser-auth cookie). A bare `curl` is refused with 403.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/config` | The Host's resolved plugin settings, which the client half reads at startup |
| GET | `/state` | Browser snapshot (attached / loading / title / url / current tab) plus the shortcut names |
| POST | `/window` | Show (`{"show": true}`) or hide (`{"show": false}`) the real Chrome window; relaunches against the same profile directory |
| POST | `/navigate` `/back` `/forward` `/reload` | Navigation and history |
| GET | `/tabs`; POST `/tabs/open` `/tabs/close` `/tabs/select` | Tabs |
| POST | `/screenshot` | One capture (`fullPage`, `scale`) |
| GET | `/frame` | The change-detected live frame: an unchanged page answers with metadata and no payload. It also takes an optional `?have=<frameId>` — the newest frame id the client already holds — so a panel that mounts after the Host's first capture is handed the frame it is missing instead of an "unchanged" about a frame it has never seen. The changed branch carries `url` / `title` / `frameId` / `capturedAt` as well as the image |
| POST | `/text` | Page text, optionally with `includeInventory` |
| POST | `/click` `/type` `/key` `/scroll` | Input actions |
| POST | `/eval-safe` | A small named set of operations (click / type / key / scroll / read), **not** arbitrary evaluation |

---

## Privacy & security

Please read this section properly. The capabilities here are strong, and so is the responsibility that comes with them.

**What it can do**

- **Read anything on the page.** `browser_read` returns the current page's rendered text. Whatever you let it open, it can read — including pages you are logged into.
- **Click and type on your pages.** `browser_act` can press buttons, enter text into fields and hit Enter to submit forms. It can take any action on a web page on your behalf.
- **Act in a real browser.** It drives a real Chrome on your machine, in a real profile, against your real logins. The window is hidden by default; raise it and you can watch everything it does.

**What it does not do**

- **It sends nothing to any third party.** Beyond the sites you choose to open, no data leaves. The only runtime dependency is `ws`, used to reach the Chrome debug port on your own machine.
- **It executes no arbitrary script.** There is no `eval` tool and no route that accepts arbitrary JavaScript. The one evaluation endpoint, `/eval-safe`, accepts exactly five named operations (`click` / `type` / `key` / `scroll` / `read`), each mapping onto a driver method whose page function is a literal written by this plugin, with caller values passed as serialized arguments through `Runtime.evaluate`'s `args` and never concatenated into code.
- **It does not touch your everyday browser.** It runs in its own Chrome profile directory, so it never reads your normal browsing history, cookies or other signed-in sites.

**Boundaries worth knowing**

- **The login persists.** The DeepSeek session in the dedicated profile directory survives until you delete that directory — including across the window toggle, which relaunches the browser against that same directory. It defaults to a per-user path under the temp directory (`<tmp>/dsh-sidebrowser-<user>`) and can be pointed elsewhere with `userDataDir`. Delete the directory to drop the login.
- **Uninstalling the plugin closes the Chrome it started.** Deliberately: leaving a debug-enabled browser running in the background is not a good outcome.
- **The control routes are local-only.** Loopback socket, Host/Origin checks and the browser marker together keep remote and cross-site callers out. It is still an endpoint that can operate a logged-in browser, so do not expose it to a LAN or the public internet.
- **Screenshots are plaintext.** The live view in the sidebar is exactly what the host browser is showing. If the page holds sensitive information, the screenshot holds it too.

**Suggestions**

- Do not run an agent against a page holding sensitive data unless you are confident in what that model will do.
- To tighten access in layers: `agentTools: false` keeps the sidebar but denies the model browser control; `selectionPopup: false` turns off the selection box; `enabled: false` turns everything off. To remove the plugin entirely: `dsh plugin --profile <profile> remove` — note it deletes **only the `dependencies` entry**; remove the package name from `dsh.profile.bundles` by hand as well, or the Host will try to load a package that is no longer there on the next start.
- Check your DeepSeek web conversation history now and then — "AI explain" uses the real conversation and leaves a record there.

---

## Development

```bash
pnpm install
pnpm build       # tsdown: ESM for the Host half, loader-wrapped CJS for the client half
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm verify:real # drives a REAL Chrome and a REAL page (see below)
```

### Verifying against a real browser

```bash
pnpm verify:real
```

This is the check that matters, and it exists because of how this plugin went.
Every defect it shipped with passed the unit suite and a clean build — the mount
-time throw that unregistered all seventeen HTTP routes, a tab body reading a
prop the shell never passes, the popup unmounting itself before the click could
land, a selection race that made every command act on the wrong tab, and AI
explain answering with the user's own prompt. All of them were invisible to
mocks and obvious the moment a real browser was involved.

`pnpm verify:real` imports the production driver, the production `browser_*`
tools and the production DeepSeek-web bridge, launches a real Chrome, and drives
real pages against 23 assertions:

| Area | What it proves |
|---|---|
| `browser_open` / `browser_read` | a new tab is created, and the read returns the rendered text plus **real** selectors for the form and the links |
| `browser_act` | typing and clicking actually change the page's DOM; scrolling actually moves the viewport; a `file:` url is refused rather than obeyed |
| `browser_tabs` | list / select / close, and a closed tab leaves the strip; no `chrome://` blank page is ever tracked |
| `browser_screenshot` | a PNG is written to disk, and it is not empty |
| AI explain | the composer is found, the prompt is typed, Enter is sent, the streaming answer is awaited, and the extracted text is the model's reply — **without** the user's prompt and **without** the model label |
| Translation | the site is opened with the text, the result is on the page, and the engine used is reported |

Nothing in the plugin is mocked; only the page is a local stand-in, because the
real sites need an account and must not be driven by a test. Set
`SIDEBROWSER_CHROME` to point at a different browser and `SIDEBROWSER_HEADLESS=0`
to watch it run.

### Layout

```
src/
  index.ts                  Host entry: config schema, single-instance guard, effect lifetime
  browser/
    cdp-client.ts           Minimal CDP WebSocket client (ws only)
    driver.ts               Stateful controller: launches Chrome, owns tabs, turns intents into CDP calls
    screenshot-stream.ts    Timed capture with change detection and single-frame retention
  host/
    routes.ts               /api/sidebrowser control routes and the trust fence
    agent-tools.ts          The five browser_* tools
  client/
    index.ts                Client plugin entry (JSX-free; re-exports surfaces)
    surfaces.tsx            Every registration: tab type, body, title, menu item, footer row, settings card, popup host
    panel.tsx               The sidebar panel (URL bar, navigation, live view, tab strip, text view)
    panel/
      use-live-frame.ts     Live-frame polling: repaints only on change, never while hidden
      use-browser-state.ts  The panel's browser-state subscription
    selection.ts            Selection recognition (word / passage) and placement maths
    selection-host.tsx      Document-wide selection listener
    selection-popup.tsx     The popup itself
    settings-card.tsx       The settings card (bound config form, staged writes)
    shortcuts.ts            Parsing and validation for shortcut URLs
    api.ts                  Typed route client that never throws an unhandled rejection
    deepseek-web.ts         Asking / translating through the DeepSeek web page (defensive extraction)
    locales.ts              Chinese and English copy
tests/                      vitest: driver, screenshot stream, selection classification, config defaults
```

Three architectural boundaries are worth remembering: **the Host half owns the Chrome process and the client half is only a same-origin asynchronous view of it**; **the plugin launches the browser lazily** — the first actual use pulls it up; and **the two halves register two different tab kinds** (`browser` and `sidebrowser-cdp`), so neither can shadow the other.

---

## Acknowledgements

Thanks to DeepSeek Harness for this plugin API — in particular the right sidebar's two-stage tab registration — and for documenting the bundle install shape. This plugin is just one implementation on its public interfaces.

---

## License

[MIT](LICENSE)
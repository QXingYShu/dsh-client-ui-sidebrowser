# dsh-sidebrowser

English | [中文](README.zh.md)

A **controllable real browser** in the DeepSeek Harness (dsh) Web GUI right sidebar: open the DeepSeek web app, Bing, 百度/有道 translation, or any URL beside your conversation and make the page you are looking at **the page your model can read and operate**; and when you select a word or a sentence in a conversation, a small popup appears beside the selection offering **AI explain**, **Translate**, and **Copy**.

> TODO: screenshot

---

## Why

State the load-bearing technical fact first, because it dictates the shape of this plugin:

**The DeepSeek web app, Bing and Google all refuse to be embedded in a cross-origin `<iframe>`.** They send `X-Frame-Options`, or a CSP `frame-ancestors` directive, and any `<iframe>` gets a blank frame or a refused connection. "Embed the web version of DeepSeek inside the GUI" therefore does not exist under the browser security model — this is not a vendor toggle.

So this plugin **does not embed a webview in the GUI**. Instead:

- The Host process **launches a real Chrome window on your own machine**, with `--remote-debugging-port`, and drives it over the Chrome DevTools Protocol (CDP).
- The right-sidebar tab is therefore a **remote control surface**: a live screenshot of that Chrome window, a URL bar, back/forward/reload, a tab strip, and a page-text view.
- Where you actually interact is **the Chrome window that opens on your desktop**.

Several consequences, stated plainly:

- **The window is visible.** It opens on your desktop. It is not an invisible background browser, and it is not a separate application you must install — you need Chrome or Edge already present.
- **It launches lazily.** Only the first time you actually use it (opening the tab, calling a tool, hitting a route) pulls the browser up; installing the plugin never pops a window on every Host start.
- **A dedicated profile directory.** The plugin gives Chrome its own `--user-data-dir`, so you **log into DeepSeek by hand once** in that window and the session persists. That login is the foundation the whole feature rests on.
- **This is why the model can read the DeepSeek web page at all.** The model needs the page's text, which a cross-origin frame could never give it. A Host-driven real Chrome window can.

### How it differs from the built-in `browser` tab

| | Shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` | This plugin, `dsh-sidebrowser` |
| --- | --- | --- |
| Tab kind | `browser` | `sidebrowser-cdp` |
| Rendering | An in-app **iframe** (Web) / Electron `<webview>` (Desktop) | A **real Chrome window on the host**, driven over CDP; the sidebar shows its live view |
| Can load DeepSeek / Bing / Google | **No** — those sites refuse to be framed cross-origin | **Yes** — it does not use a frame at all |
| Model can read and operate the page | No | Yes: `browser_read`, `browser_act`, … |
| Selection AI-explain / Translate | None | Yes |

The two **coexist**: they are separate tab kinds under separate implementation ids, neither shadows the other, and both can be open at once. The shipped package's own documentation says the same thing — when a site refuses iframe framing, or you need a browser capability that package deliberately does not grant, use an explicit external-browser route.

If all you need is ordinary web browsing, the built-in tab may already be enough. This plugin targets the different need: "let the model read, and operate, the page I am looking at."

---

## Features

1. **A right-sidebar browser.** A tab beside your conversation (tab kind `sidebrowser-cdp`) opens the DeepSeek web app, Bing, 百度 translation, 有道 translation, or any http(s) URL. The panel provides: a live view, a URL bar (accepts a URL or a search term), back / forward / reload, a tab strip (new / close / switch), shortcut buttons, and a **page text** view. The tab chip title follows the host window's current page title.
2. **Agent tools.** The model in a session gets five `browser_*` tools to read the page, click, type, press keys, scroll, navigate, manage tabs and take screenshots. The tools and the sidebar **share one driver**: a page you opened by hand is the very page the model reads, and a page the model opened appears in your sidebar. `agentTools` in the settings turns this surface off on its own while leaving the sidebar intact.
3. **A selected-text mini-popup.** Select any word or sentence in a conversation and a small box appears beside it: **AI explain** (through the DeepSeek web app, spending no API quota and using your web conversation history), **Translate** (a translation site by default — 有道 / Bing / 百度 — falling back to the DeepSeek web page when the site gives nothing back), and **Copy**. `selectionPopup` in the settings turns it off.

---

## Installation

### Install as a bundle (recommended)

```bash
dsh plugin --profile <profile> add link:<path-to-this-repo>
```

- `<profile>` is your dsh profile name, usually `desktop` or `web`;
- once the repository is published, a git URL works too: `dsh plugin --profile desktop add git+https://github.com/<owner>/dsh-sidebrowser.git`.

**A DSH restart is required afterwards.** The Host half — Chrome driver, control routes and the `browser_*` tools — runs in the Host process, and a package that has landed in the profile's `node_modules` is only claimed when that process restarts. Refreshing the Web GUI page is not enough.

### Manual install (equivalent — the flow used in development)

1. **Build first**: `pnpm install && pnpm build`, producing `lib/index.js` (the Host half, ESM) and `lib/client.js` (the client half, CommonJS wrapped for the Web GUI's module loader).
2. Copy the **whole built package directory** into the profile's `node_modules/@dsh-external/dsh-client-ui-sidebrowser/`:

   ```
   ~/.dsh/profiles/<profile>/node_modules/@dsh-external/dsh-client-ui-sidebrowser/
   ```

   That is the full package under its `@dsh-external/` scope directory — it must carry `package.json`, `lib/`, `cordis.patch.yml` and `icon.svg` — not the repository root.
3. **Make sure `ws` resolves.** It is the Host half's only runtime dependency. Most profiles already carry it, as does this repository's own `node_modules`. If it does not resolve, add `node_modules/ws` inside the package directory or install it into the profile.
4. Add the `cordis.patch.yml` row to the profile's bundle patch:

```yaml
- insert:
    - id: ui-sidebrowser
      name: '@dsh-external/dsh-client-ui-sidebrowser'
```

5. **Restart DSH. This step is not optional.** The Chrome driver, the control routes and the `browser_*` tools all live in the **Host process**; copying the package into `node_modules` does not make a running Host claim it. Refreshing the browser tab is not a substitute.

That is exactly the content of this repository's `cordis.patch.yml`. The package is dual-faced: the node half (exports `.`) runs in the Host process — browser driver, control routes and the `browser_*` tools — while the `dsh.client` declaration in `package.json` makes the browser half (exports `./client`) load in the Web GUI, where it contributes the right-sidebar tab and the selection popup.

### Requirements

- The only runtime dependency is `ws`, the CDP WebSocket client. No Puppeteer, no Playwright.
- Chrome or Chromium must be installed locally; Edge is used as a fallback, and a custom executable path can be configured in settings.
  - `C:\Program Files\Google\Chrome\Application\chrome.exe`
  - `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

---

## Usage

### Opening the sidebar browser

Pick **Side browser** from the right sidebar's guide page, or use it in a cell that already exists. The Host launches Chrome the first time you do.

**Log into DeepSeek by hand in that Chrome window the first time.** The profile directory remembers the session afterwards, so you normally do not log in again.

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
- **Translate** — a translation site by default (有道 / Bing / 百度), with the target language and engine chosen in settings. When the site yields nothing readable, it falls back to "Translate with the DeepSeek web page".
- **Copy**.

The popup is defensive by construction: no browser attached, signed out, composer missing, no answer within 90 seconds and host-route failure are each reported as one honest line you can act on, never as an empty answer box. **"I could not read an answer" is never presented as though it were the model's reply** — the difference matters, because the first is you fixing a login and the second is misinformation.

---

## Configuration

The settings card binds to **this plugin's own row in the profile** (entry id `ui-sidebrowser`, falling back to the `sidebrowser` namespace) and writes through dsh's configuration form. It is **not** browser localStorage: settings follow the profile to another machine, and one value — the target language, the translation engine — is therefore read by both the DeepSeek-web bridge and the translation-site path.

The card is staged: what you type stays in a draft until you press **Save**, which commits everything as one revision-fenced atomic mutation. Nothing lands in the settings document keystroke by keystroke.

The Host-side `Config` in `src/index.ts` is the single source of truth for these fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When false the routes and the tools are not mounted at all. |
| `executablePath` | string | `''` | Custom browser executable. Empty probes the standard Chrome / Chromium / Edge locations. |
| `port` | number | `0` | Fixed CDP debugging port. `0` means the OS assigns a free port (the default, avoiding collisions with a second dsh profile or an existing debug browser). |
| `userDataDir` | string | `''` | Chrome profile directory. Empty uses a stable per-user path under the temp directory. |
| `headless` | boolean | `false` | Start without a visible window. Off by default: you sign in there. |
| `captureIntervalMs` | number | `1000` | Capture interval in **milliseconds**, 250–10000. |
| `captureScale` | number | `0.5` | Screenshot downsample factor, 0.2–1. |
| `selectionPopup` | boolean | `true` | Whether the selection mini-popup appears. Real: turn it off and no box appears beside your selection. |
| `agentTools` | boolean | `true` | Whether the `browser_*` tools are registered. Real: turn it off and the model loses browser control while the sidebar keeps working — exactly the "I want the browser but not model control" case. |
| `defaultUrl` | string | `https://chat.deepseek.com/` | The address a fresh tab opens. Must be http(s). |
| `shortcuts` | string | `''` | Quick-launch shortcuts, one `name url` per line. |
| `targetLanguage` | string | `zh-Hans` | Target language for the translation action, as a BCP 47 tag. |
| `translationEngine` | string | `youdao` | Which translation site is preferred: `youdao` / `bing` / `baidu`. |

**The interval's unit trap.** The Host stores `captureIntervalMs` in **milliseconds**; the settings card displays and edits **seconds**. The card converts at its own two boundaries so no other code has to know — but if you edit `settings.yaml` by hand, you are writing milliseconds.

**When changes take effect:** every field is volatile, so an edit commits in place instead of remounting the plugin, which would kill the Chrome window you are using. But the four launch-affecting fields — `executablePath`, `port`, `userDataDir`, `headless` — are read when the driver is constructed, so they need a **DSH restart** to matter. That is deliberate: changing them under a live Chrome would orphan your window.

### Host control routes

The plugin registers routes under `/api/sidebrowser` for the client's same-origin calls. Every one of them passes a trust fence: **the socket must be loopback**, the **Host header must name loopback**, `Origin` must match (or `sec-fetch-site` must not be `cross-site`), and at least one browser-origin marker must be present (`sec-fetch-site: same-origin`, an `Origin`, or the Host's browser-auth cookie). A bare `curl` is refused with 403.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/state` | Browser snapshot (attached / loading / title / url / current tab) plus the shortcut names |
| POST | `/navigate` `/back` `/forward` `/reload` | Navigation and history |
| GET | `/tabs`; POST `/tabs/open` `/tabs/close` `/tabs/select` | Tabs |
| POST | `/screenshot` | One capture (`fullPage`, `scale`) |
| GET | `/frame` | The change-detected live frame: an unchanged page answers with metadata and no payload |
| POST | `/text` | Page text, optionally with `includeInventory` |
| POST | `/click` `/type` `/key` `/scroll` | Input actions |
| POST | `/eval-safe` | A small named set of operations (click / type / key / scroll / read), **not** arbitrary evaluation |

---

## Privacy & security

Please read this section properly. The capabilities here are strong, and so is the responsibility that comes with them.

**What it can do**

- **Read anything on the page.** `browser_read` returns the current page's rendered text. Whatever you let it open, it can read — including pages you are logged into.
- **Click and type on your pages.** `browser_act` can press buttons, enter text into fields and hit Enter to submit forms. It can take any action on a web page on your behalf.
- **Act in a real window.** It drives the visible Chrome window on your desktop, so you can watch everything it does.

**What it does not do**

- **It sends nothing to any third party.** Beyond the sites you choose to open, no data leaves. The only runtime dependency is `ws`, used to reach the Chrome debug port on your own machine.
- **It executes no arbitrary script.** There is no `eval` tool and no route that accepts arbitrary JavaScript. The one evaluation endpoint, `/eval-safe`, accepts exactly five named operations (`click` / `type` / `key` / `scroll` / `read`), each mapping onto a driver method whose page function is a literal written by this plugin, with caller values passed as serialized arguments through `Runtime.evaluate`'s `args` and never concatenated into code.
- **It does not touch your everyday browser.** It runs in its own Chrome profile directory, so it never reads your normal browsing history, cookies or other signed-in sites.

**Boundaries worth knowing**

- **The login persists.** The DeepSeek session in the dedicated profile directory survives until you delete that directory. It defaults to a per-user path under the temp directory (`<tmp>/dsh-sidebrowser-<user>`) and can be pointed elsewhere with `userDataDir`. Delete the directory to drop the login.
- **Uninstalling the plugin closes the Chrome it started.** Deliberately: leaving a debug-enabled browser running in the background is not a good outcome.
- **The control routes are local-only.** Loopback socket, Host/Origin checks and the browser marker together keep remote and cross-site callers out. It is still an endpoint that can operate a logged-in browser, so do not expose it to a LAN or the public internet.
- **Screenshots are plaintext.** The live view in the sidebar is exactly what the host window is showing. If the page holds sensitive information, the screenshot holds it too.

**Suggestions**

- Do not run an agent against a page holding sensitive data unless you are confident in what that model will do.
- To tighten access in layers: `agentTools: false` keeps the sidebar but denies the model browser control; `selectionPopup: false` turns off the selection box; `enabled: false` turns everything off. To remove the plugin entirely: `dsh plugin --profile <profile> remove`.
- Check your DeepSeek web conversation history now and then — "AI explain" uses the real conversation and leaves a record there.

---

## Development

```bash
pnpm install
pnpm build       # tsdown: ESM for the Host half, loader-wrapped CJS for the client half
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

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
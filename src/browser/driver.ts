/**
 * The stateful browser controller: launch Chrome, own its tabs, and expose the
 * operations the sidebar and the agent tools need.
 *
 * Architecture note that shapes every decision here: DeepSeek web, Bing and
 * Baidu all refuse to be framed (X-Frame-Options / frame-ancestors CSP), so the
 * sidebar CANNOT embed these pages in an iframe. The only workable embedding is
 * a real Chrome on the Host desktop, driven over CDP. Consequently the client
 * half of this plugin cannot show a live interactive view — it renders a
 * screenshot stream plus controls, while the real window sits on the user's
 * desktop. That tradeoff is deliberate and is why the login flow works: the
 * user signs into DeepSeek once in the real window, and the dedicated profile
 * directory keeps that session for every later run.
 *
 * The driver keeps exactly one selected tab addressable at a time, but tracks
 * every tab it opened so the sidebar's tab strip and the agent's tab tools share
 * one model of the world.
 *
 * @module dsh-sidebrowser/browser/driver
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, writeFile, unlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpClient, CdpError } from './cdp-client.ts'

/** Chrome/Edge executable locations probed in order when none is configured. */
const BROWSER_CANDIDATES: readonly string[] = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** Shortcuts the `browser_open` tool and the sidebar expose by name. */
export const BROWSER_SHORTCUTS: Readonly<Record<string, string>> = {
  deepseek: 'https://chat.deepseek.com/',
  deepseekWeb: 'https://chat.deepseek.com/',
  bing: 'https://www.bing.com/',
  baidu: 'https://www.baidu.com/',
  youdao: 'https://fanyi.youdao.com/',
  youdaoTranslate: 'https://fanyi.youdao.com/',
  googleTranslate: 'https://translate.google.com/',
  google: 'https://www.google.com/',
}

/** Configuration for {@link BrowserDriver}. */
export interface BrowserDriverOptions {
  /** Explicit browser executable; when absent, the standard locations are probed. */
  executablePath?: string
  /** Debugging port for the CDP endpoint; 0 or absent picks a free port. */
  port?: number
  /** Chrome profile directory; the dedicated dir keeps the DeepSeek login persistent. */
  userDataDir?: string
  /** Start without a visible window. Off by default: the user signs into DeepSeek in this window. */
  headless?: boolean
  /** Extra flags appended verbatim to the launch command line. */
  extraArgs?: readonly string[]
}

/** One tab the driver is tracking. */
export interface BrowserTabInfo {
  /** Driver-assigned stable id (distinct from the CDP target id). */
  id: string
  /** CDP target id backing this tab. */
  targetId: string
  /** Flat-mode CDP session id for issuing page commands. */
  sessionId: string
  /** Current URL. */
  url: string
  /** Current page title. */
  title: string
  /** True when this is the tab commands act on. */
  selected: boolean
}

/** A page snapshot: title, url, load state, and text — the agent's view of what the user sees. */
export interface PageSnapshot {
  /** The selected tab, or undefined when no tab is open. */
  tab?: BrowserTabInfo
  /** Whether the browser is running and attached. */
  attached: boolean
  /** True when the page reports itself still loading. */
  loading: boolean
  /** Page title, empty for a blank or unfinshed page. */
  title: string
  /** Page url. */
  url: string
}

/** Result of a readable-text extraction. */
export interface ExtractedText {
  /** Page title. */
  title: string
  /** Page url. */
  url: string
  /** The extracted readable text (truncated to the requested cap). */
  text: string
  /** True when the text was cut off by the cap. */
  truncated: boolean
  /** Optional compact inventory of headings/links/forms, for orientation. */
  inventory?: PageInventory
}

/** A compact map of the page's structure, so the model can aim clicks instead of guessing. */
export interface PageInventory {
  /** Up to a handful of headings, in document order. */
  headings: readonly string[]
  /** Up to a bounded number of links, as `text -> href`. */
  links: readonly { text: string, href: string }[]
  /** Interactive elements with a stable selector, for click/type. */
  fields: readonly { selector: string, tag: string, type?: string, placeholder?: string }[]
}

/** Options for {@link BrowserDriver.extractText}. */
export interface ExtractTextOptions {
  /** Hard cap on returned characters (the model transcript is the scarce resource). */
  maxChars?: number
  /** Also return a compact heading/link/field inventory. */
  includeInventory?: boolean
}

/** A failure the caller can present to a user without leaking a stack trace. */
export class BrowserError extends Error {
  /**
   * @param code - a stable machine-readable code the UI and tools branch on.
   * @param message - a human-readable explanation.
   */
  constructor(
    /** Stable machine-readable failure code. */ readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrowserError'
  }
}

/** Default cap on extracted characters; generous for prose, bounded for transcripts. */
const DEFAULT_MAX_CHARS = 8000

/** Render any thrown value as a message string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a CDP failure is the "this object handle belongs to a context that no
 * longer exists" error, which a navigation causes by invalidating the old one.
 *
 * Only this specific retryable failure is matched; every other error is real and
 * must surface to the caller.
 * @param error - the thrown value.
 * @returns true when the cached handle should be discarded and the call retried.
 */
function isStaleContextError(error: unknown): boolean {
  if (!(error instanceof CdpError)) return false
  return error.message.includes('Cannot find context with specified id')
      || error.message.includes('Execution context was destroyed')
      || error.message.includes('Cannot find object with given id')
}

/** Hard ceiling on extracted characters regardless of the requested cap. */
const MAX_TEXT_CEILING = 200_000

/** How long to wait for Chrome's debug port to accept connections after launch. */
const LAUNCH_TIMEOUT_MS = 30_000

/** Delay between probing the debug port during launch. */
const LAUNCH_POLL_MS = 250

/**
 * Resolve a usable browser executable.
 *
 * A missing browser is a normal, reportable condition (the user may not have
 * Chrome installed), not a reason to crash the Host, so this returns undefined
 * and the caller turns it into a {@link BrowserError}.
 * @param configured - an explicit path from config, if the user set one.
 * @returns the first existing candidate, or undefined when none is present.
 */
async function resolveExecutable(configured: string | undefined): Promise<string | undefined> {
  const candidates = configured !== undefined && configured !== '' ? [configured, ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Try the next candidate; a missing executable is expected here.
    }
  }
  return undefined
}

/**
 * Resolve the Chrome profile directory, defaulting to a stable per-user path.
 *
 * The default lives under the OS temp dir keyed by the current user so two
 * users on one machine (or two DSH profiles) do not share a Chrome profile,
 * which Chrome refuses anyway.
 * @param configured - an explicit directory from config, if set.
 * @returns an absolute directory path.
 */
function resolveUserDataDir(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') return configured
  const user = process.env.USER ?? process.env.USERNAME ?? 'dsh'
  return join(tmpdir(), `dsh-sidebrowser-${user}`)
}

/**
 * The stateful browser facade.
 *
 * Responsibilities are deliberately narrow: own the Chrome process, own the CDP
 * connection, own the tab set, and translate high-level intents (navigate,
 * click, type, read) into CDP calls. It registers no routes and no agent tools —
 * that wiring lives in `host/`, so this class stays independently testable and
 * reusable by the screenshot streamer.
 */
export class BrowserDriver {
  /** Resolved config; defaults are applied per-field so an empty config is valid. */
  private readonly options: BrowserDriverOptions

  /** The Chrome child process, while it is running. */
  private process: ChildProcess | undefined

  /** The CDP session, while Chrome is reachable. */
  private client: CdpClient | undefined

  /** Tabs the driver tracks, in creation order. */
  private readonly tabs = new Map<string, BrowserTabInfo>()

  /** The id of the tab commands currently act on. */
  private selectedTabId: string | undefined

  /**
   * Remote object id of each tab's page global scope, keyed by CDP session id.
   *
   * `Runtime.callFunctionOn` addresses its callee by object id, so evaluations
   * must run against the page's global object; caching it keeps one evaluation
   * from allocating one renderer handle. Entries are dropped when a tab closes.
   */
  private readonly globalObjectIds = new Map<string, string>()

  /** Monotonic tab-id counter; keeps ids readable and independent of target ids. */
  private nextTabSeq = 1

  /** Set while a launch is in progress, so concurrent callers share one launch. */
  private launching: Promise<void> | undefined

  /** Set once the driver is disposed, to reject any late use. */
  private disposed = false

  /**
   * @param options - browser launch configuration; every field is optional.
   */
  constructor(options: BrowserDriverOptions = {}) {
    this.options = options
  }

  /**
   * Ensure Chrome is running and attached, launching it if needed.
   *
   * Launch is lazy by design: mounting the plugin must not pop a browser window
   * on every Host start. The first tool call, route hit, or sidebar mount pulls
   * the browser up, and concurrent first calls share one launch via the
   * `launching` promise rather than racing two Chrome instances.
   * @returns void; throws {@link BrowserError} when no browser can be launched.
   */
  private async ensureAttached(): Promise<void> {
    if (this.disposed) throw new BrowserError('disposed', 'the side browser has been disposed')
    if (this.client?.isOpen === true) return
    if (this.launching !== undefined) {
      await this.launching
      return
    }
    this.launching = this.launch().finally(() => {
      this.launching = undefined
    })
    await this.launching
  }

  /**
   * Launch Chrome with a debugging port and connect a CDP client.
   *
   * On a reused port a stale or foreign instance may already be listening; if
   * the endpoint answers with a usable browser target we adopt it instead of
   * failing, which is what makes a Host restart reuse the still-open window.
   * @throws {BrowserError} when no executable exists or the port never opens.
   */
  private async launch(): Promise<void> {
    const executable = await resolveExecutable(this.options.executablePath)
    if (executable === undefined) {
      throw new BrowserError('no-browser', 'no Chrome/Chromium/Edge executable found; set the side browser executable in its settings')
    }
    const userDataDir = resolveUserDataDir(this.options.userDataDir)
    await mkdir(userDataDir, { recursive: true })
    const port = this.options.port && this.options.port > 0 ? this.options.port : await this.pickFreePort()
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(this.options.headless === true ? ['--headless=new'] : []),
      ...(this.options.extraArgs ?? []),
    ]
    // Reuse an already-listening debug port if it belongs to a live browser.
    const existing = await this.tryConnect(port)
    if (existing !== undefined) {
      this.client = existing
      this.adoptExistingTargets()
      return
    }
    const child = spawn(executable, args, { stdio: 'ignore', detached: false })
    this.process = child
    // `spawn` reports failure asynchronously on the child, and an EventEmitter
    // 'error' with no listener throws. Without this listener a bad
    // `executablePath` — a directory, a .lnk, a quarantined or half-deleted
    // binary — takes down the whole Host process instead of just this plugin.
    // Windows treats `access(X_OK)` as `F_OK`, so the probe above proves
    // existence, not executability, so this path is genuinely reachable.
    let spawnError: Error | undefined
    child.once('error', (error: Error) => {
      spawnError = error
      if (this.process === child) this.process = undefined
    })
    child.once('exit', () => {
      if (this.process === child) this.process = undefined
    })
    await this.waitForDebugPort(port, () => spawnError)
    const client = await this.tryConnect(port)
    if (client === undefined) {
      throw new BrowserError('launch-failed', `Chrome started but its debugging port ${port} never accepted a CDP connection`)
    }
    this.client = client
    this.adoptExistingTargets()
  }

  /**
   * Probe a debugging port and, if a browser answers, connect to it.
   *
   * Used both before launching (to adopt a live browser on a fixed port) and
   * after launching (to attach to the one we just started).
   * @param port - the CDP port to probe.
   * @returns a connected client, or undefined when nothing usable answers.
   */
  private async tryConnect(port: number): Promise<CdpClient | undefined> {
    let webSocketUrl: string
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (!response.ok) return undefined
      const body = await response.json() as { webSocketDebuggerUrl?: string }
      if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl === '') return undefined
      webSocketUrl = body.webSocketDebuggerUrl
    } catch {
      return undefined
    }
    try {
      return await CdpClient.connect(webSocketUrl)
    } catch {
      return undefined
    }
  }

  /**
   * Wait for a freshly launched browser's debugging port to accept connections.
   *
   * Chrome writes the DevToolsActivePort file and begins listening within a
   * second or so on a warm profile, but a cold first-run can take longer; this
   * polls until the deadline rather than guessing a fixed sleep.
   * @param port - the port to wait on.
   * @param spawnError - reads the pending spawn failure, if one has been reported.
   * @throws {BrowserError} when the deadline passes with no listener.
   */
  private async waitForDebugPort(port: number, spawnError?: () => Error | undefined): Promise<void> {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
      const failure = spawnError?.()
      if (failure !== undefined) {
        throw new BrowserError('launch-failed', `Chrome could not be started: ${failure.message}`)
      }
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        throw new BrowserError('launch-failed', 'Chrome exited before opening its debugging port')
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) return
      } catch {
        // Not listening yet; keep polling until the deadline.
      }
      await new Promise(resolve => { setTimeout(resolve, LAUNCH_POLL_MS) })
    }
    throw new BrowserError('launch-timeout', `Chrome debugging port ${port} did not open within ${LAUNCH_TIMEOUT_MS}ms`)
  }

  /**
   * Choose a free TCP port for a new browser instance.
   *
   * A fixed default port would collide with a second DSH profile or an
   * already-running debug browser; letting the OS pick avoids that entirely.
   * @returns an ephemeral port number.
   */
  private async pickFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => { port > 0 ? resolve(port) : reject(new Error('failed to reserve a port')) })
      })
    })
  }

  /**
   * Adopt the browser's current page targets into the tab model.
   *
   * A freshly launched Chrome opens an initial blank page, and an adopted
   * reused browser may already have tabs; both are recorded so `tabs()` and the
   * selected tab reflect reality instead of an empty model.
   */
  private adoptExistingTargets(): void {
    void this.refreshTargets().catch(() => {
      // Adoption is best-effort: the first explicit open/navigate creates a tab
      // regardless, so a failure here must not block the launch.
    })
  }

  /**
   * Refresh the tracked tab set from the browser's live targets.
   *
   * Chrome may close a tab behind the driver's back (the user closes the real
   * window); resyncing keeps the model honest so commands never act on a dead
   * target.
   * @throws {BrowserError} when the browser is not attached.
   */
  private async refreshTargets(): Promise<void> {
    const client = await this.requireClient()
    const result = await client.sendObject('Target.getTargets')
    const infos = Array.isArray(result.targetInfos) ? result.targetInfos : []
    const live = new Set<string>()
    for (const raw of infos) {
      if (typeof raw !== 'object' || raw === null) continue
      const info = raw as { targetId?: string, type?: string, url?: string, title?: string }
      if (info.type !== 'page' || typeof info.targetId !== 'string') continue
      live.add(info.targetId)
      if (this.findByTargetId(info.targetId) !== undefined) continue
      const id = this.newTabId()
      this.tabs.set(id, {
        id,
        targetId: info.targetId,
        sessionId: await this.attachSession(info.targetId),
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
        selected: false,
      })
    }
    // Drop the tabs the browser has actually destroyed. Without this the strip
    // only ever grew: a closed tab was re-adopted from a stale `Target.getTargets`
    // as a brand-new record with the same targetId, so the user could click a
    // ghost tab and then watch a later command fail against a dead target.
    for (const [id, tab] of [...this.tabs]) {
      if (live.has(tab.targetId)) continue
      this.tabs.delete(id)
      this.globalObjectIds.delete(tab.sessionId)
      // Clear the selection if it pointed at the removed tab; otherwise the id
      // would dangle until some later resync noticed, and the selection block
      // below cannot replace it (there is no next tab to pick).
      if (this.selectedTabId === id) this.selectedTabId = undefined
    }
    if (this.selectedTabId === undefined || !this.tabs.has(this.selectedTabId)) {
      const first = this.tabs.keys().next()
      if (!first.done) this.selectedTabId = first.value
    }
    this.syncSelectionFlag()
  }

  /**
   * Attach a flat-mode CDP session to a target and enable the domains we drive.
   *
   * Flat mode means one session id addresses the page for all subsequent
   * commands; enabling Page/Runtime/DOM up front means the first navigation or
   * evaluate does not race a domain that was never switched on.
   * @param targetId - the CDP target id to attach to.
   * @returns the flat-mode session id.
   */
  private async attachSession(targetId: string): Promise<string> {
    const client = await this.requireClient()
    const attached = await client.sendObject('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = typeof attached.sessionId === 'string' ? attached.sessionId : ''
    if (sessionId === '') throw new BrowserError('attach-failed', `could not attach a CDP session to target ${targetId}`)
    await client.send('Page.enable', {}, sessionId).catch(() => undefined)
    await client.send('Runtime.enable', {}, sessionId).catch(() => undefined)
    // Resolve the page's global object once and cache it: every argument-passing
    // evaluation runs against it, and a fresh remote object per call would leak
    // one handle per evaluation in the renderer.
    const globalRef = await client.sendObject('Runtime.evaluate', { expression: 'globalThis' }, sessionId).catch(() => undefined)
    const objectId = (globalRef?.result as { objectId?: unknown } | undefined)?.objectId
    if (typeof objectId === 'string' && objectId !== '') {
      this.globalObjectIds.set(sessionId, objectId)
    }
    return sessionId
  }

  /**
   * Allocate the next readable tab id.
   * @returns a fresh tab id like `tab-1`.
   */
  private newTabId(): string {
    return `tab-${this.nextTabSeq++}`
  }

  /**
   * Find a tracked tab by its CDP target id.
   * @param targetId - the CDP target id.
   * @returns the tracked tab, or undefined when it is not tracked.
   */
  private findByTargetId(targetId: string): BrowserTabInfo | undefined {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId) return tab
    return undefined
  }

  /**
   * Get the live CDP client, ensuring the browser is attached first.
   *
   * Every public operation funnels through here so a dead browser relaunches
   * transparently instead of surfacing a protocol error.
   * @returns a connected CDP client.
   * @throws {BrowserError} when the browser cannot be launched.
   */
  private async requireClient(): Promise<CdpClient> {
    await this.ensureAttached()
    const client = this.client
    if (client === undefined || !client.isOpen) throw new BrowserError('not-attached', 'the side browser is not connected to Chrome')
    return client
  }

  /**
   * Resolve which tab a command should act on.
   *
   * An explicit tab id wins; otherwise the selected tab; otherwise the first
   * tracked tab. Returns undefined only when the browser has no page at all.
   * @param tabId - an optional explicit tab id from a caller.
   * @returns the target tab, or undefined when none exists.
   */
  private async resolveTab(tabId?: string): Promise<BrowserTabInfo | undefined> {
    if (tabId !== undefined && tabId !== '') {
      const tab = this.tabs.get(tabId)
      if (tab !== undefined) return tab
      throw new BrowserError('tab-not-found', `no tab with id ${tabId}`)
    }
    if (this.selectedTabId !== undefined) {
      const tab = this.tabs.get(this.selectedTabId)
      if (tab !== undefined) return tab
    }
    return this.tabs.values().next().value
  }

  /**
   * Keep exactly one tab flagged selected.
   *
   * The flag is derived from `selectedTabId` so the two can never disagree after
   * a tab is opened or closed.
   */
  private syncSelectionFlag(): void {
    for (const tab of this.tabs.values()) tab.selected = tab.id === this.selectedTabId
  }

  /**
   * Open a URL (or a named shortcut) in a new tab and select it.
   *
   * A new tab rather than reusing the current one keeps the user's browsing
   * context intact when the agent follows a link — the sidebar's tab strip and
   * the selected tab make that explicit.
   *
   * The target is created blank and then navigated explicitly, rather than
   * passing the url to `Target.createTarget`. That ordering matters: creating a
   * target already at a url starts the load before the session is attached, so
   * the driver's `Runtime.enable` and global-object lookup race the navigation
   * and the first extraction sees a half-loaded page (or a stale execution
   * context). Navigating after attach means every domain this driver relies on is
   * live before the document starts loading.
   * @param target - a full URL or one of {@link BROWSER_SHORTCUTS}.
   * @returns the newly opened tab.
   * @throws {BrowserError} when the target is neither a valid URL nor a known shortcut.
   */
  async open(target: string): Promise<BrowserTabInfo> {
    const url = resolveNavigationTarget(target)
    const client = await this.requireClient()
    const created = await client.sendObject('Target.createTarget', { url: 'about:blank' })
    const targetId = typeof created.targetId === 'string' ? created.targetId : ''
    if (targetId === '') throw new BrowserError('open-failed', 'Chrome did not return a target id for the new tab')
    const sessionId = await this.attachSession(targetId)
    await client.send('Page.navigate', { url }, sessionId).catch((error: unknown) => {
      throw new BrowserError('navigate-failed', messageOf(error))
    })
    const id = this.newTabId()
    const tab: BrowserTabInfo = { id, targetId, sessionId, url, title: '', selected: true }
    this.tabs.set(id, tab)
    this.selectedTabId = id
    this.syncSelectionFlag()
    // Wait for the first paint so the tab carries a real title and the sidebar
    // does not show an empty tab strip entry until the next refresh.
    await this.waitForLoad(sessionId)
    return tab
  }

  /**
   * Navigate the selected (or a named) tab to a URL or shortcut.
   * @param target - a full URL or a {@link BROWSER_SHORTCUTS} key.
   * @param tabId - optional explicit tab id.
   * @returns the resulting tab snapshot after the navigation is requested.
   * @throws {BrowserError} when no tab is available or the target is invalid.
   */
  async navigate(target: string, tabId?: string): Promise<PageSnapshot> {
    const url = resolveNavigationTarget(target)
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) return await this.openAndSnapshot(url)
    const client = await this.requireClient()
    await client.send('Page.navigate', { url }, tab.sessionId)
    // A navigation is about to replace the execution context, so the cached
    // global handle is dropped now rather than being recovered by the retry path.
    this.globalObjectIds.delete(tab.sessionId)
    await this.waitForLoad(tab.sessionId)
    tab.url = url
    return await this.snapshot(tabId)
  }

  /**
   * Open a URL in a fresh tab and snapshot the browser in one step.
   *
   * Used when the first navigation happens before any tab exists (a cold
   * start), so `navigate` never has to fail for lack of a tab.
   * @param url - the validated target url.
   * @returns the post-open snapshot.
   */
  private async openAndSnapshot(url: string): Promise<PageSnapshot> {
    await this.open(url)
    return await this.snapshot()
  }

  /**
   * Go back in the selected tab's history.
   * @param tabId - optional explicit tab id.
   * @returns the resulting snapshot.
   */
  async back(tabId?: string): Promise<PageSnapshot> {
    return await this.historyStep(-1, tabId)
  }

  /**
   * Go forward in the selected tab's history.
   * @param tabId - optional explicit tab id.
   * @returns the resulting snapshot.
   */
  async forward(tabId?: string): Promise<PageSnapshot> {
    return await this.historyStep(1, tabId)
  }

  /**
   * Step the tab's history by a signed offset.
   *
   * History navigation is asynchronous in the page: we ask the page to go and
   * then let the load event land before snapshotting, so the reported url/title
   * is the destination rather than the origin.
   * @param delta - -1 for back, +1 for forward.
   * @param tabId - optional explicit tab id.
   * @returns the resulting snapshot.
   */
  private async historyStep(delta: -1 | 1, tabId?: string): Promise<PageSnapshot> {
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) throw new BrowserError('no-tab', 'there is no page open to navigate')
    const client = await this.requireClient()
    const method = delta === -1 ? 'Page.getNavigationHistory' : 'Page.getNavigationHistory'
    const history = await client.sendObject(method, {}, tab.sessionId)
    const entries = Array.isArray(history.entries) ? history.entries : []
    const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0
    const target = index + delta
    const entry = entries[target] as { id?: number } | undefined
    if (entry === undefined || typeof entry.id !== 'number') return await this.snapshot(tabId)
    await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, tab.sessionId)
    await this.waitForLoad(tab.sessionId)
    return await this.snapshot(tabId)
  }

  /**
   * Reload the selected tab.
   * @param tabId - optional explicit tab id.
   * @param ignoreCache - bypass the HTTP cache (default false).
   * @returns the resulting snapshot.
   */
  async reload(tabId?: string, ignoreCache = false): Promise<PageSnapshot> {
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) throw new BrowserError('no-tab', 'there is no page open to reload')
    const client = await this.requireClient()
    await client.send('Page.reload', { ignoreCache }, tab.sessionId)
    await this.waitForLoad(tab.sessionId)
    return await this.snapshot(tabId)
  }

  /**
   * Wait briefly for a page load to settle after a history/reload step.
   *
   * CDP fires `Page.loadEventFired` when the document is ready; we wait for it
   * with a bounded timeout so a slow or hung page never stalls the driver. The
   * wait is skipped if load already happened (the event can race subscription).
   * @param sessionId - the tab's flat-mode session id.
   */
  private async waitForLoad(sessionId: string): Promise<void> {
    const client = this.client
    if (client === undefined) return
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off()
        resolve()
      }
      const off = client.on('Page.loadEventFired', (event) => {
        // Flat mode puts the session id at the top level of the envelope, not in
        // params. Reading it out of `params` yields undefined against a real
        // Chrome, so this used to settle on the FIRST tab's load event — sending
        // navigate/open/reload on to a text extraction that reads a document
        // still half-rendered.
        if (event.sessionId === undefined || event.sessionId === sessionId) done()
      })
      const timer = setTimeout(done, 5000)
      timer.unref?.()
    })
  }

  /**
   * Select which tab subsequent commands act on.
   * @param tabId - the tab to select.
   * @returns the newly selected tab.
   * @throws {BrowserError} when the tab id is unknown.
   */
  async selectTab(tabId: string): Promise<BrowserTabInfo> {
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) throw new BrowserError('tab-not-found', `no tab with id ${tabId}`)
    this.selectedTabId = tab.id
    this.syncSelectionFlag()
    return tab
  }

  /**
   * List the tracked tabs, with the selected one flagged.
   * @returns a snapshot of every tracked tab.
   */
  async listTabs(): Promise<BrowserTabInfo[]> {
    if (this.client !== undefined && this.client.isOpen) {
      await this.refreshTargets().catch(() => {
        // Keep the last-known model if the resync fails; callers still get a list.
      })
    }
    return [...this.tabs.values()].map(tab => ({ ...tab }))
  }

  /**
   * Close a tracked tab, moving selection to a neighbour when the selected tab closes.
   * @param tabId - the tab to close.
   * @returns void; closing an unknown tab is a no-op guarded by resolveTab's error.
   */
  async closeTab(tabId: string): Promise<void> {
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) return
    const client = await this.requireClient()
    await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined)
    this.tabs.delete(tab.id)
    // The cached global handle belongs to the destroyed renderer; keeping it
    // would make a later evaluation of a reused session id fail confusingly.
    this.globalObjectIds.delete(tab.sessionId)
    if (this.selectedTabId === tab.id) {
      const next = this.tabs.keys().next()
      this.selectedTabId = next.done ? undefined : next.value
    }
    this.syncSelectionFlag()
  }

  /**
   * Take a snapshot of the selected tab's title, url, and load state.
   * @param tabId - optional explicit tab id.
   * @returns the page snapshot.
   */
  async snapshot(tabId?: string): Promise<PageSnapshot> {
    const attached = this.client?.isOpen === true
    const tab = await this.resolveTab(tabId).catch(() => undefined)
    if (!attached || tab === undefined) {
      return { attached: false, loading: false, title: '', url: '', ...(tab === undefined ? {} : { tab: { ...tab } }) }
    }
    const client = this.client as CdpClient
    const meta = await this.readPageMeta(client, tab.sessionId)
    return { attached: true, loading: meta.loading, title: meta.title, url: meta.url, tab: { ...tab, url: meta.url, title: meta.title } }
  }

  /**
   * Read title/url/loading from a page without failing the whole operation.
   *
   * A page mid-navigation can transiently refuse evaluation; treating that as
   * "unknown but attached" keeps a snapshot useful instead of throwing.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @returns title, url, and a best-effort loading flag.
   */
  private async readPageMeta(client: CdpClient, sessionId: string): Promise<{ title: string, url: string, loading: boolean }> {
    try {
      const result = await this.evaluate(client, sessionId, PAGE_META_EXPRESSION, [])
      const meta = result as { title?: unknown, url?: unknown, ready?: unknown } | undefined
      return {
        title: typeof meta?.title === 'string' ? meta.title : '',
        url: typeof meta?.url === 'string' ? meta.url : '',
        loading: meta?.ready === 'loading',
      }
    } catch {
      return { title: '', url: '', loading: true }
    }
  }

  /**
   * Evaluate a CONSTRUCTED expression in the page with serialized arguments.
   *
   * This is the security boundary of the whole plugin: the expression string is
   * always a literal this module controls, and any caller-supplied value is
   * passed as a CDP argument value rather than being concatenated into the code.
   * Raw user/model text is therefore never parsed as JavaScript. Callers must use
   * the high-level helpers (`click`, `typeText`, `extractText`) rather than
   * passing a free-form expression.
   *
   * The mechanism is `callFunctionOn`, not `Runtime.evaluate`'s (nonexistent)
   * `args` field: CDP hands the function a real `__args` object it materialises
   * from the serialized values, so the expression body reads them as ordinary
   * data. `Runtime.evaluate` with an interpolated string would be the obvious
   * alternative and is exactly the injection this design avoids.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @param expression - a literal expression this module defines (an IIFE reading `__args`).
   * @param args - the arguments object to expose to the expression as `__args`.
   * @returns the expression's return value, by value.
   * @throws {BrowserError} when the page throws or the result is not serializable.
   */
  private async evaluate(client: CdpClient, sessionId: string, expression: string, args: readonly unknown[]): Promise<unknown> {
    try {
      return await this.callOnce(client, sessionId, expression, args)
    } catch (error) {
      // A navigation replaces the page's execution context, which invalidates the
      // cached global object handle. That is expected rather than exceptional —
      // it just means a navigation raced the evaluation — so the handle is
      // re-resolved and the call retried exactly once. A second failure is real.
      if (!isStaleContextError(error)) throw error
      this.globalObjectIds.delete(sessionId)
      return await this.callOnce(client, sessionId, expression, args)
    }
  }

  /**
   * Call one literal function declaration in the page, passing serialized arguments.
   *
   * This is the security boundary of the whole plugin. The function body is
   * always a literal this module controls, and every caller-supplied value is
   * passed as a CDP argument *value*, which the page materialises as a real
   * argument — never as source text. Raw user or model text is therefore data
   * inside the page and can never be parsed as JavaScript. Callers must use the
   * high-level helpers (`click`, `typeText`, `extractText`) rather than passing a
   * free-form expression.
   *
   * `Runtime.callFunctionOn` is the mechanism rather than `Runtime.evaluate`
   * with an interpolated string, which is precisely the injection this avoids.
   * It calls the declaration as `fn.call(objectId, ...arguments)`, so the
   * declaration takes its inputs as ordinary *positional* parameters; the
   * signature each expression must expose is therefore
   * `function (cap, includeInventory) { ... }` for the extraction helper and so
   * on. Spreading the argument object into the call keeps that shape explicit.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @param expression - a literal function declaration this module defines.
   * @param args - the arguments, passed positionally into the declaration.
   * @returns the function's return value, by value.
   * @throws {BrowserError} when the page throws or returns no value.
   */
  private async callOnce(client: CdpClient, sessionId: string, expression: string, args: readonly unknown[]): Promise<unknown> {
    const objectId = await this.resolveGlobalObjectId(client, sessionId)
    const result = await client.sendObject('Runtime.callFunctionOn', {
      functionDeclaration: expression,
      objectId,
      // Each entry is a serialized CDP argument value; the page materialises it
      // as a real argument object, so caller text is never part of the source.
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    }, sessionId)
    const exception = result.exceptionDetails as { text?: string, exception?: { description?: string } } | undefined
    if (exception !== undefined && exception !== null) {
      throw new BrowserError('eval-failed', exception.exception?.description ?? exception.text ?? 'the page threw while evaluating')
    }
    return (result.result as { value?: unknown } | undefined)?.value
  }

  /**
   * Resolve (and cache) the remote object id of a page's global scope.
   *
   * `Runtime.callFunctionOn` addresses its `this` by object id, so the page's
   * global object is what an expression must be called on. A navigation can
   * invalidate a cached handle, so a stale id is re-resolved once and the
   * failure is only reported if the second attempt also fails.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @returns the remote object id for the page's global scope.
   * @throws {BrowserError} when the page has no reachable global object.
   */
  private async resolveGlobalObjectId(client: CdpClient, sessionId: string): Promise<string> {
    const cached = this.globalObjectIds.get(sessionId)
    if (cached !== undefined) return cached
    const resolved = await this.fetchGlobalObjectId(client, sessionId)
    if (resolved !== undefined) {
      this.globalObjectIds.set(sessionId, resolved)
      return resolved
    }
    throw new BrowserError('eval-failed', 'could not obtain the page global object')
  }

  /**
   * Fetch a fresh global object id, dropping the cache first when retrying.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @returns the remote object id, or undefined when the page refused.
   */
  private async fetchGlobalObjectId(client: CdpClient, sessionId: string): Promise<string | undefined> {
    this.globalObjectIds.delete(sessionId)
    const evaluated = await client.sendObject('Runtime.evaluate', { expression: 'globalThis' }, sessionId).catch(() => undefined)
    const objectId = (evaluated?.result as { objectId?: unknown } | undefined)?.objectId
    return typeof objectId === 'string' && objectId !== '' ? objectId : undefined
  }

  /**
   * Click an element by CSS selector or by viewport coordinates.
   *
   * Two mechanisms because CDP input is coordinate-based: a selector click first
   * asks the page for the element's center coordinates (a constructed query),
   * then synthesizes real mouse events there — the same thing a user click does,
   * so it works on elements that ignore `.click()`.
   * @param selector - a CSS selector, when clicking by selector.
   * @param x - viewport x coordinate, when clicking by coordinates.
   * @param y - viewport y coordinate, when clicking by coordinates.
   * @param tabId - optional explicit tab id.
   * @returns void.
   * @throws {BrowserError} when neither/both click modes are given, or the selector matches nothing.
   */
  async click(opts: { selector?: string, x?: number, y?: number, tabId?: string }): Promise<void> {
    const tab = await this.requireTab(opts.tabId)
    const client = await this.requireClient()
    const bySelector = opts.selector !== undefined && opts.selector !== ''
    const byPoint = typeof opts.x === 'number' && typeof opts.y === 'number'
    if (bySelector === byPoint) {
      throw new BrowserError('bad-click', 'click needs either a selector or both x and y coordinates')
    }
    let x = opts.x as number
    let y = opts.y as number
    if (bySelector) {
      const box = await this.evaluate(client, tab.sessionId, CLICK_HELPER_EXPRESSION, [opts.selector])
      if (typeof box !== 'object' || box === null) throw new BrowserError('selector-not-found', `no element matched selector ${JSON.stringify(opts.selector)}`)
      const point = box as { x?: unknown, y?: unknown }
      if (typeof point.x !== 'number' || typeof point.y !== 'number') {
        throw new BrowserError('selector-not-found', `the element matching ${JSON.stringify(opts.selector)} is not visible`)
      }
      x = point.x
      y = point.y
    }
    await this.synthesizeClick(client, tab.sessionId, x, y)
  }

  /**
   * Synthesize a full press/release click at viewport coordinates.
   * @param client - the CDP client.
   * @param sessionId - the tab's flat-mode session id.
   * @param x - viewport x coordinate.
   * @param y - viewport y coordinate.
   */
  private async synthesizeClick(client: CdpClient, sessionId: string, x: number, y: number): Promise<void> {
    const common = { x, y, button: 'left', clickCount: 1 }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common }, sessionId)
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common }, sessionId)
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common }, sessionId)
  }

  /**
   * Type text into an element (by selector) or into whatever has focus.
   *
   * `Input.insertText` is used rather than per-key events because it is far more
   * reliable for IME-free bulk text (the common case: filling a search box or a
   * prompt box) and does not depend on the page's key handling. When a selector
   * is given we focus the element first via a constructed query.
   * @param text - the literal text to type.
   * @param selector - optional CSS selector to focus before typing.
   * @param tabId - optional explicit tab id.
   * @returns void.
   * @throws {BrowserError} when the selector matches nothing or is not focusable.
   */
  async typeText(text: string, selector?: string, tabId?: string): Promise<void> {
    const tab = await this.requireTab(tabId)
    const client = await this.requireClient()
    if (selector !== undefined && selector !== '') {
      const focused = await this.evaluate(client, tab.sessionId, FOCUS_HELPER_EXPRESSION, [selector])
      if (focused !== true) throw new BrowserError('selector-not-found', `could not focus an element matching ${JSON.stringify(selector)}`)
    }
    await client.send('Input.insertText', { text }, tab.sessionId)
  }

  /**
   * Press one key by its KeyboardEvent key name (e.g. `Enter`, `Tab`, `Escape`).
   *
   * Synthesizes a keyDown/keyUp pair so page-level key handlers fire, matching a
   * real key press. This is how you submit a form or trigger a search after
   * typing.
   * @param key - the KeyboardEvent key value.
   * @param tabId - optional explicit tab id.
   * @returns void.
   * @throws {BrowserError} when the key is empty.
   */
  async pressKey(key: string, tabId?: string): Promise<void> {
    if (key.trim() === '') throw new BrowserError('bad-key', 'key must not be empty')
    const tab = await this.requireTab(tabId)
    const client = await this.requireClient()
    const params = { key, code: key, windowsVirtualKeyCode: virtualKeyCode(key), nativeVirtualKeyCode: virtualKeyCode(key) }
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, tab.sessionId)
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, tab.sessionId)
  }

  /**
   * Scroll the page (or a focused element) by a signed pixel amount.
   * @param deltaY - vertical scroll delta in pixels (positive scrolls down).
   * @param tabId - optional explicit tab id.
   * @returns void.
   */
  async scroll(deltaY: number, tabId?: string): Promise<void> {
    const tab = await this.requireTab(tabId)
    const client = await this.requireClient()
    await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY }, tab.sessionId)
  }

  /**
   * Extract the page's readable text, optionally with a structure inventory.
   *
   * Uses `document.body.innerText` (the rendered, visible text) rather than
   * `textContent`, so script/style noise is excluded. The extraction runs as a
   * constructed expression with a serialized cap argument — the cap is never
   * concatenated into the expression.
   * @param options - a character cap and whether to include the inventory.
   * @param tabId - optional explicit tab id.
   * @returns the extracted title, url, text (capped), and optional inventory.
   * @throws {BrowserError} when no page is open.
   */
  async extractText(options: ExtractTextOptions = {}, tabId?: string): Promise<ExtractedText> {
    const tab = await this.requireTab(tabId)
    const client = await this.requireClient()
    const cap = Math.min(Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, 200), MAX_TEXT_CEILING)
    const raw = await this.evaluate(client, tab.sessionId, EXTRACT_TEXT_EXPRESSION, [cap, options.includeInventory === true])
    if (typeof raw !== 'object' || raw === null) throw new BrowserError('extract-failed', 'the page returned an unreadable text extraction')
    const extracted = raw as { title?: unknown, url?: unknown, text?: unknown, truncated?: unknown, inventory?: unknown }
    return {
      title: typeof extracted.title === 'string' ? extracted.title : '',
      url: typeof extracted.url === 'string' ? extracted.url : tab.url,
      text: typeof extracted.text === 'string' ? extracted.text : '',
      truncated: extracted.truncated === true,
      ...(typeof extracted.inventory === 'object' && extracted.inventory !== null ? { inventory: extracted.inventory as PageInventory } : {}),
    }
  }

  /**
   * Capture the current page as a base64 PNG.
   *
   * A screenshot is how the client half shows the browser, and how the agent
   * gets a visual when text extraction is not enough (a canvas, a video frame).
   *
   * `scale` exists because a modern page's viewport is often 2000×1200 or
   * larger, and an unscaled PNG of that is several megabytes — far too much to
   * move through a poll loop. CDP's `clip.scale` downsamples during capture, so
   * the Host never materialises the full-size bitmap at all, which is the whole
   * point: the alternative (capture then resize) would need an image codec.
   * @param fullPage - capture beyond the viewport (default false; cheaper).
   * @param tabId - optional explicit tab id.
   * @param scale - downsample factor; 1 captures at natural size.
   * @returns the base64 PNG data (no `data:` prefix).
   * @throws {BrowserError} when no page is open or capture returns nothing.
   */
  async captureScreenshot(fullPage = false, tabId?: string, scale = 1): Promise<string> {
    const tab = await this.requireTab(tabId)
    const client = await this.requireClient()
    const params: Record<string, unknown> = { format: 'png', captureBeyondViewport: fullPage, fromSurface: true }
    const metrics = await client.sendObject('Page.getLayoutMetrics', {}, tab.sessionId).catch(() => undefined)
    const content = (metrics as { cssContentSize?: { width?: number, height?: number } } | undefined)?.cssContentSize
    const width = typeof content?.width === 'number' ? content.width : undefined
    const height = typeof content?.height === 'number' ? content.height : undefined
    if (fullPage) {
      if (width !== undefined && height !== undefined) {
        params.clip = { x: 0, y: 0, width, height, scale }
      }
    } else if (scale !== 1) {
      // A viewport capture without a clip ignores `scale`, so derive the
      // viewport box from the layout metrics and clip to it explicitly.
      const viewport = (metrics as { cssLayoutViewport?: { clientWidth?: number, clientHeight?: number } } | undefined)?.cssLayoutViewport
      const viewWidth = typeof viewport?.clientWidth === 'number' ? viewport.clientWidth : width
      const viewHeight = typeof viewport?.clientHeight === 'number' ? viewport.clientHeight : height
      if (viewWidth !== undefined && viewHeight !== undefined) {
        params.clip = { x: 0, y: 0, width: viewWidth, height: viewHeight, scale }
      }
    }
    const result = await client.sendObject('Page.captureScreenshot', params, tab.sessionId)
    const data = result.data
    if (typeof data !== 'string' || data === '') throw new BrowserError('capture-failed', 'Chrome returned no screenshot data')
    return data
  }

  /**
   * Resolve a target tab, erroring clearly when the browser has no page.
   * @param tabId - optional explicit tab id.
   * @returns a live tab.
   * @throws {BrowserError} when there is no tab to act on.
   */
  private async requireTab(tabId?: string): Promise<BrowserTabInfo> {
    const tab = await this.resolveTab(tabId)
    if (tab === undefined) throw new BrowserError('no-tab', 'there is no page open; open one first')
    return tab
  }

  /**
   * Persist a screenshot PNG to disk and return its path.
   *
   * The agent-facing screenshot tool returns a path/handle rather than inlining
   * megabytes of base64 into the transcript: a transcript is a scarce, persisted
   * resource, and a base64 PNG there would bloat every future context window
   * that carries the session. Writing the PNG to a temp file and returning the
   * path lets the agent (or the user) open/view it without polluting the log.
   * @param tabId - optional explicit tab id.
   * @param fullPage - capture beyond the viewport.
   * @param scale - downsample factor; the agent view defaults to half size.
   * @returns the absolute path of the written PNG.
   */
  async captureScreenshotToFile(tabId?: string, fullPage = false, scale = 1): Promise<string> {
    const data = await this.captureScreenshot(fullPage, tabId, scale)
    const path = join(tmpdir(), `dsh-sidebrowser-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`)
    await writeFile(path, Buffer.from(data, 'base64'))
    return path
  }

  /**
   * Best-effort removal of a previously written screenshot file.
   * @param path - the PNG path to delete.
   * @returns void; a missing file is ignored.
   */
  async deleteScreenshotFile(path: string): Promise<void> {
    await unlink(path).catch(() => undefined)
  }

  /**
   * Dispose the driver: close tabs' CDP session, kill the browser, clear state.
   *
   * Killing Chrome is intentional — it is a process this driver spawned into a
   * dedicated profile, and leaving it running after the Host unloads the plugin
   * would strand an invisible debug-enabled browser. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.tabs.clear()
    this.selectedTabId = undefined
    this.client?.dispose()
    this.client = undefined
    const child = this.process
    this.process = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill()
    }
  }
}

/**
 * Resolve a navigation target to an absolute http(s) URL, rejecting everything else.
 *
 * A bare keyword maps through {@link BROWSER_SHORTCUTS}; anything else must parse
 * as an http/https URL. Restricting the scheme keeps the driver from being
 * steered at `file:`/`javascript:` targets, which would turn a browsing helper
 * into a local-file-read or script-injection primitive.
 * @param target - a {@link BROWSER_SHORTCUTS} key or a URL string.
 * @returns the absolute URL.
 * @throws {BrowserError} when the target is not a known shortcut or a valid http(s) URL.
 */
function resolveNavigationTarget(target: string): string {
  const shortcut = BROWSER_SHORTCUTS[target]
  if (shortcut !== undefined) return shortcut
  const trimmed = target.trim()
  if (trimmed === '') throw new BrowserError('bad-url', 'a url or a known shortcut is required')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new BrowserError('bad-url', `${JSON.stringify(target)} is not a valid URL or a known shortcut`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('bad-url', `only http and https URLs are allowed, got ${url.protocol}`)
  }
  return url.toString()
}

/**
 * A constructed page function returning the page's title, url, and load state.
 * Takes no arguments, so it is the cheapest of the page helpers and is used for
 * every snapshot.
 */
const PAGE_META_EXPRESSION = `function () {
  return { title: document.title, url: location.href, ready: document.readyState };
}`

/**
 * A constructed page function returning an element's viewport center for
 * clicking. It receives the selector as a serialized positional argument, so the
 * caller's selector is data, not code.
 */
const CLICK_HELPER_EXPRESSION = `function (selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r2 = el.getBoundingClientRect();
  return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
}`

/**
 * A constructed page function that focuses (and clicks) an element by a
 * serialized selector argument, returning whether it succeeded.
 */
const FOCUS_HELPER_EXPRESSION = `function (selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.focus();
  if (typeof el.click === 'function') el.click();
  return document.activeElement === el;
}`

/**
 * A constructed page function extracting rendered text and an optional
 * structure inventory. `cap` and `includeInventory` arrive as serialized
 * positional arguments.
 */
const EXTRACT_TEXT_EXPRESSION = `function (cap, includeInventory) {
  const body = document.body;
  const full = body ? body.innerText : '';
  const truncated = full.length > cap;
  const text = truncated ? full.slice(0, cap) : full;
  const result = { title: document.title, url: location.href, text, truncated };
  if (includeInventory) {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 20).map(h => (h.innerText || '').trim()).filter(Boolean);
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 40)
      .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
      .filter(l => l.text !== '');
    const fields = Array.from(document.querySelectorAll('input,textarea,select,button,[contenteditable="true"]')).slice(0, 40)
      .map(el => {
        const selector = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : '');
        const out = { selector, tag: el.tagName.toLowerCase() };
        if (el.type) out.type = el.type;
        if (el.placeholder) out.placeholder = el.placeholder;
        return out;
      });
    result.inventory = { headings, links, fields };
  }
  return result;
}`

/**
 * Map a key name to a Windows virtual key code for `Input.dispatchKeyEvent`.
 *
 * CDP needs the numeric code for the page's key handlers to recognise the key.
 * Only the keys this plugin actually sends are mapped; anything else falls back
 * to a benign code that still delivers the `key` string.
 * @param key - the KeyboardEvent key value.
 * @returns the virtual key code.
 */
function virtualKeyCode(key: string): number {
  const map: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  }
  return map[key] ?? 0
}
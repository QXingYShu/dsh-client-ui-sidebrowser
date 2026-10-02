/**
 * Typed client for this plugin's Host control routes.
 *
 * The Host half owns a real Chrome window driven over CDP. DeepSeek, Bing,
 * Baidu and Youdao all refuse to be framed cross-origin, so a literal in-GUI
 * webview cannot show them and this client drives the host window instead. That
 * is also what lets the agent's `browser_*` tools and the user's own clicking
 * act on the same page.
 *
 * ## The wire contract
 *
 * Every route answers a **flat** envelope: `{ ok: true, ...fields }` on success
 * and `{ ok: false, code, error }` with a real HTTP status on failure. There is
 * no `value` wrapper, so unwrapping is "check `ok`, then take the whole body".
 * Every route is fenced (loopback socket, loopback `Host`, origin equality, a
 * browser same-origin marker), which is why the URLs here are **relative**:
 * a cross-site fetch is refused with 403 before any handler runs, and only a
 * same-origin request from the GUI itself gets through.
 *
 * ## The never-throw discipline
 *
 * Every method resolves to a {@link SideBrowserResult}. Network failures,
 * aborts, HTML error pages from a proxy, and non-`ok` envelopes all land in the
 * `ok: false` branch carrying a message the UI can show verbatim. No caller
 * needs a try/catch, and no unhandled rejection can escape from a poll loop.
 *
 * @module
 */

/** One tab the Host is tracking, as `GET /tabs` reports it. */
export interface BrowserTab {
  /** Driver-assigned stable id, distinct from the CDP target id. */
  id: string
  /** CDP target id backing this tab. */
  targetId: string
  /** CDP session id used to issue page commands. */
  sessionId: string
  /** Current URL. */
  url: string
  /** Current page title. */
  title: string
  /** Whether this is the tab commands act on. Note: the flag is `selected`. */
  selected: boolean
}

/** The Host browser's lifecycle, as this client derives it from `/state`. */
export type HostBrowserPhase =
  /** The driver has no browser attached; nothing can be driven. */
  | 'unavailable'
  /** A browser is attached but the page is still loading. */
  | 'starting'
  /** A browser is attached and the page is settled. */
  | 'ready'

/**
 * The derived view of the browser the panel renders from.
 *
 * The Host's `/state` route reports a *snapshot* (`attached`, `loading`,
 * `title`, `url`, `tab`) rather than a phase, so this client derives the phase
 * once, here, and every surface renders the same three-way answer.
 */
export interface HostBrowserState {
  /** Where the browser is, derived from `attached` + `loading`. */
  phase: HostBrowserPhase
  /** Whether the Host has a browser attached at all. */
  attached: boolean
  /** Whether the page still reports itself loading. */
  loading: boolean
  /** The command target's title. */
  title: string
  /** The command target's URL. */
  url: string
  /** The command target, or undefined when no tab is open. */
  tab: BrowserTab | undefined
  /**
   * Shortcut names the Host accepts for `navigate`/`tabs/open` (for example
   * `bing`, `baidu`), which is how the panel offers a search without building
   * a URL itself.
   */
  shortcuts: readonly string[]
}

/** One captured frame, as the screenshot stream shapes it. */
export interface HostBrowserFrame {
  /** Monotonic frame id, stable while the view is unchanged. */
  id: number
  /** Base64 PNG **without** a `data:` prefix. */
  data: string
  /** Page title at capture time. */
  title: string
  /** Page URL at capture time. */
  url: string
  /** Capture time as an ISO timestamp. */
  capturedAt: string
}

/** One tab's extracted text, mirroring the driver's `ExtractedText`. */
export interface HostPageText {
  /** Page title. */
  title: string
  /** Page URL. */
  url: string
  /** Readable text, truncated to the requested cap. */
  text: string
  /** True when the text was cut off by the cap. */
  truncated: boolean
  /** Optional structure map, present only when `includeInventory` was asked for. */
  inventory: HostPageInventory | undefined
}

/** A compact map of a page's structure, so a reader can aim instead of guess. */
export interface HostPageInventory {
  /** Headings in document order. */
  headings: readonly string[]
  /** Links as `text -> href`. */
  links: ReadonlyArray<{ text: string; href: string }>
  /** Interactive elements with a stable selector. */
  fields: ReadonlyArray<{ selector: string; tag: string; type?: string; placeholder?: string }>
}

/** The result of every call: a discriminated envelope, never a throw. */
export type SideBrowserResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/** Route path prefix every Host route shares. */
const ROUTE = '/api/sidebrowser'

/** How long one route call may take before the client gives up on it. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Ask for a signal that fires after `ms`.
 *
 * A screenshot of a slow page can take seconds, and a Host that has died hangs
 * forever otherwise; a panel stuck on a spinner is worse than an error.
 * @param ms - timeout in milliseconds.
 * @returns an abort signal that fires after `ms`.
 */
function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => { controller.abort() }, ms)
  return controller.signal
}

/** Per-call options. */
interface CallOptions {
  /** Abort deadline for this call. */
  timeoutMs?: number
}

/**
 * Turn an HTTP failure into the readable sentence the panel shows.
 *
 * A Host that has not mounted this plugin answers 404 on the whole prefix, and
 * a refused cross-site request answers 403 — both are materially different from
 * a browser that declined a command, so each gets its own message.
 * @param status - the HTTP status code.
 * @param body - the response body, when it is short enough to be informative.
 * @returns the message.
 */
function describeStatus(status: number, body: string): string {
  if (status === 404) {
    return 'The host did not mount the side-browser routes (is this plugin installed and enabled in this DSH instance?)'
  }
  if (status === 403) {
    return 'The host refused this request as cross-site; the side browser only answers the GUI on this machine'
  }
  if (status === 401) {
    return 'The host rejected this request as unauthenticated; reload the page and retry'
  }
  const detail = body.trim().slice(0, 200)
  return detail === ''
    ? `The host answered HTTP ${status}`
    : `The host answered HTTP ${status}: ${detail}`
}

/** The typed route client every surface in this plugin shares. */
export class SideBrowserApi {
  /**
   * @param basePath - route prefix, overridable so a future Host can mount the
   *   routes elsewhere without touching callers.
   */
  constructor(private readonly basePath: string = ROUTE) {}

  /**
   * Perform one route call and normalize its outcome.
   *
   * Everything that can go wrong on the wire becomes the `ok: false` branch:
   * a rejected fetch, an aborted deadline, an HTML error page, an envelope
   * without `ok`, and a well-formed `ok: false` with a stable `code`.
   * @param path - route path appended to the prefix.
   * @param init - fetch options; a GET by default.
   * @returns the unwrapped body, or a readable failure.
   */
  private async call<T>(
    path: string,
    init: RequestInit & CallOptions = {},
  ): Promise<SideBrowserResult<T>> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init
    let response: Response
    try {
      response = await fetch(`${this.basePath}${path}`, {
        // The Host's fence checks origin and the browser marker, so the
        // credentials the GUI already holds must travel with the request.
        credentials: 'same-origin',
        ...requestInit,
        signal: deadline(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: error instanceof DOMException && error.name === 'TimeoutError'
          ? `The host did not answer within ${Math.round(timeoutMs / 1000)} seconds`
          : `Cannot reach the host browser: ${reason}`,
      }
    }

    const raw = await response.text().catch(() => '')
    let body: Record<string, unknown>
    try {
      body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {
        ok: false,
        error: response.ok
          ? 'The host returned a response that is not JSON'
          : describeStatus(response.status, raw),
      }
    }

    if (body.ok === true) {
      // Flat envelope: the whole body is the value. No `value` key exists.
      return { ok: true, value: body as T }
    }
    if (body.ok === false) {
      // A stable `code` is more useful to a caller branching on failure, but
      // the user-facing text is the Host's `error`; prefer it and fall back to
      // the code so a failure without a message is still nameable.
      const message = typeof body.error === 'string' && body.error !== '' ? body.error : undefined
      const code = typeof body.code === 'string' && body.code !== '' ? body.code : undefined
      return { ok: false, error: message ?? code ?? 'The host reported a failure without a reason' }
    }
    return { ok: false, error: describeStatus(response.status, raw) }
  }

  /**
   * POST a JSON body to a route.
   *
   * The Host requires `application/json` and refuses anything else with 415,
   * which is deliberate: a form post cannot express these commands, and
   * accepting one would open a simple-request CSRF hole.
   */
  private post<T>(path: string, body: Record<string, unknown>, options: CallOptions = {}): Promise<SideBrowserResult<T>> {
    return this.call<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...options,
    })
  }

  /** Read a string field, treating a blank string as absent. */
  private static str(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  /** Read a boolean field, defaulting to false. */
  private static bool(value: unknown): boolean {
    return value === true
  }

  /** Read one tab record from the wire, or undefined when it is unusable. */
  private static tab(value: unknown): BrowserTab | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as Record<string, unknown>
    const id = SideBrowserApi.str(raw.id)
    if (id === '') return undefined
    return {
      id,
      targetId: SideBrowserApi.str(raw.targetId),
      sessionId: SideBrowserApi.str(raw.sessionId),
      url: SideBrowserApi.str(raw.url),
      title: SideBrowserApi.str(raw.title),
      selected: SideBrowserApi.bool(raw.selected),
    }
  }

  /**
   * Read the Host's resolved plugin settings.
   *
   * This is the channel the client actually has: the Host holds the
   * authoritative values because it owns the schema and the volatile config
   * fields. The `configForms` client service this used to depend on is not
   * served by any shipped DSH package, which is why every setting silently
   * fell back to the compiled-in defaults.
   * @returns the settings, or an empty object when the Host has none to give.
   */
  async config(): Promise<SideBrowserResult<Record<string, unknown>>> {
    const result = await this.call<Record<string, unknown>>('/config')
    if (!result.ok) return result
    const raw = result.value.config
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: true, value: {} }
    return { ok: true, value: raw as Record<string, unknown> }
  }

  /**
   * Read the browser's snapshot.
   *
   * The Host answers with a `PageSnapshot` plus the shortcut roster; there is no
   * `phase`, no history reachability and no tab list here, so this client
   * derives the phase and leaves the tab list to {@link tabs}.
   * @returns the derived state.
   */
  async state(): Promise<SideBrowserResult<HostBrowserState>> {
    const result = await this.call<Record<string, unknown>>('/state')
    if (!result.ok) return result
    const raw = result.value
    const attached = SideBrowserApi.bool(raw.attached)
    const loading = SideBrowserApi.bool(raw.loading)
    const shortcuts = Array.isArray(raw.shortcuts)
      ? raw.shortcuts.filter((entry): entry is string => typeof entry === 'string')
      : []
    return {
      ok: true,
      value: {
        // The three-way derivation, made once so every surface agrees.
        phase: attached ? (loading ? 'starting' : 'ready') : 'unavailable',
        attached,
        loading,
        title: SideBrowserApi.str(raw.title),
        url: SideBrowserApi.str(raw.url),
        tab: SideBrowserApi.tab(raw.tab),
        shortcuts,
      },
    }
  }

  /**
   * Navigate the command target.
   * @param url - an absolute URL, or a shortcut name the Host recognises.
   * @param tabId - the tab to navigate; the selected one by default.
   */
  async navigate(url: string, tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/navigate', tabId === undefined ? { url } : { url, tabId })
  }

  /** Go back one entry in a tab's history. */
  async back(tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/back', tabId === undefined ? {} : { tabId })
  }

  /** Go forward one entry in a tab's history. */
  async forward(tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/forward', tabId === undefined ? {} : { tabId })
  }

  /**
   * Reload a tab.
   * @param tabId - the tab to reload.
   * @param ignoreCache - bypass the HTTP cache, which is what makes a reload
   *   button actually reload after a CDN-served page.
   */
  async reload(tabId?: string, ignoreCache = false): Promise<SideBrowserResult<null>> {
    return this.post('/reload', tabId === undefined ? { ignoreCache } : { tabId, ignoreCache })
  }

  /**
   * List the tabs.
   *
   * `/state` deliberately carries no tab list, so this is the tab strip's one
   * source. Each tab's command-target flag is named `selected` on the wire.
   */
  async tabs(): Promise<SideBrowserResult<{ tabs: readonly BrowserTab[] }>> {
    const result = await this.call<Record<string, unknown>>('/tabs')
    if (!result.ok) return result
    const list = Array.isArray(result.value.tabs) ? result.value.tabs : []
    return {
      ok: true,
      value: {
        tabs: list
          .map(entry => SideBrowserApi.tab(entry))
          .filter((tab): tab is BrowserTab => tab !== undefined),
      },
    }
  }

  /** Open a new tab, and make it the command target. */
  async openTab(url: string): Promise<SideBrowserResult<{ tab: BrowserTab | undefined }>> {
    const result = await this.post<Record<string, unknown>>('/tabs/open', { url })
    if (!result.ok) return result
    return { ok: true, value: { tab: SideBrowserApi.tab(result.value.tab) } }
  }

  /** Close one tab. The Host decides what happens to the command target. */
  async closeTab(tabId: string): Promise<SideBrowserResult<null>> {
    return this.post('/tabs/close', { tabId })
  }

  /** Make one tab the command target. */
  async selectTab(tabId: string): Promise<SideBrowserResult<null>> {
    return this.post('/tabs/select', { tabId })
  }

  /**
   * Capture the command target now.
   *
   * This is the explicit capture; the *live view* polls `GET /frame` instead,
   * which is change detected and therefore affordable at 1–2 Hz. An explicit
   * capture is what the reload and refresh affordances want, because it must
   * show the page as it is now rather than as it was on the last poll.
   * @param options - which tab, the whole scroll height, and a scale factor.
   * @returns the frame.
   */
  async screenshot(options: { tabId?: string; fullPage?: boolean; scale?: number } = {}): Promise<SideBrowserResult<HostBrowserFrame>> {
    const result = await this.post<Record<string, unknown>>('/screenshot', {
      ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
      ...(options.fullPage === true ? { fullPage: true } : {}),
      ...(options.scale === undefined ? {} : { scale: options.scale }),
    }, { timeoutMs: 25_000 })
    if (!result.ok) return result
    const frame = SideBrowserApi.frame(result.value.frame)
    if (frame === undefined) return { ok: false, error: 'The host returned an empty frame' }
    return { ok: true, value: frame }
  }

  /**
   * Poll for the live view.
   *
   * The Host captures on demand and compares the encoded bytes: an unchanged
   * page answers `changed: false` with **no payload**, which is what makes a
   * frequent poll cheap. A caller must therefore paint only on
   * `changed: true` and keep the last frame otherwise — repainting on every
   * poll would decode the same PNG twice a second for nothing.
   * @returns either a new frame, or proof the view is unchanged.
   */
  async frame(): Promise<SideBrowserResult<
    { changed: true; frame: HostBrowserFrame } | { changed: false; frameId: number; capturedAt: string }
  >> {
    const result = await this.call<Record<string, unknown>>('/frame', { timeoutMs: 25_000 })
    if (!result.ok) return result
    const raw = result.value
    if (SideBrowserApi.bool(raw.changed)) {
      const frame = SideBrowserApi.frame(raw.frame)
      if (frame === undefined) return { ok: false, error: 'The host reported a changed frame but sent no image' }
      return { ok: true, value: { changed: true, frame } }
    }
    return {
      ok: true,
      value: {
        changed: false,
        frameId: typeof raw.frameId === 'number' ? raw.frameId : 0,
        capturedAt: SideBrowserApi.str(raw.capturedAt),
      },
    }
  }

  /** Read one frame record from the wire, or undefined when it is unusable. */
  private static frame(value: unknown): HostBrowserFrame | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as Record<string, unknown>
    const data = SideBrowserApi.str(raw.data)
    if (data === '') return undefined
    return {
      id: typeof raw.id === 'number' ? raw.id : 0,
      data,
      title: SideBrowserApi.str(raw.title),
      url: SideBrowserApi.str(raw.url),
      capturedAt: SideBrowserApi.str(raw.capturedAt),
    }
  }

  /**
   * Read a page's visible text.
   *
   * This is the route the agent itself uses, which is why the panel offers it:
   * a screenshot at sidebar width is unreadable for a dense page, so the text
   * view is what makes a documentation or search page usable from here — and
   * what the user reads and the model reads are then the same content.
   *
   * The route is a POST with no selector parameter: it reads the whole page.
   * @param options - which tab, the character cap, and whether to ask for the
   *   structure inventory.
   */
  async text(options: { tabId?: string; maxChars?: number; includeInventory?: boolean } = {}): Promise<SideBrowserResult<HostPageText>> {
    const result = await this.post<Record<string, unknown>>('/text', {
      ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
      ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
      ...(options.includeInventory === true ? { includeInventory: true } : {}),
    }, { timeoutMs: 25_000 })
    if (!result.ok) return result
    const raw = result.value
    return {
      ok: true,
      value: {
        title: SideBrowserApi.str(raw.title),
        url: SideBrowserApi.str(raw.url),
        text: SideBrowserApi.str(raw.text),
        truncated: SideBrowserApi.bool(raw.truncated),
        inventory: SideBrowserApi.inventory(raw.inventory),
      },
    }
  }

  /** Narrow the optional structure inventory, or undefined when absent. */
  private static inventory(value: unknown): HostPageInventory | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as Record<string, unknown>
    return {
      headings: Array.isArray(raw.headings) ? raw.headings.filter((h): h is string => typeof h === 'string') : [],
      links: Array.isArray(raw.links)
        ? raw.links.flatMap(entry => {
          if (typeof entry !== 'object' || entry === null) return []
          const link = entry as Record<string, unknown>
          return [{ text: SideBrowserApi.str(link.text), href: SideBrowserApi.str(link.href) }]
        })
        : [],
      fields: Array.isArray(raw.fields)
        ? raw.fields.flatMap(entry => {
          if (typeof entry !== 'object' || entry === null) return []
          const field = entry as Record<string, unknown>
          return [{
            selector: SideBrowserApi.str(field.selector),
            tag: SideBrowserApi.str(field.tag),
            ...(typeof field.type === 'string' ? { type: field.type } : {}),
            ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder } : {}),
          }]
        })
        : [],
    }
  }

  /**
   * Click an element or a point in the command target.
   *
   * Coordinates are CSS pixels in the page's viewport, the same space the
   * screenshot is captured in, so a click can be aimed at something the user
   * can actually see in the panel.
   * @param target - an element selector, or explicit coordinates.
   * @param tabId - the tab to act on.
   */
  async click(
    target: { selector: string } | { x: number; y: number },
    tabId?: string,
  ): Promise<SideBrowserResult<null>> {
    return this.post('/click', { ...target, ...(tabId === undefined ? {} : { tabId }) })
  }

  /**
   * Type into the page.
   *
   * With a selector the Host focuses that element first; without one it types
   * into whatever is focused. There is no `replace` flag: the driver clears the
   * field itself when a selector is given, which is what makes typing into a
   * React-controlled composer actually register.
   * @param text - the text to enter.
   * @param selector - optional element to focus first.
   * @param tabId - the tab to act on.
   */
  async type(text: string, selector?: string, tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/type', {
      text,
      ...(selector === undefined ? {} : { selector }),
      ...(tabId === undefined ? {} : { tabId }),
    })
  }

  /**
   * Send one key to the page.
   * @param key - a key name such as `Enter` or `Escape`.
   * @param tabId - the tab to act on.
   */
  async key(key: string, tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/key', { key, ...(tabId === undefined ? {} : { tabId }) })
  }

  /**
   * Scroll the page.
   * @param deltaY - vertical scroll amount in CSS pixels.
   * @param tabId - the tab to act on.
   */
  async scroll(deltaY: number, tabId?: string): Promise<SideBrowserResult<null>> {
    return this.post('/scroll', { deltaY, ...(tabId === undefined ? {} : { tabId }) })
  }
}

/** The shared route client; surfaces take one in rather than each building their own. */
export const sideBrowserApi = new SideBrowserApi()
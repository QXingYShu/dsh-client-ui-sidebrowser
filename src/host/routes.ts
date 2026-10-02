/**
 * Host HTTP control surface for the sidebar browser.
 *
 * The client half is a same-origin fetch away from these routes, exactly as the
 * task board's panel is. Every route lives under one prefix so the fence below
 * is applied in one place, and every route answers the same `{ ok, ... }`
 * envelope so the client has a single parsing rule instead of one per endpoint.
 *
 * ## Security posture
 *
 * These routes can drive a logged-in browser: they can read whatever page the
 * user has open and can type into it. That makes them an agent-control-plane
 * endpoint, not a convenience API, so they are fenced exactly like the task
 * board's:
 *
 * - **Loopback socket.** The connection must originate from this machine.
 * - **Loopback Host header.** A rebinding attack that reaches the port with a
 *   foreign `Host` is refused.
 * - **Origin equality / `sec-fetch-site`.** A cross-site page that manages to
 *   reach the port cannot drive the user's browser.
 * - **A browser same-origin marker.** A bare `curl` sends neither header and is
 *   refused. This is a tripwire, not the authority: the socket/Host/origin
 *   checks above carry that. It exists so that a random local process cannot
 *   casually drive a logged-in browser session.
 *
 * No route accepts raw JavaScript. `eval-safe` exposes only a small, named set
 * of operations, each backed by a driver method whose page expression this
 * module (not the caller) defines — see the note in the driver on the
 * serialized-argument convention.
 *
 * @module dsh-sidebrowser/host/routes
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { BrowserError, BROWSER_SHORTCUTS, type BrowserDriver } from '../browser/driver.ts'
import type { ScreenshotStream } from '../browser/screenshot-stream.ts'

/** URL prefix shared by every side-browser route. */
export const SIDEBROWSER_API_PREFIX = '/api/sidebrowser'

/** Largest accepted request body: the sidebar sends small JSON control messages. */
const BODY_LIMIT = 64 * 1024

/** Default response headers; every answer is uncacheable live state. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} satisfies OutgoingHttpHeaders

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Harness browser-auth cookie prefix (dsh-client-connection): the
 * authority-bound signed cookie the Host mints in exchange for its launch token.
 * Only an application on this machine can hold it, so its presence is a usable
 * browser signal for shells that forward the page's requests with the fetch
 * headers stripped.
 */
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Whether a Cookie header carries the Host's browser-auth credential.
 * @param header - the raw Cookie header value.
 * @returns true when any segment starts with the browser-auth prefix.
 */
function carriesBrowserAuthCookie(header: string | undefined): boolean {
  if (header === undefined) return false
  return header.split(';').some(segment => segment.trim().startsWith(BROWSER_AUTH_COOKIE_PREFIX))
}

/**
 * Browser-signal tripwire, NOT an authority check.
 *
 * A first-party client that presents neither `Origin` nor `sec-fetch-site` must
 * still pass: the DSH Desktop shell serves the Web GUI from `dsh-app://app/`
 * and forwards its requests itself, deleting both headers on the way. What it
 * does attach is the Host's browser-auth cookie. A request carrying none of
 * these three signals is not the panel, so it is refused.
 * @param req - the incoming request.
 * @returns true when at least one browser signal is present.
 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  if (typeof req.headers.origin === 'string') return true
  return carriesBrowserAuthCookie(req.headers.cookie)
}

/**
 * Full trust fence for one side-browser request.
 *
 * Authority is the loopback socket plus Host/origin equality; the browser
 * marker above is an additional tripwire on top. `X-Forwarded-For` is never
 * trusted — the socket address is authoritative.
 * @param req - the incoming request.
 * @returns true when the request may drive the browser.
 */
export function isTrustedSidebrowserRequest(req: IncomingMessage): boolean {
  if (!browserSameOriginMarker(req)) return false
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response with the family's headers.
 * @param res - the response to write.
 * @param status - the HTTP status code.
 * @param body - the JSON-serialisable body.
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * Read and parse a bounded JSON request body.
 *
 * A body past the cap is refused rather than drained: these are control
 * messages, and a multi-megabyte "navigate" is never legitimate.
 * @param req - the incoming request.
 * @returns the parsed JSON value.
 * @throws {Error} `'body-too-large'` past the cap, or the JSON.parse error.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) {
      // Stop reading but let the socket drain: abandoning a half-read request
      // leaves the connection unusable, so the client sees a reset rather than
      // the 413 this is about.
      req.destroy()
      throw new Error('body-too-large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  return JSON.parse(text)
}

/** Narrow a value to a JSON object, or undefined when it is not one. */
function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read a string field, treating a blank string as absent.
 *
 * Whitespace counts as blank, not just the empty string: a form or a
 * keyboard-submitted URL bar routinely sends `"   "`, and passing that through
 * would replace the user's page with an error page instead of reporting the
 * missing argument. Trimming also means a value the caller sends padded with
 * spaces — which a copy-paste out of a URL bar very often is — works.
 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a boolean field. */
function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Read a finite number field, truncating to an integer where the caller wants one. */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Turn any thrown value into the `{ ok:false, code, error }` envelope the client expects. */
function failureOf(error: unknown): { status: number, body: Record<string, unknown> } {
  if (error instanceof BrowserError) {
    // A browser that cannot be launched is a configuration problem the user can
    // fix, not a server fault, so it reports 503 with its stable code rather
    // than a 500 the client would render as "the plugin is broken".
    const status = error.code === 'no-browser' || error.code === 'launch-failed' || error.code === 'launch-timeout' || error.code === 'not-attached'
      ? 503
      : 400
    return { status, body: { ok: false, code: error.code, error: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, code: 'internal', error: message } }
}

/**
 * Build every `/api/sidebrowser/*` route.
 *
 * @param driver - the browser controller backing the routes.
 * @param stream - the screenshot stream the client polls for its live view.
 * @returns the routes, ready to hand to `ctx.webServer.register`.
 */
export function makeSidebrowserRoutes(driver: BrowserDriver, stream: ScreenshotStream): WebRoute[] {
  /**
   * Apply the trust fence, answering 403 itself when the request is untrusted.
   * @param req - the incoming request.
   * @param res - the response.
   * @returns true when the handler may proceed.
   */
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedSidebrowserRequest(req)) return true
    writeJson(res, 403, { ok: false, code: 'forbidden', error: 'this request did not come from the local web UI' })
    return false
  }

  /**
   * Build a GET route that runs a handler inside the fence.
   *
   * The handler returns the JSON body rather than writing it, so every route
   * body is a plain expression and the write/error path stays in one place.
   * @param name - the path segment after the prefix.
   * @param handler - produces the response body.
   * @returns the web route.
   */
  const get = (name: string, handler: (req: IncomingMessage) => Promise<unknown>): WebRoute => ({
    kind: 'exact',
    path: `${SIDEBROWSER_API_PREFIX}/${name}`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'use GET' })
        return
      }
      if (!guard(req, res)) return
      void (async () => {
        try {
          writeJson(res, 200, await handler(req))
        } catch (error) {
          if (res.headersSent) return
          const { status, body } = failureOf(error)
          writeJson(res, status, body)
        }
      })()
    },
  })

  /**
   * Build a POST route that runs a JSON-bodied handler inside the fence.
   *
   * The content-type check is strict because a form post cannot express these
   * operations, and accepting one would open a simple-request CSRF hole.
   * @param name - the path segment after the prefix.
   * @param handler - receives the parsed body object.
   * @returns the web route.
   */
  const post = (name: string, handler: (body: Record<string, unknown>) => Promise<unknown>): WebRoute => ({
    kind: 'exact',
    path: `${SIDEBROWSER_API_PREFIX}/${name}`,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'use POST' })
        return
      }
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        writeJson(res, 415, { ok: false, code: 'json-required', error: 'send application/json' })
        return
      }
      void (async () => {
        let parsed: unknown
        try {
          parsed = await readJsonBody(req)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, code: 'bad-body', error: message })
          return
        }
        const body = asJsonObject(parsed)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-body', error: 'the request body must be a JSON object' })
          return
        }
        try {
          writeJson(res, 200, await handler(body))
        } catch (error) {
          if (res.headersSent) return
          const { status, body: failure } = failureOf(error)
          writeJson(res, status, failure)
        }
      })()
    },
  })

  const state = get('state', async () => ({
    ok: true,
    shortcuts: BROWSER_SHORTCUTS,
    ...(await driver.snapshot()),
  }))

  const navigate = post('navigate', async body => {
    const url = readString(body, 'url') ?? readString(body, 'target')
    if (url === undefined) throw new BrowserError('bad-url', 'pass a url or a known shortcut name')
    const tabId = readString(body, 'tabId')
    return { ok: true, ...(await driver.navigate(url, tabId)) }
  })

  const back = post('back', async body => ({ ok: true, ...(await driver.back(readString(body, 'tabId'))) }))
  const forward = post('forward', async body => ({ ok: true, ...(await driver.forward(readString(body, 'tabId'))) }))
  const reload = post('reload', async body => ({
    ok: true,
    ...(await driver.reload(readString(body, 'tabId'), readBoolean(body, 'ignoreCache') === true)),
  }))

  const tabs = get('tabs', async () => ({ ok: true, tabs: await driver.listTabs() }))

  const openTab = post('tabs/open', async body => {
    const url = readString(body, 'url') ?? readString(body, 'target')
    if (url === undefined) throw new BrowserError('bad-url', 'pass a url or a known shortcut name')
    return { ok: true, tab: await driver.open(url) }
  })

  const closeTab = post('tabs/close', async body => {
    const tabId = readString(body, 'tabId')
    if (tabId === undefined) throw new BrowserError('tab-id-required', 'pass a tabId')
    await driver.closeTab(tabId)
    return { ok: true, tabId, tabs: await driver.listTabs() }
  })

  const selectTab = post('tabs/select', async body => {
    const tabId = readString(body, 'tabId')
    if (tabId === undefined) throw new BrowserError('tab-id-required', 'pass a tabId')
    return { ok: true, tab: await driver.selectTab(tabId) }
  })

  /**
   * The client's live view. `fullPage` and `scale` are accepted so the sidebar
   * can trade fidelity for bandwidth without a second endpoint.
   */
  const screenshot = post('screenshot', async body => {
    const tabId = readString(body, 'tabId')
    const fullPage = readBoolean(body, 'fullPage') === true
    const requested = readNumber(body, 'scale')
    const scale = requested === undefined ? 1 : Math.min(Math.max(requested, 0.2), 1)
    // Answer with a frame *record*, the same shape `/frame` sends and the same
    // one the client's parser expects. Returning the bare base64 string here
    // instead meant every explicit capture failed client-side with "empty frame".
    const data = await driver.captureScreenshot(fullPage, tabId, scale)
    const page = await driver.snapshot(tabId).catch(() => undefined)
    return {
      ok: true,
      frame: {
        id: Date.now(),
        data,
        title: page?.title ?? '',
        url: page?.url ?? '',
        capturedAt: new Date().toISOString(),
      },
    }
  })

  /**
   * The polled live view. Separate from `screenshot` because it is change
   * detected: an unchanged page answers with metadata and no payload, which is
   * what makes a 1 Hz poll affordable.
   */
  const frame = get('frame', async () => {
    let poll: Awaited<ReturnType<ScreenshotStream['poll']>>
    try {
      poll = await stream.poll()
    } catch (error) {
      // Cold start: no tab exists yet, so there is nothing to capture. That is
      // an empty view, not a failure — answering 4xx/5xx here made the
      // sidebar's very first paint a server error.
      if (error instanceof BrowserError && error.code === 'no-tab') {
        const idle = stream.latest()
        return {
          ok: true,
          changed: false,
          frameId: idle?.id ?? 0,
          capturedAt: idle?.capturedAt ?? new Date().toISOString(),
          title: idle?.title ?? '',
          url: idle?.url ?? '',
        }
      }
      throw error
    }
    if (!poll.changed) {
      return { ok: true, changed: false, frameId: poll.frameId, capturedAt: poll.capturedAt, title: poll.title, url: poll.url }
    }
    return { ok: true, changed: true, frame: poll.frame }
  })

  const text = post('text', async body => {
    const maxChars = readNumber(body, 'maxChars')
    return {
      ok: true,
      ...(await driver.extractText({
        ...(maxChars === undefined ? {} : { maxChars }),
        includeInventory: readBoolean(body, 'includeInventory') === true,
      }, readString(body, 'tabId'))),
    }
  })

  const click = post('click', async body => {
    const selector = readString(body, 'selector')
    const x = readNumber(body, 'x')
    const y = readNumber(body, 'y')
    const tabId = readString(body, 'tabId')
    await driver.click({
      ...(selector === undefined ? {} : { selector }),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      ...(tabId === undefined ? {} : { tabId }),
    })
    return { ok: true, action: 'click', ...(await driver.snapshot(tabId)) }
  })

  const type = post('type', async body => {
    const text = readString(body, 'text')
    if (text === undefined) throw new BrowserError('text-required', 'pass the text to type')
    const tabId = readString(body, 'tabId')
    await driver.typeText(text, readString(body, 'selector'), tabId)
    return { ok: true, action: 'type', typed: text.length, ...(await driver.snapshot(tabId)) }
  })

  const key = post('key', async body => {
    const name = readString(body, 'key')
    if (name === undefined) throw new BrowserError('key-required', 'pass a key name such as Enter')
    const tabId = readString(body, 'tabId')
    await driver.pressKey(name, tabId)
    return { ok: true, action: 'key', key: name, ...(await driver.snapshot(tabId)) }
  })

  const scroll = post('scroll', async body => {
    const deltaY = readNumber(body, 'deltaY') ?? readNumber(body, 'delta') ?? 600
    const tabId = readString(body, 'tabId')
    await driver.scroll(deltaY, tabId)
    return { ok: true, action: 'scroll', deltaY, ...(await driver.snapshot(tabId)) }
  })

  /**
   * The deliberately small "safe operations" surface.
   *
   * There is no raw-eval route. Each operation below maps onto a driver method
   * whose page expression is defined in this package, with caller values passed
   * as serialized arguments — so the only thing a caller can influence is the
   * data, never the code. Exposing `eval` here would hand any page-rendered
   * untrusted content a script-execution primitive inside the user's logged-in
   * browser, which is not a capability a browsing sidebar should have.
   */
  const evalSafe = post('eval-safe', async body => {
    const operation = readString(body, 'operation')
    if (operation === undefined) throw new BrowserError('operation-required', 'pass an operation name')
    const tabId = readString(body, 'tabId')
    switch (operation) {
      case 'click': {
        const selector = readString(body, 'selector')
        const x = readNumber(body, 'x')
        const y = readNumber(body, 'y')
        await driver.click({
          ...(selector === undefined ? {} : { selector }),
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          ...(tabId === undefined ? {} : { tabId }),
        })
        return { ok: true, operation, ...(await driver.snapshot(tabId)) }
      }
      case 'type': {
        const text = readString(body, 'text')
        if (text === undefined) throw new BrowserError('text-required', 'pass the text to type')
        await driver.typeText(text, readString(body, 'selector'), tabId)
        return { ok: true, operation, ...(await driver.snapshot(tabId)) }
      }
      case 'key': {
        const name = readString(body, 'key')
        if (name === undefined) throw new BrowserError('key-required', 'pass a key name')
        await driver.pressKey(name, tabId)
        return { ok: true, operation, ...(await driver.snapshot(tabId)) }
      }
      case 'scroll': {
        const deltaY = readNumber(body, 'deltaY') ?? 600
        await driver.scroll(deltaY, tabId)
        return { ok: true, operation, ...(await driver.snapshot(tabId)) }
      }
      case 'read': {
        const maxChars = readNumber(body, 'maxChars')
        return {
          ok: true,
          operation,
          ...(await driver.extractText({
            ...(maxChars === undefined ? {} : { maxChars }),
            includeInventory: readBoolean(body, 'includeInventory') === true,
          }, tabId)),
        }
      }
      default:
        throw new BrowserError('unknown-operation', `unsupported operation ${JSON.stringify(operation)}`)
    }
  })

  return [state, navigate, back, forward, reload, tabs, openTab, closeTab, selectTab, screenshot, frame, text, click, type, key, scroll, evalSafe]
}
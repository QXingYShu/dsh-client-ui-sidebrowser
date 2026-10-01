/**
 * Shared fakes for the side-browser unit suite.
 *
 * Two rules the whole suite obeys, because they are what keeps it honest:
 *
 * 1. **No Chrome, no network.** Every driver interaction goes through a stub
 *    implementing only the methods a given test exercises. A test that needs a
 *    method the stub does not implement fails loudly (TypeError at run time)
 *    instead of silently passing against a real browser.
 * 2. **Never stub the thing under test.** The stubs here stand in for the
 *    environment (a CDP-backed browser, a Node HTTP request/response), never for
 *    the plugin's own logic.
 *
 * @module
 */

import { vi, type Mock } from 'vitest'
import type { BrowserDriver, BrowserTabInfo, PageSnapshot, ExtractedText } from '../src/browser/driver.ts'
import { BrowserError } from '../src/browser/driver.ts'

/** A tab record with every field filled, for stubs that return tab lists. */
export function makeTab(overrides: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id: 'tab-1',
    targetId: 'TARGET-1',
    sessionId: 'SESSION-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    selected: true,
    ...overrides,
  }
}

/** A snapshot stub value with every field filled. */
export function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    tab: makeTab(),
    attached: true,
    loading: false,
    title: 'Example Domain',
    url: 'https://example.com/',
    ...overrides,
  }
}

/** An extraction stub value. */
export function makeExtracted(overrides: Partial<ExtractedText> = {}): ExtractedText {
  return {
    title: 'Example Domain',
    url: 'https://example.com/',
    text: 'Example Domain\nThis domain is for use in illustrative examples.',
    truncated: false,
    ...overrides,
  }
}

/** Options for {@link makeDriverStub}. */
export interface DriverStubOptions {
  /** Per-method replacements; anything omitted gets a working default. */
  overrides?: Partial<Record<keyof BrowserDriver, unknown>>
  /**
   * When set, every driver method rejects with this `BrowserError`.
   *
   * This is how "the browser refused" reaches the tools and routes: it is the
   * only failure shape those layers are contractually required to translate, so
   * the refusal envelopes are pinned by making exactly this happen.
   */
  failure?: { code: string, message: string }
}

/** The driver methods the stub implements; anything else is a bug in the test. */
const DRIVER_METHODS = [
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'snapshot',
  'listTabs',
  'selectTab',
  'closeTab',
  'click',
  'typeText',
  'pressKey',
  'scroll',
  'extractText',
  'captureScreenshot',
  'captureScreenshotToFile',
  'deleteScreenshotFile',
  'dispose',
] as const

/**
 * A driver stub whose methods are spies, so a test can assert both the answer
 * the plugin produced *and* the browser command it issued to get there.
 */
export interface DriverStub {
  /** The stub presented to production code as a real `BrowserDriver`. */
  readonly driver: BrowserDriver
  /**
   * Every driver method as a spy, keyed by method name.
   *
   * The index is total by construction — {@link makeDriverStub} fills one entry
   * per method it implements — so a lookup needs no guard and
   * `noUncheckedIndexedAccess` does not apply.
   */
  readonly spies: Record<(typeof DRIVER_METHODS)[number], Mock>
}

/**
 * Build a driver stub.
 *
 * @param options - per-method behaviour, or a universal failure.
 * @returns the stub, split into the driver face and its spies.
 */
export function makeDriverStub(options: DriverStubOptions = {}): DriverStub {
  // The record is deliberately loose about arity: the defaults below stand in
  // for methods whose real signatures take arguments, and each test overrides
  // the ones it cares about with a signature that matches.
  const defaults: Record<string, (...args: never[]) => unknown> = {
    open: async () => makeTab(),
    navigate: async () => makeSnapshot(),
    back: async () => makeSnapshot(),
    forward: async () => makeSnapshot(),
    reload: async () => makeSnapshot(),
    snapshot: async () => makeSnapshot(),
    listTabs: async () => [makeTab()],
    selectTab: async (tabId: string) => makeTab({ id: tabId }),
    closeTab: async () => undefined,
    click: async () => undefined,
    typeText: async () => undefined,
    pressKey: async () => undefined,
    scroll: async () => undefined,
    extractText: async () => makeExtracted(),
    captureScreenshot: async () => 'QUJD',
    captureScreenshotToFile: async () => '/tmp/dsh-sidebrowser-shot.png',
    deleteScreenshotFile: async () => undefined,
    dispose: async () => undefined,
  }
  const { overrides = {}, failure } = options
  const spies: Record<string, Mock> = {}
  const stub: Record<string, unknown> = {}
  for (const name of DRIVER_METHODS) {
    const chosen = overrides[name]
    let impl: (...args: never[]) => unknown
    if (failure !== undefined) {
      impl = async () => { throw new BrowserError(failure.code, failure.message) }
    } else if (typeof chosen === 'function') {
      impl = chosen as (...args: never[]) => unknown
    } else {
      impl = defaults[name] as (...args: never[]) => unknown
    }
    const spy = vi.fn(impl)
    spies[name] = spy
    stub[name] = spy
  }
  return { driver: stub as unknown as BrowserDriver, spies }
}

/** What a recorded response carries. */
export interface RecordedResponse {
  /** HTTP status passed to `writeHead`. */
  status: number
  /** Response headers passed to `writeHead`. */
  headers: Record<string, unknown>
  /** Parsed JSON body the route wrote, or the raw string when unparseable. */
  body: Record<string, unknown> | string | undefined
}

/** A fake response whose writes are captured for assertions. */
export interface FakeResponse {
  /** What the handler wrote. */
  readonly recorded: RecordedResponse
  /** Whether `writeHead` has run — routes use it to avoid double answers. */
  headersSent: boolean
  writeHead(status: number, headers?: Record<string, unknown>): FakeResponse
  end(chunk?: string): FakeResponse
}

/**
 * Build a fake `ServerResponse` that records the JSON answer.
 *
 * The routes answer through `writeHead` + `end` synchronously except for the
 * awaited handler, so tests await a microtask flush before asserting.
 * @returns the recording response.
 */
export function makeResponse(): FakeResponse {
  const recorded: RecordedResponse = { status: 0, headers: {}, body: undefined }
  const response: FakeResponse = {
    recorded,
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      recorded.status = status
      recorded.headers = headers
      response.headersSent = true
      return response
    },
    end(chunk?: string) {
      recorded.body = typeof chunk === 'string' ? parseMaybeJson(chunk) : undefined
      return response
    },
  }
  return response
}

/** Parse a response chunk as JSON, keeping the raw text when it is not JSON. */
function parseMaybeJson(chunk: string): Record<string, unknown> | string {
  try {
    return JSON.parse(chunk) as Record<string, unknown>
  } catch {
    return chunk
  }
}

/** Header and body values for one fake request. */
export interface FakeRequestInit {
  /** Remote socket address; the fence's primary authority check. */
  remoteAddress?: string
  /** `host` header. */
  host?: string
  /** `sec-fetch-site` header. */
  secFetchSite?: string
  /** `origin` header. */
  origin?: string
  /** `cookie` header. */
  cookie?: string
  /** HTTP method; GET by default. */
  method?: string
  /** JSON request body, serialized for POST routes. */
  body?: unknown
  /** `content-type` header; POST routes require `application/json`. */
  contentType?: string
}

/**
 * Build a fake `IncomingMessage` carrying exactly the headers given.
 *
 * Only the header surface the fence reads is modelled; `for await` over the
 * request yields the optional JSON body once, so POST routes can be driven end
 * to end without a socket.
 * @param init - the header and body values for this request.
 * @returns the request stub.
 */
export function makeRequest(init: FakeRequestInit = {}): Record<string, unknown> {
  const headers: Record<string, string> = { host: init.host ?? '127.0.0.1:19387' }
  if (init.secFetchSite !== undefined) headers['sec-fetch-site'] = init.secFetchSite
  if (init.origin !== undefined) headers.origin = init.origin
  if (init.cookie !== undefined) headers.cookie = init.cookie
  if (init.contentType !== undefined) headers['content-type'] = init.contentType
  const serialized = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {})
  const chunks = init.body === undefined ? [] : [Buffer.from(serialized, 'utf8')]
  const iterator = (async function* (): AsyncGenerator<Buffer> {
    for (const chunk of chunks) yield chunk
  })()
  return {
    method: init.method ?? 'GET',
    url: '/api/sidebrowser/state',
    headers,
    socket: { remoteAddress: init.remoteAddress ?? '127.0.0.1' },
    [Symbol.asyncIterator]: () => iterator,
  }
}

/**
 * Flush the microtask queue so a route handler's awaited body has settled.
 *
 * The route handlers write their answer from inside a floating async IIFE, so a
 * test that asserts immediately after calling `handler` would read an empty
 * response. Two turns of the queue drain the driver's stub awaits.
 * @returns void, after the queue has drained.
 */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  await new Promise(resolve => { setImmediate(resolve) })
}
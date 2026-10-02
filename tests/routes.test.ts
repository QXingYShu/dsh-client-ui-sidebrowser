/**
 * Tests for the Host control routes: the cross-site trust fence and the wire
 * envelope.
 *
 * These routes can read whatever page the user has open and type into it, which
 * makes them an agent-control-plane endpoint rather than a convenience API. The
 * fence is therefore the most important thing in this file, and it is tested
 * both as a predicate and through a real route handler so that a route which
 * forgot to call the guard would be caught.
 *
 * The driver is a stub and no socket is ever opened: requests are plain header
 * bags and responses are recorded writes.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeSidebrowserRoutes, isTrustedSidebrowserRequest, SIDEBROWSER_API_PREFIX } from '../src/host/routes.ts'
import type { BrowserDriver } from '../src/browser/driver.ts'
import type { ScreenshotStream } from '../src/browser/screenshot-stream.ts'
import { BrowserError, BROWSER_SHORTCUTS } from '../src/browser/driver.ts'
import { makeDriverStub, makeExtracted, makeRequest, makeResponse, makeSnapshot, settle } from './helpers.ts'

/** A screenshot stream stub whose `poll` a test controls. */
function makeStreamStub(poll: ScreenshotStream['poll']): ScreenshotStream {
  return { poll, latest: () => undefined, start: () => undefined, stop: () => undefined, dispose: () => undefined } as unknown as ScreenshotStream
}

/**
 * Build the route table over a stubbed driver and stream.
 * @param driver - the driver the routes drive.
 * @param poll - what `GET /frame` should answer with.
 * @returns the routes, keyed by path segment.
 */
function makeRoutes(
  driver: BrowserDriver,
  poll?: ScreenshotStream['poll'],
  readConfig?: () => Record<string, unknown>,
): Map<string, WebRoute> {
  const stream = makeStreamStub(poll ?? (async () => {
    throw new Error('there is no page open to screenshot')
  }))
  return new Map(makeSidebrowserRoutes(driver, stream, readConfig).map(route => [route.path, route]))
}

/**
 * Drive one route handler and return what it wrote.
 * @param routes - the route table.
 * @param path - the full path, including the prefix.
 * @param request - the request stub.
 * @returns the recorded response.
 */
async function call(
  routes: Map<string, WebRoute>,
  path: string,
  request: Record<string, unknown>,
): Promise<ReturnType<typeof makeResponse>['recorded']> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route at ${path}`)
  const res = makeResponse()
  await route.handler(request as never, res as never)
  await settle()
  return res.recorded
}

/** A request the GUI itself would send: same-origin, over loopback. */
function sameOrigin(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return makeRequest({ secFetchSite: 'same-origin', ...extra })
}

describe('trust fence predicate', () => {
  it('trusts the GUI\'s own same-origin request', () => {
    // This is the one request that must always pass: the sidebar is a
    // same-origin fetch away from these routes and is the entire feature.
    expect(isTrustedSidebrowserRequest(sameOrigin() as never)).toBe(true)
  })

  it('refuses a cross-site request even from the local machine', () => {
    // A web page the user happens to have open can reach 127.0.0.1; without this
    // check any page on the internet could read the user's logged-in DeepSeek
    // session through this port.
    expect(isTrustedSidebrowserRequest(makeRequest({ secFetchSite: 'cross-site' }) as never)).toBe(false)
  })

  it('refuses a request whose Origin points at another site', () => {
    // Origin equality is the authority check behind the fetch metadata: a
    // foreign origin must not drive the user's browser even if it reached here.
    expect(isTrustedSidebrowserRequest(makeRequest({ origin: 'https://evil.test' }) as never)).toBe(false)
  })

  it('refuses a non-loopback socket address', () => {
    // The socket address is authoritative and `X-Forwarded-For` is never
    // trusted; a request that arrived from the network is refused outright.
    expect(isTrustedSidebrowserRequest(makeRequest({ remoteAddress: '203.0.113.9' }) as never)).toBe(false)
  })

  it('refuses a foreign Host header, closing the DNS-rebinding hole', () => {
    // A rebinding attack resolves evil.test to 127.0.0.1 and then talks to this
    // port with `Host: evil.test`; matching the header against the loopback
    // authority is what stops it.
    expect(isTrustedSidebrowserRequest(makeRequest({ host: 'evil.test' }) as never)).toBe(false)
  })

  it('refuses a request with no browser signal at all', () => {
    // A bare `curl` sends no Origin, no sec-fetch-site and no cookie. It is not
    // the panel, so it must not be able to drive a logged-in browser.
    expect(isTrustedSidebrowserRequest(makeRequest() as never)).toBe(false)
  })

  it('accepts the desktop shell, which forwards requests without fetch headers', () => {
    // The DSH Desktop shell serves the GUI from `dsh-app://app/` and strips
    // Origin and sec-fetch-site on the way in. Refusing it would break the
    // desktop app entirely, so its browser-auth cookie is the accepted signal.
    expect(isTrustedSidebrowserRequest(makeRequest({ cookie: 'dsh-auth-abc=1; other=2' }) as never)).toBe(true)
  })

  it('accepts every loopback address form the Host can be reached on', () => {
    // Windows reports IPv4-mapped IPv6 sockets as `::ffff:127.0.0.1`; refusing
    // those would make the feature work on Linux and silently fail on Windows.
    for (const remoteAddress of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
      expect(isTrustedSidebrowserRequest(makeRequest({ remoteAddress, secFetchSite: 'same-origin' }) as never), remoteAddress).toBe(true)
    }
  })

  it('accepts a Host header naming localhost or the bracketed IPv6 loopback', () => {
    // The GUI is reachable under several authorities; all of them are local.
    for (const host of ['localhost:19387', '[::1]:19387', '127.0.0.1:19387']) {
      expect(isTrustedSidebrowserRequest(makeRequest({ host, secFetchSite: 'same-origin' }) as never), host).toBe(true)
    }
  })
})

describe('route table', () => {
  it('serves the Host\'s resolved settings, which the client cannot get elsewhere', async () => {
    // The client half used to read its settings from a `configForms` service that
    // no shipped DSH package provides, so it silently ran on compiled-in
    // defaults: a translation site the user never chose, a capture interval they
    // never set. This route is the channel that exists.
    const settings = {
      translationEngine: 'bing',
      targetLanguage: 'zh-Hans',
      captureIntervalMs: 3000,
      enabled: true,
    }
    const routes = makeRoutes(makeDriverStub().driver, undefined, () => settings)
    const recorded = await call(routes, `${SIDEBROWSER_API_PREFIX}/config`, sameOrigin({ method: 'GET' }))
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ ok: true, config: settings })
  })

  it('answers an empty config rather than failing when the Host has none to give', async () => {
    const routes = makeRoutes(makeDriverStub().driver)
    const recorded = await call(routes, `${SIDEBROWSER_API_PREFIX}/config`, sameOrigin({ method: 'GET' }))
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ ok: true, config: {} })
  })

  it('registers every documented endpoint under one prefix', () => {
    // One prefix means the fence is applied in exactly one place; a route
    // registered outside it would be unfenced by construction.
    const paths = [...makeRoutes(makeDriverStub().driver).keys()].sort()
    expect(paths).toEqual([
      `${SIDEBROWSER_API_PREFIX}/back`,
      `${SIDEBROWSER_API_PREFIX}/click`,
      `${SIDEBROWSER_API_PREFIX}/config`,
      `${SIDEBROWSER_API_PREFIX}/eval-safe`,
      `${SIDEBROWSER_API_PREFIX}/forward`,
      `${SIDEBROWSER_API_PREFIX}/frame`,
      `${SIDEBROWSER_API_PREFIX}/key`,
      `${SIDEBROWSER_API_PREFIX}/navigate`,
      `${SIDEBROWSER_API_PREFIX}/reload`,
      `${SIDEBROWSER_API_PREFIX}/screenshot`,
      `${SIDEBROWSER_API_PREFIX}/scroll`,
      `${SIDEBROWSER_API_PREFIX}/state`,
      `${SIDEBROWSER_API_PREFIX}/tabs`,
      `${SIDEBROWSER_API_PREFIX}/tabs/close`,
      `${SIDEBROWSER_API_PREFIX}/tabs/open`,
      `${SIDEBROWSER_API_PREFIX}/tabs/select`,
      `${SIDEBROWSER_API_PREFIX}/text`,
      `${SIDEBROWSER_API_PREFIX}/type`,
    ])
  })

  it('exposes no raw-eval route, so page content can never execute here', () => {
    // Any eval-shaped endpoint would hand page-rendered untrusted content a
    // script-execution primitive inside the user's logged-in browser.
    const paths = [...makeRoutes(makeDriverStub().driver).keys()]
    expect(paths.some(path => path.endsWith('/eval'))).toBe(false)
    expect(paths).toContain(`${SIDEBROWSER_API_PREFIX}/eval-safe`)
  })
})

describe('fence enforcement through a real handler', () => {
  it('answers a same-origin GET with the flat ok envelope', async () => {
    // The client parses one rule — "check `ok`, then take the whole body" — so
    // a success must be `{ ok: true, ... }` with no nested `value` wrapper.
    const { driver } = makeDriverStub({ overrides: { snapshot: async () => makeSnapshot() } })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin())
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ ok: true, attached: true, title: 'Example Domain' })
  })

  it('publishes the shortcut roster on /state, so the panel needs no hard-coded urls', async () => {
    // The sidebar's shortcut buttons are built from this list; a shortcut added
    // to the driver but missing here would be invisible in the UI.
    const recorded = await call(makeRoutes(makeDriverStub().driver), `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin())
    expect(recorded.body).toMatchObject({ ok: true, shortcuts: BROWSER_SHORTCUTS })
  })

  it('refuses a cross-site GET with 403 and never reaches the browser', async () => {
    // The handler, not just the predicate: a route that forgot the guard would
    // hand any web page the user's page contents.
    const { driver, spies } = makeDriverStub()
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/state`, makeRequest({ secFetchSite: 'cross-site' }))
    expect(recorded.status).toBe(403)
    expect(recorded.body).toMatchObject({ ok: false, code: 'forbidden' })
    expect(spies.snapshot).not.toHaveBeenCalled()
  })

  it('refuses a cross-site POST as firmly as a GET', async () => {
    // The write routes are the dangerous ones — typing into a logged-in page —
    // so the fence must not depend on the method.
    const { driver, spies } = makeDriverStub()
    const recorded = await call(
      makeRoutes(driver),
      `${SIDEBROWSER_API_PREFIX}/type`,
      makeRequest({ method: 'POST', secFetchSite: 'cross-site', contentType: 'application/json', body: { text: 'x' } }),
    )
    expect(recorded.status).toBe(403)
    expect(spies.typeText).not.toHaveBeenCalled()
  })

  it('never lets an untrusted request reach the browser, whatever method it uses', async () => {
    // The method check runs before the fence, so a wrong-method request from an
    // untrusted caller gets 405 rather than 403. That ordering is harmless — it
    // reveals only that a path exists, which the route table already implies, and
    // no browser work happens either way. What matters is the invariant below.
    const { driver, spies } = makeDriverStub()
    const routes = makeRoutes(driver)
    for (const [path, request] of [
      [`${SIDEBROWSER_API_PREFIX}/navigate`, makeRequest({ method: 'POST', contentType: 'application/json', body: { url: 'https://example.com/' } })],
      [`${SIDEBROWSER_API_PREFIX}/state`, makeRequest()],
      [`${SIDEBROWSER_API_PREFIX}/tabs`, makeRequest()],
    ] as [string, Record<string, unknown>][]) {
      const recorded = await call(routes, path, request)
      expect(recorded.body, path).toMatchObject({ ok: false })
      expect(String((recorded.body as Record<string, unknown>).code), path).toMatch(/forbidden|method-not-allowed/)
    }
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
  })

  it('answers every route uncacheable, with a no-referrer policy', async () => {
    // These are live state answers; a cache or a referrer leak would serve a
    // stale page or hand the user's url to a third party.
    const recorded = await call(makeRoutes(makeDriverStub().driver), `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin())
    expect(recorded.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
  })
})

describe('method and content negotiation', () => {
  it('refuses a POST to a GET route and a GET to a POST route', async () => {
    // Getting this backwards would let a form post — which needs no CORS
    // preflight — reach a control route.
    const routes = makeRoutes(makeDriverStub().driver)
    const getAsPost = await call(routes, `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin({ method: 'POST' }))
    expect(getAsPost.status).toBe(405)
    expect(getAsPost.body).toMatchObject({ code: 'method-not-allowed' })
    const postAsGet = await call(routes, `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({ method: 'GET' }))
    expect(postAsGet.status).toBe(405)
  })

  it('requires application/json on a POST, closing the simple-request CSRF hole', async () => {
    // A form post can only send urlencoded content, so accepting one would
    // let any page on the internet submit a control command.
    const recorded = await call(
      makeRoutes(makeDriverStub().driver),
      `${SIDEBROWSER_API_PREFIX}/click`,
      makeRequest({ method: 'POST', secFetchSite: 'same-origin', contentType: 'text/plain', body: { selector: '#go' } }),
    )
    expect(recorded.status).toBe(415)
    expect(recorded.body).toMatchObject({ code: 'json-required' })
  })

  it('refuses a body that is not a JSON object', async () => {
    // An array or a bare scalar would reach the handler's field readers, where
    // every lookup silently returns undefined and the route fails confusingly.
    const recorded = await call(
      makeRoutes(makeDriverStub().driver),
      `${SIDEBROWSER_API_PREFIX}/click`,
      makeRequest({ method: 'POST', secFetchSite: 'same-origin', contentType: 'application/json', body: '[1,2]' }),
    )
    expect(recorded.status).toBe(400)
    expect(recorded.body).toMatchObject({ code: 'bad-body' })
  })
})

describe('failure envelopes', () => {
  it('reports a configuration failure as 503, not as a broken plugin', async () => {
    // "No Chrome is installed" is a thing the user fixes in settings; a 500
    // would be rendered as "the side browser is broken" and sent nowhere.
    const { driver } = makeDriverStub({
      failure: { code: 'no-browser', message: 'no Chrome/Chromium/Edge executable found' },
    })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin())
    expect(recorded.status).toBe(503)
    expect(recorded.body).toEqual({ ok: false, code: 'no-browser', error: 'no Chrome/Chromium/Edge executable found' })
  })

  it('reports a bad request as 400 with its stable code', async () => {
    // The status separates "the caller is wrong" from "the browser is wrong",
    // and the stable code is what the client branches on.
    const { driver } = makeDriverStub({ failure: { code: 'bad-url', message: 'only http and https URLs are allowed' } })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { url: 'file:///etc/passwd' },
    }))
    expect(recorded.status).toBe(400)
    expect(recorded.body).toMatchObject({ ok: false, code: 'bad-url' })
  })

  it('reports an unexpected failure as a 500 internal error', async () => {
    // Anything not modelled as a `BrowserError` is genuinely unexpected, and
    // saying so is more useful than inventing a stable code for it.
    const { driver } = makeDriverStub({
      overrides: { snapshot: async () => { throw new TypeError('cannot read x of undefined') } },
    })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/state`, sameOrigin())
    expect(recorded.status).toBe(500)
    expect(recorded.body).toEqual({ ok: false, code: 'internal', error: 'cannot read x of undefined' })
  })

  it('rejects a navigate with neither a url nor a shortcut name', async () => {
    // The message tells the model exactly which field is missing, which turns
    // one refusal into one successful retry.
    const { driver, spies } = makeDriverStub()
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: {},
    }))
    expect(recorded.status).toBe(400)
    expect(recorded.body).toMatchObject({ ok: false, code: 'bad-url' })
    expect(spies.navigate).not.toHaveBeenCalled()
  })

  it('names the missing field for tab routes that need a tabId', async () => {
    // `close`/`select` without an id would act on an arbitrary tab.
    const { driver } = makeDriverStub()
    for (const name of ['tabs/close', 'tabs/select']) {
      const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/${name}`, sameOrigin({
        method: 'POST',
        contentType: 'application/json',
        body: {},
      }))
      expect(recorded.body, name).toMatchObject({ ok: false, code: 'tab-id-required' })
    }
  })

  it('requires the text and key fields by name rather than typing nothing', async () => {
    // Typing an empty string or pressing an unnamed key would be a silent
    // no-op that reads to the model as success.
    const routes = makeRoutes(makeDriverStub().driver)
    const typed = await call(routes, `${SIDEBROWSER_API_PREFIX}/type`, sameOrigin({ method: 'POST', contentType: 'application/json', body: {} }))
    expect(typed.body).toMatchObject({ code: 'text-required' })
    const keyed = await call(routes, `${SIDEBROWSER_API_PREFIX}/key`, sameOrigin({ method: 'POST', contentType: 'application/json', body: {} }))
    expect(keyed.body).toMatchObject({ code: 'key-required' })
  })
})

describe('route behaviour', () => {
  it('answers /frame with the frame payload only when it changed', async () => {
    // The whole reason /frame exists separately from /screenshot: a 1 Hz poll of
    // a static page must cost metadata, not a multi-megabyte PNG.
    const { driver } = makeDriverStub()
    const changed = makeRoutes(driver, async () => ({
      changed: true,
      frame: { id: 3, data: 'QUJD', title: 'Doc', url: 'https://example.com/', capturedAt: '2026-01-01T00:00:00.000Z' },
    }))
    const changedBody = await call(changed, `${SIDEBROWSER_API_PREFIX}/frame`, sameOrigin())
    expect(changedBody.body).toMatchObject({ ok: true, changed: true, frame: { id: 3, data: 'QUJD' } })

    const unchanged = makeRoutes(driver, async () => ({
      changed: false,
      frameId: 3,
      capturedAt: '2026-01-01T00:00:00.000Z',
      title: 'Doc',
      url: 'https://example.com/',
    }))
    const unchangedBody = await call(unchanged, `${SIDEBROWSER_API_PREFIX}/frame`, sameOrigin())
    expect(unchangedBody.body).toEqual({
      ok: true,
      changed: false,
      frameId: 3,
      capturedAt: '2026-01-01T00:00:00.000Z',
      title: 'Doc',
      url: 'https://example.com/',
    })
    expect(Object.hasOwn(unchangedBody.body as Record<string, unknown>, 'frame')).toBe(false)
  })

  it('lets a failed frame poll report the browser failure through the envelope', async () => {
    // With no frame ever captured there is nothing to fall back on, so the
    // honest answer is the error, not an empty "unchanged".
    const { driver } = makeDriverStub()
    const routes = makeRoutes(driver, async () => { throw new BrowserError('no-browser', 'install chrome') })
    const recorded = await call(routes, `${SIDEBROWSER_API_PREFIX}/frame`, sameOrigin())
    expect(recorded.status).toBe(503)
    expect(recorded.body).toMatchObject({ ok: false, code: 'no-browser' })
  })

  it('returns page text through /text with the truncation flag intact', async () => {
    // The agent and the user must see the same content, and both need to know
    // whether the cap cut it.
    const { driver } = makeDriverStub({
      overrides: { extractText: async () => makeExtracted({ text: 'page body', truncated: true }) },
    })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/text`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { maxChars: 300, includeInventory: true },
    }))
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ ok: true, text: 'page body', truncated: true })
  })

  it('clamps a requested screenshot scale into the legible band', async () => {
    // The panel's zoom control and the agent both send a scale; an unclamped
    // 0.05 would produce an unreadable frame nobody can use.
    const { driver, spies } = makeDriverStub()
    const routes = makeRoutes(driver)
    await call(routes, `${SIDEBROWSER_API_PREFIX}/screenshot`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { scale: 0.01 },
    }))
    expect(spies.captureScreenshot).toHaveBeenCalledWith(false, undefined, 0.2)
  })

  it('accepts only the named operations on /eval-safe', async () => {
    // This route is the deliberate alternative to a raw eval. It must stay a
    // closed set: an unrecognised name is refused, not forwarded anywhere.
    const { driver } = makeDriverStub()
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/eval-safe`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { operation: 'runScript' },
    }))
    expect(recorded.status).toBe(400)
    expect(recorded.body).toMatchObject({ ok: false, code: 'unknown-operation' })
  })

  it('routes an eval-safe read through the same capped extraction as /text', async () => {
    // The safe-operations surface must not become a way around the character
    // cap that keeps a page from flooding the agent's context.
    const { driver, spies } = makeDriverStub()
    const routes = makeRoutes(driver)
    await call(routes, `${SIDEBROWSER_API_PREFIX}/eval-safe`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { operation: 'read', maxChars: 1200 },
    }))
    expect(spies.extractText).toHaveBeenCalledWith({ maxChars: 1200, includeInventory: false }, undefined)
  })

  it('requires an operation name on /eval-safe', async () => {
    // Without it the switch would fall to its default branch, which is an
    // unhelpful refusal rather than a precise one.
    const recorded = await call(makeRoutes(makeDriverStub().driver), `${SIDEBROWSER_API_PREFIX}/eval-safe`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: {},
    }))
    expect(recorded.body).toMatchObject({ code: 'operation-required' })
  })

  it('reports the tab list after a close, so the client can resync its strip', async () => {
    // The sidebar's tab strip is a mirror of the Host's model; returning only
    // an acknowledgement would leave it showing a tab that no longer exists.
    const { driver } = makeDriverStub({
      overrides: { listTabs: async () => [] },
    })
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/tabs/close`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { tabId: 'tab-1' },
    }))
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ ok: true, tabId: 'tab-1', tabs: [] })
  })

  it('treats a blank url field as absent rather than navigating to it', async () => {
    // The route's reader treats an empty string as absent, so the refusal names
    // the missing field. A whitespace-only value is *not* blank to that reader
    // and is forwarded; the driver is the layer that rejects it as `bad-url`, so
    // either way the user's page is never navigated away to an error page.
    const { driver, spies } = makeDriverStub({
      failure: { code: 'bad-url', message: 'only http and https URLs are allowed' },
    })
    const routes = makeRoutes(driver)
    const blank = await call(routes, `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { url: '' },
    }))
    expect(blank.body).toMatchObject({ ok: false, code: 'bad-url' })
    expect(spies.navigate).not.toHaveBeenCalled()

    const padded = await call(routes, `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { url: '   ' },
    }))
    expect(padded.body).toMatchObject({ ok: false, code: 'bad-url' })
  })

  it('accepts a shortcut name under the target field as well as url', async () => {
    // The panel sends `url`, the tools send `target`; both spellings have to
    // work or one caller silently stops navigating.
    const { driver, spies } = makeDriverStub()
    await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/navigate`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: { target: 'bing' },
    }))
    expect(spies.navigate).toHaveBeenCalledWith('bing', undefined)
  })
})
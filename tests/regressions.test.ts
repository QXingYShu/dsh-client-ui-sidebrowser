// @vitest-environment jsdom
/**
 * Regression tests for the defects that made the plugin non-functional.
 *
 * Every case here corresponds to a real bug that survived a green test suite and
 * a clean build, because the suite asserted almost none of the seams these bugs
 * lived in. They are grouped by the seam rather than by the file that happened to
 * own it, so a future refactor that reintroduces one has a single obvious place
 * to fail.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeSidebrowserRoutes, SIDEBROWSER_API_PREFIX } from '../src/host/routes.ts'
import { BrowserError } from '../src/browser/driver.ts'
import type { BrowserDriver } from '../src/browser/driver.ts'
import type { ScreenshotStream } from '../src/browser/screenshot-stream.ts'
import { makeDriverStub, makeRequest, makeResponse, settle } from './helpers.ts'
import { apply as applyClient, SIDEBROWSER_TAB_ID } from '../src/client/surfaces.tsx'

/** Build the route table over a stubbed driver and stream. */
function makeRoutes(driver: BrowserDriver, poll?: ScreenshotStream['poll']): Map<string, WebRoute> {
  const stream = {
    poll: poll ?? (async () => { throw new Error('unused') }),
    latest: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
  } as unknown as ScreenshotStream
  return new Map(makeSidebrowserRoutes(driver, stream).map(route => [route.path, route]))
}

/** Drive one route handler and return what it wrote. */
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

describe('host: /screenshot answers a shape the client can parse', () => {
  // The bug: the route returned `{ok:true, data: "<base64 string>"}` while the
  // client fed `data` into a parser that requires an OBJECT with
  // `{id, data, title, url}`. Every explicit capture therefore resolved to
  // `{ok:false, error:'The host returned an empty frame'}` - silently, in the
  // tab's menu item and the panel's refresh control.
  it('nests a complete frame record under `frame`', async () => {
    const { driver } = makeDriverStub()
    const recorded = await call(makeRoutes(driver), `${SIDEBROWSER_API_PREFIX}/screenshot`, sameOrigin({
      method: 'POST',
      contentType: 'application/json',
      body: {},
    }))

    expect(recorded.status).toBe(200)
    const body = recorded.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    // The client parses `value.frame`, so the record must live there...
    const frame = body.frame as Record<string, unknown>
    expect(typeof frame).toBe('object')
    // ...and carry the exact fields the client's `frame()` reader requires.
    expect(typeof frame.data).toBe('string')
    expect((frame.data as string).length).toBeGreaterThan(0)
    expect(typeof frame.title).toBe('string')
    expect(typeof frame.url).toBe('string')
    expect(typeof frame.id).toBe('number')
    expect(typeof frame.capturedAt).toBe('string')
  })
})

describe('host: /frame is an empty state on a cold start, not a server error', () => {
  // The bug: `captureScaled` threw a bare `Error`, which the route's error
  // translator does not recognise, so it mapped to `{status:500,
  // code:'internal'}`. The sidebar's very first paint - before any tab exists -
  // came back as an HTTP 500.
  it('answers changed:false with no frame when no page exists', async () => {
    const { driver } = makeDriverStub()
    const routes = makeRoutes(driver, async () => {
      // The refusal the real `captureScaled` now raises in this situation.
      throw new BrowserError('no-tab', 'there is no page open to screenshot')
    })
    const recorded = await call(routes, `${SIDEBROWSER_API_PREFIX}/frame`, sameOrigin({ method: 'GET' }))

    expect(recorded.status).toBe(200)
    const body = recorded.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.changed).toBe(false)
    expect(body).not.toHaveProperty('frame')
  })

  it('still reports a genuine server fault as a 500', async () => {
    const { driver } = makeDriverStub()
    const routes = makeRoutes(driver, async () => {
      throw new Error('unexpected')
    })
    const recorded = await call(routes, `${SIDEBROWSER_API_PREFIX}/frame`, sameOrigin({ method: 'GET' }))
    expect(recorded.status).toBe(500)
    expect((recorded.body as Record<string, unknown>).code).toBe('internal')
  })

  it('the real stream refuses with a recognised BrowserError, not a bare Error', async () => {
    // The exact seam where the 500 originated: a bare `Error` bypasses the
    // route translator. This pins the type raised by the production path.
    const { ScreenshotStream } = await import('../src/browser/screenshot-stream.ts')
    const { driver } = makeDriverStub({ overrides: { listTabs: async () => [] } })
    const stream = new ScreenshotStream(driver, { intervalMs: 1000, scale: 0.5 })
    await expect(stream.poll()).rejects.toBeInstanceOf(BrowserError)
    await expect(stream.poll()).rejects.toMatchObject({ code: 'no-tab' })
    stream.dispose()
  })
})

/**
 * A minimal cordis-shaped context for the host plugin entry.
 *
 * `effect` is called eagerly and its disposer invoked on teardown, which is what
 * the real cordis does, so a registration that happens inside the callback body
 * is observable here exactly as it is in the Host.
 */
function hostCtx(systemPrompt: unknown, registered: string[]): Record<string, unknown> {
  return {
    // Cordis exposes `ctx.inject` as a FUNCTION taking (deps, callback); the
    // callback re-runs when a dependency becomes available. Returning undefined
    // models a deployment with no scoped-inject support.
    inject: () => undefined,
    // Services are resolved through `ctx.get(name)`, never by direct property.
    get: (name: string): unknown => (name === 'systemPrompt' ? systemPrompt : undefined),
    webServer: {
      register: (route: WebRoute): (() => void) => {
        registered.push(route.path)
        return () => {}
      },
    },
    effect: (fn: () => unknown): (() => void) => {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
}

/**
 * Clear the process-wide single-mount guard so a fresh apply can run.
 *
 * The guard set is captured into a module-level const when `index.ts` first
 * loads, so reassigning the `globalThis` property has no effect on it — the Set
 * itself has to be emptied.
 */
function resetMountOnce(): void {
  const key = Symbol.for('dsh-sidebrowser.mounted')
  const held = (globalThis as Record<symbol, Set<string> | undefined>)[key]
  if (held !== undefined) held.clear()
}

describe('host: the system-prompt announcement cannot take the plugin down', () => {
  // The bug: `prompt.section({ name, content })` was called with no `order` and
  // with a field the assembler never reads. The real service throws a TypeError
  // on a non-finite order, and that throw happened INSIDE the `ctx.effect` whose
  // catch un-registered all 17 routes - so the plugin mounted and then
  // immediately deleted its own HTTP surface. Every sidebar call answered 404.
  it('registers with `order` and `text`, which is what the assembler reads', async () => {
    const sections: Array<Record<string, unknown>> = []
    const ctx = hostCtx({
      section: (section: Record<string, unknown>): (() => void) => {
        sections.push(section)
        return () => {}
      },
    }, [])

    const { apply } = await import('../src/index.ts')
    resetMountOnce()
    await (apply as unknown as (ctx: unknown, config: unknown) => void)(ctx, { enabled: false })

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'sidebrowser' })
    // Both fields the real assembler validates and renders.
    expect(Number.isFinite(sections[0]!.order)).toBe(true)
    expect(typeof sections[0]!.text).toBe('string')
    // And the field that never existed must not be the one carrying the text.
    expect(sections[0]).not.toHaveProperty('content')
  })

  it('still mounts when the assembler rejects the section', async () => {
    const registered: string[] = []
    const ctx = hostCtx({
      section: (): (() => void) => {
        throw new Error('prompt section order must be a finite number')
      },
    }, registered)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { apply } = await import('../src/index.ts')
    resetMountOnce()
    await (apply as unknown as (ctx: unknown, config: unknown) => void)(ctx, { enabled: false })

    // The whole point: an optional surface failing must not un-register the
    // required one. Before the fix this list was empty.
    expect(registered.length).toBeGreaterThan(10)
  })
})

describe('client: the tab body reads the prop the shell actually passes', () => {
  // The bug: the body read `props.useSidebarRightTabInfo`, which is only the
  // TypeScript TYPE's name. The slot framework names an injected hook's prop
  // `use<Name>`, and the seat declares its factory under the key `tabInfo`, so
  // the real prop is `useTabInfo`. The body then hit `return null` on every
  // render: the tab opened to a blank pane and nothing was logged.

  /**
   * Mount the client plugin against a stub shell and render the tab body.
   * @param props - the props to hand the body.
   * @returns the rendered markup.
   */
  function renderBody(props: Record<string, unknown>): string {
    let body: unknown
    const ctx = {
      // `bindSettingsForm` resolves through `ctx.get`, like every other
      // optional service in the client half; undefined models one that is absent.
      get: (): unknown => undefined,
      inject: (): (() => void) => () => {},
      effect: (fn: () => unknown): (() => void) => {
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      slots: {
        inject: (_name: string, cb: () => unknown): (() => void) => {
          cb()
          return () => {}
        },
        register: (record: Record<string, unknown>, Component: unknown): (() => void) => {
          if (record.name === 'sidebar.right.pane.tab') body = Component
          return () => {}
        },
      },
      sidebarRightTabs: { register: (): (() => void) => () => {} },
    }
    ;(globalThis as { __dshSideBrowserApplied?: boolean }).__dshSideBrowserApplied = false
    applyClient(ctx as never)
    expect(body, 'the tab body must register into sidebar.right.pane.tab').toBeDefined()
    return renderToStaticMarkup(createElement(body as never, props))
  }

  /** The tab-info record the real shell hands a body (sidebar-right contract). */
  function tabInfo(): Record<string, unknown> {
    return {
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: SIDEBROWSER_TAB_ID,
        kind: 'sidebrowser-cdp',
        visible: true,
        signal: new AbortController().signal,
        navigation: { revision: 0, params: undefined },
        actions: {
          bindCommands: (): (() => void) => () => {},
          openResource: (): void => {},
          openTab: (): void => {},
          close: (): void => {},
        },
      },
    }
  }

  it('renders markup when given `useTabInfo`', () => {
    const html = renderBody({ useTabInfo: () => tabInfo() })
    expect(html.length).toBeGreaterThan(0)
  })

  it('would render nothing under the type-only name - the exact regression', () => {
    // Pin the trap explicitly: if someone renames this back to the type name,
    // this test is the one that goes red before the users do.
    const html = renderBody({ useSidebarRightTabInfo: () => tabInfo() })
    expect(html).toBe('')
  })

  it('reaches the tab action bag for bindCommands instead of a second prop', () => {
    // The reference tab does `tab.actions.bindCommands({refresh})`; there is no
    // `bindCommands` prop anywhere in the shipped packages, so reading one
    // always yielded undefined and the refresh binding was dead.
    const info = tabInfo()
    const actions = (info.tab as Record<string, unknown>).actions as Record<string, unknown>
    expect(actions.bindCommands).toBeTypeOf('function')
    const html = renderBody({ useTabInfo: () => info })
    expect(html.length).toBeGreaterThan(0)
  })
})

describe('host: CDP events carry the envelope sessionId', () => {
  // The bug: `handleFrame` dropped the frame's top-level `sessionId` (flat mode
  // puts it on the envelope, not in `params`), and `waitForLoad` then read
  // `event.params.sessionId` - always undefined against real Chrome - so the
  // guard was a tautology and navigation commands settled on ANY tab's load
  // event, letting text extraction race a half-rendered document.
  it('keeps sessionId at the top level where waitForLoad looks for it', async () => {
    const { CdpClient } = await import('../src/browser/cdp-client.ts')
    const client = new (CdpClient as unknown as new (timeoutMs?: number, maxBytes?: number) => {
      on(method: string, handler: (event: unknown) => void): () => void
      handleFrame(data: string): void
    })(1_000, 1_000_000)

    const seen: Array<Record<string, unknown>> = []
    client.on('Page.loadEventFired', event => { seen.push(event as Record<string, unknown>) })

    client.handleFrame(JSON.stringify({
      method: 'Page.loadEventFired',
      params: { timestamp: 123.4 },
      sessionId: 'SESSION-42',
    }))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.sessionId).toBe('SESSION-42')
    // The exact field that used to be consulted: still absent, and now unused.
    expect((seen[0]!.params as Record<string, unknown>).sessionId).toBeUndefined()
  })
})

describe('host: a stale target snapshot cannot delete a freshly opened tab', () => {
  // The race, seen against real Chrome: `adoptExistingTargets` is
  // fire-and-forget, so its `Target.getTargets` snapshot is taken BEFORE a
  // concurrent `open()` but its response lands AFTER. The removal step then
  // deletes the just-opened tab (absent from the stale list) and hands
  // selection to whatever the stale list did contain — every later command
  // acts on the wrong page (observed: clicks burning 5s timeouts against
  // chrome://newtab, scroll timing out at 30s).
  it('discards a refresh whose snapshot predates a concurrent open', async () => {
    const { BrowserDriver } = await import('../src/browser/driver.ts')
    const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser' })
    const internals = driver as unknown as {
      tabs: Map<string, { id: string, targetId: string, selected: boolean }>
      selectedTabId: string | undefined
      client: unknown
      tabModelEpoch: number
    }

    let releaseTargets: ((value: unknown) => void) | undefined
    const staleSnapshot = new Promise(resolve => { releaseTargets = resolve })
    let getCalls = 0
    const OLD = { targetId: 'T-OLD', type: 'page', url: 'about:old', title: 'old' }
    const NEW = { targetId: 'T-NEW', type: 'page', url: 'https://example.com/', title: 'new' }
    internals.client = {
      isOpen: true,
      sendObject: async (method: string): Promise<Record<string, unknown>> => {
        if (method === 'Target.getTargets') {
          getCalls += 1
          // First call is the stale one: it blocks until `open()` has finished,
          // then reports a world that predates the new tab.
          if (getCalls === 1) return await staleSnapshot as Record<string, unknown>
          return { targetInfos: [OLD, NEW] }
        }
        if (method === 'Target.createTarget') return { targetId: 'T-NEW' }
        if (method === 'Target.attachToTarget') return { sessionId: `S-${Math.random().toString(16).slice(2)}` }
        return {}
      },
      send: async (): Promise<Record<string, unknown>> => ({}),
      // waitForLoad settles when the event carries no session id.
      on: (_method: string, handler: (event: unknown) => void): (() => void) => {
        const timer = setTimeout(() => handler({}), 1)
        return () => clearTimeout(timer)
      },
      dispose: (): void => {},
    }

    // The refresh starts first and blocks on getTargets...
    const listing = driver.listTabs()
    // ...then the concurrent open creates a tab the stale snapshot never saw.
    const opened = await driver.open('https://example.com/')
    expect(internals.tabModelEpoch).toBeGreaterThan(0)

    // Now the stale response lands.
    releaseTargets?.({ targetInfos: [OLD] })
    await listing

    expect(internals.tabs.has(opened.id), 'the freshly opened tab was deleted by a stale snapshot').toBe(true)
    expect(internals.tabs.get(opened.id)?.selected, 'selection was stolen by a stale snapshot').toBe(true)
    expect(internals.selectedTabId).toBe(opened.id)
    await driver.dispose()
  })
})

describe('host: a tab the user closes is dropped the moment it is destroyed', () => {
  // Inferring a close from "missing in the next snapshot" leaves every command
  // in between acting on a dead target. Chrome says so directly, and the driver
  // now listens instead of waiting for a resync.
  it('drops the tab, its caches and the selection on targetDestroyed', async () => {
    const { BrowserDriver } = await import('../src/browser/driver.ts')
    const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser' })
    const internals = driver as unknown as {
      tabs: Map<string, { id: string, targetId: string, sessionId: string, selected: boolean }>
      selectedTabId: string | undefined
      globalObjectIds: Map<string, string>
      client: unknown
      watchDestroyedTargets: (client: unknown) => void
    }

    // Two tracked tabs so the selection has somewhere to fall back to.
    internals.tabs.set('tab-1', { id: 'tab-1', targetId: 'T-1', sessionId: 'S-1', selected: true })
    internals.tabs.set('tab-2', { id: 'tab-2', targetId: 'T-2', sessionId: 'S-2', selected: false })
    internals.selectedTabId = 'tab-1'
    internals.globalObjectIds.set('S-1', 'obj-1')

    const handlers = new Map<string, (event: unknown) => void>()
    internals.client = {
      isOpen: true,
      on: (method: string, handler: (event: unknown) => void): (() => void) => {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      },
      sendObject: async (): Promise<Record<string, unknown>> => ({}),
      send: async (): Promise<Record<string, unknown>> => ({}),
      dispose: (): void => {},
    }
    internals.watchDestroyedTargets(internals.client)
    expect(handlers.has('Target.targetDestroyed')).toBe(true)

    handlers.get('Target.targetDestroyed')?.({ params: { targetId: 'T-1' } })

    expect(internals.tabs.has('tab-1')).toBe(false)
    expect(internals.globalObjectIds.has('S-1')).toBe(false)
    // Selection moves to a surviving tab rather than dangling on a dead id.
    expect(internals.selectedTabId).toBe('tab-2')
    expect(internals.tabs.get('tab-2')?.selected).toBe(true)

    // An unknown or malformed destroy event must not disturb anything.
    handlers.get('Target.targetDestroyed')?.({ params: { targetId: 'T-NOPE' } })
    handlers.get('Target.targetDestroyed')?.({ params: {} })
    expect(internals.tabs.has('tab-2')).toBe(true)
    expect(internals.selectedTabId).toBe('tab-2')
    await driver.dispose()
  })
})

describe('host: the browser\'s own blank tabs are not tracked', () => {
  // A freshly launched Chrome always has a chrome://newtab surface. Tracking it
  // puts a page with nothing to read at the head of the strip, and - worse -
  // synthesized input and capture addressed at it hang until the command
  // timeout instead of answering (observed as a 30s CDP timeout on scroll).
  it('skips blank surfaces and drops a tab navigated onto one', async () => {
    const { BrowserDriver } = await import('../src/browser/driver.ts')
    const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser' })
    const internals = driver as unknown as {
      tabs: Map<string, { id: string, targetId: string, sessionId: string, selected: boolean }>
      selectedTabId: string | undefined
      client: unknown
      watchDestroyedTargets: (client: unknown) => void
    }

    // A tab the user has already navigated onto a blank surface. The id is
    // deliberately NOT `tab-1`: the driver allocates ids from its own counter, so
    // a hand-picked id can collide with the one the real page is given.
    internals.tabs.set('seeded-blank', { id: 'seeded-blank', targetId: 'T-NEW', sessionId: 'S-1', selected: true })
    internals.selectedTabId = 'seeded-blank'

    let attaches = 0
    internals.client = {
      isOpen: true,
      on: (): (() => void) => () => {},
      sendObject: async (method: string): Promise<Record<string, unknown>> => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { targetId: 'T-NEW', type: 'page', url: 'chrome://newtab/', title: '' },
              { targetId: 'T-REAL', type: 'page', url: 'https://example.com/', title: 'Example' },
            ],
          }
        }
        if (method === 'Target.attachToTarget') { attaches += 1; return { sessionId: 'S-2' } }
        return {}
      },
      send: async (): Promise<Record<string, unknown>> => ({}),
      dispose: (): void => {},
    }

    const tabs = await driver.listTabs()

    expect(tabs.map(t => t.targetId)).toEqual(['T-REAL'])
    expect(internals.tabs.has('seeded-blank')).toBe(false)
    // Selection moved off the blank page rather than dangling on it.
    expect(internals.selectedTabId).toBe(tabs[0]!.id)
    // Only the real page was ever attached to.
    expect(attaches).toBe(1)
    await driver.dispose()
  })
})

describe('host: destroyed tabs are dropped from the tracked strip', () => {
  // The bug: `refreshTargets` only ever ADDED targets. A tab closed by the user
  // was re-adopted from a stale `Target.getTargets` as a new record with the
  // SAME targetId - a ghost the user could click, which then failed - and the
  // strip never shrank.
  it('removes a tracked tab the browser no longer reports', async () => {
    const { BrowserDriver } = await import('../src/browser/driver.ts')
    const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser' })
    const internals = driver as unknown as {
      tabs: Map<string, { id: string, targetId: string, sessionId: string, selected: boolean }>
      selectedTabId: string | undefined
      globalObjectIds: Set<string>
      client: unknown
      syncSelectionFlag: () => void
    }
    internals.tabs.set('tab-1', {
      id: 'tab-1',
      targetId: 'TARGET-1',
      sessionId: 'SESSION-1',
      selected: true,
    })
    internals.selectedTabId = 'tab-1'
    internals.syncSelectionFlag()
    // An attached client whose browser reports no page targets at all: the
    // world after the user closed their last tab.
    internals.client = {
      isOpen: true,
      sendObject: async () => ({ targetInfos: [] }),
      dispose: () => {},
      on: () => () => {},
    }

    const tabs = await driver.listTabs()
    expect(tabs).toHaveLength(0)
    expect(internals.tabs.size).toBe(0)
    expect(internals.selectedTabId).toBeUndefined()
    await driver.dispose()
  })
})
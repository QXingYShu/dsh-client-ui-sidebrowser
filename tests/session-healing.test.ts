/**
 * Regression tests for dead-CDP-session healing in {@link BrowserDriver}.
 *
 * The bug: a tab's CDP session can die without any `Target.targetDestroyed`
 * event ever arriving. The renderer is discarded, the target navigates
 * cross-process, Chrome reuses the id. The tab then stayed in the strip, still
 * selected and showing an empty url, and every command on it answered with the
 * raw protocol error
 *
 * ```text
 * Page.navigate failed (-32001): Session with given id not found.
 * ```
 *
 * That raw text is what the user saw in the sidebar panel, and because the dead
 * tab kept the selection every later action failed the same way - the tab strip
 * appeared to jump around while nothing the user did had any effect.
 *
 * The fix is `withLiveTab`: drop the dead tab (which clears the selection when
 * it pointed at it), resync the model against what Chrome really reports, and
 * retry the operation exactly once. This file pins that contract.
 *
 * No Chrome is launched here. Every case drives a REAL `BrowserDriver` whose
 * `client` is a fake, so the production paths under test - tab bookkeeping,
 * selection, `dropTab`, `refreshTargets`, the retry - are the shipped ones.
 *
 * The contract is pinned directly on the private helper, so these cases do not
 * depend on which public method happens to route through it. The wiring is
 * pinned separately, at the bottom, against the methods that actually use it.
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { BrowserDriver, BrowserError } from '../src/browser/driver.ts'
import type { BrowserTabInfo } from '../src/browser/driver.ts'
import { CdpError } from '../src/browser/cdp-client.ts'

/** One tab the fake browser reports from `Target.getTargets`. */
interface FakeTarget {
  targetId: string
  url: string
  title: string
}

/** One CDP command the fake browser answered, and the session it was addressed to. */
interface RecordedCall {
  method: string
  sessionId: string | undefined
}

/** The fake CDP client plus the log of what it was asked. */
interface FakeChrome {
  /** A client shaped like the real one, for injection into `internals.client`. */
  client: unknown
  /** Every command, in order. */
  calls: RecordedCall[]
  /** How many times one command was addressed at one session. */
  callsTo: (method: string, sessionId?: string) => number
}

/**
 * How many times a command was addressed at one session.
 *
 * The retry is only observable because the fake answers a dead session
 * differently from a live one, so the count is the whole point of the log.
 * @param calls - the recorded commands.
 * @param method - the CDP method to count.
 * @param sessionId - the session to count against; omit to count every session.
 * @returns the number of matching calls.
 */
function countCalls(calls: readonly RecordedCall[], method: string, sessionId?: string): number {
  return calls.filter(call => call.method === method && (sessionId === undefined || call.sessionId === sessionId)).length
}

/**
 * The refusal a discarded renderer produces, verbatim.
 *
 * This is the real `CdpError`, not a stand-in: whether the driver recognises it
 * may depend on it being the module's own error class as well as on its text.
 * @param method - the CDP method that failed.
 * @returns the error a dead session raises.
 */
function deadSession(method: string): CdpError {
  return new CdpError(method, -32001, 'Session with given id not found')
}

/**
 * Answer each built-in page expression with a record it can actually read.
 *
 * The driver passes its page helpers as literal declarations, so the fake keys
 * off what the function body mentions rather than off an identity it cannot see.
 * @param declaration - the function declaration the driver sent.
 * @returns the value the page "returned".
 */
function pageResult(declaration: string): unknown {
  if (declaration.includes('document.activeElement')) return true
  if (declaration.includes('readyState')) return { title: 'Healed page', url: 'https://healed.example/', ready: 'complete' }
  if (declaration.includes('innerText')) {
    return {
      title: 'Healed page',
      url: 'https://healed.example/',
      text: 'healed body text',
      truncated: false,
      inventory: { headings: [], links: [], fields: [] },
    }
  }
  if (declaration.includes('querySelector')) return { x: 120, y: 240 }
  return {}
}

/** Options for {@link makeFakeChrome}. */
interface FakeChromeOptions {
  /** Pages the browser reports; a tracked target missing from here was destroyed. */
  targets: readonly FakeTarget[]
  /** Session ids whose first page command fails the way a discarded renderer does. */
  deadSessions?: readonly string[]
  /** Make the resync itself fail, to prove its errors are swallowed. */
  resyncFails?: boolean
  /** Session id handed out by `Target.attachToTarget` for a given target. */
  attach?: (targetId: string) => string
}

/**
 * Build a fake CDP client that fails a dead session once and answers after.
 *
 * "Fails the first command, then answers" is what makes a retry observable
 * without a browser: a session that failed forever would prove nothing about
 * how many attempts were made, and one that never failed would prove nothing
 * at all.
 * @param options - the pages, dead sessions and resync behaviour to script.
 * @returns the client plus its command log.
 */
function makeFakeChrome(options: FakeChromeOptions): FakeChrome {
  const calls: RecordedCall[] = []
  const dead = new Set(options.deadSessions ?? [])
  const failedOnce = new Set<string>()
  const attach = options.attach ?? ((targetId: string) => `ATTACHED-${targetId}`)
  // The session the last page command was addressed at. `waitForLoad` is always
  // called with the tab it just issued a command to, so echoing this back is
  // what a real `Page.loadEventFired` for that page looks like.
  let lastSession: string | undefined

  const handle = async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> => {
    calls.push({ method, sessionId })
    if (sessionId !== undefined) lastSession = sessionId
    if (method === 'Target.getTargets') {
      if (options.resyncFails === true) throw new Error('the resync could not reach the browser')
      return { targetInfos: options.targets.map(target => ({ ...target, type: 'page' })) }
    }
    if (method === 'Target.attachToTarget') return { sessionId: attach(String(params?.targetId)) }
    // A dead session fails its FIRST page command and answers every later one.
    if (sessionId !== undefined && dead.has(sessionId) && !failedOnce.has(sessionId)) {
      failedOnce.add(sessionId)
      throw deadSession(method)
    }
    if (method === 'Runtime.evaluate') return { result: { objectId: `global-${sessionId ?? ''}` } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: pageResult(String((params as { functionDeclaration?: unknown } | undefined)?.functionDeclaration ?? '')) } }
    if (method === 'Page.getLayoutMetrics') {
      return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 }, cssContentSize: { width: 1200, height: 2400 } }
    }
    if (method === 'Page.captureScreenshot') return { data: 'UE5H' }
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] }
    return {}
  }

  const client = {
    isOpen: true,
    send: async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> =>
      await handle(method, params, sessionId),
    sendObject: async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> =>
      await handle(method, params, sessionId),
    // `waitForLoad` waits for this event; answering it at once keeps a
    // navigation from spending its five-second budget inside a unit test.
    on: (method: string, handler: (event: unknown) => void): (() => void) => {
      if (method !== 'Page.loadEventFired') return () => {}
      const timer = setTimeout(() => { handler({ sessionId: lastSession }) }, 1)
      return () => { clearTimeout(timer) }
    },
    dispose: (): void => {},
  }
  return { client, calls, callsTo: (method, sessionId) => countCalls(calls, method, sessionId) }
}

/** The private surface these tests reach into. */
interface DriverInternals {
  tabs: Map<string, BrowserTabInfo>
  selectedTabId: string | undefined
  client: unknown
  globalObjectIds: Map<string, string>
  /** The healing helper under test, invoked exactly as the public methods do. */
  withLiveTab: <T>(tabId: string | undefined, run: (tab: BrowserTabInfo) => Promise<T>) => Promise<T>
}

/** A seeded tab row, as `BrowserDriver` stores it. */
function tab(id: string, targetId: string, sessionId: string, url: string, selected: boolean): BrowserTabInfo {
  return { id, targetId, sessionId, url, title: url, selected }
}

/** Options for {@link makeDriver}. */
interface HarnessOptions {
  /** Tabs to seed into the model, in creation order. */
  tabs?: readonly BrowserTabInfo[]
  /** Which seeded tab is selected; defaults to the first one. */
  selected?: string
  /** Pages the fake browser reports; defaults to everything but the dead target. */
  targets?: readonly FakeTarget[]
  /** Session ids whose first page command fails like a discarded renderer. */
  deadSessions?: readonly string[]
  /** Make the resync itself fail, to prove its errors are swallowed. */
  resyncFails?: boolean
}

/**
 * Build a driver over a seeded tab model and a fake browser.
 *
 * The seeds are deliberately NOT registered in `tabCreationOrder`: that is the
 * state of a tab the model knows nothing about the provenance of, and it is
 * also the state `refreshTargets` treats as oldest-possible, so a resync is
 * free to remove it. Each seeded session gets a cached page global because a
 * session that has been working has one - without it, `extractText` would spend
 * its failure inside a swallowed `Runtime.evaluate` instead of the command the
 * caller actually made.
 * @param options - the world to model.
 * @returns the driver, its internals and the fake browser.
 */
function makeDriver(options: HarnessOptions = {}): { driver: BrowserDriver, internals: DriverInternals, chrome: FakeChrome } {
  const tabs = options.tabs ?? [
    tab('tab-dead', 'T-DEAD', 'S-DEAD', 'https://dead.example/', true),
    tab('tab-live', 'T-LIVE', 'S-LIVE', 'https://live.example/', false),
  ]
  const targets = options.targets ?? [{ targetId: 'T-LIVE', url: 'https://live.example/', title: 'Live' }]
  const chrome = makeFakeChrome({
    targets,
    ...(options.deadSessions === undefined ? {} : { deadSessions: options.deadSessions }),
    ...(options.resyncFails === undefined ? {} : { resyncFails: options.resyncFails }),
  })

  // An impossible executable: this driver must never launch a browser.
  const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser' })
  const internals = driver as unknown as DriverInternals
  internals.client = chrome.client
  for (const seeded of tabs) {
    internals.tabs.set(seeded.id, seeded)
    internals.globalObjectIds.set(seeded.sessionId, `global-${seeded.sessionId}`)
  }
  internals.selectedTabId = options.selected ?? tabs[0]?.id
  return { driver, internals, chrome }
}

/** Every driver built by a test, so each is disposed exactly once afterwards. */
const live: BrowserDriver[] = []

afterEach(async () => {
  for (const driver of live.splice(0)) await driver.dispose()
})

/** Register a driver for teardown and hand it back. */
function track(driver: BrowserDriver): BrowserDriver {
  live.push(driver)
  return driver
}

describe('a dead CDP session is dropped from the model', () => {
  it('removes the tab and moves the selection off it', async () => {
    // The user-visible half of the bug: the tab stayed in the strip, still
    // selected, showing an empty url. Every later action then failed the same
    // way, so the panel looked stuck and the strip looked like it was jumping.
    const { driver, internals, chrome } = makeDriver()
    track(driver)

    const attempted: string[] = []
    const result = await internals.withLiveTab(undefined, async live => {
      attempted.push(live.id)
      throw deadSession('Page.navigate')
    }).catch((error: unknown) => error)

    // The drop happens BETWEEN the two attempts: the retry already resolves
    // against `tab-live`. This operation fails again (the closure throws
    // unconditionally), so the raw protocol error still reaches the caller -
    // the fix stops the model from being poisoned, it does not invent a page.
    expect(attempted).toEqual(['tab-dead', 'tab-live'])
    expect((result as Error).message).toContain('Session with given id not found')

    // The dead tab is gone from the model...
    expect(internals.tabs.has('tab-dead')).toBe(false)
    // ...and the selection no longer points at a corpse.
    expect(internals.selectedTabId).toBe('tab-live')
    expect(internals.tabs.get('tab-live')?.selected).toBe(true)
    // The dead tab's renderer-bound caches went with it.
    expect(internals.globalObjectIds.has('S-DEAD')).toBe(false)
    // ...after a resync, so the model is rebuilt from what Chrome reports.
    expect(chrome.callsTo('Target.getTargets')).toBe(1)
  })

  it('clears the selection entirely when the dead tab was the only one', async () => {
    const { driver, internals } = makeDriver({
      tabs: [tab('tab-dead', 'T-DEAD', 'S-DEAD', 'https://dead.example/', true)],
      targets: [],
    })
    track(driver)

    await internals.withLiveTab(undefined, async () => {
      throw deadSession('Page.reload')
    }).catch(() => undefined)

    expect(internals.tabs.size).toBe(0)
    expect(internals.selectedTabId).toBeUndefined()
  })
})

describe('the operation is retried exactly once, against a live tab', () => {
  it('runs twice and hands the caller the retry result', async () => {
    const { driver, internals } = makeDriver()
    track(driver)

    const attempted: string[] = []
    const result = await internals.withLiveTab(undefined, async live => {
      attempted.push(live.id)
      if (attempted.length === 1) throw deadSession('Page.navigate')
      return `landed-on:${live.id}`
    })

    expect(attempted).toEqual(['tab-dead', 'tab-live'])
    expect(result).toBe('landed-on:tab-live')
  })

  it('does not retry a second time when the retry fails the same way', async () => {
    // "Retried once" is the load-bearing word. A loop here would turn one dead
    // session into an unbounded resync-and-fail cycle on every command.
    const { driver, internals } = makeDriver()
    track(driver)

    let attempts = 0
    const failure = await internals.withLiveTab(undefined, async () => {
      attempts += 1
      throw deadSession('Page.navigate')
    }).catch((error: unknown) => error)

    expect(attempts).toBe(2)
    expect((failure as Error).message).toContain('Session with given id not found')
  })

  it('retries onto a page the resync re-adopted, not onto a stale record', async () => {
    // The realistic shape: the tab the driver knew about died, and Chrome still
    // has a page the model had lost track of. Healing has to find it, or the
    // caller would land back on nothing.
    const { driver, internals, chrome } = makeDriver({
      tabs: [tab('tab-dead', 'T-DEAD', 'S-DEAD', 'https://dead.example/', true)],
      targets: [{ targetId: 'T-SURVIVOR', url: 'https://survivor.example/', title: 'Survivor' }],
    })
    track(driver)

    const attempted: string[] = []
    const result = await internals.withLiveTab(undefined, async live => {
      attempted.push(live.sessionId)
      if (attempted.length === 1) throw deadSession('Page.navigate')
      return live.url
    })

    expect(attempted[0]).toBe('S-DEAD')
    expect(attempted[1]).toBe('ATTACHED-T-SURVIVOR')
    expect(result).toBe('https://survivor.example/')
    // The re-adopted page is attached and becomes the selection.
    expect(chrome.callsTo('Target.attachToTarget')).toBe(1)
    expect(internals.tabs.get('tab-1')?.selected).toBe(true)
  })

  it('still retries when the resync itself fails', async () => {
    // A resync is best-effort housekeeping. If its failure aborted the heal, a
    // flaky `Target.getTargets` would turn a recoverable dead session into the
    // same raw error the fix exists to remove.
    const { driver, internals } = makeDriver({ resyncFails: true })
    track(driver)

    const attempted: string[] = []
    const result = await internals.withLiveTab(undefined, async live => {
      attempted.push(live.id)
      if (attempted.length === 1) throw deadSession('Page.navigate')
      return `ok:${live.id}`
    })

    expect(attempted).toEqual(['tab-dead', 'tab-live'])
    expect(result).toBe('ok:tab-live')
    expect(internals.tabs.has('tab-dead')).toBe(false)
  })
})

describe('a failure that is not a dead session is left alone', () => {
  it('propagates a BrowserError unchanged, without retrying or dropping anything', async () => {
    // `bad-url` is the driver's own refusal, raised before any browser work.
    // Treating it as a dead session would drop the user's tab because they
    // mistyped a URL.
    const { driver, internals, chrome } = makeDriver()
    track(driver)

    let attempts = 0
    const failure = await internals.withLiveTab(undefined, async () => {
      attempts += 1
      throw new BrowserError('bad-url', '"nope" is not a valid URL or a known shortcut')
    }).catch((error: unknown) => error)

    expect(attempts).toBe(1)
    expect(failure).toBeInstanceOf(BrowserError)
    expect((failure as BrowserError).code).toBe('bad-url')
    expect((failure as BrowserError).message).toBe('"nope" is not a valid URL or a known shortcut')
    // Nothing was touched: no retry, no drop, no resync.
    expect(internals.tabs.has('tab-dead')).toBe(true)
    expect(internals.selectedTabId).toBe('tab-dead')
    expect(chrome.callsTo('Target.getTargets')).toBe(0)
  })

  it('propagates a different CDP failure with the same code, unchanged', async () => {
    // Discrimination is by message, not merely by "the command failed". A
    // malformed parameter is a real fault the caller must see verbatim; healing
    // it would silently retry a bad request and then fail somewhere else.
    const { driver, internals, chrome } = makeDriver()
    track(driver)

    let attempts = 0
    const failure = await internals.withLiveTab(undefined, async () => {
      attempts += 1
      throw new CdpError('Page.navigate', -32001, 'Cannot navigate to invalid URL')
    }).catch((error: unknown) => error)

    expect(attempts).toBe(1)
    expect((failure as Error).message).toContain('Cannot navigate to invalid URL')
    expect(internals.tabs.has('tab-dead')).toBe(true)
    expect(chrome.callsTo('Target.getTargets')).toBe(0)
  })
})

describe('healing with nothing left to heal onto', () => {
  it('reports the ordinary no-tab refusal', async () => {
    // The user must learn "open a page first", not read a protocol error. This
    // is the same `requireTab` refusal every cold start produces.
    const { driver, internals } = makeDriver({
      tabs: [tab('tab-dead', 'T-DEAD', 'S-DEAD', 'https://dead.example/', true)],
      targets: [],
    })
    track(driver)

    let attempts = 0
    const failure = await internals.withLiveTab(undefined, async () => {
      attempts += 1
      throw deadSession('Page.navigate')
    }).catch((error: unknown) => error)

    // The retry never ran: there was no tab to resolve before calling it.
    expect(attempts).toBe(1)
    expect(failure).toBeInstanceOf(BrowserError)
    expect((failure as BrowserError).code).toBe('no-tab')
    expect(internals.tabs.size).toBe(0)
    expect(internals.selectedTabId).toBeUndefined()
  })

  it('tells a caller that named the dead tab that the tab is gone', async () => {
    // Silently retargeting an explicit tab id would run the caller's command on
    // a page they did not ask for - a click landing somewhere else entirely.
    const { driver, internals } = makeDriver({
      selected: 'tab-live',
    })
    track(driver)

    const failure = await internals.withLiveTab('tab-dead', async () => {
      throw deadSession('Page.navigate')
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BrowserError)
    expect((failure as BrowserError).code).toBe('tab-not-found')
    // The named tab is the one that was dropped, and the user's selection,
    // which pointed elsewhere, was left exactly where it was.
    expect(internals.tabs.has('tab-dead')).toBe(false)
    expect(internals.selectedTabId).toBe('tab-live')
  })
})

// ---------------------------------------------------------------------------
// The wiring.
//
// `withLiveTab` is private, so a caller cannot reach it except through a public
// method. What matters to the user is therefore not that the helper exists but
// that the operations they actually invoke route through it. The list below
// was read off `src/browser/driver.ts`; each entry cites the `this.withLiveTab`
// call that makes it heal. A method NOT listed here must keep its pre-fix
// behaviour, and the case after the table pins that.
// ---------------------------------------------------------------------------

describe('a session that dies mid-command is recognised through the CDP client', () => {
  // The end-to-end shape of the original report, driven entirely by the fake
  // browser: the first command addressed at a dead session fails the way a
  // discarded renderer fails, and the retry on the next session succeeds.
  it('drops the dead tab and answers the caller from the live one', async () => {
    const { driver, internals, chrome } = makeDriver({ deadSessions: ['S-DEAD'] })
    track(driver)

    const sent: string[] = []
    const answered = await internals.withLiveTab(undefined, async live => {
      // Exactly what a page command does: ask the client, hand the answer back.
      sent.push(live.sessionId)
      const client = chrome.client as { sendObject: (m: string, p?: Record<string, unknown>, s?: string) => Promise<Record<string, unknown>> }
      return await client.sendObject('Page.getTitle', {}, live.sessionId)
    })

    // The caller gets the live page's answer, not the dead session's failure.
    expect(answered).toEqual({})
    expect(sent).toEqual(['S-DEAD', 'S-LIVE'])
    expect(internals.tabs.has('tab-dead')).toBe(false)
    expect(internals.selectedTabId).toBe('tab-live')
    // One attempt on the dead session, one on the live one - and the live
    // session answered, which is what made the retry possible.
    expect(chrome.callsTo('Page.getTitle', 'S-DEAD')).toBe(1)
    expect(chrome.callsTo('Page.getTitle', 'S-LIVE')).toBe(1)
  })
})

/**
 * One public operation that routes through the healing helper.
 *
 * The helper is private, so a caller can only reach it through a public method.
 * What a user experiences is therefore not that `withLiveTab` exists but that
 * the operations they actually invoke route through it - so the wiring is worth
 * pinning separately from the helper it routes into.
 */
interface HealedOperation {
  /** The public entry point the sidebar or an agent tool calls. */
  readonly name: string
  /** Where the method reaches the helper, for a reader who wants to verify it. */
  readonly source: string
  /** The CDP command whose failure proves an attempt was made on a dead session. */
  readonly command: string
  /** How often that command is issued against the live session (keyDown + keyUp, and so on). */
  readonly liveCalls: number
  /** Drives the operation the way production does. */
  readonly invoke: (driver: BrowserDriver) => Promise<unknown>
}

/**
 * The operations that heal, read off `src/browser/driver.ts`.
 *
 * `withLiveTab` is called from exactly three places: `navigate` (driver.ts:867),
 * `reload` (driver.ts:947), and the private `historyStep` that backs both
 * `back` and `forward` (driver.ts:924). Anything not in this table must keep
 * its pre-fix behaviour, which the next describe block pins.
 */
const HEALED_OPERATIONS: readonly HealedOperation[] = [
  {
    name: 'navigate',
    source: 'src/browser/driver.ts:867',
    command: 'Page.navigate',
    liveCalls: 1,
    invoke: async driver => await driver.navigate('https://healed.example/'),
  },
  {
    name: 'back',
    source: 'src/browser/driver.ts:924 (via the private historyStep)',
    command: 'Page.getNavigationHistory',
    liveCalls: 1,
    invoke: async driver => await driver.back(),
  },
  {
    name: 'forward',
    source: 'src/browser/driver.ts:924 (via the private historyStep)',
    command: 'Page.getNavigationHistory',
    liveCalls: 1,
    invoke: async driver => await driver.forward(),
  },
  {
    name: 'reload',
    source: 'src/browser/driver.ts:947',
    command: 'Page.reload',
    liveCalls: 1,
    invoke: async driver => await driver.reload(),
  },
]

describe('the tab operations that heal a dead session', () => {
  for (const operation of HEALED_OPERATIONS) {
    it(`${operation.name} drops the dead tab and answers from the live one (${operation.source})`, async () => {
      const { driver, internals, chrome } = makeDriver({ deadSessions: ['S-DEAD'] })
      track(driver)

      const result = await operation.invoke(driver)

      // The caller receives the live page's snapshot, not the dead session's
      // failure - this is the whole user-visible change.
      expect(result).toMatchObject({ attached: true, url: 'https://healed.example/' })
      // The zombie leaves the strip and the selection moves off it.
      expect(internals.tabs.has('tab-dead')).toBe(false)
      expect(internals.selectedTabId).toBe('tab-live')
      expect(internals.tabs.get('tab-live')?.selected).toBe(true)
      // Exactly one attempt against the dead session, and the retry went to the
      // live one. Two dead attempts would mean the retry loop is unbounded.
      expect(chrome.callsTo(operation.command, 'S-DEAD')).toBe(1)
      expect(chrome.callsTo(operation.command, 'S-LIVE')).toBe(operation.liveCalls)
    })
  }

  it('leaves a healthy session untouched, issuing the command only once', async () => {
    // The healing path must be inert when nothing is wrong. A driver that
    // dropped and re-attached on every command would resync constantly and the
    // selection would churn on every keystroke.
    const { driver, internals, chrome } = makeDriver()
    track(driver)

    const result = await driver.navigate('https://healed.example/')

    expect(result).toMatchObject({ attached: true, url: 'https://healed.example/' })
    expect(internals.tabs.has('tab-dead')).toBe(true)
    expect(internals.selectedTabId).toBe('tab-dead')
    expect(chrome.callsTo('Page.navigate', 'S-DEAD')).toBe(1)
    // No resync: the repair path never ran.
    expect(chrome.callsTo('Target.getTargets')).toBe(0)
  })
})

/**
 * One public operation that issues page commands but is NOT routed through the
 * helper.
 */
interface UnhealedOperation {
  /** The public entry point. */
  readonly name: string
  /** Drives the operation the way production does. */
  readonly invoke: (driver: BrowserDriver) => Promise<unknown>
}

/**
 * The input and read operations, which the fix now covers too.
 *
 * These were deliberately left unwired first, with cases asserting they still
 * failed, so that widening the fix would turn them red and force the question.
 * The answer is that they should heal: a dead session reported through
 * `click`, `typeText`, `pressKey`, `scroll`, `extractText` or
 * `captureScreenshot` was the user's "every command fails on it" symptom, and
 * the agent-facing verbs are exactly where a model notices most.
 */
const UNHEALED_OPERATIONS: readonly UnhealedOperation[] = [
  { name: 'click', invoke: async driver => await driver.click({ selector: '#go' }) },
  { name: 'typeText', invoke: async driver => await driver.typeText('hello') },
  { name: 'pressKey', invoke: async driver => await driver.pressKey('Enter') },
  { name: 'scroll', invoke: async driver => await driver.scroll(240) },
  { name: 'extractText', invoke: async driver => await driver.extractText() },
  { name: 'captureScreenshot', invoke: async driver => await driver.captureScreenshot() },
]

describe('the input and read operations heal a dead session like the navigation verbs', () => {
  for (const operation of UNHEALED_OPERATIONS) {
    it(`${operation.name} drops the dead tab and completes against the live one`, async () => {
      const { driver, internals } = makeDriver({ deadSessions: ['S-DEAD'] })
      track(driver)

      // `returnsValue` marks the verbs that answer with something. For those the
      // stronger claim is available - the retry really landed on the live page -
      // while the rest resolve with void, and "did not throw" is the whole proof.
      const returnsValue = operation.name === 'extractText' || operation.name === 'captureScreenshot'
      const outcome = await operation.invoke(driver).catch((error: unknown) => error)
      expect(outcome).not.toBeInstanceOf(Error)
      if (returnsValue) expect(outcome).toBeDefined()

      // The zombie is gone rather than left in the strip for the user to hit
      // again on the next click.
      expect(internals.tabs.has('tab-dead')).toBe(false)
      expect(internals.selectedTabId).not.toBe('tab-dead')
    })
  }
})
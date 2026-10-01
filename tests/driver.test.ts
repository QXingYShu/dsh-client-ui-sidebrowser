/**
 * Tests for the driver's input validation, exercised without a browser.
 *
 * The validation in `driver.ts` is the plugin's security boundary, not just its
 * tidiness: the driver is driven by model output, so anything it accepts
 * verbatim becomes a capability. Restricting navigation to `http(s)` keeps a
 * browsing helper from becoming a local-file-read or script-injection primitive,
 * and rejecting an ambiguous click keeps it from guessing where the user's
 * mouse goes.
 *
 * No Chrome is ever launched. `resolveExecutable` prepends the configured path to
 * the standard candidate list rather than replacing it, so the executable
 * lookup's `access` probe is the one place that decides whether a browser
 * process could start — mocking it to always report "not found" makes every
 * launch attempt fail with `no-browser` deterministically. That is what makes
 * these tests hermetic: a test that reaches `no-browser` has proven it passed
 * validation and stopped at the launch boundary, and a test that reaches
 * `bad-url`/`bad-click` has proven the validation runs before any CDP work.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserError } from '../src/browser/driver.ts'

// The executable probe is the only path from "a tool call arrived" to "a Chrome
// process starts". Making it fail turns every launch into a deterministic
// `no-browser` refusal instead of a real browser on the maintainer's desktop.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => {
      throw new Error('ENOENT: no such file or directory (blocked by test)')
    }),
  }
})

// Imported after the mock is registered, so the driver picks up the blocked
// filesystem probe. `BrowserError` is imported as a type and as a value: the
// class is both, and `expect(...).toBeInstanceOf` needs the value while the
// return type of the assertion helper needs the type.
const { BrowserDriver, BrowserError: BrowserErrorClass, BROWSER_SHORTCUTS } = await import('../src/browser/driver.ts')
type Driver = InstanceType<typeof BrowserDriver>

/** Every driver created by these tests, torn down after each case. */
const created: Driver[] = []

/**
 * Build a driver whose launch can only ever fail with `no-browser`.
 * @param options - launch options to override.
 * @returns the driver, registered for disposal.
 */
function makeDriver(options: Record<string, unknown> = {}): Driver {
  const driver = new BrowserDriver({ executablePath: '/definitely/not/a/browser', ...options })
  created.push(driver)
  return driver
}

/**
 * Seed one tracked tab so an operation can get past tab resolution.
 *
 * `click` resolves a tab before checking its arguments, so without a tab the
 * driver would fail with `no-tab` and the `bad-click` path would never run. The
 * tab is inserted in exactly the shape a real launch produces; no browser is
 * involved and no CDP command is issued.
 * @param driver - the driver to seed.
 * @returns the seeded tab id.
 */
function seedTab(driver: Driver): string {
  const internals = driver as unknown as {
    tabs: Map<string, unknown>
    selectedTabId: string | undefined
    syncSelectionFlag: () => void
  }
  internals.tabs.set('tab-1', {
    id: 'tab-1',
    targetId: 'TARGET-1',
    sessionId: 'SESSION-1',
    url: 'https://example.com/',
    title: 'Example Domain',
    selected: true,
  })
  internals.selectedTabId = 'tab-1'
  internals.syncSelectionFlag()
  return 'tab-1'
}

/**
 * Assert that an operation rejects with a {@link BrowserError} of one code.
 *
 * Asserting the code rather than only "it threw" is the point: routes and tools
 * branch on it, and a bare `Error` would render as an internal fault.
 * @param operation - a thunk producing the promise, so a synchronous throw is
 *   captured here instead of escaping before the assertion runs.
 * @param code - the expected stable failure code.
 * @returns the rejection, for further assertions.
 */
async function expectBrowserError(operation: () => Promise<unknown>, code: string): Promise<BrowserError> {
  const error = await (async () => {
    try {
      await operation()
    } catch (reason) {
      return reason
    }
    return undefined
  })()
  if (error === undefined) throw new Error(`expected the call to reject with ${code}, but it resolved`)
  expect(error).toBeInstanceOf(BrowserError)
  expect((error as InstanceType<typeof BrowserError>).code).toBe(code)
  expect((error as InstanceType<typeof BrowserError>).name).toBe('BrowserError')
  return error as InstanceType<typeof BrowserError>
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  for (const driver of created.splice(0)) await driver.dispose()
})

describe('navigation target validation', () => {
  it('rejects a file: url before touching the browser', async () => {
    // `file:///C:/Users/.../id_rsa` through a model-driven tool would be a local
    // file-read primitive; the scheme check is the only thing standing between a
    // browsing sidebar and the user's filesystem.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('file:///etc/passwd'), 'bad-url')
  })

  it('rejects a javascript: url before touching the browser', async () => {
    // A `javascript:` target would execute in the page context — inside the
    // user's logged-in DeepSeek session, which is the whole reason this
    // browser exists.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('javascript:fetch("http://evil.test")'), 'bad-url')
  })

  it('rejects other non-web schemes, because the rule is http(s) only', async () => {
    // An allow-list, not a deny-list: a scheme nobody has thought of yet is
    // refused by default rather than waiting to be added to a blocklist.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('data:text/html,<h1>x</h1>'), 'bad-url')
    await expectBrowserError(() => driver.open('chrome://settings'), 'bad-url')
    await expectBrowserError(() => driver.open('ftp://example.com/file'), 'bad-url')
  })

  it('rejects an empty or whitespace-only target', async () => {
    // `new URL('')` throws an opaque `TypeError` the sidebar would render as an
    // internal fault; the driver turns it into a code the model can act on.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open(''), 'bad-url')
    await expectBrowserError(() => driver.open('   '), 'bad-url')
  })

  it('rejects a bare word that is not a known shortcut', async () => {
    // The model is told it may pass a shortcut name; a name it invented must be
    // refused rather than searched for, or it would navigate somewhere unknown.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('definitely not a shortcut'), 'bad-url')
  })

  it('rejects the same targets through navigate, not just open', async () => {
    // `navigate` is the tool the model calls most often, so the guard has to sit
    // on the shared target resolution rather than on one entry point.
    const driver = makeDriver()
    await expectBrowserError(() => driver.navigate('file:///etc/passwd'), 'bad-url')
    await expectBrowserError(() => driver.navigate('javascript:alert(1)'), 'bad-url')
  })

  it('names the offending scheme so the model can correct itself in one retry', async () => {
    // The message is read by the model: "only http and https URLs are allowed,
    // got file:" tells it exactly what to change, where a generic failure costs
    // a wasted attempt.
    const driver = makeDriver()
    const error = await expectBrowserError(() => driver.open('file:///x'), 'bad-url')
    expect(error.message).toContain('file:')
  })

  it('resolves every documented shortcut to a real https origin', () => {
    // These names are what the model is told to use; if one stopped resolving,
    // the fallback would be a confusing `bad-url` rather than a clear failure.
    for (const [name, url] of Object.entries(BROWSER_SHORTCUTS)) {
      expect(url, name).toMatch(/^https:\/\//)
    }
    expect(BROWSER_SHORTCUTS.deepseek).toBe('https://chat.deepseek.com/')
    expect(BROWSER_SHORTCUTS.youdao).toBe('https://fanyi.youdao.com/')
    // The aliases exist so a model that guesses the longer name still works.
    expect(BROWSER_SHORTCUTS.deepseekWeb).toBe(BROWSER_SHORTCUTS.deepseek)
    expect(BROWSER_SHORTCUTS.youdaoTranslate).toBe(BROWSER_SHORTCUTS.youdao)
  })

  it('lets a valid shortcut past validation and fails only at launch', async () => {
    // `no-browser` rather than `bad-url` proves the name resolved to a URL and
    // the refusal came from the launch boundary, not from the name check.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('deepseek'), 'no-browser')
  })

  it('lets a plain https url past validation and fails only at launch', async () => {
    // The mirror of the rejection cases: valid input must not be turned away.
    const driver = makeDriver()
    await expectBrowserError(() => driver.open('https://example.com/'), 'no-browser')
  })
})

describe('click argument validation', () => {
  /**
   * Build a driver that has a tab and an attached CDP client.
   *
   * `click` resolves a tab, then a client, and only then checks its arguments,
   * so reaching the `bad-click` throw requires both to be present. The client is
   * a stub that answers only the round trips a successful click needs; every
   * other command raises, so a test cannot accidentally depend on protocol
   * behaviour it never meant to exercise.
   */
  function makeAttachedDriver(): Driver {
    const driver = makeDriver()
    seedTab(driver)
    const internals = driver as unknown as {
      client: unknown
      tabs: Map<string, unknown>
      selectedTabId: string | undefined
      syncSelectionFlag: () => void
    }
    // Only the round trips a successful click genuinely needs are modelled:
    // resolving the page global, asking the page where the element is, and the
    // three synthesized input events. Anything else is a bug in the test and
    // says so loudly rather than being answered with a plausible value that
    // could hide it. Both `send` and `sendObject` are backed by one table
    // because the driver reaches for either depending on the call.
    const answers: Record<string, Record<string, unknown>> = {
      'Runtime.evaluate': { result: { objectId: 'GLOBAL-1' } },
      'Runtime.callFunctionOn': { result: { value: { x: 55, y: 66 } } },
      'Input.dispatchMouseEvent': {},
    }
    const answer = async (method: string): Promise<Record<string, unknown>> => {
      const value = answers[method]
      if (value === undefined) throw new Error(`the test reached ${method}, which this case does not need`)
      return value
    }
    const send = vi.fn(answer)
    internals.client = {
      isOpen: true,
      send,
      sendObject: vi.fn(answer),
      on: vi.fn(() => () => undefined),
      dispose: vi.fn(() => undefined),
    }
    return driver
  }

  it('rejects a click with neither a selector nor coordinates', async () => {
    // With nothing to aim at, any fallback would be a guess at where the user's
    // mouse is — on a real page, inside a logged-in session.
    await expectBrowserError(() => makeAttachedDriver().click({}), 'bad-click')
  })

  it('rejects a click given both a selector and coordinates', async () => {
    // Both modes at once is ambiguous: the model believes two different elements
    // are the target, one of them is wrong, and silently picking one would click
    // something the model never intended.
    await expectBrowserError(() => makeAttachedDriver().click({ selector: '#go', x: 10, y: 20 }), 'bad-click')
  })

  it('rejects a click with only one of x and y', async () => {
    // Half a coordinate pair is not a point; treating x as y would send the
    // click to (10, 0), the top-left corner of the page.
    await expectBrowserError(() => makeAttachedDriver().click({ x: 10 }), 'bad-click')
    await expectBrowserError(() => makeAttachedDriver().click({ y: 20 }), 'bad-click')
  })

  it('rejects an empty selector string as no selector at all', async () => {
    // A model that sends `selector: ""` meant "no target"; `querySelector("")`
    // is a syntax error, not a click.
    await expectBrowserError(() => makeAttachedDriver().click({ selector: '' }), 'bad-click')
  })

  it('explains both accepted forms in the refusal message', async () => {
    // The model reads this message and retries; naming the two accepted shapes
    // is what turns one refusal into one successful retry.
    const error = await expectBrowserError(() => makeAttachedDriver().click({}), 'bad-click')
    expect(error.message).toContain('selector')
    expect(error.message).toContain('coordinates')
  })

  it('rejects an empty selector even when coordinates are absent entirely', async () => {
    // `selector: ""` and a missing selector both mean "no target"; the two must
    // not diverge, or one of them would fall through to a coordinate default.
    await expectBrowserError(() => makeAttachedDriver().click({ selector: '' }), 'bad-click')
  })

  it('accepts a selector and dispatches a synthesized press and release', async () => {
    // The positive case: valid arguments must reach the input synthesis, which
    // is what makes a real page's click handlers fire instead of a `.click()`
    // being swallowed. Move, press, release is the whole gesture.
    const driver = makeAttachedDriver()
    const client = (driver as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client
    await driver.click({ selector: '#go' })
    expect(client.send.mock.calls.map(call => call[0])).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ])
  })

  it('accepts a full coordinate pair without asking the page where the element is', async () => {
    // Coordinate clicks are how the agent clicks something it saw in a
    // screenshot: the driver must go straight to input synthesis rather than
    // querying a selector it was not given.
    const driver = makeAttachedDriver()
    const client = (driver as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client
    await driver.click({ x: 120, y: 240 })
    const dispatched = client.send.mock.calls
      .filter(call => call[0] === 'Input.dispatchMouseEvent')
      .map(call => (call[1] as { x: number, y: number, type: string }))
    expect(dispatched).toHaveLength(3)
    for (const event of dispatched) {
      expect(event.x).toBe(120)
      expect(event.y).toBe(240)
    }
  })

  it('passes the caller selector as a serialized argument, never as page source', async () => {
    // The injection boundary of the whole plugin: a selector containing quotes
    // or script must arrive as a data value, or a model-supplied selector would
    // be arbitrary JavaScript executed in the user's logged-in browser.
    const driver = makeAttachedDriver()
    const client = (driver as unknown as { client: { sendObject: ReturnType<typeof vi.fn> } }).client
    const hostile = `a"; alert(document.cookie); //`
    await driver.click({ selector: hostile })
    const call = client.sendObject.mock.calls.find(entry => entry[0] === 'Runtime.callFunctionOn')
    const params = call?.[1] as { functionDeclaration: string, arguments: Array<{ value: unknown }> }
    // The expression is a literal this module owns, and the hostile selector is
    // an argument value beside it.
    expect(params.functionDeclaration).not.toContain('alert(document.cookie)')
    expect(params.arguments).toEqual([{ value: hostile }])
  })

  it('reports an unknown tab id instead of clicking the selected tab', async () => {
    // A tab the driver never tracked means the model acted on a page that no
    // longer exists; falling back to the selected tab would click the wrong page.
    const driver = makeAttachedDriver()
    await expectBrowserError(() => driver.click({ selector: '#go', tabId: 'tab-99' }), 'tab-not-found')
  })

  it('reports a missing browser before even looking at the click arguments', async () => {
    // `click` resolves a client before validating its arguments, so a browser
    // that is not up yet is reported as `no-browser`. That ordering is what lets
    // the sidebar tell the user "no Chrome is running" instead of blaming their
    // click.
    const driver = makeDriver()
    seedTab(driver)
    await expectBrowserError(() => driver.click({}), 'no-browser')
  })
})

describe('key validation', () => {
  it('rejects an empty key name before touching the browser', async () => {
    // An empty key would be dispatched as a synthetic event with no key, which
    // pages handle unpredictably; the model almost always sent nothing by
    // mistake.
    const driver = makeDriver()
    await expectBrowserError(() => driver.pressKey('   '), 'bad-key')
  })

  it('reports the key problem rather than a missing page', async () => {
    // The key is validated before tab resolution, so a typo in the key name is
    // reported as the key problem even when no tab is open.
    const driver = makeDriver()
    await expectBrowserError(() => driver.pressKey(''), 'bad-key')
  })
})

describe('disposal', () => {
  it('rejects every operation after dispose with the disposed code', async () => {
    // The Host effect cleanup disposes the driver on plugin unload. A tool call
    // racing that cleanup must report `disposed` rather than silently relaunching
    // a Chrome window nobody will ever close.
    const driver = makeDriver()
    await driver.dispose()
    await expectBrowserError(() => driver.navigate('https://example.com/'), 'disposed')
    await expectBrowserError(() => driver.open('deepseek'), 'disposed')
  })

  it('is idempotent, because cleanup may run twice', async () => {
    // A double dispose must not throw out of the Host's cleanup path, where it
    // would mask the real error that triggered the teardown.
    const driver = makeDriver()
    await driver.dispose()
    await expect(driver.dispose()).resolves.toBeUndefined()
  })
})
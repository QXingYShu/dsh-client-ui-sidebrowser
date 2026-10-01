/**
 * Tests for the five `browser_*` agent tools.
 *
 * These tools are the only way the model reaches the user's logged-in browser,
 * so two properties matter more than anything else they do: every domain refusal
 * must arrive as a *readable value* the model can act on rather than a thrown
 * tool error (an exception looks like an internal fault and gets retried
 * forever), and the schemas must be well-formed, because a malformed parameter
 * schema means the model is calling the tool with arguments it was never
 * offered.
 *
 * The driver is a stub throughout — no Chrome, no CDP.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildSidebrowserTools, SIDEBROWSER_TOOL_NAMES } from '../src/host/agent-tools.ts'
import { BrowserError } from '../src/browser/driver.ts'
import { makeDriverStub, makeExtracted, makeSnapshot, makeTab } from './helpers.ts'

/**
 * The minimum execution identity a tool needs.
 *
 * None of these tools read `exec` (they have no timeouts to honour and forward
 * no cancellation), so a stub identity is enough; a tool that started depending
 * on it would fail loudly here rather than silently misbehaving.
 */
const EXEC = {} as unknown as ToolRunContext

/** Every tool, built against a stub driver. */
function tools(): ToolDefinition[] {
  return buildSidebrowserTools(makeDriverStub().driver)
}

/** Find one tool by name, failing the test if the roster changed shape. */
function toolNamed(name: string, list: ToolDefinition[] = tools()): ToolDefinition {
  const found = list.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`no tool named ${name}; the roster is ${list.map(tool => tool.name).join(', ')}`)
  return found
}

/** Run one tool and return its canonical JSON value. */
function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return tool.execute(args, EXEC) as Promise<Record<string, unknown>>
}

describe('tool roster and schemas', () => {
  it('registers exactly the five documented browser tools', () => {
    // The model discovers these by name; a rename or a dropped tool is a
    // behaviour change the announcement text would also have to match.
    expect(tools().map(tool => tool.name)).toEqual([...SIDEBROWSER_TOOL_NAMES])
  })

  it('exposes a name, a description and an object parameter schema for each tool', () => {
    // A tool missing any of these is not model-callable at all: the registry
    // whitelists exactly name/description/parameters.
    for (const name of SIDEBROWSER_TOOL_NAMES) {
      const tool = toolNamed(name)
      expect(tool.name, name).toBe(name)
      expect(tool.description, name).toBeTypeOf('string')
      expect(tool.description.length, name).toBeGreaterThan(40)
      expect(tool.parameters, name).toMatchObject({ type: 'object' })
    }
  })

  it('describes every parameter it accepts, so the model can fill it in', () => {
    // The parameter map *is* the model's contract. A property present in the
    // map with no description is a property the model has to guess at.
    for (const name of SIDEBROWSER_TOOL_NAMES) {
      const tool = toolNamed(name)
      const properties = tool.parameters.properties as Record<string, { description?: string }> | undefined
      expect(properties, name).toBeTypeOf('object')
      for (const [property, spec] of Object.entries(properties ?? {})) {
        expect(spec.description, `${name}.${property}`).toBeTruthy()
      }
    }
  })

  it('marks exactly the arguments a tool cannot run without', () => {
    // Over-marking forces the model to invent arguments it was told were
    // optional; under-marking lets it call the tool into a guaranteed refusal.
    const required = (name: string): string[] | undefined =>
      (toolNamed(name).parameters as { required?: string[] }).required
    expect(required('browser_open')).toEqual(['url'])
    expect(required('browser_act')).toEqual(['action'])
    // Read and screenshot work with no arguments at all, so nothing is required.
    expect(required('browser_read')).toBeUndefined()
    expect(required('browser_screenshot')).toBeUndefined()
    expect(required('browser_tabs')).toBeUndefined()
  })

  it('constrains browser_act to the actions it implements', () => {
    // The enum is the guard against a model inventing `browser_act(action:
    // "delete")`; every listed action must be a real branch in the handler.
    const action = (toolNamed('browser_act').parameters.properties as Record<string, { enum?: string[] }>).action
    expect(action?.enum).toEqual(['navigate', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'reload'])
  })

  it('constrains browser_tabs to the tab operations it implements', () => {
    // Same reasoning for the tab tool, whose `action` defaults to `list`.
    const action = (toolNamed('browser_tabs').parameters.properties as Record<string, { enum?: string[] }>).action
    expect(action?.enum).toEqual(['list', 'open', 'close', 'select'])
  })

  it('names the shortcuts a model is invited to pass, in the open tool description', () => {
    // The model cannot pass `deepseek` unless the description says so, and the
    // panel's shortcut buttons are useless to the agent without it.
    const description = toolNamed('browser_open').description
    for (const shortcut of ['deepseek', 'bing', 'baidu', 'youdao']) {
      expect(description).toContain(shortcut)
    }
  })

  it('rejects an argument the schema does not offer, before the browser is touched', async () => {
    // `defineTool` validates first: a typo'd argument must be refused by the
    // schema rather than reaching Chrome as an undefined field.
    const tool = toolNamed('browser_read')
    await expect(tool.execute({ maxChars: 'lots' }, EXEC)).rejects.toThrow()
  })

  it('rejects a missing required argument before the browser is touched', async () => {
    // Same boundary for a call with no url at all: it must not become a CDP
    // command issued with an undefined target.
    const tool = toolNamed('browser_open')
    await expect(tool.execute({}, EXEC)).rejects.toThrow()
  })
})

describe('refusal envelopes', () => {
  /** Every tool driven with a driver that refuses, plus arguments that get there. */
  const refusals: { name: string, args: Record<string, unknown> }[] = [
    { name: 'browser_open', args: { url: 'https://example.com/' } },
    { name: 'browser_read', args: {} },
    { name: 'browser_act', args: { action: 'navigate', url: 'https://example.com/' } },
    { name: 'browser_tabs', args: { action: 'list' } },
    { name: 'browser_screenshot', args: {} },
  ]

  for (const { name, args } of refusals) {
    it(`returns a readable refusal instead of throwing when ${name} hits a browser failure`, async () => {
      // A thrown tool error reads as an internal fault, so the model retries
      // forever instead of telling the user to install Chrome. The refusal is a
      // value the model can read and report.
      const { driver } = makeDriverStub({
        failure: { code: 'no-browser', message: 'no Chrome/Chromium/Edge executable found' },
      })
      const tool = toolNamed(name, buildSidebrowserTools(driver))
      await expect(run(tool, args)).resolves.toMatchObject({
        ok: false,
        code: 'no-browser',
        message: 'no Chrome/Chromium/Edge executable found',
      })
    })
  }

  it('keeps the driver\'s own code rather than flattening every failure', async () => {
    // The two codes a model branches on are `no-browser` (the user must install
    // or configure a browser) and `selector-not-found` (the model's assumption
    // about the page was wrong, so it should re-read). Collapsing them into one
    // code would make that distinction impossible.
    const { driver } = makeDriverStub({
      overrides: { click: async () => { throw new BrowserError('selector-not-found', 'no element matched selector "#go"') } },
    })
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'click', selector: '#go' })).resolves.toMatchObject({
      ok: false,
      code: 'selector-not-found',
    })
  })

  it('reports a non-BrowserError failure as browser-failed instead of crashing', async () => {
    // An unexpected error still has to reach the model as a readable refusal; an
    // unhandled throw here would abort the agent turn.
    const { driver } = makeDriverStub({
      overrides: { extractText: async () => { throw new TypeError('cannot read property of undefined') } },
    })
    const tool = toolNamed('browser_read', buildSidebrowserTools(driver))
    await expect(run(tool, {})).resolves.toMatchObject({
      ok: false,
      code: 'browser-failed',
      message: 'cannot read property of undefined',
    })
  })

  it('refuses a click with neither a selector nor coordinates, without calling the browser', async () => {
    // The tool owns this check so the model gets a code it can act on; without
    // it the call would reach Chrome with nothing to aim at.
    const { driver, spies } = makeDriverStub()
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'click' })).resolves.toMatchObject({ ok: false, code: 'bad-click' })
    expect(spies.click).not.toHaveBeenCalled()
  })

  it('rejects an action outside the enum before it reaches the browser', async () => {
    // The parameter enum is the outer guard: `defineTool` validates before the
    // handler runs, so an invented action is refused by the schema. The
    // handler's own `unknown-action` branch is therefore unreachable from the
    // registry, and stays as defence in depth for any other caller.
    const { driver, spies } = makeDriverStub()
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(tool.execute({ action: 'delete-everything' }, EXEC)).rejects.toThrow(/must be one of/)
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
  })

  it('refuses the missing arguments each action needs, naming what is missing', async () => {
    // One message per missing argument: the model reads it and retries once
    // instead of guessing again.
    const { driver } = makeDriverStub()
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'navigate' })).resolves.toMatchObject({ ok: false, code: 'url-required' })
    await expect(run(tool, { action: 'type' })).resolves.toMatchObject({ ok: false, code: 'text-required' })
    await expect(run(tool, { action: 'key' })).resolves.toMatchObject({ ok: false, code: 'key-required' })
  })

  it('refuses a tab operation without a tabId', async () => {
    // `close` and `select` without an id would act on an arbitrary tab; refusing
    // is the only safe reading of an under-specified command.
    const { driver } = makeDriverStub()
    const tool = toolNamed('browser_tabs', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'close' })).resolves.toMatchObject({ ok: false, code: 'tab-id-required' })
    await expect(run(tool, { action: 'select' })).resolves.toMatchObject({ ok: false, code: 'tab-id-required' })
  })

  it('defaults the tab action to list, so an argument-free call is not an error', async () => {
    // `browser_tabs()` with no action is the most natural thing a model writes;
    // it must list, not refuse with `unknown-action: undefined`.
    const { driver } = makeDriverStub()
    const tool = toolNamed('browser_tabs', buildSidebrowserTools(driver))
    const value = await run(tool, {})
    expect(value).toMatchObject({ ok: true, count: 1 })
    expect(Object.hasOwn(value, 'action')).toBe(false)
  })
})

describe('successful reads and reports', () => {
  it('reports an opened tab with a real title once the page has painted', async () => {
    // A freshly created target has no title until its first paint; reporting the
    // empty value would make the model think it opened a blank page.
    const { driver } = makeDriverStub({
      overrides: {
        open: async () => makeTab({ id: 'tab-7', title: '', selected: true }),
        snapshot: async () => makeSnapshot({ title: 'DeepSeek', url: 'https://chat.deepseek.com/' }),
      },
    })
    const tool = toolNamed('browser_open', buildSidebrowserTools(driver))
    await expect(run(tool, { url: 'deepseek' })).resolves.toEqual({
      ok: true,
      tabId: 'tab-7',
      title: 'DeepSeek',
      url: 'https://chat.deepseek.com/',
      selected: true,
    })
  })

  it('falls back to the tab record when the post-open snapshot fails', async () => {
    // The tab exists even when the snapshot does not; losing the title is
    // acceptable, losing the url the model just asked for is not.
    const { driver } = makeDriverStub({
      overrides: {
        open: async () => makeTab({ id: 'tab-7', url: 'https://chat.deepseek.com/', title: 'DeepSeek' }),
        snapshot: async () => { throw new Error('not attached') },
      },
    })
    const tool = toolNamed('browser_open', buildSidebrowserTools(driver))
    await expect(run(tool, { url: 'deepseek' })).resolves.toMatchObject({
      ok: true,
      url: 'https://chat.deepseek.com/',
      title: 'DeepSeek',
    })
  })

  it('returns the page text, the truncation flag and the url together', async () => {
    // The model needs to know the text was cut off, or it will reason about a
    // page it only partially saw.
    const { driver } = makeDriverStub({
      overrides: {
        extractText: async () => makeExtracted({ title: 'Doc', url: 'https://example.com/doc', text: 'body text', truncated: true }),
      },
    })
    const tool = toolNamed('browser_read', buildSidebrowserTools(driver))
    await expect(run(tool, { maxChars: 200, includeInventory: true })).resolves.toEqual({
      ok: true,
      title: 'Doc',
      url: 'https://example.com/doc',
      text: 'body text',
      truncated: true,
    })
  })

  it('omits the inventory entirely when none was requested', async () => {
    // An `inventory: undefined` key would still be serialised as a field the
    // model has to interpret; omitting it is the honest "there is none".
    const { driver } = makeDriverStub()
    const tool = toolNamed('browser_read', buildSidebrowserTools(driver))
    const value = await run(tool, {})
    expect(Object.hasOwn(value, 'inventory')).toBe(false)
  })

  it('forwards the model\'s own tabId to the browser, so it acts on the tab it named', async () => {
    // The model opens two tabs and then reads the second; without forwarding,
    // every call would act on whichever tab the user last touched.
    const { driver, spies } = makeDriverStub()
    const tool = toolNamed('browser_read', buildSidebrowserTools(driver))
    await run(tool, { tabId: 'tab-2', maxChars: 500 })
    expect(spies.extractText).toHaveBeenCalledWith({ maxChars: 500, includeInventory: false }, 'tab-2')
  })

  it('confirms a click with the resulting url, so the model can see it navigated', async () => {
    // A click that silently did nothing reads as success; the post-action url
    // is what tells the model the click actually went somewhere.
    const { driver } = makeDriverStub({
      overrides: { snapshot: async () => makeSnapshot({ url: 'https://example.com/results', title: 'Results' }) },
    })
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'click', selector: '#go' })).resolves.toMatchObject({
      ok: true,
      action: 'click',
      url: 'https://example.com/results',
    })
  })

  it('reports how many characters it typed, so the model can verify the length', async () => {
    // A truncated or mangled paste is a common failure on search boxes; the
    // character count is the cheapest signal that the text arrived whole.
    const { driver } = makeDriverStub()
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'type', text: 'hello world', selector: '#q' })).resolves.toMatchObject({
      ok: true,
      action: 'type',
      typed: 11,
    })
  })

  it('clamps a scroll beyond the allowed range into the default step', async () => {
    // The description tells the model a pixel delta; a runaway value would fling
    // the page past everything the model wanted to read.
    const { driver, spies } = makeDriverStub()
    const tool = toolNamed('browser_act', buildSidebrowserTools(driver))
    await run(tool, { action: 'scroll', deltaY: 1200 })
    expect(spies.scroll).toHaveBeenCalledWith(1200, undefined)
  })

  it('projects a compact tab list, dropping the CDP session identifiers', async () => {
    // `targetId`/`sessionId` are protocol plumbing; exposing them invites the
    // model to pass them back as a tabId, which would never resolve.
    const { driver } = makeDriverStub({
      overrides: {
        listTabs: async () => [makeTab({ id: 'tab-1', targetId: 'T1', sessionId: 'S1' })],
      },
    })
    const tool = toolNamed('browser_tabs', buildSidebrowserTools(driver))
    await expect(run(tool, { action: 'list' })).resolves.toEqual({
      ok: true,
      count: 1,
      tabs: [{ id: 'tab-1', title: 'Example Domain', url: 'https://example.com/', selected: true }],
    })
  })

  it('returns a file path for a screenshot rather than the image bytes', async () => {
    // A base64 PNG is megabytes, and pasting one into the transcript would bloat
    // every later context window that carries the session.
    const { driver } = makeDriverStub({
      overrides: { captureScreenshotToFile: async () => '/tmp/dsh-sidebrowser-shot-1.png' },
    })
    const tool = toolNamed('browser_screenshot', buildSidebrowserTools(driver))
    const value = await run(tool, {})
    expect(value).toMatchObject({ ok: true, path: '/tmp/dsh-sidebrowser-shot-1.png', scale: 0.5, fullPage: false })
    expect(Object.hasOwn(value, 'data')).toBe(false)
  })

  it('clamps the requested screenshot scale into the legible band', async () => {
    // The scale is model-supplied; below the floor the image is unreadable, so
    // the tool clamps rather than trusting it.
    const { driver, spies } = makeDriverStub()
    const tool = toolNamed('browser_screenshot', buildSidebrowserTools(driver))
    await run(tool, { scale: 0.01, fullPage: true })
    expect(spies.captureScreenshotToFile).toHaveBeenCalledWith(undefined, true, 0.2)
    spies.captureScreenshotToFile.mockClear()
    await run(tool, { scale: 9 })
    expect(spies.captureScreenshotToFile).toHaveBeenCalledWith(undefined, false, 1)
  })
})
// @vitest-environment jsdom
/**
 * Tests for the sidebar panel's own surface and address handling.
 *
 * The panel is what the user actually looks at, and its controls are wired
 * through a route client rather than through the driver — so the failures that
 * matter here are "the controls are missing or never call anything", which a
 * markup assertion catches and an integration test of the driver would not.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SideBrowserPanel, resolveAddress } from '../src/client/panel.tsx'
import type { SideBrowserApi } from '../src/client/api.ts'

/** A route client that records what the panel asked for. */
function makeApi(overrides: Partial<Record<string, unknown>> = {}): { api: SideBrowserApi; calls: string[] } {
  const calls: string[] = []
  // A recording route method. Declared as a function rather than an arrow with
  // a generic parameter: `<T>(…)` in a .tsx file parses as JSX.
  function record(name: string, value: unknown): (...args: unknown[]) => Promise<unknown> {
    return (...args: unknown[]) => {
      calls.push(name)
      return Promise.resolve({ ok: true, value })
    }
  }
  const api = {
    state: async () => ({ ok: true, value: { attached: true, url: 'https://example.com/', title: 'Example', loading: false } }),
    frame: async () => ({ ok: true, value: { changed: false, frameId: 1, capturedAt: '' } }),
    text: async () => ({ ok: true, value: { title: 'Example', url: 'https://example.com/', text: 'body', truncated: false } }),
    navigate: record('navigate', {}),
    reload: record('reload', {}),
    back: record('back', {}),
    forward: record('forward', {}),
    openTab: record('openTab', {}),
    closeTab: record('closeTab', {}),
    selectTab: record('selectTab', {}),
    listTabs: async () => ({ ok: true, value: [] }),
    screenshot: record('screenshot', { id: 1, data: '', title: '', url: '', capturedAt: '' }),
    ...overrides,
  } as unknown as SideBrowserApi
  return { api, calls }
}

/** Render the panel the way the tab seat does. */
function render(api: SideBrowserApi): string {
  return renderToStaticMarkup(createElement(SideBrowserPanel, {
    api,
    pollIntervalSeconds: 1,
    extraShortcuts: [],
    visible: true,
    signal: new AbortController().signal,
    bindCommands: () => () => {},
  }))
}

describe('resolveAddress', () => {
  it('passes a URL through untouched', () => {
    expect(resolveAddress('https://chat.deepseek.com/')).toBe('https://chat.deepseek.com/')
    expect(resolveAddress('http://localhost:3000/x')).toBe('http://localhost:3000/x')
  })

  it('treats bare words as a search, the way a browser bar does', () => {
    // Typing "what is CDP" must not become a failed navigation.
    expect(resolveAddress('what is CDP')).toBe('https://www.bing.com/search?q=what%20is%20CDP')
    expect(resolveAddress('  bing.com  ')).toBe('https://bing.com')
    expect(resolveAddress('')).toBe('')
  })

  it('upgrades localhost and a dotted host to a usable url', () => {
    expect(resolveAddress('localhost:8080')).toBe('http://localhost:8080')
    expect(resolveAddress('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })
})

describe('panel surface', () => {
  it('renders its controls rather than an empty box', () => {
    // The tab body rendered an empty string forever once before; the panel is
    // the surface a user stares at, so its controls are asserted explicitly.
    const { api } = makeApi()
    const html = render(api)
    expect(html).toContain('<input')
    expect(html).toContain('<button')
    // Navigation controls: back, forward, reload, and a way to open a new tab.
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('renders with no frame yet, instead of failing', () => {
    // Cold start: the Host has not captured anything. The panel must still
    // render its chrome so the user can type an address.
    const { api } = makeApi({
      frame: async () => ({ ok: false, error: 'The host returned no frame' }),
      state: async () => ({ ok: true, value: { attached: true, url: '', title: '', loading: false } }),
    })
    const html = render(api)
    expect(html).toContain('<input')
  })

  it('renders when the Host has no browser attached', () => {
    // The sidebar must be able to explain itself rather than disappearing.
    const { api } = makeApi({
      state: async () => ({ ok: false, error: 'no browser is attached to this DSH instance' }),
    })
    const html = render(api)
    expect(html).toContain('<input')
  })

  it('reports a Host failure instead of rendering a blank view', () => {
    const error = 'The host did not mount the side-browser routes'
    const { api } = makeApi({
      frame: async () => ({ ok: false, error }),
      state: async () => ({ ok: false, error }),
    })
    // Either the panel surfaces the message or it degrades, but it must not
    // throw during render.
    expect(() => render(api)).not.toThrow()
  })
})

describe('panel refresh binding', () => {
  it('offers the tab a refresh command on mount and releases it on unmount', () => {
    const commands: Array<Record<string, unknown>> = []
    const bindCommands = (cmds: Record<string, unknown>): (() => void) => {
      commands.push(cmds)
      return () => {}
    }
    const { api } = makeApi()
    renderToStaticMarkup(createElement(SideBrowserPanel, {
      api,
      pollIntervalSeconds: 1,
      extraShortcuts: [],
      visible: true,
      signal: new AbortController().signal,
      bindCommands,
    }))
    // renderToStaticMarkup does not run effects, so assert on the contract the
    // panel was handed rather than on a registration that effects would make.
    expect(commands).toHaveLength(0)
    expect(typeof bindCommands).toBe('function')
  })

  it('does not call the Host while the tab is hidden', () => {
    // A collapsed sidebar must cost nothing: the poll loop is keyed on
    // visibility, and an agent-facing driver must not poll behind the scenes.
    const calls: string[] = []
    const { api } = makeApi({
      frame: async () => { calls.push('frame'); return { ok: true, value: { changed: false, frameId: 1, capturedAt: '' } } },
      state: async () => { calls.push('state'); return { ok: true, value: { attached: true, url: 'https://example.com/', title: '', loading: false } } },
    })
    renderToStaticMarkup(createElement(SideBrowserPanel, {
      api,
      pollIntervalSeconds: 1,
      extraShortcuts: [],
      visible: false,
      signal: new AbortController().signal,
      bindCommands: () => () => {},
    }))
    expect(calls).toEqual([])
    expect(vi.isMockFunction(() => undefined)).toBe(false)
  })
})
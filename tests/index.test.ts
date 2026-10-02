/**
 * Tests for the Host loader entry: volatile config reads, the optional-service
 * resolvers, and the single-instance mount guard.
 *
 * These three helpers are what decide whether a side browser appears at all:
 * a config read that captures a stale value would leave the master switch stuck,
 * a resolver that throws would stop the plugin from mounting, and a mount guard
 * that never releases would make the browser impossible to reload after a Host
 * restart. None of them need Chrome, so they are tested directly.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { Config, mountOnce, readConfigField, resolvePromptRegistry, resolveToolRegistry, SIDEBROWSER_GUIDANCE } from '../src/index.ts'

/** Build a `Volatile` the way the Host does: a stable reference over a committed value. */
function volatileOf<T>(value: T): Volatile<T> {
  let current = value
  return { get: () => current } as unknown as Volatile<T>
}

describe('config field reads', () => {
  it('returns a plain value as it stands', () => {
    // A programmatic mount passes plain values, so the reader must not mangle them.
    expect(readConfigField(true, false)).toBe(true)
    expect(readConfigField('/opt/chrome', '')).toBe('/opt/chrome')
    expect(readConfigField(0, 9222)).toBe(0)
  })

  it('falls back for an absent field rather than handing back undefined', () => {
    // Every call site does `readConfigField(config?.x, DEFAULT) ?? ...` arithmetic;
    // returning undefined here would surface as NaN or a crash at first use.
    expect(readConfigField(undefined, true)).toBe(true)
    expect(readConfigField(undefined, 1000)).toBe(1000)
    expect(readConfigField(undefined, 'https://chat.deepseek.com/')).toBe('https://chat.deepseek.com/')
  })

  it('reads a volatile field through get() at the moment of the call', () => {
    // The Host commits an edited setting into the same reference instead of
    // remounting the row, so the value must be dereferenced late, every time.
    const field = volatileOf(false)
    expect(readConfigField(field, true)).toBe(false)
    const committed = field as unknown as { get: () => boolean }
    committed.get = () => true
    expect(readConfigField(field, false)).toBe(true)
  })

  it('does not call get() on a plain object that happens to be the config value', () => {
    // Only a `get`-bearing object is a volatile reference; a plain object value
    // (e.g. a nested option bag) must pass through untouched.
    const value = { nested: 1 }
    expect(readConfigField(value as unknown as Volatile<{ nested: number }>, { nested: 0 })).toBe(value)
  })

  it('keeps falsy configured values instead of substituting the fallback', () => {
    // `port: 0` means "let the OS pick a free port" and `headless: false` is a
    // real choice; a truthiness-based reader would silently override both.
    expect(readConfigField(0, 9222)).toBe(0)
    expect(readConfigField(false, true)).toBe(false)
    expect(readConfigField('', 'C:\\Program Files\\Google\\Chrome\\chrome.exe')).toBe('')
  })
})

describe('optional service resolution', () => {
  /** A context whose `get` answers the given service name. */
  function contextWith(services: Record<string, unknown>): Context {
    return { get: (name: string) => services[name] } as unknown as Context
  }

  it('resolves the tool registry when the deployment serves one', () => {
    const registry = { register: () => () => undefined }
    expect(resolveToolRegistry(contextWith({ tools: registry }))).toBe(registry)
  })

  it('resolves to undefined when the deployment serves no tool registry', () => {
    // The sidebar is the primary consumer; a deployment without `tools` must
    // still mount and lose only the agent-facing surface.
    expect(resolveToolRegistry(contextWith({}))).toBeUndefined()
  })

  it('rejects a registry that lacks register(), rather than trusting the name', () => {
    // A differently-shaped service under the same name must not be mistaken for
    // the registry: the caller would then throw on first tool registration.
    expect(resolveToolRegistry(contextWith({ tools: { add: () => undefined } }))).toBeUndefined()
    expect(resolveToolRegistry(contextWith({ tools: 'not-a-service' }))).toBeUndefined()
  })

  it('survives a context whose get() throws for a missing service', () => {
    // Cordis signals "not provided" by throwing in some compositions; the row
    // must still mount instead of failing activation.
    const ctx = { get: () => { throw new Error('service not found: tools') } } as unknown as Context
    expect(resolveToolRegistry(ctx)).toBeUndefined()
    expect(resolvePromptRegistry(ctx)).toBeUndefined()
  })

  it('resolves the prompt registry only when it can accept a section', () => {
    const registry = { section: () => () => undefined }
    expect(resolvePromptRegistry(contextWith({ systemPrompt: registry }))).toBe(registry)
    expect(resolvePromptRegistry(contextWith({ systemPrompt: { add: () => undefined } }))).toBeUndefined()
  })
})

describe('single-instance mount guard', () => {
  /** A package name unique per test, so one test cannot hold another's lease. */
  const PKG = 'tests/index/mount-once'

  /**
   * A context whose `effect` behaves like cordis's: it stores the disposer the
   * effect callback returns and hands it back, and `disposeAll` runs it. This is
   * the contract `mountOnce` relies on to learn that its holder died.
   */
  function makeEffectContext(): { ctx: Context, disposeAll: () => void } {
    const disposers: Array<() => void> = []
    const ctx = {
      effect: (fn: () => unknown) => {
        const disposer = fn() as (() => void) | undefined
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => undefined
      },
    } as unknown as Context
    return {
      ctx,
      disposeAll: () => {
        for (const disposer of disposers.splice(0)) disposer()
      },
    }
  }

  it('runs the wrapped apply exactly once for one package name', () => {
    const apply = vi.fn()
    const mount = mountOnce(PKG, apply)
    mount(makeEffectContext().ctx)
    mount(makeEffectContext().ctx)
    mount(makeEffectContext().ctx)
    // Two live mounts would fight over one Chrome user-data-dir (Chrome refuses
    // a second process on the same profile) and double-register every route.
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('keeps the mount blocked while the holder is still live', () => {
    const apply = vi.fn()
    const mount = mountOnce(`${PKG}/live`, apply)
    const holder = makeEffectContext()
    mount(holder.ctx)
    mount(holder.ctx)
    // The first holder has not disposed, so the lease is still held.
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('allows a remount after the holder effect disposes', () => {
    const apply = vi.fn()
    const mount = mountOnce(`${PKG}/remount`, apply)
    const ctx = makeEffectContext()
    mount(ctx.ctx)
    expect(apply).toHaveBeenCalledTimes(1)
    // A Host reload disposes the old fiber; the name must be free again or the
    // browser could never come back after a plugin update.
    ctx.disposeAll()
    mount(ctx.ctx)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('mounts again after a double dispose, proving the guard is idempotent', () => {
    const apply = vi.fn()
    const mount = mountOnce(`${PKG}/idempotent`, apply)
    const ctx = makeEffectContext()
    mount(ctx.ctx)
    ctx.disposeAll()
    ctx.disposeAll()
    mount(ctx.ctx)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('mounts on a context with no effect support at all', () => {
    // A programmatic `apply(ctx)` outside a fiber still has to run exactly once;
    // the guard must not depend on the effect API existing.
    const apply = vi.fn()
    const mount = mountOnce(`${PKG}/no-effect`, apply)
    mount({} as never)
    mount({} as never)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('scopes the lease per package name', () => {
    // Two installations of this package (different install sources) share a
    // process; the guard keys on the package name, so distinct names coexist.
    const first = vi.fn()
    const second = vi.fn()
    mountOnce(`${PKG}/scope-a`, first)({} as never)
    mountOnce(`${PKG}/scope-b`, second)({} as never)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('plugin config schema', () => {
  it('defaults to enabled, headless, and a two-second half-scale capture', () => {
    // Headless is the default now: the page belongs in the sidebar and nothing
    // should pop up in front of the conversation. A user who needs the real
    // window - to sign in by hand, say - turns it on explicitly.
    // The schema hands back `Volatile` references by design, so the effective
    // values are read exactly as `applyImpl` reads them.
    const parsed = Config({}) as Config
    expect(readConfigField(parsed.enabled, false)).toBe(true)
    expect(readConfigField(parsed.headless, false)).toBe(true)
    expect(readConfigField(parsed.port, 9222)).toBe(0)
    expect(readConfigField(parsed.executablePath, 'x')).toBe('')
    expect(readConfigField(parsed.userDataDir, 'x')).toBe('')
    expect(readConfigField(parsed.captureIntervalMs, 250)).toBe(1000)
    expect(readConfigField(parsed.captureScale, 0.2)).toBe(0.5)
  })

  it('keeps the browser headless unless a window is asked for', () => {
    // Reported as "why does it open a new Chrome window - I wanted it inside the
    // DSH sidebar". The page belongs in the panel, so no window should appear on
    // a fresh install; the real window is opt-in, for signing in by hand.
    const parsed = Config({}) as Config
    expect(readConfigField(parsed.headless, false)).toBe(true)
    // Asking for a window is one setting away.
    const asked = Config({ headless: false }) as Config
    expect(readConfigField(asked.headless, true)).toBe(false)
  })

  it('accepts an in-band capture setting and rejects one out of band', () => {
    // The bounds are the frame budget: an out-of-band value would either be
    // illegible or would flood the poll route.
    const parsed = Config({ captureScale: 0.25, captureIntervalMs: 250 }) as Config
    expect(readConfigField(parsed.captureScale, 0)).toBe(0.25)
    expect(readConfigField(parsed.captureIntervalMs, 0)).toBe(250)
    expect(() => Config({ captureScale: 0.1 })).toThrow()
    expect(() => Config({ captureScale: 1.5 })).toThrow()
    expect(() => Config({ captureIntervalMs: 10 })).toThrow()
    expect(() => Config({ captureIntervalMs: 60_000 })).toThrow()
  })
})

describe('model-facing announcement', () => {
  it('names the tools and the trigger phrases the user would actually type', () => {
    // Without this paragraph the model has no reason to suspect the browser
    // exists, and the tools stay undiscovered; the trigger words are what make
    // the announcement reachable from a Chinese or English request alike.
    for (const tool of ['browser_open', 'browser_read', 'browser_act', 'browser_tabs', 'browser_screenshot']) {
      expect(SIDEBROWSER_GUIDANCE).toContain(tool)
    }
    expect(SIDEBROWSER_GUIDANCE).toContain('右侧栏')
    expect(SIDEBROWSER_GUIDANCE).toContain('翻译')
    expect(SIDEBROWSER_GUIDANCE).toContain('AI解释')
  })
})
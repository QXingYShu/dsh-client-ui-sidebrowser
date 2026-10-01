/**
 * Tests for the screenshot stream's change detection and frame lifecycle.
 *
 * This module exists to make a 1–2 Hz live view affordable, and the whole claim
 * rests on one property: an unchanged page must cost nothing to re-report. An
 * idle sidebar re-polls constantly, so a regression here is a silent bandwidth
 * and Host-memory leak rather than a visible error — exactly the kind of defect
 * a test has to carry.
 *
 * The driver is a fake that returns scripted PNG bytes; no Chrome, no CDP.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserDriver, PageSnapshot } from '../src/browser/driver.ts'
import { ScreenshotStream } from '../src/browser/screenshot-stream.ts'
import { makeTab } from './helpers.ts'

/** A page snapshot stub with every field filled. */
function snapshotOf(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return { attached: true, loading: false, title: 'Example', url: 'https://example.com/', ...overrides }
}

/**
 * Build a driver stub whose captures return scripted PNG bytes in order.
 *
 * The last scripted frame repeats forever once the queue drains, so a test can
 * script "same, same, then different" without counting ticks by hand.
 * @param frames - PNG payloads in capture order.
 * @returns the stub plus a capture counter.
 */
function makeScriptedDriver(frames: string[]): { driver: BrowserDriver, captures: () => number } {
  const queue = [...frames]
  let captures = 0
  const driver = {
    listTabs: async () => [makeTab()],
    captureScreenshot: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      captures += 1
      return next ?? ''
    },
    snapshot: async () => snapshotOf(),
  } as unknown as BrowserDriver
  return { driver, captures: () => captures }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('change detection', () => {
  it('reports the very first frame as changed, because nothing was shown before', async () => {
    // The client's panel paints nothing until a `changed: true` arrives, so a
    // first poll that answered "unchanged" would leave the sidebar blank until
    // the user happened to scroll something.
    const { driver } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver)
    await expect(stream.poll()).resolves.toMatchObject({
      changed: true,
      frame: { id: 1, data: 'AAAA' },
    })
  })

  it('reports byte-identical pixels as unchanged and sends no payload', async () => {
    // This is the load-bearing property: an idle page (a user reading an
    // article) produces the same PNG forever, and re-sending megabytes on every
    // poll is exactly what this module exists to prevent.
    const { driver } = makeScriptedDriver(['AAAA', 'AAAA'])
    const stream = new ScreenshotStream(driver)
    await stream.poll()
    const second = await stream.poll()
    expect(second.changed).toBe(false)
    // No `frame` key at all: the payload must be absent rather than empty, or
    // the client would decode a blank image over a good one.
    expect(Object.hasOwn(second, 'frame')).toBe(false)
  })

  it('keeps the same frame id while the view is unchanged', async () => {
    // A stable id is how the client distinguishes "nothing changed" from "a new
    // frame that happens to look identical"; a fresh id per poll would defeat
    // that and force a repaint every second.
    const { driver } = makeScriptedDriver(['AAAA', 'AAAA', 'AAAA'])
    const stream = new ScreenshotStream(driver)
    await stream.poll()
    await expect(stream.poll()).resolves.toMatchObject({ changed: false, frameId: 1 })
    await expect(stream.poll()).resolves.toMatchObject({ changed: false, frameId: 1 })
  })

  it('reports changed once the pixels differ, and advances the frame id', async () => {
    // The moment the user scrolls or the page animates, the sidebar must
    // repaint — and with the new bytes, not the stale baseline.
    const { driver } = makeScriptedDriver(['AAAA', 'BBBB'])
    const stream = new ScreenshotStream(driver)
    await stream.poll()
    const second = await stream.poll()
    expect(second.changed).toBe(true)
    if (second.changed) {
      expect(second.frame.data).toBe('BBBB')
      expect(second.frame.id).toBe(2)
    }
  })

  it('returns a new frame after every change, with monotonic ids', async () => {
    // Ids advance only on a genuinely new frame, so a client can cache by id and
    // know that a gap means frames were skipped, not renumbered.
    const { driver } = makeScriptedDriver(['A', 'B', 'C', 'D'])
    const stream = new ScreenshotStream(driver)
    const ids: number[] = []
    for (let poll = 0; poll < 4; poll += 1) {
      const result = await stream.poll()
      if (result.changed) ids.push(result.frame.id)
    }
    expect(ids).toEqual([1, 2, 3, 4])
  })

  it('keeps the last good frame addressable while the page is unchanged', async () => {
    // `latest()` is what the frame route uses to answer immediately, so a
    // client that connects just after a capture is not shown an empty view.
    const { driver } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver)
    expect(stream.latest()).toBeUndefined()
    await stream.poll()
    expect(stream.latest()).toMatchObject({ id: 1, data: 'AAAA' })
  })

  it('refreshes the title and url on an unchanged frame without re-sending pixels', async () => {
    // A SPA can change its url and title while the pixels stay identical (a hash
    // route, a query-string filter). Carrying the metadata forward keeps the
    // sidebar's address bar truthful without paying for a re-send.
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => 'AAAA',
      snapshot: async () => snapshotOf({ title: 'New title', url: 'https://example.com/#filtered' }),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    const second = await stream.poll()
    expect(second.changed).toBe(true)
    await expect(stream.poll()).resolves.toMatchObject({
      changed: false,
      title: 'New title',
      url: 'https://example.com/#filtered',
    })
  })

  it('survives a failing snapshot by keeping the previous frame metadata', async () => {
    // A snapshot can transiently fail mid-navigation; reporting an empty title
    // would make the sidebar flicker to a blank address bar for no reason.
    let failSnapshot = false
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => 'AAAA',
      snapshot: async () => {
        if (failSnapshot) throw new Error('Execution context was destroyed')
        return snapshotOf()
      },
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    await stream.poll()
    failSnapshot = true
    await expect(stream.poll()).resolves.toMatchObject({
      changed: false,
      title: 'Example',
      url: 'https://example.com/',
    })
  })
})

describe('capture failures', () => {
  it('keeps answering with the last good frame when a capture fails', async () => {
    // "The browser is not attached yet" is the normal case on a cold sidebar,
    // and the last frame is still what the user is looking at — the poll must
    // degrade to "unchanged", never to an error the panel would flash at them.
    let captures = 0
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => {
        captures += 1
        if (captures === 1) return 'AAAA'
        throw new Error('there is no page open to screenshot')
      },
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    await stream.poll()
    await expect(stream.poll()).resolves.toMatchObject({ changed: false, frameId: 1 })
  })

  it('rejects the first poll when there has never been a frame to fall back on', async () => {
    // Falling back to a frame that does not exist would be a fabrication; the
    // caller has to learn the browser is not up yet.
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => { throw new Error('there is no page open to screenshot') },
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    await expect(stream.poll()).rejects.toThrow('there is no page open to screenshot')
  })

  it('rejects when no tab is open, naming the real cause', async () => {
    // The message is what the sidebar shows; "there is no page open to
    // screenshot" tells the user to open one, where a CDP error would not.
    const driver = {
      listTabs: async () => [],
      snapshot: async () => snapshotOf({ attached: false, title: '', url: '' }),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    await expect(stream.poll()).rejects.toThrow('there is no page open to screenshot')
  })

  it('captures the selected tab, not the first one', async () => {
    // The user may have selected tab 2; a frame of tab 1 in the live view would
    // show them the wrong page while every control acted on the right one.
    const driver = {
      listTabs: async () => [makeTab({ id: 'tab-1', selected: false }), makeTab({ id: 'tab-2', selected: true })],
      captureScreenshot: async (_fullPage: boolean, tabId: string) => `shot:${tabId}`,
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver)
    await expect(stream.poll()).resolves.toMatchObject({ changed: true, frame: { data: 'shot:tab-2' } })
  })

  it('passes the configured scale down to the capture', async () => {
    // Downscaling inside Chrome is what keeps a frame inside the poll budget,
    // so a lost scale would silently make every frame several megabytes.
    const capture = vi.fn(async () => 'AAAA')
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: capture,
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    await new ScreenshotStream(driver, { scale: 0.25 }).poll()
    expect(capture).toHaveBeenCalledWith(false, 'tab-1', 0.25)
  })

  it('clamps the configured scale into the legible band', async () => {
    // Config is user input; a scale below the floor produces an unreadable
    // thumbnail and one above 1 only wastes bytes.
    const capture = vi.fn(async () => 'AAAA')
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: capture,
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    await new ScreenshotStream(driver, { scale: 0.01 }).poll()
    expect(capture).toHaveBeenLastCalledWith(false, 'tab-1', 0.2)
    capture.mockClear()
    await new ScreenshotStream(driver, { scale: 8 }).poll()
    expect(capture).toHaveBeenLastCalledWith(false, 'tab-1', 1)
  })
})

describe('frame lifecycle', () => {
  it('keeps the baseline fresh on its interval timer without a poll', async () => {
    // The client decides when it wants a frame, but the timer still runs so the
    // "has anything changed?" baseline is never stale by a full interval.
    const { driver, captures } = makeScriptedDriver(['AAAA', 'BBBB'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    stream.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toBe(2)
    // The timer already captured the change, so the client's next poll sees no
    // new frame: the stream's own baseline update is what paid for it.
    await expect(stream.poll()).resolves.toMatchObject({ changed: false, frameId: 2 })
    stream.stop()
  })

  it('keeps capturing after a failed tick, because the next tick usually works', async () => {
    // A failed capture is almost always "the browser is not attached *yet*",
    // which resolves on the next tick. A stream that stopped on the first error
    // would never come back on its own.
    let attempts = 0
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('not attached yet')
        return 'AAAA'
      },
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    const onError = vi.fn()
    const stream = new ScreenshotStream(driver, { intervalMs: 1000, onError })
    stream.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledTimes(1)
    // The failure must not have left a half-built frame behind.
    expect(stream.latest()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(stream.latest()?.data).toBe('AAAA')
    stream.stop()
  })

  it('never runs two captures at once when a capture outlasts the interval', async () => {
    // A heavy page can take longer than the interval; overlapping captures would
    // queue an unbounded backlog of screenshots in the Host.
    let inFlight = 0
    let maxInFlight = 0
    let release: (() => void) | undefined
    const driver = {
      listTabs: async () => [makeTab()],
      captureScreenshot: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>(resolve => { release = resolve })
        inFlight -= 1
        return 'AAAA'
      },
      snapshot: async () => snapshotOf(),
    } as unknown as BrowserDriver
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    stream.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(maxInFlight).toBe(1)
    release?.()
    stream.stop()
  })

  it('treats a second start on a running stream as a no-op', async () => {
    // Two intervals would double the capture rate, halving the very budget the
    // interval exists to set.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    stream.start()
    stream.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toBe(1)
    stream.stop()
  })

  it('halts captures on stop while keeping the last frame answerable', async () => {
    // `stop` releases the timer but deliberately retains the frame: a poll that
    // arrives after a stop must still describe what the user is looking at
    // rather than reporting a blank view.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    await stream.poll()
    stream.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(captures()).toBe(1)
    expect(stream.latest()?.data).toBe('AAAA')
  })

  it('releases the retained frame on dispose, not only on stop', async () => {
    // `dispose` is what the Host effect cleanup calls; if it only stopped the
    // timer, a disabled plugin would keep several megabytes resident forever.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    await stream.poll()
    stream.dispose()
    expect(stream.latest()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5000)
    expect(captures()).toBe(1)
  })

  it('does not capture on start, so mounting never pops a browser window', () => {
    // The first capture is deliberately deferred to the next tick: mounting the
    // plugin must not launch Chrome on every Host start.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    stream.start()
    expect(captures()).toBe(0)
    stream.stop()
  })

  it('holds the poll interval at or above the floor', async () => {
    // A 50 ms interval from a bad config would turn the live view into a
    // screenshot flood; the constructor clamps it instead of trusting input.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 5 })
    stream.start()
    await vi.advanceTimersByTimeAsync(200)
    // At the 200 ms floor only one capture has fired, not forty.
    expect(captures()).toBe(1)
    stream.stop()
  })

  it('resumes capturing after a stop and start', async () => {
    // The master switch toggling must bring the live view back, not leave a
    // stream that was stopped once permanently dead.
    const { driver, captures } = makeScriptedDriver(['AAAA'])
    const stream = new ScreenshotStream(driver, { intervalMs: 1000 })
    stream.start()
    await vi.advanceTimersByTimeAsync(1000)
    stream.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(captures()).toBe(1)
    stream.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toBe(2)
    stream.stop()
  })
})
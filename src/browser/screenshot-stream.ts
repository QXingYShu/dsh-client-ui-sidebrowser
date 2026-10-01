/**
 * Periodic screenshot capture for the sidebar's live view.
 *
 * Because DeepSeek/Bing/Baidu refuse cross-origin framing, the sidebar cannot
 * embed the real page. It renders this stream instead: the Host captures the
 * real Chrome window on an interval and the client polls the latest frame. That
 * makes frame cost the central concern, which is what this module exists to
 * manage:
 *
 * - **Change detection.** An idle page (a user reading an article, an agent
 *   thinking between tool calls) produces byte-identical PNGs. Re-sending them
 *   wastes Host memory, poll bandwidth, and the client's decode work, so an
 *   unchanged frame is reported as "same as before" with no payload at all.
 * - **Bounded frames.** A full-resolution PNG of a modern page is several
 *   megabytes. Capturing the viewport (not the full scroll height) and
 *   downscaling keeps a frame inside a budget that a 1–2 Hz poll can sustain.
 * - **Bounded retention.** Only the newest frame is retained. This is a
 *   last-frame cache, not a video buffer; keeping history would trade memory
 *   for a feature the sidebar does not offer.
 *
 * @module dsh-sidebrowser/browser/screenshot-stream
 */

import type { BrowserDriver } from './driver.ts'

/** Options for {@link ScreenshotStream}. */
export interface ScreenshotStreamOptions {
  /** Milliseconds between capture attempts. */
  intervalMs?: number
  /** Viewport scale factor applied on capture (0.5 halves each dimension, a quarter of the pixels). */
  scale?: number
  /** Capture the whole scrollable page rather than just the viewport. */
  fullPage?: boolean
  /** Called after every capture attempt, successfully or not. */
  onError?: (error: Error) => void
}

/** Default poll interval: fast enough to feel live, slow enough to be cheap. */
const DEFAULT_INTERVAL_MS = 1000

/** Clamp the capture scale into a band that stays legible but bounded. */
const MIN_SCALE = 0.2

/** Upper bound on the capture scale; above 1 there is nothing to gain for a sidebar thumbnail. */
const MAX_SCALE = 1

/** One captured frame plus its metadata. */
export interface ScreenshotFrame {
  /** Monotonic frame id, incremented on every *new* frame; stable across unchanged polls. */
  id: number
  /** Base64 PNG data with no `data:` prefix. */
  data: string
  /** Page title at capture time. */
  title: string
  /** Page url at capture time. */
  url: string
  /** Capture time as an ISO timestamp. */
  capturedAt: string
}

/** What a poll returns: either a fresh frame or proof the view is unchanged. */
export type ScreenshotPoll =
  /** A newly captured, changed frame. */
  | { changed: true, frame: ScreenshotFrame }
  /** The current view is byte-identical to the previous frame; nothing was re-sent. */
  | { changed: false, frameId: number, capturedAt: string, title: string, url: string }

/**
 * A self-capturing, change-detecting screenshot source for one tab.
 *
 * The stream owns a timer and the last frame; `start`/`stop` bracket its life so
 * the Host effect that registers the routes can tear it down cleanly. A capture
 * that fails (no browser yet, tab closed mid-shot) is reported through
 * {@link ScreenshotStreamOptions.onError} and does not stop the stream, because
 * the overwhelmingly common cause is "the browser is not attached *yet*", which
 * resolves on the next tick.
 */
export class ScreenshotStream {
  /** The driver frames are captured from. */
  private readonly driver: BrowserDriver

  /** Resolved options with defaults applied. */
  private readonly intervalMs: number

  /** Resolved viewport scale. */
  private readonly scale: number

  /** Whether to capture beyond the viewport. */
  private readonly fullPage: boolean

  /** Error reporter supplied at construction. */
  private readonly onError: ((error: Error) => void) | undefined

  /** The capture timer, while the stream is running. */
  private timer: NodeJS.Timeout | undefined

  /** The most recent successfully captured frame, retained as the change baseline. */
  private last: ScreenshotFrame | undefined

  /** Monotonic frame id; only advanced when a frame is genuinely new. */
  private nextFrameId = 1

  /** Set while a capture is in flight, so ticks never overlap captures. */
  private capturing = false

  /** Set once the stream is stopped, to reject late ticks. */
  private stopped = false

  /**
   * @param driver - the browser driver whose selected tab is captured.
   * @param options - interval, scale, and error reporting.
   */
  constructor(driver: BrowserDriver, options: ScreenshotStreamOptions = {}) {
    this.driver = driver
    this.intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 200)
    this.scale = Math.min(Math.max(options.scale ?? 0.5, MIN_SCALE), MAX_SCALE)
    this.fullPage = options.fullPage === true
    this.onError = options.onError
  }

  /**
   * Begin capturing on an interval.
   *
   * The first capture is deferred to the next tick rather than run inline, so
   * `start` never blocks on a browser that may not be launched yet — mounting
   * the plugin must not pop a browser window, and the sidebar polls state
   * separately anyway.
   * @returns void; a second `start` on a running stream is a no-op.
   */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // The stream must not by itself hold the Host process open during shutdown.
    this.timer.unref?.()
  }

  /**
   * Stop capturing and release the timer.
   *
   * Idempotent, so the Host effect's cleanup can call it unconditionally.
   * @returns void.
   */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Run one capture attempt, swallowing and reporting its failure.
   *
   * Ticks are serialized via the `capturing` flag: a capture that takes longer
   * than the interval (a heavy page, a busy Host) must not queue an unbounded
   * backlog of overlapping captures.
   * @returns void.
   */
  private async tick(): Promise<void> {
    if (this.stopped || this.capturing) return
    this.capturing = true
    try {
      await this.capture()
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.capturing = false
    }
  }

  /**
   * Capture one frame and update the change baseline if the pixels differ.
   *
   * The comparison is on the encoded PNG bytes. Two frames that encode to the
   * same bytes are visually identical by definition, so this is both exact and
   * free — no image decoding on the Host.
   * @returns the newly stored frame.
   */
  private async capture(): Promise<ScreenshotFrame> {
    const data = await this.captureScaled()
    const snapshot = await this.driver.snapshot().catch(() => undefined)
    const previous = this.last
    if (previous !== undefined && previous.data === data) {
      // Identical pixels: keep the existing frame id so the client can tell
      // "nothing changed" from "a new frame that happens to look the same".
      previous.title = snapshot?.title ?? previous.title
      previous.url = snapshot?.url ?? previous.url
      return previous
    }
    const frame: ScreenshotFrame = {
      id: this.nextFrameId++,
      data,
      title: snapshot?.title ?? '',
      url: snapshot?.url ?? '',
      capturedAt: new Date().toISOString(),
    }
    this.last = frame
    return frame
  }

  /**
   * Capture the selected tab at the configured scale.
   *
   * The tab is resolved explicitly so a frame is always attributed to one tab,
   * even when the user selects another between captures. Downscaling happens
   * inside Chrome's capture (see `BrowserDriver.captureScreenshot`), so the
   * Host never materialises a full-resolution bitmap.
   * @returns the base64 PNG data.
   * @throws {Error} when there is no page to capture.
   */
  private async captureScaled(): Promise<string> {
    const tabs = await this.driver.listTabs()
    const tab = tabs.find(t => t.selected) ?? tabs[0]
    if (tab === undefined) throw new Error('there is no page open to screenshot')
    return await this.driver.captureScreenshot(this.fullPage, tab.id, this.scale)
  }

  /**
   * The most recent frame, if any has been captured.
   *
   * The routes use this to answer a poll immediately without waiting a tick, so
   * a client that connects just after a capture is not shown an empty view.
   * @returns the latest frame, or undefined before the first capture.
   */
  latest(): ScreenshotFrame | undefined {
    return this.last
  }

  /**
   * Poll for the current view, capturing first so the answer is never stale by a
   * full interval.
   *
   * This is a pull model on purpose: the client decides when it wants a frame
   * (only while the sidebar is visible), so a closed sidebar costs nothing. The
   * interval timer still runs to keep the baseline fresh, but this method is the
   * one that produces what the client actually sees.
   * @returns a fresh frame, or the unchanged verdict when the view is static.
   */
  async poll(): Promise<ScreenshotPoll> {
    const before = this.latest()
    let frame: ScreenshotFrame
    try {
      frame = await this.capture()
    } catch (error) {
      if (before !== undefined) {
        // A failed capture still has a truthful answer: the last good frame is
        // still what the user is looking at.
        return { changed: false, frameId: before.id, capturedAt: before.capturedAt, title: before.title, url: before.url }
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (frame.id === before?.id) {
      return { changed: false, frameId: frame.id, capturedAt: frame.capturedAt, title: frame.title, url: frame.url }
    }
    return { changed: true, frame }
  }

  /**
   * Stop the stream and drop the retained frame.
   *
   * The retained base64 PNG can be several megabytes; releasing it on stop keeps
   * a disabled plugin from pinning that memory.
   * @returns void.
   */
  dispose(): void {
    this.stop()
    this.last = undefined
  }
}
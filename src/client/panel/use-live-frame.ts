/**
 * Live-frame polling for the side-browser panel.
 *
 * The panel cannot embed the host page — DeepSeek, Bing, Baidu and Youdao all
 * refuse to be framed cross-origin — so the panel shows a **live view** of the
 * Host's Chrome window instead, polled from `GET /frame`.
 *
 * Two properties of that route shape this whole module:
 *
 * - **It is change detected.** The Host compares the encoded PNG bytes and, for
 *   an unchanged page, answers `changed: false` with **no payload**. So the
 *   hook must paint only on `changed: true` and otherwise keep the frame it
 *   already has. Repainting on every poll would decode the same megabyte of
 *   PNG twice a second for no visible difference.
 * - **It captures on demand.** Polling is a pull, so a closed sidebar costs the
 *   Host nothing. That is why this hook does not run when the tab is hidden,
 *   and why a visible tab is the only thing that pays for a frame.
 *
 * On top of that the hook enforces two disciplines any polling loop needs: one
 * request in flight at a time (a capture that takes longer than the interval
 * must skip its tick rather than queue), and no state commits after unmount.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostBrowserFrame, SideBrowserApi } from '../api.ts'

/** What the panel needs to render the live view. */
export interface FrameView {
  /** The newest frame, or undefined before the first one arrives. */
  frame: HostBrowserFrame | undefined
  /** Whether a poll is in flight right now. */
  polling: boolean
  /** The last failure, cleared by the next successful poll. */
  error: string | undefined
  /** Force a poll on the next tick instead of waiting out the interval. */
  refresh: () => void
}

/** Interval bounds, matching the settings field that drives them. */
export const MIN_POLL_MS = 1_000
export const MAX_POLL_MS = 10_000

/**
 * Clamp a configured interval into the band the Host's capture loop tolerates.
 * @param seconds - the configured interval in seconds.
 * @returns the interval in milliseconds, clamped.
 */
export function clampPollMs(seconds: number): number {
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : 2_000
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)))
}

/**
 * Turn a base64 PNG payload into an `img` source.
 *
 * The Host deliberately sends bare base64 with no `data:` prefix, because the
 * prefix is constant and would inflate every frame over the wire.
 * @param frame - the frame to render.
 * @returns a `data:` URL.
 */
export function frameSrc(frame: HostBrowserFrame): string {
  return `data:image/png;base64,${frame.data}`
}

/**
 * Poll the Host for live frames and expose the newest one.
 *
 * Inert when `api` is undefined or the view is hidden, so a component can mount
 * before the Host routes exist, and a collapsed sidebar costs nothing.
 * @param api - the route client, or undefined.
 * @param pollMs - poll interval in milliseconds.
 * @param active - whether polling should run.
 * @returns the newest frame and the poll's state.
 */
export function useLiveFrame(
  api: SideBrowserApi | undefined,
  pollMs: number,
  active: boolean,
): FrameView {
  const [frame, setFrame] = useState<HostBrowserFrame | undefined>(undefined)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)
  const frameIdRef = useRef(0)
  const forcedRef = useRef(false)
  const aliveRef = useRef(true)

  // A forced refresh is a one-shot, read and cleared by the poll loop rather
  // than a dependency — restarting the interval on every reload click would
  // drop the cadence the user configured.
  const refresh = useCallback(() => {
    forcedRef.current = true
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (api === undefined || !active) return
    let cancelled = false

    const poll = async (): Promise<void> => {
      forcedRef.current = false
      if (inFlight.current) return
      inFlight.current = true
      setPolling(true)
      try {
        const result = await api.frame()
        if (cancelled || !aliveRef.current) return
        if (!result.ok) {
          setError(result.error)
          return
        }
        setError(undefined)
        if (result.value.changed) {
          // Only a genuinely new frame replaces what is on screen; the frame id
          // guards against a Host that re-sends a frame the client already has.
          if (result.value.frame.id !== frameIdRef.current) {
            frameIdRef.current = result.value.frame.id
            setFrame(result.value.frame)
          }
        }
        // `changed: false` carries no payload and nothing changed: keeping the
        // previous frame is the correct and only answer.
      } finally {
        inFlight.current = false
        if (!cancelled && aliveRef.current) setPolling(false)
      }
    }

    void poll()
    const handle = setInterval(() => { void poll() }, pollMs)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [api, pollMs, active])

  return { frame, polling, error, refresh }
}
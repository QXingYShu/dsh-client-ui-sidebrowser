/**
 * Host-browser snapshot polling for the side-browser panel.
 *
 * Kept separate from the live-frame hook because the two answer different
 * questions and poll on different cadences. `useLiveFrame` needs a short
 * interval to look live; this one needs a long one, because `/state` only
 * changes when the user acts. Merging them would either make the URL bar lag or
 * make the view stutter.
 *
 * It is also refreshed imperatively after every command the panel issues
 * (`refresh()`), so a navigation reflects immediately instead of waiting for
 * the next tick — which is what makes the URL bar feel connected to the page.
 *
 * ## What is read where
 *
 * `/state` reports the *snapshot* (attached, loading, title, url, selected tab)
 * and the Host's shortcut roster, but deliberately no tab list. The tab strip
 * therefore reads `/tabs` separately, through {@link useTabs}, so a strip with
 * many tabs does not force the URL bar to wait on it.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserTab, HostBrowserState, SideBrowserApi } from '../api.ts'

/** The interval between unattended snapshot polls. */
const STATE_POLL_MS = 3_000

/** What the panel renders from. */
export interface BrowserStateView {
  /** The last snapshot read, or undefined before the first one lands. */
  state: HostBrowserState | undefined
  /** The last failure, cleared by the next successful read. */
  error: string | undefined
  /** Whether a read is in flight. */
  loading: boolean
  /** Re-read now, for after a command the panel issued itself. */
  refresh: () => void
}

/**
 * Read and keep the browser's snapshot.
 *
 * Inert without an `api`, so the panel mounts safely before its routes exist.
 * @param api - the route client, or undefined.
 * @param active - whether polling should run.
 * @returns the current snapshot and its refresh control.
 */
export function useBrowserState(
  api: SideBrowserApi | undefined,
  active: boolean,
): BrowserStateView {
  const [state, setState] = useState<HostBrowserState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    void readNow.current()
  }, [])

  // The imperative refresh has to reach the currently running poll loop, which
  // is recreated whenever the api or the cadence changes; a ref keeps the
  // public `refresh` referentially stable across those changes.
  const readNow = useRef<() => void>(() => {})

  useEffect(() => {
    if (api === undefined || !active) return
    let cancelled = false

    const read = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      setLoading(true)
      try {
        const result = await api.state()
        if (cancelled || !aliveRef.current) return
        if (result.ok) {
          setState(result.value)
          setError(undefined)
        } else {
          setError(result.error)
        }
      } finally {
        inFlight.current = false
        if (!cancelled && aliveRef.current) setLoading(false)
      }
    }

    readNow.current = () => { void read() }
    void read()
    const handle = setInterval(() => { void read() }, STATE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
      readNow.current = () => {}
    }
  }, [api, active])

  return { state, error, loading, refresh }
}

/** What the tab strip renders from. */
export interface TabsView {
  /** The tabs, in window order. */
  tabs: readonly BrowserTab[]
  /** The last failure, cleared by the next successful read. */
  error: string | undefined
  /** Re-read now. */
  refresh: () => void
}

/**
 * Read the tab list.
 *
 * A separate read from `/state` because the strip changes only when the user
 * opens, closes or selects a tab — far rarer than the snapshot's title and URL.
 * @param api - the route client, or undefined.
 * @param active - whether polling should run.
 * @returns the current tabs and their refresh control.
 */
export function useTabs(
  api: SideBrowserApi | undefined,
  active: boolean,
): TabsView {
  const [tabs, setTabs] = useState<readonly BrowserTab[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)
  const aliveRef = useRef(true)
  const readNow = useRef<() => void>(() => {})

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    readNow.current()
  }, [])

  useEffect(() => {
    if (api === undefined || !active) return
    let cancelled = false

    const read = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const result = await api.tabs()
        if (cancelled || !aliveRef.current) return
        if (result.ok) {
          setTabs(result.value.tabs)
          setError(undefined)
        } else {
          setError(result.error)
        }
      } finally {
        inFlight.current = false
      }
    }

    readNow.current = () => { void read() }
    void read()
    const handle = setInterval(() => { void read() }, STATE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
      readNow.current = () => {}
    }
  }, [api, active])

  return { tabs, error, refresh }
}
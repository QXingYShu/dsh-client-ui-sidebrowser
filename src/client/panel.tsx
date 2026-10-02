/**
 * The side-browser tab body: a control surface for the Host's Chrome window.
 *
 * ## What this panel is, and why it looks the way it does
 *
 * The user asked for a browser inside the DSH sidebar. A literal embedded
 * webview is impossible here — DeepSeek, Bing, Baidu and Youdao all refuse to
 * be framed cross-origin — so this tab drives a **real Chrome on the host**
 * over CDP and shows it here as a **live view** plus navigation controls.
 *
 * That browser now runs **headless by default**, so nothing pops up in front of
 * the conversation: the page is in this panel and nowhere else. The Host does
 * expose `POST /api/sidebrowser/window`, which brings the real window up for as
 * long as the user wants it — which is how a DeepSeek sign-in is completed by
 * hand — and puts it away again; the sign-in survives because it lives in the
 * profile directory, not in the window.
 *
 * ## Why the page text view exists
 *
 * A screenshot at sidebar width is unreadable for a dense page — a search
 * results list, a documentation page. `/text` returns the page's readable
 * text, which makes those pages usable from the sidebar. It is also the route
 * the agent's tools use, so what the user reads here and what the model reads
 * are guaranteed to be the same content.
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SideBrowserApi } from './api.ts'
import css from './sidebrowser.module.css'
import { t } from './locales.ts'
import { clampPollMs, frameSrc, useLiveFrame } from './panel/use-live-frame.ts'
import { useBrowserState, useTabs } from './panel/use-browser-state.ts'
import { builtInShortcuts, type ShortcutEntry } from './shortcuts.ts'

/** Props the tab seat injects into the body. */
export interface SideBrowserPanelProps {
  /** Route client; shared across bodies so remounts do not restart polls. */
  api: SideBrowserApi
  /** Configured capture interval, in seconds. */
  pollIntervalSeconds: number
  /** Extra shortcuts the user configured in the settings card. */
  extraShortcuts: readonly ShortcutEntry[]
  /** Whether the column is currently showing this tab. */
  visible: boolean
  /**
   * The tab's lifetime signal. Aborted when the record disappears or the
   * plugin unloads — NOT on hide — so every long-lived subscription this panel
   * starts is hung on it rather than on visibility.
   */
  signal: AbortSignal
  /**
   * Offer this page's own refresh in the tab's actions menu.
   * @returns disposer.
   */
  bindCommands: (commands: { refresh?: () => void }) => () => void
}

/**
 * Turn a typed or pasted address into something the Host can navigate to.
 *
 * The bar accepts a bare query the way a browser's does: text with no scheme
 * becomes a search rather than a failed navigation, because that is what a user
 * typing "what is CDP" into this field means.
 * @param raw - the field's contents.
 * @returns the URL to navigate to.
 */
export function resolveAddress(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  // localhost BEFORE the scheme test: `localhost:3000` matches
  // `^[a-z][a-z0-9+.-]*:` and would otherwise be taken for a URL whose scheme
  // is "localhost", passed through untouched, and refused by the Host as a
  // non-http scheme. A dev server is what the user meant.
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  // A dotted, space-free token that looks like a host:example.tld:port/path.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(trimmed)) return `https://${trimmed}`
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`
}

/** Format an ISO capture timestamp as a local wall-clock time. */
function formatClock(iso: string): string {
  if (iso === '') return ''
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

/**
 * The side-browser tab body.
 *
 * @param props - the injected face and the tab lifetime signal.
 * @returns the panel.
 */
export function SideBrowserPanel(props: SideBrowserPanelProps): React.ReactElement {
  const { api, signal, bindCommands, visible } = props
  const pollMs = clampPollMs(props.pollIntervalSeconds)
  const browser = useBrowserState(api, visible)
  const tabStrip = useTabs(api, visible)
  // Polling only while the column shows this tab is what makes a closed sidebar
  // free: the Host's `/frame` route is a pull, so nobody asks, nobody captures.
  const live = useLiveFrame(api, pollMs, visible)

  const [urlDraft, setUrlDraft] = useState('')
  const [commandError, setCommandError] = useState<string | undefined>(undefined)
  const [textOpen, setTextOpen] = useState(false)
  const [pageText, setPageText] = useState<string | undefined>(undefined)
  const [textTruncated, setTextTruncated] = useState(false)
  const [textLoading, setTextLoading] = useState(false)
  const [textError, setTextError] = useState<string | undefined>(undefined)
  const [addressDraft, setAddressDraft] = useState('')

  // The URL field follows the page, but only while the user is not editing it:
  // overwriting the field mid-keystroke is the classic way to make an address
  // bar feel broken.
  const editingRef = useRef(false)
  useEffect(() => {
    if (!editingRef.current) setUrlDraft(browser.state?.url ?? '')
  }, [browser.state?.url])

  const loadPageText = useCallback(async (): Promise<void> => {
    setTextLoading(true)
    setTextError(undefined)
    const result = await api.text({ maxChars: 20_000 })
    setTextLoading(false)
    if (result.ok) {
      setPageText(result.value.text)
      setTextTruncated(result.value.truncated)
    } else {
      setPageText(undefined)
      setTextTruncated(false)
      setTextError(result.error)
    }
  }, [api])

  // The tab's own refresh action re-reads the snapshot and forces a new frame.
  useEffect(() => bindCommands({
    refresh: () => {
      browser.refresh()
      tabStrip.refresh()
      live.refresh()
      void loadPageText()
    },
  }), [bindCommands, browser.refresh, tabStrip.refresh, live.refresh, loadPageText])

  // The tab's lifetime ends when the record disappears; nothing to clean up here
  // beyond clearing the error state, but the subscription keeps this panel's
  // contract with the shell explicit and gives a future async holder a place to
  // hang its teardown.
  useEffect(() => {
    const onAbort = (): void => { setCommandError(undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => { signal.removeEventListener('abort', onAbort) }
  }, [signal])

  /**
   * Run one Host command, then re-read the state so the URL bar and tab strip
   * agree with what the Host actually did.
   * @param command - the route call to issue.
   */
  const run = useCallback(async (
    command: Promise<{ ok: boolean; error?: string }>,
  ): Promise<void> => {
    const result = await command
    setCommandError(result.ok ? undefined : result.error)
    browser.refresh()
    tabStrip.refresh()
    live.refresh()
  }, [browser.refresh, tabStrip.refresh, live.refresh])

  const navigate = useCallback((value: string): void => {
    const address = resolveAddress(value)
    if (address === '') return
    setUrlDraft(address)
    void run(api.navigate(address))
  }, [api, run])

  const shortcuts = useMemo(
    () => [...builtInShortcuts, ...props.extraShortcuts],
    [props.extraShortcuts],
  )

  const phase = browser.state?.phase ?? 'starting'
  const ready = phase === 'ready' || phase === 'starting'
  const phaseText = phase === 'ready'
    ? t('panel.connection.ready')
    : phase === 'starting'
      ? t('panel.connection.connecting')
      : t('panel.connection.unavailable')
  const shownError = commandError ?? tabStrip.error ?? live.error
  const selectedTab = tabStrip.tabs.find(tab => tab.selected)

  return (
    <div className={css.root} data-dsh-sidebrowser-panel="">
      <div className={css.topBar}>
        <button
          type="button"
          className={css.iconButton}
          title={t('panel.nav.back')}
          aria-label={t('panel.nav.back')}
          disabled={!ready || selectedTab === undefined}
          onClick={() => { void run(api.back()) }}
        >
          {'←'}
        </button>
        <button
          type="button"
          className={css.iconButton}
          title={t('panel.nav.forward')}
          aria-label={t('panel.nav.forward')}
          disabled={!ready || selectedTab === undefined}
          onClick={() => { void run(api.forward()) }}
        >
          {'→'}
        </button>
        <button
          type="button"
          className={css.iconButton}
          title={t('panel.nav.reload')}
          aria-label={t('panel.nav.reload')}
          disabled={!ready}
          onClick={() => { void run(api.reload(undefined, true)) }}
        >
          {'⟳'}
        </button>
        <input
          className={css.urlBar}
          value={urlDraft}
          placeholder={t('panel.url.placeholder')}
          aria-label={t('panel.url.placeholder')}
          spellCheck={false}
          onFocus={() => { editingRef.current = true }}
          onChange={event => { setUrlDraft(event.target.value) }}
          onBlur={() => { editingRef.current = false }}
          onKeyDown={event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            editingRef.current = false
            navigate(urlDraft)
          }}
        />
      </div>

      <div className={css.statusLine} data-tone={shownError !== undefined ? 'error' : undefined}>
        <span className={css.statusDot} data-phase={phase} />
        <span className={css.statusText}>{shownError ?? phaseText}</span>
      </div>

      {textOpen ? (
        <pre className={css.textView}>
          {textLoading
            ? t('panel.text.loading')
            : textError !== undefined
              ? t('panel.text.failed', { error: textError })
              : pageText === undefined || pageText.trim() === ''
                ? t('panel.text.empty')
                : textTruncated ? `${pageText}\n\n…` : pageText}
        </pre>
      ) : (
        <div className={css.viewport}>
          {live.frame === undefined
            ? <p className={css.viewportPlaceholder}>{phaseText}</p>
            : <img className={css.frame} src={frameSrc(live.frame)} alt={t('panel.screenshot.alt')} />}
        </div>
      )}

      {/* The one honest thing the panel can say about the host window: it is a
          real window on the user's desktop, and there is no route that brings
          it to the front, so no button pretending otherwise is offered. */}
      <p className={css.hint}>{t('panel.hint')}</p>

      <div className={css.tabStrip} role="tablist" aria-label={t('panel.tabs.title')}>
        {tabStrip.tabs.map(tab => (
          <span
            key={tab.id}
            className={css.tabChip}
            data-active={tab.selected ? 'true' : 'false'}
            role="tab"
            aria-selected={tab.selected}
            title={tab.url === '' ? tab.title : `${tab.title || tab.url}\n${tab.url}`}
          >
            <button
              type="button"
              className={css.tabChipLabel}
              style={{ all: 'unset', cursor: 'pointer' }}
              onClick={() => { void run(api.selectTab(tab.id)) }}
            >
              {tab.title === '' ? tab.url : tab.title}
            </button>
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('panel.tabs.close', { title: tab.title || tab.url })}
              onClick={() => { void run(api.closeTab(tab.id)) }}
            >
              {'×'}
            </button>
          </span>
        ))}
        <button
          type="button"
          className={css.textButton}
          disabled={!ready}
          onClick={() => { void run(api.openTab('about:blank')) }}
        >
          + {t('panel.tabs.new')}
        </button>
      </div>

      {ready && tabStrip.tabs.length === 0 && <span className={css.hint}>{t('panel.tabs.empty')}</span>}

      <div className={css.shortcuts}>
        {shortcuts.map(entry => (
          <button
            key={entry.url}
            type="button"
            className={css.shortcutButton}
            title={entry.url}
            disabled={!ready}
            onClick={() => navigate(entry.url)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <form
        className={css.shortcutForm}
        onSubmit={event => {
          event.preventDefault()
          const address = resolveAddress(addressDraft)
          if (address !== '') {
            navigate(address)
            setAddressDraft('')
          }
        }}
      >
        <input
          className={css.shortcutInput}
          value={addressDraft}
          placeholder={t('panel.shortcuts.add')}
          aria-label={t('panel.shortcuts.add')}
          onChange={event => { setAddressDraft(event.target.value) }}
        />
        <button
          type="button"
          className={css.textButton}
          onClick={() => {
            if (!textOpen) {
              setTextOpen(true)
              void loadPageText()
              return
            }
            setTextOpen(false)
          }}
        >
          {t('panel.text.toggle')}
        </button>
        {textOpen && (
          <button
            type="button"
            className={css.textButton}
            disabled={textLoading}
            onClick={() => { void loadPageText() }}
          >
            {t('panel.text.refresh')}
          </button>
        )}
      </form>

      {browser.loading && phase === 'starting' && (
        <span className={css.hint}>{t('panel.connection.connecting')}</span>
      )}
    </div>
  )
}
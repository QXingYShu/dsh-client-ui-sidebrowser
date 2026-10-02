/**
 * The selection mini-popup: AI解释 / 翻译 / 复制, next to what you selected.
 *
 * ## Why it renders as a plain element, not a portal
 *
 * The popup must appear over the conversation regardless of what the shell's own
 * stacking and overflow contexts do to the selection's ancestors — the
 * conversation scrolls inside its own column with `overflow: auto`, so a popup
 * rendered inside that tree would be clipped by it. Escaping those contexts is
 * the job of `SelectionHost`, which mounts this subtree in a React root
 * appended to `document.body`; from inside that root an ordinary render already
 * sits at body level, so `position: fixed` places it in the viewport
 * coordinates `positionPopup` computes. Using `createPortal` here would have
 * imported `react-dom`, which the GUI's module loader does not resolve for a
 * plugin half (and whose inlined copy reads `process.env`, which a browser does
 * not define).
 *
 * ## Why AI解释 goes through the DeepSeek web page
 *
 * The user asked for their DeepSeek web session specifically, not an API key:
 * their login, their quota, their existing conversation. So "AI解释" drives the
 * host's Chrome to `chat.deepseek.com`, types the prompt, and reads the answer
 * back — see {@link askDeepSeekWeb} for the sequence and its failure modes.
 * Every failure there is reported here as one honest sentence, because the
 * difference between "DeepSeek said this" and "I could not reach DeepSeek" is
 * exactly the difference the user needs to see.
 *
 * @module
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SideBrowserApi } from './api.ts'
import css from './sidebrowser.module.css'
import { OWN_SURFACE_ATTRIBUTE, copyToClipboard, positionPopup, type DetectedSelection } from './selection.ts'
import { askDeepSeekWeb, buildExplainPrompt, engineForSelection, translateSelection, type BridgeStage, type TranslationEngine } from './deepseek-web.ts'
import { t } from './locales.ts'

/** Props the popup renders from. */
export interface SelectionPopupProps {
  /** The selection the popup is acting on. */
  selection: DetectedSelection
  /** Route client for the host browser. */
  api: SideBrowserApi
  /** Engine to force, or undefined to let the selection decide (word vs sentence). */
  engine: TranslationEngine | undefined
  /** Target language code the engine understands. */
  targetLanguage: string
  /** How long to wait for DeepSeek's answer. */
  answerTimeoutMs: number
  /** Dismiss the popup. */
  onClose: () => void
}

/** What the popup is doing right now. */
type PopupActivity =
  | { kind: 'idle' }
  | { kind: 'explaining'; stage: string }
  | { kind: 'translating'; stage: string }

/** The popup's rendered result area, once an action has produced text. */
interface PopupResult {
  /** Whether the text is an explanation or a translation. */
  kind: 'explanation' | 'translation'
  /** The text to show. */
  text: string
}

/**
 * Render the mini-popup beside a selection.
 *
 * Every long-lived effect is hung on unmount or on the selection changing, and
 * every asynchronous action checks a liveness ref before committing state, so
 * dismissing the popup mid-request cannot produce a React state update on an
 * unmounted tree.
 * @param props - the selection, the route client, and the dismiss callback.
 * @returns the portal.
 */
export function SelectionPopup(props: SelectionPopupProps): React.ReactElement | null {
  const { selection, api, onClose } = props
  const [activity, setActivity] = useState<PopupActivity>({ kind: 'idle' })
  const [result, setResult] = useState<PopupResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [warning, setWarning] = useState<string | undefined>(undefined)
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const [placement, setPlacement] = useState<{ left: number; top: number } | undefined>(undefined)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Re-measure after every content change, because the box's height depends on
  // whether a result is showing — and a box that overflows the viewport is
  // worse than one that is slightly mis-positioned.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const next = positionPopup(selection.rect, box.offsetWidth, box.offsetHeight)
    setPlacement(current => (
      current !== undefined && current.left === next.left && current.top === next.top
        ? current
        : next
    ))
  }, [selection, result, activity, error, warning])

  // Escape and an outside click dismiss; the buttons themselves are inside the
  // box, so a click on one never reaches this document-level handler.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: PointerEvent): void => {
      const box = boxRef.current
      if (box === null) return
      const target = event.target
      if (target instanceof Node && box.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    // `pointerdown` rather than `click`: a click fires after mouseup, which is
    // too late — the browser has already moved the caret and cleared the
    // selection by then.
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [onClose])

  const explain = useCallback(async (): Promise<void> => {
    setActivity({ kind: 'explaining', stage: t('dsweb.opening') })
    setError(undefined)
    setWarning(undefined)
    const outcome = await askDeepSeekWeb(
      buildExplainPrompt(selection.text, selection.kind),
      api,
      {
        timeoutMs: props.answerTimeoutMs,
        onProgress: stage => {
          if (!aliveRef.current) return
          setActivity({ kind: 'explaining', stage: stageLabel(stage) })
        },
      },
    )
    if (!aliveRef.current) return
    if (outcome.kind === 'answer') {
      setResult({ kind: 'explanation', text: outcome.text })
      setActivity({ kind: 'idle' })
      return
    }
    setActivity({ kind: 'idle' })
    // A failure here is always actionable, and each kind has its own sentence:
    // "log in" and "the page changed" are different problems for the user.
    setError(outcome.kind === 'host-error'
      ? t('popup.error.host', { error: outcome.reason })
      : outcome.kind === 'timeout'
        ? t('dsweb.timeout', { seconds: String(Math.round(props.answerTimeoutMs / 1000)) })
        : t('dsweb.unavailable'))
    if (outcome.kind === 'login-required') setWarning(t('dsweb.loginRequired'))
    if (outcome.kind === 'composer-missing') setWarning(t('dsweb.composerMissing'))
  }, [api, props.answerTimeoutMs, selection.kind, selection.text])

  const translate = useCallback(async (): Promise<void> => {
    // Resolve the engine here rather than inside translateSelection, so the
    // status line can name the site actually being used. With the setting on
    // `auto` that is 有道 for a single word and Bing for a sentence.
    const engine = engineForSelection(selection.text, props.engine)
    setActivity({ kind: 'translating', stage: t('translate.opening', { engine: engine.name }) })
    setError(undefined)
    setWarning(undefined)
    const outcome = await translateSelection(selection.text, api, {
      engine,
      target: props.targetLanguage,
      timeoutMs: 15_000,
      onProgress: (stage, detail) => {
        if (!aliveRef.current) return
        const stage1 = stageLabel(stage)
        setActivity({
          kind: 'translating',
          stage: detail === undefined ? stage1 : t('translate.opening', { engine: detail }) + stage1,
        })
      },
    })
    if (!aliveRef.current) return
    setActivity({ kind: 'idle' })
    switch (outcome.kind) {
      case 'translated':
        setResult({ kind: 'translation', text: outcome.text })
        return
      case 'opened':
        // The site is on screen in the sidebar browser and the Host's `/text`
        // route reads whole pages rather than one element, so there is nothing
        // to extract here. Say plainly where the result is, and — when a
        // fallback was tried and failed — say why, rather than showing an
        // empty result box that looks like an empty translation.
        setWarning(outcome.note === undefined
          ? t('translate.siteResult', { engine: engine.name })
          : t('translate.fallbackUsed', { engine: engine.name }))
        return
      case 'host-error':
        setError(t('translate.failed', { error: outcome.reason }))
        return
      default:
        setError(t('dsweb.unavailable'))
    }
  }, [api, props.engine, props.targetLanguage, selection.text])

  const copy = useCallback(async (): Promise<void> => {
    const ok = await copyToClipboard(selection.text)
    if (!aliveRef.current) return
    setCopied(ok)
    if (ok) {
      setTimeout(() => {
        if (aliveRef.current) setCopied(false)
      }, 1_500)
    }
  }, [selection.text])

  const busy = activity.kind !== 'idle'
  const style = placement === undefined
    ? { visibility: 'hidden' as const }
    : { left: `${placement.left}px`, top: `${placement.top}px` }

  return (
    <div className={css.popupLayer} {...{ [OWN_SURFACE_ATTRIBUTE]: '' }}>
      <div
        ref={boxRef}
        className={css.popup}
        role="dialog"
        aria-label={selection.kind === 'word' ? t('popup.wordHint') : t('popup.sentenceHint')}
        style={style}
      >
        <div className={css.popupRow}>
          <span className={css.popupSelection} title={selection.text}>{selection.text}</span>
        </div>
        <div className={css.popupRow}>
          <button
            type="button"
            className={`${css.popupAction} ${css.popupPrimary}`}
            disabled={busy}
            onClick={() => { void explain() }}
          >
            {t('popup.explain')}
          </button>
          <button
            type="button"
            className={css.popupAction}
            disabled={busy}
            onClick={() => { void translate() }}
          >
            {t('popup.translate')}
          </button>
          <button type="button" className={css.popupAction} onClick={() => { void copy() }}>
            {copied ? t('popup.copied') : t('popup.copy')}
          </button>
          <button
            type="button"
            className={css.popupAction}
            aria-label={t('popup.close')}
            onClick={onClose}
          >
            {'×'}
          </button>
        </div>
        {busy && <span className={css.popupStatus}>{activity.stage || t('popup.working')}</span>}
        {error !== undefined && <span className={css.popupError}>{error}</span>}
        {warning !== undefined && <span className={css.popupWarning}>{warning}</span>}
        {result !== undefined && (
          <>
            <div className={css.popupRow}>
              <button
                type="button"
                className={css.popupAction}
                onClick={() => { setExpanded(value => !value) }}
              >
                {expanded ? t('popup.collapse') : t('popup.expand')}
              </button>
              <span className={css.popupStatus}>{t('popup.result.label')}</span>
            </div>
            {expanded && <pre className={css.popupResult}>{result.text}</pre>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A short human label for a bridge progress stage.
 * @param stage - the stage reported by {@link askDeepSeekWeb}.
 * @returns its localized label.
 */
function stageLabel(stage: BridgeStage): string {
  switch (stage) {
    case 'opening':
      return t('dsweb.opening')
    case 'typing':
    case 'waiting':
      return t('dsweb.submitted')
    case 'reading':
      return t('dsweb.answer')
  }
}
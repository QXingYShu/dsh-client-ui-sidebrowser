/**
 * The popup host: the document-level listener that decides when to show it.
 *
 * This is deliberately plain DOM rather than a React component. It has to
 * attach to `mouseup` on the whole document and act before the shell's own
 * handlers can, which a React tree inside the shell's root cannot do
 * reliably. It renders exactly one React subtree — the popup — through a portal
 * and leaves the rest of the app untouched.
 *
 * @module
 */

import { useEffect, useState } from 'react'
import { SelectionPopup } from './selection-popup.tsx'
import { detectSelection, OWN_SURFACE_ATTRIBUTE, type DetectedSelection } from './selection.ts'
import type { SideBrowserApi } from './api.ts'
import type { TranslationEngine } from './deepseek-web.ts'

/** How long after a mouseup the selection is read. */
const SETTLE_MS = 0

/** Props the popup host renders from. */
export interface SelectionHostProps {
  /** Whether the feature is enabled by the user's settings. */
  enabled: boolean
  /** Route client, or undefined while the Host routes are unavailable. */
  api: SideBrowserApi | undefined
  /** Engine to force, or undefined to let the selection decide (word vs sentence). */
  engine: TranslationEngine | undefined
  /** Target language code. */
  targetLanguage: string
  /** How long to wait for a DeepSeek answer. */
  answerTimeoutMs: number
}

/**
 * Listen for conversation selections and render the popup for one at a time.
 *
 * Only one popup exists at a time by construction: selecting something else
 * replaces it. That matches how the gesture works — a user who re-selects has
 * moved on.
 * @param props - the feature toggle and the dependencies the popup needs.
 * @returns the popup subtree, or nothing when there is no selection.
 */
export function SelectionHost(props: SelectionHostProps): React.ReactElement | null {
  const [selection, setSelection] = useState<DetectedSelection | undefined>(undefined)
  const { enabled, api } = props

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      setSelection(undefined)
      return
    }

    const onMouseUp = (event: MouseEvent): void => {
      // Read after the browser has settled the selection: `mouseup` is the
      // first event at which the range is final for the current gesture.
      const handle = setTimeout(() => {
        setSelection(detectSelection(event))
      }, SETTLE_MS)
      document.addEventListener('mouseup', clear, { once: true })
      function clear(): void {
        clearTimeout(handle)
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      // Shift+arrow selection never fires a mouseup at all, so keyboard users
      // get the same affordance by watching the key that ends a selection.
      if (event.shiftKey && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')) {
        setSelection(detectSelection(event))
      }
    }

    const onPointerDown = (event: Event): void => {
      // A press INSIDE the popup is the user reaching for one of its buttons, not
      // the start of a new selection. Clearing unconditionally would unmount the
      // popup: `pointerdown`, `mouseup` and `click` are three separate tasks, and
      // React flushes the unmount in a microtask at the end of the first one — so
      // the button node is detached before the click is dispatched, and React 18's
      // root-delegated `onClick` never fires. Every action in the popup would be
      // dead on arrival.
      const target = event.target
      if (target instanceof Element && target.closest(`[${OWN_SURFACE_ATTRIBUTE}]`) !== null) return
      // Any other fresh press means the user is doing something else.
      setSelection(undefined)
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [enabled])

  if (!enabled || api === undefined || selection === undefined) return null

  return (
    <SelectionPopup
      selection={selection}
      api={api}
      engine={props.engine}
      targetLanguage={props.targetLanguage}
      answerTimeoutMs={props.answerTimeoutMs}
      onClose={() => { setSelection(undefined) }}
    />
  )
}
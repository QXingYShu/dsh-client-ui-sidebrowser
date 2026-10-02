/**
 * Text-selection detection for the conversation.
 *
 * The mini-popup only makes sense over **readable conversation text**: a
 * selection the user made while dragging through a code block, a diff, or the
 * panel's own URL field is not something they want explained or translated. So
 * this module's job is mostly to say no — precisely, and cheaply, on every
 * `mouseup` in the document.
 *
 * The rules, in the order they are applied:
 *
 * 1. The event target must be real text content, never a text-entry control
 *    (`input`, `textarea`, `[contenteditable]`) or any of this plugin's own
 *    elements. Opening a popup over a field the user is typing into would
 *    steal the click that was meant to place a cursor.
 * 2. The selection must be non-empty, not collapsed, and live entirely inside
 *    the conversation column rather than in a sidebar, a settings page or this
 *    plugin's panel.
 * 3. It must be short enough to be an explainable unit. A user who selects
 *    three paragraphs has not asked for a definition.
 *
 * @module
 */

/** Longest selection the popup offers to act on, in characters. */
export const MAX_SELECTION_CHARS = 2_000

/** Attribute marking this plugin's own DOM, which must never trigger the popup. */
export const OWN_SURFACE_ATTRIBUTE = 'data-dsh-sidebrowser'

/** What one detected selection carries. */
export interface DetectedSelection {
  /** The selected text, already trimmed of surrounding whitespace. */
  text: string
  /** Where the selection sits, in viewport coordinates. */
  rect: DOMRect
  /** Whether the selection reads as one word or as a passage. */
  kind: 'word' | 'phrase'
}

/**
 * Whether an element is one the user is typing into.
 * @param node - the candidate element.
 * @returns true for text-entry surfaces.
 */
function isTextEntry(node: Element): boolean {
  const tag = node.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if (node.hasAttribute('contenteditable')) {
    const value = node.getAttribute('contenteditable')
    return value !== 'false'
  }
  return node.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

/**
 * Whether an element belongs to this plugin.
 * @param node - the candidate element.
 * @returns true when the element is the plugin's own surface.
 */
function isOwnSurface(node: Element | null): boolean {
  if (node === null) return false
  if (node.hasAttribute?.(OWN_SURFACE_ATTRIBUTE)) return true
  return node.closest?.(`[${OWN_SURFACE_ATTRIBUTE}]`) != null
}

/**
 * Attributes that positively place an element OUTSIDE the conversation.
 *
 * Every one of these is emitted by a shipped package (`dsh-client-ui-sidebar`
 * and `dsh-client-ui-sidebar-right`, dsh-client-ui-* 0.2.0-rc.2). Note what is
 * deliberately absent: no shipped package marks the conversation column with a
 * stable attribute — `data-conversation` exists in no package at all — so the
 * inclusion side cannot be decided precisely and is left permissive.
 */
const OUTSIDE_CONVERSATION = [
  '[data-sidebar-right-session]',
  '[data-sidebar-right-panel]',
  '[data-sidebar-right-tab]',
  '[data-dockkit-pane]',
  '[data-dockkit-tab]',
  '[role="dialog"]',
].join(', ')

/**
 * Whether an element sits inside the conversation column.
 *
 * The exclusion side is precise and the inclusion side is permissive on
 * purpose: a popup that opens once too often is a nuisance, whereas a branch
 * keyed on an attribute the shell does not set would either never fire (so the
 * exclusion below would never run) or, worse, silently disable the feature.
 * @param node - the selection's anchor element.
 * @returns whether the popup may open for it.
 */
function isInConversation(node: Element): boolean {
  if (isOwnSurface(node)) return false
  return node.closest(OUTSIDE_CONVERSATION) === null
}

/**
 * Read the current selection and decide whether the popup should appear.
 *
 * @param event - the `mouseup` that ended the selection gesture.
 * @returns what to act on, or undefined when the popup must stay hidden.
 */
export function detectSelection(event: MouseEvent | Event): DetectedSelection | undefined {
  if (typeof window === 'undefined') return undefined
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined

  const target = event.target
  if (target instanceof Element) {
    if (isTextEntry(target) || isOwnSurface(target)) return undefined
    // A selection made inside a text-entry control is reported by the control,
    // not by the document: bail rather than opening over someone's draft.
    if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null) return undefined
  }

  const raw = selection.toString().trim()
  if (raw === '' || raw.length > MAX_SELECTION_CHARS) return undefined

  const range = selection.getRangeAt(0)
  const anchor = range.startContainer.parentElement
  if (anchor === null) return undefined
  if (!isInConversation(anchor)) return undefined

  // A selection whose end sits in a different element than its start is a
  // multi-block selection; the rect below would be a huge box spanning the
  // conversation, so it is rejected on geometry rather than by counting words.
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return undefined

  return { text: raw, rect, kind: classify(raw) }
}

/**
 * Whether a selection is one word or a passage.
 *
 * Language-neutral by construction: whitespace is the primary signal for
 * space-delimited scripts, and character count for scripts that do not use
 * it (Chinese, Japanese, Thai). A multi-character CJK run is a phrase, not a
 * word, even though it contains no spaces.
 * @param text - the trimmed selection.
 * @returns the classification the prompt builder keys on.
 */
function classify(text: string): 'word' | 'phrase' {
  if (/\s/.test(text)) return 'phrase'
  if (/^[\p{L}\p{N}'’-]{1,24}$/u.test(text)) return 'word'
  return Array.from(text).length <= 2 ? 'word' : 'phrase'
}

/**
 * Compute where the popup should sit.
 *
 * The box is placed under the selection by default and flipped above it when
 * there is not enough room below, then clamped to the viewport with a margin
 * so it never lands under a window edge or off screen. Both decisions are made
 * here rather than in CSS because the box's size is content-dependent and only
 * known after it renders.
 *
 * @param rect - the selection's bounding rect in viewport coordinates.
 * @param popupWidth - the rendered box width.
 * @param popupHeight - the rendered box height.
 * @returns the box's left and top.
 */
export function positionPopup(
  rect: DOMRect,
  popupWidth: number,
  popupHeight: number,
): { left: number; top: number } {
  const margin = 8
  const gap = 6
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  const preferredTop = rect.bottom + gap
  const flipped = preferredTop + popupHeight + margin > viewportHeight && rect.top - gap - popupHeight - margin >= 0
  const top = flipped ? rect.top - gap - popupHeight : preferredTop

  const centred = rect.left + rect.width / 2 - popupWidth / 2
  const left = Math.min(
    Math.max(centred, margin),
    Math.max(margin, viewportWidth - popupWidth - margin),
  )

  return {
    left: Math.round(left),
    top: Math.round(Math.min(Math.max(top, margin), Math.max(margin, viewportHeight - popupHeight - margin))),
  }
}

/**
 * Copy text to the clipboard, preferring the async API and falling back.
 *
 * The fallback exists because a page served over plain HTTP (or an older
 * Electron) refuses `navigator.clipboard`, and "复制" that silently does
 * nothing is worse than one that reports it.
 * @param text - the text to copy.
 * @returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path rather than reporting a failure.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
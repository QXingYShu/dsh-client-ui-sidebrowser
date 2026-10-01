// @vitest-environment jsdom
/**
 * Tests for selection detection and popup placement.
 *
 * The selection popup is the part of this plugin the user touches most, and its
 * failure modes are all "it appeared when it should not have" or "it appeared
 * off-screen": a popup over a field someone is typing into steals their click,
 * and a popup clamped to the wrong edge is invisible. Both are pure geometry and
 * DOM membership, so both are tested directly here.
 *
 * jsdom is requested per-file with a docblock rather than through a global
 * `environment: 'jsdom'` config: only this file needs a DOM, and keeping the
 * other files on the default node environment means importing
 * `src/index.ts` (which pulls the whole Host half) does not drag a DOM in.
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  copyToClipboard,
  detectSelection,
  MAX_SELECTION_CHARS,
  OWN_SURFACE_ATTRIBUTE,
  positionPopup,
} from '../src/client/selection.ts'
import { classifySelection } from '../src/client/deepseek-web.ts'

/** Build a rect with sensible defaults so each test states only the interesting edge. */
function rect(overrides: Partial<{ top: number, left: number, width: number, height: number, bottom: number, right: number }> = {}): DOMRect {
  const top = overrides.top ?? 100
  const left = overrides.left ?? 100
  const width = overrides.width ?? 200
  const height = overrides.height ?? 20
  const value = {
    top,
    left,
    width,
    height,
    bottom: overrides.bottom ?? top + height,
    right: overrides.right ?? left + width,
  }
  return { ...value, x: left, y: top, toJSON: () => value } as DOMRect
}

/** Set the viewport size `positionPopup` reads from `window`. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

/** Append markup and return its root element. */
function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

/**
 * Select the text of an element and fire the `mouseup` that ends the gesture.
 *
 * jsdom has no layout engine, so `Range.getBoundingClientRect` is absent and is
 * stubbed here with a fixed non-empty rect — the only geometry `detectSelection`
 * reads. Without this the zero-size guard would reject every selection and the
 * "it should have detected" cases could not be expressed at all.
 */
function selectText(target: Element, rectOverride: DOMRect = rect()): Event {
  const range = document.createRange()
  range.selectNodeContents(target)
  // `parentElement` is what `detectSelection` reads the anchor from, and the
  // text node inside it is what the range must start in.
  range.setStart(target.firstChild ?? target, 0)
  range.setEnd(target.firstChild ?? target, (target.textContent ?? '').length)
  Object.defineProperty(range, 'getBoundingClientRect', { value: () => rectOverride, configurable: true })
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  const event = new MouseEvent('mouseup', { bubbles: true })
  Object.defineProperty(event, 'target', { value: target, configurable: true })
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  setViewport(1024, 768)
})

describe('popup placement', () => {
  it('places the box under the selection with a gap when there is room', () => {
    // The common case: the popup opens below the words the user selected, not
    // over them, so the text they are reading stays visible.
    setViewport(1200, 800)
    const placed = positionPopup(rect({ top: 100, height: 20 }), 180, 40)
    expect(placed.top).toBe(126)
    expect(placed.left).toBe(110)
  })

  it('centres horizontally on the selection', () => {
    // A box far from the selection is the "what does this refer to?" bug; the
    // centre of the box must land on the centre of the highlighted words.
    setViewport(1200, 800)
    const placed = positionPopup(rect({ left: 500, width: 100 }), 200, 40)
    expect(placed.left).toBe(450)
  })

  it('flips above the selection when there is no room below', () => {
    // A selection at the very bottom of the viewport would otherwise push the
    // popup off-screen, making the feature unreachable exactly where a user is
    // most likely to select text (the last line of an answer).
    setViewport(1200, 800)
    const placed = positionPopup(rect({ top: 770, height: 20 }), 180, 40)
    expect(placed.top).toBe(770 - 6 - 40)
    expect(placed.top).toBeGreaterThanOrEqual(0)
  })

  it('clamps to the left margin instead of overflowing a narrow viewport', () => {
    // A selection hugging the left edge would centre the box at a negative x
    // and hide it outside the window.
    setViewport(1200, 800)
    const placed = positionPopup(rect({ left: 0, width: 20 }), 180, 40)
    expect(placed.left).toBe(8)
  })

  it('clamps to the right margin instead of overflowing past the window', () => {
    // The mirror of the left-edge case: a selection at the right edge must not
    // push the popup past the window's inner edge.
    setViewport(600, 800)
    const placed = positionPopup(rect({ left: 560, width: 30 }), 180, 40)
    expect(placed.left).toBe(600 - 180 - 8)
  })

  it('keeps a box taller than the viewport on screen rather than at a negative top', () => {
    // A degenerate rendering (a tall translated-text box) must not produce a
    // negative `top`, which would place the popup outside the document.
    setViewport(400, 300)
    const placed = positionPopup(rect({ top: 0, height: 10 }), 200, 900)
    expect(placed.top).toBeGreaterThanOrEqual(0)
    expect(placed.left).toBeGreaterThanOrEqual(0)
  })

  it('returns whole pixels, because the popup is positioned absolutely', () => {
    // Fractional `left`/`top` make the box sit on a half pixel and render
    // blurry on fractional-DPI displays; rounding at the source is cheaper than
    // compensating in CSS.
    setViewport(1200, 800)
    const placed = positionPopup(rect({ left: 100.4, top: 100.6 }), 180.5, 40.25)
    expect(Number.isInteger(placed.left)).toBe(true)
    expect(Number.isInteger(placed.top)).toBe(true)
  })
})

describe('selection classification', () => {
  it('treats a Latin token without whitespace as a word', () => {
    // The word path asks for meaning and an example sentence; a passage path
    // would ask the wrong question of a single word.
    expect(classifySelection('ephemeral')).toBe('word')
    expect(classifySelection("don't")).toBe('word')
    expect(classifySelection('co-operate')).toBe('word')
  })

  it('treats whitespace-bearing text as a passage in either script', () => {
    // Chinese and English both use the space as the primary passage signal, so
    // the two scripts must not diverge on it.
    expect(classifySelection('ephemeral means short-lived')).toBe('phrase')
    expect(classifySelection('你好 世界')).toBe('phrase')
    expect(classifySelection('can not')).toBe('phrase')
  })

  it('treats a short space-less CJK run as a word', () => {
    // Chinese has no spaces, so "no whitespace" alone would call a whole phrase
    // a word; the short-run rule is what keeps 翻译 out of the passage prompt,
    // which would ask DeepSeek to explain it line by line.
    expect(classifySelection('你好')).toBe('word')
    expect(classifySelection('翻译')).toBe('word')
    expect(classifySelection('光合作用')).toBe('word')
  })

  it('treats a long space-less CJK passage as a phrase', () => {
    // classifySelection used to test /^[\p{L}\p{N}'’-]{1,24}$/u first, whose \p{L}
    // covers Han, so every space-less Chinese run up to 24 characters returned
    // 'word' and the CJK length rule beneath it was unreachable. A user selecting
    // an ordinary Chinese sentence therefore got the "explain this word and give
    // an example sentence" prompt instead of the passage prompt: the wrong
    // request, and it burns their DeepSeek quota. The Latin branch is now scoped
    // to \p{Script=Latin}, so the CJK length rule is reachable again.
    expect(classifySelection('这是一个短语')).toBe('phrase')
    expect(classifySelection('请帮我翻译这一段文字')).toBe('phrase')
  })

  it('classifies a run past the length rules as a phrase', () => {
    // Past the 24-character Latin bound and past the short-run bound, nothing
    // is left but the phrase answer — which is the honest one for a long
    // identifier or a run of punctuation no dictionary would answer for.
    expect(classifySelection('C'.repeat(40))).toBe('phrase')
    expect(classifySelection('？？？？？')).toBe('phrase')
    expect(classifySelection('..............')).toBe('phrase')
  })

  it('sends a short punctuation run down the word path, an accepted imprecision', () => {
    // The short-run fallback (at most four characters) has no "is this a word"
    // check of its own, so "？？？" lands on 'word'. This is recorded rather
    // than asserted as correct: it is the same class of imprecision as the CJK
    // defect above, and it is cheap to tighten if the lead wants one fix for
    // both (require at least one letter before accepting a run as a word).
    expect(classifySelection('？？？')).toBe('word')
  })

  it('treats an empty or whitespace-only selection as a passage, never a word', () => {
    // An empty classification would produce an "explain the word " prompt with
    // no word in it; the phrase path is the safer default.
    expect(classifySelection('')).toBe('phrase')
    expect(classifySelection('   \n  ')).toBe('phrase')
  })

  it('ignores surrounding whitespace when classifying', () => {
    // A selection carries the dragged text verbatim, padding included.
    expect(classifySelection('  hello  ')).toBe('word')
  })
})

describe('selection detection', () => {
  it('detects a plain conversation selection and reports its kind', () => {
    // The happy path everything else is measured against: text the user
    // selected in the transcript becomes an actionable popup with a kind.
    mount('<div data-conversation><p id="turn">ephemeral</p></div>')
    const target = document.getElementById('turn') as HTMLElement
    const detected = detectSelection(selectText(target))
    expect(detected?.text).toBe('ephemeral')
    expect(detected?.kind).toBe('word')
    expect(detected?.rect.width).toBe(200)
  })

  it('reports a multi-word selection as a phrase', () => {
    // The kind decides which of the two DeepSeek prompts is sent, so a
    // sentence must not be sent the "explain this word" prompt.
    mount('<div data-conversation><p id="turn">ephemeral and short-lived</p></div>')
    const detected = detectSelection(selectText(document.getElementById('turn') as HTMLElement))
    expect(detected?.kind).toBe('phrase')
  })

  it('refuses a selection inside a text input', () => {
    // A popup over a field the user is typing into steals the click that was
    // meant to place a cursor; the control owns its own selection.
    mount('<div data-conversation><input id="field" value="selected text" /></div>')
    const field = document.getElementById('field') as HTMLElement
    expect(detectSelection(selectText(field))).toBeUndefined()
  })

  it('refuses a selection inside a textarea', () => {
    // Same reason as the input case; a textarea is the most common place a user
    // drafts a message.
    mount('<div data-conversation><textarea id="draft">some draft text</textarea></div>')
    expect(detectSelection(selectText(document.getElementById('draft') as HTMLElement))).toBeUndefined()
  })

  it('refuses a selection inside a contenteditable region', () => {
    // The model's own composer is contenteditable, and explaining a half-typed
    // prompt would be noise at best.
    mount('<div data-conversation><div id="composer" contenteditable="true">typed so far</div></div>')
    expect(detectSelection(selectText(document.getElementById('composer') as HTMLElement))).toBeUndefined()
  })

  it('refuses a selection inside this plugin\'s own surfaces', () => {
    // The popup renders inside the sidebar panel it describes; selecting text
    // there must not stack a second popup on top of the first.
    mount(`<div ${OWN_SURFACE_ATTRIBUTE}="panel"><p id="panelText">panel copy</p></div>`)
    expect(detectSelection(selectText(document.getElementById('panelText') as HTMLElement))).toBeUndefined()
  })

  it('refuses a selection anchored inside a plugin surface even when the event target is elsewhere', () => {
    // A drag can start in the panel and end over the transcript; the anchor
    // decides, because that is where the text came from.
    mount('<div data-conversation><p id="turn">conversation</p></div>')
    const target = document.getElementById('turn') as HTMLElement
    const selection = selectText(target)
    const range = window.getSelection()?.getRangeAt(0)
    expect(range).toBeDefined()
    mount(`<div ${OWN_SURFACE_ATTRIBUTE}><span id="own">own text</span></div>`)
    // Re-anchor the live selection inside the plugin surface while keeping the
    // mouseup target on the transcript.
    const own = document.getElementById('own') as HTMLElement
    const ownRange = document.createRange()
    ownRange.selectNodeContents(own)
    Object.defineProperty(ownRange, 'getBoundingClientRect', { value: () => rect(), configurable: true })
    const live = window.getSelection()
    live?.removeAllRanges()
    live?.addRange(ownRange)
    expect(detectSelection(selection)).toBeUndefined()
  })

  it('refuses a selection longer than the explainable limit', () => {
    // A user who selects three paragraphs has not asked for a definition, and
    // pasting all of it into a DeepSeek prompt wastes their quota.
    mount(`<div data-conversation><p id="long">${'x'.repeat(MAX_SELECTION_CHARS + 1)}</p></div>`)
    expect(detectSelection(selectText(document.getElementById('long') as HTMLElement))).toBeUndefined()
  })

  it('accepts a selection exactly at the limit', () => {
    // The bound must be inclusive: off-by-one here would silently refuse the
    // longest selection the feature says it supports.
    mount(`<div data-conversation><p id="edge">${'x'.repeat(MAX_SELECTION_CHARS)}</p></div>`)
    expect(detectSelection(selectText(document.getElementById('edge') as HTMLElement))?.text.length).toBe(MAX_SELECTION_CHARS)
  })

  it('refuses a collapsed selection', () => {
    // A plain click collapses the caret; opening a popup for it would make the
    // popup appear on every click in the transcript.
    mount('<div data-conversation><p id="turn">ephemeral</p></div>')
    const target = document.getElementById('turn') as HTMLElement
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.collapse(target.firstChild ?? target)
    const event = new MouseEvent('mouseup', { bubbles: true })
    Object.defineProperty(event, 'target', { value: target, configurable: true })
    expect(detectSelection(event)).toBeUndefined()
  })

  it('refuses a selection with no selection at all', () => {
    // Some shells deliver a `mouseup` after the selection was already cleared
    // (a click on empty space); that must be a no-op, not a crash.
    mount('<div data-conversation><p id="turn">ephemeral</p></div>')
    window.getSelection()?.removeAllRanges()
    const event = new MouseEvent('mouseup', { bubbles: true })
    Object.defineProperty(event, 'target', { value: document.body, configurable: true })
    expect(detectSelection(event)).toBeUndefined()
  })

  it('refuses a selection inside the right sidebar column', () => {
    // The right sidebar is where this plugin's own panel lives; explaining text
    // the user is reading there would be self-referential.
    mount('<div data-sidebar-right><p id="side">sidebar copy</p></div>')
    expect(detectSelection(selectText(document.getElementById('side') as HTMLElement))).toBeUndefined()
  })

  it('accepts unmarked body text, so an unfamiliar shell still gets the popup', () => {
    // A deployment whose markup lacks `data-conversation` would otherwise
    // produce a popup nowhere; being slightly over-eager is the safer default.
    mount('<p id="plain">a plain paragraph</p>')
    expect(detectSelection(selectText(document.getElementById('plain') as HTMLElement))?.text).toBe('a plain paragraph')
  })
})

describe('clipboard copy', () => {
  /**
   * Install a `navigator.clipboard` and `document.execCommand` pair, returning
   * a function that puts the originals back.
   *
   * jsdom ships neither `navigator.clipboard` nor `document.execCommand`, so both
   * must be faked explicitly: the module reads `navigator.clipboard?.writeText`
   * and then calls `document.execCommand`, and a bare `undefined` would exercise
   * only the catch-all failure path rather than the fallbacks being tested.
   */
  function installClipboard(options: {
    writeText?: (() => Promise<void>) | undefined
    execCommand: (command: string) => boolean
  }): () => void {
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const previousExec = Object.getOwnPropertyDescriptor(document, 'execCommand')
    Object.defineProperty(navigator, 'clipboard', { value: options.writeText === undefined ? undefined : { writeText: options.writeText }, configurable: true })
    Object.defineProperty(document, 'execCommand', { value: options.execCommand, configurable: true })
    return () => {
      if (previousClipboard === undefined) delete (navigator as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', previousClipboard)
      if (previousExec === undefined) delete (document as { execCommand?: unknown }).execCommand
      else Object.defineProperty(document, 'execCommand', previousExec)
    }
  }

  it('reports success when the async clipboard API works', async () => {
    // The popup's 复制 button has to say whether it worked; a silent failure is
    // worse than one that reports it.
    const restore = installClipboard({ writeText: async () => undefined, execCommand: () => false })
    try {
      await expect(copyToClipboard('copy me')).resolves.toBe(true)
    } finally {
      restore()
    }
  })

  it('falls back to the execCommand path when the async clipboard rejects', async () => {
    // A page served over plain HTTP refuses `navigator.clipboard`, and older
    // Electron shells do too; the plugin must still copy, or the button would
    // silently do nothing for exactly the users on http://.
    const restore = installClipboard({
      writeText: async () => { throw new Error('clipboard write denied') },
      execCommand: (command) => command === 'copy',
    })
    try {
      await expect(copyToClipboard('fallback copy')).resolves.toBe(true)
      // The hidden textarea must not be left behind: it would become a stray
      // focusable element sitting in the conversation transcript.
      expect(document.querySelectorAll('textarea').length).toBe(0)
    } finally {
      restore()
    }
  })

  it('falls back to the execCommand path when no async clipboard exists at all', async () => {
    // `navigator.clipboard?.writeText` is undefined rather than throwing here,
    // which is the older-shell shape the optional-chaining in the module exists
    // to handle.
    const restore = installClipboard({ writeText: undefined, execCommand: () => true })
    try {
      await expect(copyToClipboard('legacy copy')).resolves.toBe(true)
    } finally {
      restore()
    }
  })

  it('reports failure when neither clipboard path works', async () => {
    // Reporting the failure lets the popup say so; swallowing it would present
    // a no-op to the user as a success.
    const restore = installClipboard({ writeText: undefined, execCommand: () => false })
    try {
      await expect(copyToClipboard('will not copy')).resolves.toBe(false)
      // Even the failed attempt must clean up its scratch textarea.
      expect(document.querySelectorAll('textarea').length).toBe(0)
    } finally {
      restore()
    }
  })
})
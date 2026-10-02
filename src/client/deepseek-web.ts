/**
 * Ask DeepSeek a question through the DeepSeek **web page**, not an API key.
 *
 * The user asked for this explicitly: their DeepSeek web login, their quota,
 * their existing conversation history. So there is no model call here at all.
 * What happens instead is a small remote-control sequence against the Host's
 * Chrome window over {@link SideBrowserApi}:
 *
 * 1. navigate to `https://chat.deepseek.com/` if not already there;
 * 2. type the prompt into the composer and press Enter;
 * 3. poll the page text until the answer stops growing;
 * 4. extract the last assistant turn and return it.
 *
 * ## Why it is defensive rather than optimistic
 *
 * The page belongs to a third party. It can be signed out, it can be showing a
 * modal, its DOM can change, and the network can be slow. Every one of those
 * cases is reported as a typed outcome the caller renders as one honest line —
 * never as an empty answer and never as an unbounded wait. A caller must never
 * present "I could not do it" as though it were the model's reply, because the
 * difference matters: the first is the user fixing a login, the second is
 * misinformation.
 *
 * ## Why the extraction is approximate
 *
 * The Host route returns the page's visible text, not its React tree. The
 * answer is therefore located structurally — "everything after the last user
 * turn marker, up to the composer" — with generous fallbacks. When every
 * fallback comes up empty, the module says so instead of guessing.
 *
 * @module
 */

import type { SideBrowserApi } from './api.ts'

/** Where the DeepSeek chat lives. */
export const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com/'

/**
 * Selectors for the DeepSeek composer's input, newest markup first.
 *
 * DeepSeek has used a `textarea` and a ProseMirror-style `div[contenteditable]`
 * across recent revisions, so both are listed; the Host tries each in order and
 * reports which one it found (or that it found none).
 */
const COMPOSER_SELECTORS: readonly string[] = [
  '.fbb737a4 textarea',
  'div.fbb737a4 input',
  'main textarea',
  'textarea',
  '[contenteditable="true"]',
]

/**
 * Markers that end a user turn in the rendered conversation, so the answer can
 * be cut from everything that follows the last one. Matched case-insensitively
 * against the extracted page text.
 */
const USER_TURN_MARKERS: readonly string[] = ['You', '你']

/** How the attempt ended. */
export type DeepSeekWebOutcome =
  /** The page answered and its text was extracted. */
  | { kind: 'answer'; text: string }
  /** The page needs a signed-in session before it will accept a prompt. */
  | { kind: 'login-required' }
  /** The composer was not found; the page structure changed under us. */
  | { kind: 'composer-missing' }
  /** The prompt was sent but no complete answer arrived inside the deadline. */
  | { kind: 'timeout'; elapsedMs: number }
  /** A route call failed; `reason` is its readable message. */
  | { kind: 'host-error'; reason: string }

/** Tunables for one {@link askDeepSeekWeb} call. */
export interface AskDeepSeekWebOptions {
  /**
   * How long to wait for a completed answer. DeepSeek reasons before it
   * answers, so the default is generous; a caller that must stay snappy should
   * lower it and treat `timeout` as a retryable outcome.
   */
  timeoutMs?: number
  /**
   * How often to re-read the page while waiting. Fast enough that a short
   * answer feels immediate, slow enough not to hammer the Host.
   */
  pollMs?: number
  /**
   * Report progress (page opened, prompt sent, answer growing) so a popup can
   * show the user that something is happening instead of one frozen label.
   */
  onProgress?: (stage: DeepSeekWebStage, detail?: string) => void
}

/** Progress stages the bridges report. */
export type DeepSeekWebStage = 'opening' | 'typing' | 'waiting' | 'reading'

/** Every stage a bridge can be in; a translation adds its own by mapping onto these. */
export type BridgeStage = DeepSeekWebStage

/** How many consecutive unchanged reads count as "the answer has stopped growing". */
const QUIET_POLLS = 3

/**
 * How long to wait for the chat page to show the prompt as a turn before
 * concluding it never accepted it.
 *
 * A logged-out chat still renders a composer, so the text can be typed and
 * Enter pressed without complaint; the prompt simply never becomes part of the
 * conversation. Short, because the answer to "why did nothing happen" should be
 * "you are not logged in", not a minute of silence.
 */
const ACCEPT_PROBE_MS = 6_000

/** Default overall deadline. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Default poll interval. */
const DEFAULT_POLL_MS = 1_500

/**
 * Sleep, as a promise.
 * @param ms - milliseconds to wait.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Compose the prompt for a selected word or phrase.
 *
 * A single word and a passage need genuinely different instructions: a word
 * asks for meaning and usage, while a passage asks what the passage claims.
 * Folding the selection into a delimited block keeps a selection that itself
 * contains instruction-like text from being read as part of the request.
 * @param selection - the text the user selected.
 * @param kind - whether the selection is one word or a longer passage.
 * @param language - the language to answer in, when the caller wants one.
 * @returns the prompt to send.
 */
export function buildExplainPrompt(
  selection: string,
  kind: 'word' | 'phrase',
  language?: string,
): string {
  const suffix = language === undefined ? '' : `\n请用${language}回答。`
  if (kind === 'word') {
    return `请解释下面这个词的含义、常见用法，并给一个例句。\n\n<selection>${selection}</selection>${suffix}`
  }
  return `请解释下面这段话在说什么，逐句说明，并指出其中的关键结论。\n\n<selection>${selection}</selection>${suffix}`
}

/**
 * Compose the prompt for a translation.
 * @param selection - the text to translate.
 * @param language - the target language, already a human-readable name.
 * @returns the prompt to send.
 */
export function buildTranslatePrompt(selection: string, language: string): string {
  return `请把下面这段文字翻译成${language}，只输出译文，不要解释。\n\n<selection>${selection}</selection>`
}

/**
 * Longest run of space-less characters still treated as a single word.
 *
 * Four is a reading, not a measurement: it covers the great majority of modern
 * Chinese compounds (光合作用, 人工智能) while keeping an ordinary clause of six
 * or more characters on the passage side, which is the split that matters for
 * choosing the prompt.
 */
const CJK_WORD_MAX_CHARS = 4

/** Longest Latin token still treated as one word. */
const LATIN_WORD_MAX_CHARS = 24

/**
 * Decide whether a selection is one word or a passage.
 *
 * Whitespace alone cannot decide this: Chinese and Japanese are written without
 * spaces, so "contains no whitespace" would call an entire ordinary sentence a
 * word and send DeepSeek the wrong prompt. Nor can a generic `\p{L}` run, which
 * covers Han and would swallow every space-less Chinese run up to its length
 * bound — the CJK length rule below then never runs. So the two scripts are
 * decided separately:
 *
 * - **CJK** — a word is a short run (at most {@link CJK_WORD_MAX_CHARS}); past
 *   that it is a phrase regardless of the absence of spaces.
 * - **Latin and other space-delimited scripts** — a word is a single token under
 *   {@link LATIN_WORD_MAX_CHARS}, optionally carrying internal apostrophes and
 *   hyphens so `don't` and `well-known` stay words.
 *
 * A run that is neither script (say emoji, or a formula) is decided by the CJK
 * rule, which is the conservative reading: a longer run is a phrase.
 * @param selection - the selected text.
 * @returns the classification the prompt builder keys on.
 */
export function classifySelection(selection: string): 'word' | 'phrase' {
  const trimmed = selection.trim()
  if (trimmed === '') return 'phrase'
  if (/\s/.test(trimmed)) return 'phrase'
  // Scoped to the Latin script on purpose: an unscoped \p{L} would match Han
  // and make the CJK rule below unreachable.
  if (new RegExp(`^[\\p{Script=Latin}\\p{N}'’-]{1,${LATIN_WORD_MAX_CHARS}}$`, 'u').test(trimmed)) return 'word'
  // Space-less scripts: a short run is a word, anything longer is a phrase.
  if (Array.from(trimmed).length <= CJK_WORD_MAX_CHARS) return 'word'
  return 'phrase'
}

/**
 * Cut the assistant's answer out of the DeepSeek page text.
 *
 * DeepSeek renders the conversation as alternating user and assistant turns,
 * so the answer is the tail that follows the last user marker. Three passes,
 * most specific first:
 *
 * 1. after the last user marker, if one is recognisable;
 * 2. after a `deepseek`/`DeepSeek` attribution line, which is how a logged-out
 *    render labels the reply;
 * 3. the last non-empty block, when the page has a single turn.
 *
 * A pass that finds nothing falls through to the next rather than returning an
 * empty answer, and an all-empty page returns an empty string so the caller
 * reports "no answer read" instead of showing a blank box.
 * @param pageText - the visible text of the page.
 * @returns the extracted answer, possibly empty.
 */
export function extractAnswer(pageText: string): string {
  const trimmed = pageText.trim()
  if (trimmed === '') return ''

  // Both anchors are positions in the rendered text, and the assistant's own
  // attribution is the better one: a user turn is rendered as its label ("You")
  // followed by the message body, so cutting at the label necessarily swallows
  // the user's own message. The assistant turn is labelled with the model name
  // and its text follows that label directly.
  const userIndex = lastMarkerIndex(trimmed, USER_TURN_MARKERS)
  const attributionIndex = lastAttributionIndex(trimmed)

  const anchor = attributionIndex > userIndex ? attributionIndex : userIndex
  if (anchor >= 0) {
    const tail = trimmed.slice(anchor).trim()
    // A label with no body yet means the answer has not arrived. Returning it
    // would show the user a popup reading "DeepSeek-V3" and, because the text
    // never changes, the caller would treat it as a finished answer.
    if (tail !== '' && !isTurnLabel(tail)) return tail
  }
  // An anchor that yields nothing usable (a trailing label with an empty body)
  // must not end the attempt: fall through to the block heuristic below.
  const blocks = trimmed.split(/\n{2,}/).filter(block => block.trim() !== '')
  const last = blocks.length === 0 ? '' : (blocks[blocks.length - 1] ?? '').trim()
  return isTurnLabel(last) ? '' : last
}

/**
 * Whether a block is only a turn label rather than a message.
 *
 * A conversation whose last block is "DeepSeek-V3" or "You" has a turn that was
 * rendered without a body yet, which is not an answer.
 * @param block - the trimmed text of one block.
 * @returns whether it is a bare label.
 */
function isTurnLabel(block: string): boolean {
  return /^(?:you|你|deepseek[\w.-]*)$/i.test(block)
}

/**
 * Index just past the last whole-line occurrence of any user-turn marker.
 * @param text - the page text.
 * @returns the end index of the marker, or -1 when no marker is on its own line.
 */
function lastMarkerIndex(text: string, markers: readonly string[]): number {
  let best = -1
  for (const marker of markers) {
    const index = lastIndexOfMarker(text, marker)
    if (index >= 0 && index + marker.length > best) best = index + marker.length
  }
  return best
}

/**
 * Index just past the end of the last assistant label in the page text.
 *
 * The label is the model name ("DeepSeek-V3", "DeepSeek-R1"), so matching only
 * the word and cutting there would leave the version suffix ("-V3") welded onto
 * the first word of the answer. The scan therefore takes the whole
 * whitespace-delimited word the match landed in.
 * @param text - the page text.
 * @returns the index just past the label word, or -1 when there is none.
 */
function lastAttributionIndex(text: string): number {
  const attribution = /deepseek[\w.-]*/gi
  let match: RegExpExecArray | null = attribution.exec(text)
  let last = -1
  while (match !== null) {
    last = match.index + match[0].length
    match = attribution.exec(text)
  }
  return last
}

/**
 * Find the last occurrence of a line that is exactly a user-turn marker.
 *
 * A whole-line match is what keeps the word "you" inside an answer from being
 * mistaken for the start of a new user turn.
 * @param text - the page text.
 * @param marker - the marker to find.
 * @returns the index of the match, or -1.
 */
function lastIndexOfMarker(text: string, marker: string): number {
  const pattern = new RegExp(`(?:^|\\n)${escapeRegExp(marker)}(?:\\n|$)`, 'g')
  let found = -1
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    found = match.index + (match[0].startsWith('\n') ? 1 : 0)
    match = pattern.exec(text)
  }
  return found
}

/**
 * Escape a string for literal use inside a `RegExp`.
 * @param value - the raw string.
 * @returns the escaped string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the page text looks like a signed-out DeepSeek.
 *
 * The login surface is the one state in which typing into a composer would be
 * silently useless: the field is present, the send button works, and the
 * answer never comes because the session is anonymous.
 * @param pageText - the visible page text.
 * @returns true when the page is asking the user to sign in.
 */
export function looksSignedOut(pageText: string): boolean {
  const text = pageText.toLowerCase()
  if (!/登录|log in|login|sign in|sign up/.test(text)) return false
  // A signed-in conversation also shows the login link in a menu; require that
  // the page carries no conversation content before calling it signed out.
  return !/\bdeepthink\b|\bthinking\b/i.test(pageText) || text.length < 400
}

/** How the caller wants a translation performed. */
export type TranslationStrategy = 'site' | 'deepseek'

/** A translation engine this plugin can drive through the host browser. */
export interface TranslationEngine {
  /** Stable id, stored in settings and used in the panel's engine picker. */
  id: string
  /** Human-readable name, shown in the popup's status line. */
  name: string
  /**
   * Build the URL for one translation request.
   *
   * Each engine is a site that accepts the text and the language pair as URL
   * parameters, so the result is on screen without any interaction and without
   * the Host needing a per-site DOM hook — which matters, because third-party
   * markup changes without notice and a stale selector would silently stop
   * working where a URL keeps working.
   */
  url: (text: string, target: string) => string
}

/** The engines offered out of the box. */
export const TRANSLATION_ENGINES: readonly TranslationEngine[] = [
  {
    id: 'youdao',
    name: '有道词典',
    // The DICTIONARY, not the sentence translator: a single word is an
    // explanation request, and `dict.youdao.com` answers it with entries,
    // phonetics and examples. The sentence translator at fanyi.youdao.com
    // does not carry a whole sentence usefully through its URL form, which is
    // why a phrase is routed to Bing instead.
    url: (text) => `https://dict.youdao.com/?${new URLSearchParams({ key: text })}`,
  },
  {
    id: 'bing',
    name: 'Bing 翻译',
    url: (text, target) =>
      `https://www.bing.com/translator?${new URLSearchParams({ from: 'auto', to: target, text })}`,
  },
  {
    id: 'baidu',
    name: '百度翻译',
    url: (text, target) =>
      `https://fanyi.baidu.com/?${new URLSearchParams({ from: 'auto', to: target, query: text })}`,
  },
]

/**
 * The target languages offered in the settings card, as the codes the
 * translation sites expect.
 *
 * A short list on purpose: each entry maps to a code every supported engine
 * accepts, so a chosen language never produces a request the site rejects.
 */
export const TARGET_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
]

/**
 * Translate a selection.
 *
 * ## Why the translation site is the default
 *
 * A translation site returns in one to three seconds, costs no quota, and
 * leaves the DeepSeek conversation untouched. The DeepSeek web page produces
 * better prose for a sentence but takes ten seconds or more, spends the user's
 * chat quota, and leaves the transcript full of throwaway questions. So the
 * site path is the default and the DeepSeek path is the fallback, and the
 * fallback exists because a translation site can lose a race with its own
 * captcha — in which case asking DeepSeek still answers.
 *
 * The site path navigates and reports what it could read. When the site renders
 * a result the Host can see, it is read back directly; when it does not (a
 * captcha, a layout the selector no longer matches), the attempt falls through
 * to DeepSeek rather than showing the user an empty box.
 * @param text - the selection to translate.
 * @param api - the route client.
 * @param options - engine, target language, and the DeepSeek fallback.
 * @returns what happened, including the text when it could be read back.
 */
export async function translateSelection(
  text: string,
  api: SideBrowserApi,
  options: TranslateOptions = {},
): Promise<TranslationOutcome> {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  // Word vs sentence picks the site: see engineForSelection. A caller that
  // pinned an engine keeps it.
  const engine = engineForSelection(trimmed, options.engine)
  const target = options.target ?? 'zh-Hans'
  const timeoutMs = options.timeoutMs ?? 15_000

  options.onProgress?.('opening', engine.name)
  const navigated = await api.navigate(engine.url(trimmed, target))
  if (!navigated.ok) {
    // A navigation failure means the site is not reachable at all, which the
    // DeepSeek bridge can still answer around — so it gets the fallback.
    if (options.fallbackToDeepSeek === false) return { kind: 'host-error', reason: navigated.error }
    return viaDeepSeek(trimmed, target, api, options.onProgress, options.timeoutMs)
  }

  // A prefilled site renders its result asynchronously. The Host's `/text`
  // route reads the whole page rather than one selector, so the site's own
  // result is not separately addressable — and that is fine, because the live
  // view in the sidebar IS the site: poll the page text once to confirm the
  // page rendered, then let the user read the result from the panel itself.
  // Waiting longer than that would be waiting for nothing extractable.
  const deadline = Date.now() + timeoutMs
  let pageText = ''
  while (Date.now() < deadline) {
    await delay(1_200)
    const read = await api.text({ maxChars: 6_000 })
    if (!read.ok) break
    pageText = read.value.text
    if (pageText !== '') break
  }

  // The site rendered. That is the end of this path, deliberately.
  //
  // It used to be judged by whether the page was "long enough", and a site that
  // rendered but did not parse to a long enough string was treated as having
  // failed - so the fallback navigated away from the very page the user was
  // reading and replaced it with the DeepSeek login screen. The user saw their
  // translation disappear and a login form appear, for no stated reason.
  //
  // The Host reads whole pages rather than one selector, so the result is not
  // separately addressable here - but it is not needed: the live view IS the
  // site, and the user is already looking at it.
  if (pageText !== '') {
    return { kind: 'opened', engine: engine.id }
  }

  // Only a site that produced no readable text at all falls back.
  if (options.fallbackToDeepSeek === false) {
    return { kind: 'host-error', reason: 'The translation site returned nothing readable' }
  }
  const outcome = await viaDeepSeek(trimmed, target, api, options.onProgress, options.timeoutMs)
  if (outcome.kind === 'translated') return outcome
  if (outcome.kind === 'host-error') return outcome
  // The DeepSeek path failed for a reason the user can act on (signed out,
  // composer gone, timed out). The site is still open on screen, so say that
  // rather than reporting only the fallback's failure.
  return {
    kind: 'opened',
    engine: engine.id,
    note: outcome.kind === 'login-required' || outcome.kind === 'composer-missing' || outcome.kind === 'timeout'
      ? outcome.kind
      : undefined,
  }
}

/**
 * Choose the engine for a selection.
 *
 * The two things a user selects want different sites. A single word is really an
 * "explain this word" request, and 有道's dictionary entry answers that far
 * better than a sentence-level translator does. A sentence is a real
 * translation request, and 有道's URL form does not carry one — it answers a
 * phrase lookup with nothing useful — so a phrase goes to Bing.
 *
 * An engine the user pinned in settings always wins; this only decides the
 * default when they have not chosen one.
 * @param selection - the selected text.
 * @param preferred - the configured engine, when the user set one.
 * @returns the engine to use.
 */
export function engineForSelection(selection: string, preferred?: TranslationEngine): TranslationEngine {
  if (preferred !== undefined) return preferred
  const kind = classifySelection(selection)
  const wanted = kind === 'word' ? 'youdao' : 'bing'
  return TRANSLATION_ENGINES.find(engine => engine.id === wanted) ?? TRANSLATION_ENGINES[0]!
}

/** Options for one {@link translateSelection} call. */
export interface TranslateOptions {
  /** The site to try first; the first entry of {@link TRANSLATION_ENGINES} by default. */
  engine?: TranslationEngine
  /** Target language code the site understands. */
  target?: string
  /** How long to wait for the site's own result before falling back. */
  timeoutMs?: number
  /** Whether to ask DeepSeek when the site yields nothing; default true. */
  fallbackToDeepSeek?: boolean
  /** Progress reporting, shared with the DeepSeek bridge. */
  onProgress?: (stage: DeepSeekWebStage, detail?: string) => void
}

/**
 * Ask DeepSeek to translate, as the fallback path.
 * @param text - the selection.
 * @param target - the target language name.
 * @param api - the route client.
 * @param onProgress - progress reporting.
 * @param timeoutMs - the DeepSeek bridge's own deadline.
 * @returns the DeepSeek outcome, with an `engine` marker added on success.
 */
async function viaDeepSeek(
  text: string,
  target: string,
  api: SideBrowserApi,
  onProgress: ((stage: DeepSeekWebStage, detail?: string) => void) | undefined,
  timeoutMs: number | undefined,
): Promise<TranslationOutcome> {
  const outcome = await askDeepSeekWeb(buildTranslatePrompt(text, target), api, { onProgress, timeoutMs })
  return outcome.kind === 'answer' ? { kind: 'translated', text: outcome.text, engine: 'deepseek' } : outcome
}

/**
 * The note a caller can show on an `opened` outcome.
 *
 * The site is on screen either way; this says why the DeepSeek fallback could
 * not rescue the attempt, so the user knows whether to log in, wait, or read the
 * site directly. An `empty` selection can never reach this branch, so it is
 * excluded from the union rather than being a note the caller cannot explain.
 */
export type TranslationNote = 'login-required' | 'composer-missing' | 'timeout'

/** What a translation attempt produced. */
export type TranslationOutcome =
  /** A translation was read back; `engine` names where it came from. */
  | { kind: 'translated'; text: string; engine: string }
  /**
   * The site is open and its result is on screen in the panel. `note` says why
   * the DeepSeek fallback did not produce text, when one was tried.
   */
  | { kind: 'opened'; engine: string; note?: TranslationNote }
  /** The selection was empty. */
  | { kind: 'empty' }
  /** DeepSeek needs a signed-in session. */
  | { kind: 'login-required' }
  /** DeepSeek's composer was not found. */
  | { kind: 'composer-missing' }
  /** No complete answer in time. */
  | { kind: 'timeout'; elapsedMs: number }
  /** A route call failed. */
  | { kind: 'host-error'; reason: string }
export async function askDeepSeekWeb(
  prompt: string,
  api: SideBrowserApi,
  options: AskDeepSeekWebOptions = {},
): Promise<DeepSeekWebOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  const onProgress = options.onProgress

  onProgress?.('opening')
  const state = await api.state()
  if (!state.ok) return { kind: 'host-error', reason: state.error }

  // No attached browser means nothing can be typed at all, which is a different
  // problem from being signed out of DeepSeek and deserves its own report.
  if (!state.value.attached) {
    return { kind: 'host-error', reason: 'no browser is attached to this DSH instance' }
  }

  const alreadyThere = state.value.url.startsWith('https://chat.deepseek.com')
  if (!alreadyThere) {
    const navigated = await api.navigate(DEEPSEEK_CHAT_URL)
    if (!navigated.ok) return { kind: 'host-error', reason: navigated.error }
  }

  // Give the chat page a moment to mount its composer after a navigation.
  await delay(pollMs)
  const beforeText = await api.text({ maxChars: 4_000 })
  if (!beforeText.ok) return { kind: 'host-error', reason: beforeText.error }
  if (looksSignedOut(beforeText.value.text)) return { kind: 'login-required' }

  onProgress?.('typing')
  let typed = false
  for (const selector of COMPOSER_SELECTORS) {
    const entered = await api.type(prompt, selector)
    if (entered.ok) {
      typed = true
      break
    }
    // A missing selector is the expected outcome for all but one entry; only a
    // reason other than "no such element" is worth surfacing.
    if (!/no such element|no element|not found|找不到/i.test(entered.error)) {
      return { kind: 'host-error', reason: entered.error }
    }
  }
  if (!typed) return { kind: 'composer-missing' }

  const sent = await api.key('Enter')
  if (!sent.ok) return { kind: 'host-error', reason: sent.error }

  onProgress?.('waiting')
  let previousLength = -1
  let quiet = 0
  // How long to keep waiting for the page to ACCEPT the prompt before concluding
  // it never will.
  const acceptBy = Math.min(deadline, Date.now() + ACCEPT_PROBE_MS)
  while (Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    const read = await api.text({ maxChars: 8_000 })
    if (!read.ok) {
      // A read that failed once is usually a mid-navigation gap; only a
      // sustained failure should end the attempt, and the next iteration will
      // find out.
      quiet = 0
      continue
    }
    const pageText = read.value.text
    if (looksSignedOut(pageText)) return { kind: 'login-required' }
    // The page never showed the prompt as a turn. Typing and Enter both
    // "succeed" against a logged-out chat - the composer accepts the text and
    // the key press is swallowed - so the only honest reading is that the page
    // did not accept it. Reporting that now is the difference between a user
    // learning "log in first" in a few seconds and watching a button do nothing
    // for the full ninety.
    const promptAccepted = pageText.includes(prompt.trim().slice(0, 40))
    if (!promptAccepted && Date.now() > acceptBy) {
      return { kind: 'login-required' }
    }
    const answer = extractAnswer(pageText)
    // Before the assistant types anything, the page ends with the user's own
    // turn, and the cut from there is the prompt that was just sent. Treating
    // it as an answer is stable, so the poll loop would settle on it and the
    // popup would show the user their own selection back as DeepSeek's reply.
    // An answer identical to what we typed is therefore not yet an answer.
    const isEcho = answer !== '' && answer === prompt.trim()
    if (answer !== '' && !isEcho) {
      if (answer.length === previousLength) {
        quiet += 1
        if (quiet >= QUIET_POLLS) {
          onProgress?.('reading', answer)
          return { kind: 'answer', text: answer }
        }
      } else {
        quiet = 0
        previousLength = answer.length
      }
    }
  }
  return { kind: 'timeout', elapsedMs: timeoutMs }
}
/**
 * Quick-launch shortcuts for the side-browser panel.
 *
 * The set the user explicitly named — DeepSeek chat, Bing, 百度翻译, 有道翻译 —
 * ships as built-ins, because they are what makes the panel useful the moment
 * it opens. Anything else is a user setting, parsed in the settings card and
 * passed in as `extraShortcuts`, so this module never has to read configuration
 * itself.
 *
 * The URLs live in the client rather than in the Host because they are pure UI
 * affordances: no state, no validation that the Host needs, and a user editing
 * a shortcut should see the change without restarting anything.
 *
 * @module
 */

/** One button in the panel's shortcut row. */
export interface ShortcutEntry {
  /** Button text. */
  label: string
  /** Where pressing it navigates. */
  url: string
}

/**
 * The shortcuts every installation offers.
 *
 * Kept in the order a user most likely wants them: the chat they are already
 * signed into, then a search engine, then the two translators.
 */
export const builtInShortcuts: readonly ShortcutEntry[] = [
  { label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { label: 'Bing', url: 'https://www.bing.com/' },
  { label: '百度', url: 'https://www.baidu.com/' },
  { label: '百度翻译', url: 'https://fanyi.baidu.com/' },
  { label: '有道翻译', url: 'https://fanyi.youdao.com/' },
  { label: 'GitHub', url: 'https://github.com/' },
]

/**
 * Parse the settings field's `name url` lines into shortcut entries.
 *
 * Deliberately forgiving: a blank line and a line with no URL are skipped
 * rather than reported, because this field is edited as free text and a user
 * mid-typing should not see an error for an unfinished line. Only a line that
 * names a label but an address the browser cannot open is worth surfacing, and
 * the settings card reports that separately.
 * @param text - the configured lines.
 * @returns the usable entries.
 */
export function parseShortcuts(text: string): ShortcutEntry[] {
  const entries: ShortcutEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const spaceAt = trimmed.indexOf(' ')
    if (spaceAt < 0) {
      // A bare address is still usable; derive its label from the host name.
      if (isUsableUrl(trimmed)) entries.push({ label: hostLabel(trimmed), url: trimmed })
      continue
    }
    const label = trimmed.slice(0, spaceAt).trim()
    const url = trimmed.slice(spaceAt + 1).trim()
    if (label === '' || !isUsableUrl(url)) continue
    entries.push({ label, url })
  }
  return entries
}

/**
 * Whether a string is an address the browser will actually navigate to.
 *
 * Only `http:` and `https:` qualify: a `javascript:` or `file:` shortcut would
 * run the browser's own URL handlers on a click the user did not read
 * carefully, and the Host navigates these URLs unattended.
 * @param url - the candidate address.
 * @returns whether it is safe and usable.
 */
export function isUsableUrl(url: string): boolean {
  if (url === '') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Derive a readable button label from a bare address.
 * @param url - the address.
 * @returns the host without its `www.` prefix.
 */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 24)
  }
}
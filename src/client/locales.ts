/**
 * Copy for the side-browser panel and the selection mini-popup.
 *
 * Two dictionaries (zh-first, English fallback) selected by the document
 * language, with a runtime override wired by the client `apply()` so the
 * surfaces follow a language change without a page reload — the same two-step
 * shape the task-board client uses, for the same reason: a plugin half must
 * never depend on the locale service having applied before its first render,
 * so the document-language pick stays as the unwired fallback.
 *
 * Key naming follows `area.thing` (`panel.*` for the tab body, `popup.*` for
 * the selection box, `settings.*` for the plugin settings card). A key that
 * reads as a template carries `{name}` placeholders filled by `t(key, params)`.
 *
 * @module
 */

/** zh dictionary; the key set is the compile-time source of truth. */
export const zh = {
  // --- Panel ---------------------------------------------------------------
  'panel.title': '侧边浏览器',
  'panel.hint': '这是主机浏览器的实时画面，页面就在这里，不必再开一个窗口。',
  'panel.hintShort': '实时画面 · 无需另开窗口',
  'panel.nav.back': '后退',
  'panel.nav.forward': '前进',
  'panel.nav.reload': '刷新',
  'panel.nav.stop': '停止',
  'panel.url.placeholder': '输入网址或搜索内容，回车打开',
  'panel.url.home': '主页',
  // There is deliberately no "show the host window" affordance: the Host
  // exposes no route that raises its window, and a button that silently did
  // nothing would be worse than the honest copy below.
  'panel.windowOnDesktop': '页面在主机桌面的浏览器窗口中，这里是它的实时画面',
  'panel.windowOnDesktopShort': '实时画面 · 主机桌面上的浏览器窗口',
  'panel.connection.connecting': '正在连接主机浏览器…',
  'panel.connection.ready': '已连接',
  'panel.connection.lost': '与主机浏览器的连接断开，正在重试…',
  'panel.connection.unavailable': '主机上没有可用的浏览器窗口：{error}',
  'panel.text.toggle': '页面文本',
  'panel.text.loading': '正在读取页面文本…',
  'panel.text.empty': '这个页面没有可提取的文字（可能是画布或纯图片页面）',
  'panel.text.failed': '读取页面文本失败：{error}',
  'panel.text.refresh': '重新读取页面文本',
  'panel.shortcuts': '快捷入口',
  'panel.shortcuts.add': '添加网址',
  'panel.shortcuts.label': '名称',
  'panel.shortcuts.url': '网址',
  'panel.shortcuts.remove': '移除 {name}',
  'panel.shortcuts.added': '已添加 {name}',
  'panel.shortcuts.removed': '已移除 {name}',
  'panel.shortcuts.invalid': '这个网址不能打开：{url}',
  'panel.tabs.title': '浏览器标签页',
  'panel.tabs.close': '关闭 {title}',
  'panel.tabs.new': '新标签页',
  'panel.tabs.empty': '没有浏览器标签页',
  'panel.tabs.active': '当前标签页：{title}',
  'panel.screenshot.alt': '主机浏览器当前页面的截图',
  'panel.screenshot.stale': '截图停在 {time}',
  'panel.error.title': '操作失败',
  'panel.pageTitle': '主机窗口：{title}',

  // --- Selection mini-popup ------------------------------------------------
  'popup.explain': 'AI 解释',
  'popup.translate': '翻译',
  'popup.copy': '复制',
  'popup.copied': '已复制',
  'popup.working': '处理中…',
  'popup.retry': '重试',
  'popup.close': '关闭',
  'popup.expand': '展开结果',
  'popup.collapse': '收起结果',
  'popup.result.label': '结果',
  'popup.fallback': '改用 DeepSeek 网页版',
  'popup.translate.withDeepSeek': '用 DeepSeek 网页版翻译',
  'popup.error.noSelection': '选中的文字已经消失了，请重新选择',
  'popup.error.host': '主机浏览器没有响应：{error}',
  'popup.answer.empty': '没有读到回答，请在主机窗口中查看',
  'popup.wordHint': '选中了一个词',
  'popup.sentenceHint': '选中了一段文字',

  // --- DeepSeek web bridge -------------------------------------------------
  'dsweb.opening': '正在打开 DeepSeek 网页版…',
  'dsweb.loginRequired': '请先在主机窗口中登录 DeepSeek，完成后重试',
  'dsweb.composerMissing': '没有找到 DeepSeek 的输入框，网页结构可能已经变化',
  'dsweb.submitted': '已提交，等待 DeepSeek 回答…',
  'dsweb.timeout': '{seconds} 秒内没有等到回答结束',
  'dsweb.answer': 'DeepSeek 的回答',
  'dsweb.unavailable': '未能自动提交，请在主机窗口中完成登录或发送',

  // --- Translation ---------------------------------------------------------
  'translate.opening': '正在打开 {engine} 翻译…',
  'translate.siteResult': '{engine} 的译文已经显示在侧边浏览器里',
  'translate.fallbackUsed': '{engine} 没有返回可提取的译文，已改用 DeepSeek 网页版',
  'translate.failed': '翻译失败：{error}',
  'translate.target': '目标语言',
  'translate.engine': '翻译引擎',
  'translate.empty': '没有选中的内容',

  // --- Settings card -------------------------------------------------------
  'settings.title': '侧边浏览器',
  'settings.description': '把 DeepSeek 网页版、搜索引擎和翻译站放进 DSH 的右侧栏，并让你选中的文字可以直接解释或翻译。',
  'settings.notExposed': '当前 DSH 没有把本插件的设置项暴露给配置页面。请直接编辑 ~/.dsh/settings.yaml，或把下面的配置命名空间加入宿主设置白名单后重启。',
  'settings.readOnly': '当前部署以只读方式保存设置。',
  'settings.expand': '展开设置',
  'settings.collapse': '收起设置',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.discard': '放弃修改',
  'settings.unsaved': '未保存',
  'settings.saveFailed': '部署没有接受这些值，内容保留在表单里等你修改。',
  'settings.invalidNumber': '请输入数字，留空表示使用默认值。',
  'settings.inherit': '继承默认',
  'settings.on': '开',
  'settings.off': '关',
  'settings.overridden': '已覆盖',
  'settings.reset': '恢复默认',
  'settings.defaultUrl': '默认打开的网址',
  'settings.defaultUrlHint': '打开侧边浏览器标签页时首先访问的地址。',
  'settings.pollInterval': '截图刷新间隔（秒）',
  'settings.pollIntervalHint': '每 1 到 10 秒抓取一次主机窗口的截图。间隔越短越费 CPU；默认 2 秒。',
  'settings.targetLanguage': '翻译目标语言',
  'settings.targetLanguageHint': '选中文本后点“翻译”时使用的目标语言。',
  'settings.translationEngine': '翻译引擎',
  'settings.translationEngineHint': '翻译站点速度更快；DeepSeek 网页版解释更自然，但会占用对话历史。',
  'settings.enablePopup': '启用选中文本小工具',
  'settings.enablePopupHint': '在对话里选中文字后，在旁边显示“AI 解释 / 翻译 / 复制”小框。',
  'settings.enableAgentTools': '让 agent 使用浏览器工具',
  'settings.enableAgentToolsHint': '把 browser_* 工具交给会话中的模型，让它能读取并操作这个浏览器窗口。',
  'settings.shortcuts': '快捷入口网址',
  'settings.shortcutsHint': '每行一条“名称 网址”。左侧栏浏览器里的快捷入口按钮由这里生成。',
  'settings.shortcutsInvalid': '第 {line} 行不是一个合法的网址',
  'settings.shortcutsSaved': '快捷入口已保存',
}

/** en dictionary; keyed identically to {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  'panel.title': 'Side browser',
  'panel.hint': 'This is the live view of the browser running on the host; the page is here, not in a separate window.',
  'panel.hintShort': 'Live view · no separate window',
  'panel.nav.back': 'Back',
  'panel.nav.forward': 'Forward',
  'panel.nav.reload': 'Reload',
  'panel.nav.stop': 'Stop',
  'panel.url.placeholder': 'Type a URL or a search, press Enter',
  'panel.url.home': 'Home',
  'panel.windowOnDesktop': 'The page is a real Chrome window on your desktop; this is its live view.',
  'panel.windowOnDesktopShort': 'Live view · a browser window on your desktop',
  'panel.connection.connecting': 'Connecting to the host browser…',
  'panel.connection.ready': 'Connected',
  'panel.connection.lost': 'Lost the host browser connection, retrying…',
  'panel.connection.unavailable': 'No browser window is available on the host: {error}',
  'panel.text.toggle': 'Page text',
  'panel.text.loading': 'Reading the page text…',
  'panel.text.empty': 'This page has no extractable text (canvas- or image-only)',
  'panel.text.failed': 'Reading the page text failed: {error}',
  'panel.text.refresh': 'Re-read the page text',
  'panel.shortcuts': 'Shortcuts',
  'panel.shortcuts.add': 'Add a URL',
  'panel.shortcuts.label': 'Name',
  'panel.shortcuts.url': 'URL',
  'panel.shortcuts.remove': 'Remove {name}',
  'panel.shortcuts.added': 'Added {name}',
  'panel.shortcuts.removed': 'Removed {name}',
  'panel.shortcuts.invalid': 'This URL cannot be opened: {url}',
  'panel.tabs.title': 'Browser tabs',
  'panel.tabs.close': 'Close {title}',
  'panel.tabs.new': 'New tab',
  'panel.tabs.empty': 'No browser tabs',
  'panel.tabs.active': 'Current browser tab: {title}',
  'panel.screenshot.alt': 'Screenshot of the host browser’s current page',
  'panel.screenshot.stale': 'Screenshot frozen at {time}',
  'panel.error.title': 'Action failed',
  'panel.pageTitle': 'Host window: {title}',

  'popup.explain': 'AI explain',
  'popup.translate': 'Translate',
  'popup.copy': 'Copy',
  'popup.copied': 'Copied',
  'popup.working': 'Working…',
  'popup.retry': 'Retry',
  'popup.close': 'Close',
  'popup.expand': 'Expand result',
  'popup.collapse': 'Collapse result',
  'popup.result.label': 'Result',
  'popup.fallback': 'Retry with the DeepSeek web page',
  'popup.translate.withDeepSeek': 'Translate with the DeepSeek web page',
  'popup.error.noSelection': 'The selected text is gone; select it again',
  'popup.error.host': 'The host browser did not answer: {error}',
  'popup.answer.empty': 'No answer could be read; look at the host window',
  'popup.wordHint': 'One word selected',
  'popup.sentenceHint': 'A passage selected',

  'dsweb.opening': 'Opening the DeepSeek web page…',
  'dsweb.loginRequired': 'Log in to DeepSeek in the host window first, then retry',
  'dsweb.composerMissing': 'The DeepSeek composer was not found; the page structure may have changed',
  'dsweb.submitted': 'Submitted, waiting for DeepSeek to answer…',
  'dsweb.timeout': 'No completed answer within {seconds} seconds',
  'dsweb.answer': 'DeepSeek’s answer',
  'dsweb.unavailable': 'Could not submit automatically — please finish logging in or sending in the host window',

  'translate.opening': 'Opening {engine} translation…',
  'translate.siteResult': 'The {engine} result is open in the side browser',
  'translate.fallbackUsed': '{engine} had no extractable translation; falling back to the DeepSeek web page',
  'translate.failed': 'Translation failed: {error}',
  'translate.target': 'Target language',
  'translate.engine': 'Translation engine',
  'translate.empty': 'Nothing is selected',

  'settings.title': 'Side browser',
  'settings.description': 'Put the DeepSeek web app, a search engine and translation sites into the DSH right sidebar, and act on selected text with one click.',
  'settings.notExposed': 'This DSH build does not expose this plugin’s settings namespace to the configuration page. Edit ~/.dsh/settings.yaml directly, or allow the namespace in the Host settings allowlist and restart.',
  'settings.readOnly': 'This deployment stores settings read-only.',
  'settings.expand': 'Show settings',
  'settings.collapse': 'Hide settings',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.discard': 'Discard',
  'settings.unsaved': 'Unsaved',
  'settings.saveFailed': 'The deployment did not accept these values; they are left for you to correct.',
  'settings.invalidNumber': 'Enter a number, or leave blank to use the default.',
  'settings.inherit': 'Inherit',
  'settings.on': 'On',
  'settings.off': 'Off',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.defaultUrl': 'URL opened by default',
  'settings.defaultUrlHint': 'The address the side-browser tab visits when it opens.',
  'settings.pollInterval': 'Screenshot interval (seconds)',
  'settings.pollIntervalHint': 'How often the host window is captured, from 1 to 10 seconds. Shorter is smoother but busier; the default is 2.',
  'settings.targetLanguage': 'Translation target language',
  'settings.targetLanguageHint': 'The target language used when you press Translate on selected text.',
  'settings.translationEngine': 'Translation engine',
  'settings.translationEngineHint': 'A translation site is faster; the DeepSeek web page explains better but fills your chat history.',
  'settings.enablePopup': 'Selection mini-popup',
  'settings.enablePopupHint': 'Show an “AI explain / Translate / Copy” box beside text you select in a conversation.',
  'settings.enableAgentTools': 'Browser tools for the agent',
  'settings.enableAgentToolsHint': 'Give the session’s model the browser_* tools so it can read and operate this browser window.',
  'settings.shortcuts': 'Shortcut URLs',
  'settings.shortcutsHint': 'One “name URL” pair per line. These become the shortcut buttons in the sidebar browser.',
  'settings.shortcutsInvalid': 'Line {line} is not a usable URL',
  'settings.shortcutsSaved': 'Shortcuts saved',
}

/** The dictionary key union. */
export type SideBrowserKey = keyof typeof zh

/**
 * The active dictionary, picked from the document language.
 *
 * This is the fallback path only: once {@link setRuntimeTranslate} has wired
 * the locale service, `t` never reads it.
 * @returns the dictionary for the document language.
 */
export function dictionary(): Record<SideBrowserKey, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/**
 * The SDK translate seat, wired by `apply()` once `ctx.locale` is bound.
 *
 * Reading the active locale at call time (rather than closing over one
 * dictionary) is what lets a language switch reach an already-mounted panel
 * without reloading the page.
 */
let runtimeT: ((key: SideBrowserKey, params?: Record<string, string>) => string) | undefined

/**
 * Wire (or, with `undefined`, unwire) the SDK translate seat.
 * @param translate - the namespace-bound translate, or undefined to restore the document-language pick.
 */
export function setRuntimeTranslate(translate: ((key: SideBrowserKey, params?: Record<string, string>) => string) | undefined): void {
  runtimeT = translate
}

/**
 * Translate one key.
 *
 * The locale service substitutes `{name}` placeholders itself; the fallback
 * path does the same here so both behave identically for the panel.
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns the translated string.
 */
export function t(key: SideBrowserKey, params?: Record<string, string>): string {
  if (runtimeT !== undefined) return runtimeT(key, params)
  let text: string = dictionary()[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}
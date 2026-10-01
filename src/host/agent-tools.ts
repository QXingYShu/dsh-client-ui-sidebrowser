/**
 * Agent tools for the sidebar browser: the DSH-native counterpart of the panel.
 *
 * Every tool drives the same {@link BrowserDriver} the sidebar drives, so a page
 * the user opened by hand is a page the agent can read, and a page the agent
 * opened appears in the user's sidebar. That shared state is the whole point of
 * the feature: the user keeps looking at DeepSeek web in a real Chrome window,
 * and the agent operates exactly that window.
 *
 * Domain refusals come back as `ok: false` values the model can read and react
 * to, rather than as thrown tool errors: "this page needs a login" is something
 * the model should report to the user, not an internal fault to retry.
 *
 * Deliberately absent: a raw `eval` tool. Exposing arbitrary JavaScript
 * execution inside the user's logged-in browser would let any page-rendered
 * content become an injection vector. The tools below cover navigation, reading,
 * clicking, typing, keys, scrolling and tabs — everything a browsing assistant
 * legitimately needs, and nothing that is a code-execution primitive.
 *
 * @module dsh-sidebrowser/host/agent-tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BrowserError, type BrowserDriver } from '../browser/driver.ts'

/** Unconstrained JSON value the tools return (their output schema is the JSON node). */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Registered tool names, in registration order. */
export const SIDEBROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_read',
  'browser_act',
  'browser_tabs',
  'browser_screenshot',
] as const

/** Model-facing JSON rendering shared by every tool. */
function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value: unknown): Json {
  return value as Json
}

/** A domain refusal the model is expected to read and act on. */
function refused(code: string, message: string): Json {
  return json({ ok: false, code, message })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Translate a driver failure into a stable code the model can branch on.
 *
 * The two codes that matter to a model are `no-browser` (the user must install
 * Chrome or point the plugin at one) and `selector-not-found` (the model's
 * assumption about the page was wrong and it should re-read the page).
 * @param error - the thrown value.
 * @returns the tool's refusal envelope.
 */
function refusedFrom(error: unknown): Json {
  if (error instanceof BrowserError) {
    return refused(error.code, error.message)
  }
  return refused('browser-failed', messageOf(error))
}

/** A compact tab projection for the model. */
function tabView(tab: { id: string, url: string, title: string, selected: boolean }): Record<string, unknown> {
  return { id: tab.id, title: tab.title, url: tab.url, selected: tab.selected }
}

/**
 * Build every side-browser agent tool.
 *
 * @param driver - the browser controller the tools drive.
 * @returns the tool definitions, in {@link SIDEBROWSER_TOOL_NAMES} order.
 */
export function buildSidebrowserTools(driver: BrowserDriver): ToolDefinition[] {
  return [
    buildOpenTool(driver),
    buildReadTool(driver),
    buildActTool(driver),
    buildTabsTool(driver),
    buildScreenshotTool(driver),
  ]
}

function buildOpenTool(driver: BrowserDriver): ToolDefinition {
  return defineTool({
    name: 'browser_open',
    description: [
      'Open a URL in the sidebar browser and return the new tab id, title, and url.',
      'Pass a full http(s) url, or one of the built-in shortcuts: deepseek (the DeepSeek web chat), bing, baidu, youdao (有道翻译), google, googleTranslate.',
      'The browser is a real Chrome window on the user\'s desktop with its own persistent profile, so the user stays signed in to DeepSeek and you are driving the same window they are looking at; if the page shows a sign-in wall, ask the user to log in there rather than trying to authenticate for them.',
      'Every open creates a new tab, so the user\'s current page is never navigated out from under them; use browser_tabs to switch between them.',
      'Triggers: 打开网页, open url, 上网页, 浏览网页, browser, side browser, 侧边栏浏览器, deepseek 网页版, 百度, bing, 有道翻译.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'A full http(s) url, or a shortcut name (deepseek, bing, baidu, youdao, google, googleTranslate).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const tab = await driver.open(args.url)
        // A freshly created target has no title until its first paint, so the
        // snapshot is taken after the fact rather than reporting an empty one.
        const snapshot = await driver.snapshot(tab.id).catch(() => undefined)
        return json({
          ok: true,
          tabId: tab.id,
          title: snapshot?.title !== undefined && snapshot.title !== '' ? snapshot.title : tab.title,
          url: snapshot?.url !== undefined && snapshot.url !== '' ? snapshot.url : tab.url,
          selected: tab.selected,
        })
      } catch (error) {
        return refusedFrom(error)
      }
    },
  })
}

function buildReadTool(driver: BrowserDriver): ToolDefinition {
  return defineTool({
    name: 'browser_read',
    description: [
      'Read the current page of the sidebar browser as text: the visible rendered text plus the title and url, so you can see what the user is looking at.',
      'Pass includeInventory to also get headings, links, and a compact list of form fields with selectors — use it once before clicking or typing so your selectors are real rather than guessed.',
      'The text is capped (default 8000 characters, hard ceiling 200000); pass maxChars to raise or lower it.',
      'This reads rendered text, not the DOM, so it sees what a human would see and nothing hidden by CSS.',
      'Triggers: 读取网页, 看看网页, read page, browser read, 网页内容, 页面内容, 侧边栏, side browser, 当前网页.',
    ].join(' '),
    parameters: {
      tabId: { type: 'string', description: 'Which tab to read; omit for the currently selected one.' },
      maxChars: { type: 'integer', description: 'Cap on returned characters (default 8000, ceiling 200000).' },
      includeInventory: { type: 'boolean', description: 'Also return headings, links, and form-field selectors (default false).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const result = await driver.extractText({
          ...(args.maxChars === undefined ? {} : { maxChars: args.maxChars }),
          includeInventory: args.includeInventory === true,
        }, args.tabId)
        return json({
          ok: true,
          title: result.title,
          url: result.url,
          text: result.text,
          truncated: result.truncated,
          ...(result.inventory === undefined ? {} : { inventory: result.inventory }),
        })
      } catch (error) {
        return refusedFrom(error)
      }
    },
  })
}

function buildActTool(driver: BrowserDriver): ToolDefinition {
  return defineTool({
    name: 'browser_act',
    description: [
      'Perform one action in the sidebar browser and return a short confirmation with the resulting url and title.',
      'Actions: navigate (url or shortcut), click (selector, or x plus y viewport coordinates), type (text into selector, or into whatever has focus when selector is omitted), key (one key name such as Enter, Tab, Escape), scroll (deltaY in pixels, default 600), back, forward, reload.',
      'To type into a page, call browser_read with includeInventory once to learn the real selectors, then click the field and type; pressing Enter after typing is usually what submits the form or runs the search.',
      'Actions run against the currently selected tab unless you pass a tabId from browser_open or browser_tabs.',
      'Triggers: 操作网页, 点击网页, 输入, click page, type in page, scroll page, 网页操作, browser act, 侧边栏, side browser, 刷新网页, 返回.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['navigate', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'reload'],
        description: 'The action to perform.',
      },
      url: { type: 'string', description: 'For navigate: a full http(s) url or a shortcut name.' },
      selector: { type: 'string', description: 'For click and type: a CSS selector for the target element.' },
      text: { type: 'string', description: 'For type: the literal text to enter.' },
      key: { type: 'string', description: 'For key: a key name such as Enter, Tab, Escape, ArrowDown.' },
      x: { type: 'number', description: 'For click by coordinates: viewport x.' },
      y: { type: 'number', description: 'For click by coordinates: viewport y.' },
      deltaY: { type: 'number', description: 'For scroll: vertical pixels, positive scrolls down (default 600).' },
      tabId: { type: 'string', description: 'Which tab to act on; omit for the currently selected one.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const tabId = args.tabId
      try {
        switch (args.action) {
          case 'navigate': {
            if (args.url === undefined || args.url === '') return refused('url-required', 'navigate needs a url or a shortcut name')
            const snapshot = await driver.navigate(args.url, tabId)
            return json({ ok: true, action: args.action, ...snapshot })
          }
          case 'click': {
            const hasSelector = args.selector !== undefined && args.selector !== ''
            const hasPoint = typeof args.x === 'number' && typeof args.y === 'number'
            if (!hasSelector && !hasPoint) {
              return refused('bad-click', 'click needs either a selector or both x and y coordinates')
            }
            await driver.click({
              ...(args.selector === undefined ? {} : { selector: args.selector }),
              ...(typeof args.x === 'number' ? { x: args.x } : {}),
              ...(typeof args.y === 'number' ? { y: args.y } : {}),
              ...(tabId === undefined ? {} : { tabId }),
            })
            return json({ ok: true, action: args.action, ...(await driver.snapshot(tabId)) })
          }
          case 'type': {
            if (args.text === undefined || args.text === '') return refused('text-required', 'type needs the text to enter')
            await driver.typeText(args.text, args.selector, tabId)
            return json({ ok: true, action: args.action, typed: args.text.length, ...(await driver.snapshot(tabId)) })
          }
          case 'key': {
            if (args.key === undefined || args.key === '') return refused('key-required', 'key needs a key name such as Enter')
            await driver.pressKey(args.key, tabId)
            return json({ ok: true, action: args.action, key: args.key, ...(await driver.snapshot(tabId)) })
          }
          case 'scroll': {
            const deltaY = typeof args.deltaY === 'number' ? args.deltaY : 600
            await driver.scroll(deltaY, tabId)
            return json({ ok: true, action: args.action, deltaY, ...(await driver.snapshot(tabId)) })
          }
          case 'back':
            return json({ ok: true, action: args.action, ...(await driver.back(tabId)) })
          case 'forward':
            return json({ ok: true, action: args.action, ...(await driver.forward(tabId)) })
          case 'reload':
            return json({ ok: true, action: args.action, ...(await driver.reload(tabId)) })
          default:
            return refused('unknown-action', `unsupported action ${JSON.stringify(args.action)}`)
        }
      } catch (error) {
        return refusedFrom(error)
      }
    },
  })
}

function buildTabsTool(driver: BrowserDriver): ToolDefinition {
  return defineTool({
    name: 'browser_tabs',
    description: [
      'List, open, close, or select tabs in the sidebar browser.',
      'list (the default) returns every tab with its id, title, url, and which one is selected; open takes a url or shortcut name; close takes a tabId; select takes a tabId and makes it the tab later actions act on.',
      'Actions without a tabId use the selected tab, so select first if you mean a specific page.',
      'Triggers: 标签页, tabs, 多标签, 切换标签, switch tab, 关闭标签, side browser, 侧边栏浏览器.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'close', 'select'],
        description: 'What to do with tabs (default list).',
      },
      url: { type: 'string', description: 'For open: a full http(s) url or a shortcut name.' },
      tabId: { type: 'string', description: 'For close and select: the tab to act on.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = args.action ?? 'list'
      try {
        switch (action) {
          case 'list': {
            const tabs = await driver.listTabs()
            return json({ ok: true, count: tabs.length, tabs: tabs.map(tabView) })
          }
          case 'open': {
            if (args.url === undefined || args.url === '') return refused('url-required', 'open needs a url or a shortcut name')
            const tab = await driver.open(args.url)
            return json({ ok: true, action, tab: tabView(tab) })
          }
          case 'close': {
            if (args.tabId === undefined || args.tabId === '') return refused('tab-id-required', 'close needs a tabId')
            await driver.closeTab(args.tabId)
            const tabs = await driver.listTabs()
            return json({ ok: true, action, tabId: args.tabId, tabs: tabs.map(tabView) })
          }
          case 'select': {
            if (args.tabId === undefined || args.tabId === '') return refused('tab-id-required', 'select needs a tabId')
            return json({ ok: true, action, tab: tabView(await driver.selectTab(args.tabId)) })
          }
          default:
            return refused('unknown-action', `unsupported action ${JSON.stringify(action)}`)
        }
      } catch (error) {
        return refusedFrom(error)
      }
    },
  })
}

function buildScreenshotTool(driver: BrowserDriver): ToolDefinition {
  return defineTool({
    name: 'browser_screenshot',
    description: [
      'Capture the sidebar browser\'s current page as a PNG file on the Host and return its path.',
      'It returns a file path rather than inline image data on purpose: a base64 PNG is megabytes, and pasting one into the transcript would bloat every later context window that carries this session. Read the file if you actually need to see the pixels.',
      'Use it when rendered text is not enough — a canvas, a chart, a video frame, or a sign-in or CAPTCHA wall you need to describe to the user.',
      'By default the frame is captured at half scale, which is enough to recognise layout and controls; pass fullPage to capture the whole scrollable page, or scale to choose another factor between 0.2 and 1.',
      'Triggers: 截图, 看看页面长什么样, screenshot, 页面截图, browser screenshot, 侧边栏截图.',
    ].join(' '),
    parameters: {
      tabId: { type: 'string', description: 'Which tab to capture; omit for the currently selected one.' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page rather than the viewport (default false).' },
      scale: { type: 'number', description: 'Downsample factor between 0.2 and 1 (default 0.5).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      const scale = typeof args.scale === 'number' ? Math.min(Math.max(args.scale, 0.2), 1) : 0.5
      try {
        const path = await driver.captureScreenshotToFile(args.tabId, args.fullPage === true, scale)
        const snapshot = await driver.snapshot(args.tabId).catch(() => undefined)
        return json({
          ok: true,
          path,
          title: snapshot?.title ?? '',
          url: snapshot?.url ?? '',
          fullPage: args.fullPage === true,
          scale,
          note: 'The PNG is on the Host filesystem at this path; read it with a file tool if you need the image content.',
        })
      } catch (error) {
        return refusedFrom(error)
      }
    },
  })
}
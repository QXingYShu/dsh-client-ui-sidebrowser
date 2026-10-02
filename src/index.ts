/**
 * Host loader entry for the side-browser plugin.
 *
 * The Host owns the Chrome process, the CDP connection, the control routes, and
 * the agent tools. The browser half is a same-origin asynchronous view over that
 * service: it polls `/api/sidebrowser/frame` for the live image and posts to the
 * control routes, while the real Chrome window sits on the user's desktop.
 *
 * Why a real Chrome window rather than an embedded view: DeepSeek web, Bing,
 * Baidu and every other site worth putting in this sidebar refuse to be framed
 * (X-Frame-Options / frame-ancestors CSP). There is no iframe embedding that
 * works, so the plugin drives a genuine browser and mirrors it. The cost of that
 * choice — the client shows a screenshot stream, not a live interactive surface
 * — is paid knowingly, and it buys the property that actually matters here: the
 * user signs into DeepSeek once in a real window with a persistent profile, and
 * the agent then operates that authenticated session.
 *
 * @module dsh-sidebrowser
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { BrowserDriver } from './browser/driver.ts'
import { ScreenshotStream } from './browser/screenshot-stream.ts'
import { makeSidebrowserRoutes } from './host/routes.ts'
import { buildSidebrowserTools } from './host/agent-tools.ts'

/**
 * Services this row needs.
 *
 * `webServer` is required: the client half is a same-origin fetch away from
 * these routes, so without it there is no sidebar at all. `tools` is
 * deliberately NOT injected — like the task board, a deployment whose runtime
 * serves no tool registry must still mount the browser and lose only the
 * agent-facing surface, rather than fail to load.
 *
 * `systemPrompt` is likewise resolved optionally rather than injected: the
 * announcement below tells the model the browser exists, which is what makes the
 * tools discoverable, but a deployment without the prompt assembler must still
 * mount.
 */
export const inject = ['webServer']

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * Every field is marked volatile so the Host commits an edit into this running
 * fiber's references instead of remounting the row — a remount would dispose
 * the driver, which kills the user's Chrome window and loses their login flow
 * mid-session. The settings form the Host renders is this schema.
 */
export interface Config {
  /** Master switch: when false, the tools and routes answer "disabled". */
  enabled?: Volatile<boolean>
  /** Explicit browser executable; absent means probe the standard Chrome/Edge locations. */
  executablePath?: Volatile<string>
  /** Fixed CDP debugging port; absent or 0 means an OS-assigned free port. */
  port?: Volatile<number>
  /** Chrome profile directory; absent means a stable per-user directory under the temp dir. */
  userDataDir?: Volatile<string>
  /**
   * Show the real Chrome window on the desktop.
   *
   * OFF by default, which is the whole point of the sidebar: the browser runs
   * headless and the page appears in the panel, so nothing pops up in front of
   * the conversation. Turn it on only when you need the real window itself -
   * completing a sign-in by hand, for instance - then turn it off again.
   */
  headless?: Volatile<boolean>
  /** Milliseconds between background screenshot captures. */
  captureIntervalMs?: Volatile<number>
  /** Capture scale for the sidebar's live view, 0.2..1. */
  captureScale?: Volatile<number>
  /**
   * Whether the text-selection mini-popup appears. Owned by the Host rather than
   * the client so the toggle has one durable home: the client reads it over the
   * settings form instead of keeping a second copy in browser storage.
   */
  selectionPopup?: Volatile<boolean>
  /**
   * Whether the `browser_*` agent tools are registered. Defaults to true; a
   * deployment that prefers a model without browser control can turn it off
   * without disabling the sidebar itself.
   */
  agentTools?: Volatile<boolean>
  /** URL the sidebar opens on a fresh tab. Must be http(s); empty means the shipped default. */
  defaultUrl?: Volatile<string>
  /**
   * Extra quick-launch shortcuts, one `name url` per line.
   *
   * A line format rather than a nested object because the settings form stores
   * one value per field, and a parsed array would have to survive a round trip
   * through the Host's own schema projection.
   */
  shortcuts?: Volatile<string>
  /**
   * Language the selection popup's 翻译 action targets, as a BCP 47 tag.
   *
   * Stored here rather than in browser storage so the choice follows the profile
   * to another machine, and so the DeepSeek-web bridge and the translation-site
   * path read the same value.
   */
  targetLanguage?: Volatile<string>
  /**
   * Which translation site 翻译 prefers: `auto`, `youdao`, `bing` or `baidu`.
   *
   * `auto` is the default and is deliberately not one site: a single-word
   * selection is an explanation request and goes to 有道, while a sentence is a
   * translation request and goes to Bing, because 有道's URL form does not
   * carry a full sentence usefully.
   */
  translationEngine?: Volatile<string>
}

/**
 * Read one config field's current value.
 *
 * The Host hands schema-volatile fields as stable references it commits in
 * place, so a live value must be read at use time rather than captured when the
 * plugin activates. A plain value (a programmatic mount, or a field the schema
 * does not mark volatile) is returned as it stands.
 * @param field - the config field as the Host handed it.
 * @param fallback - value to use when the field is absent.
 * @returns the effective field value.
 */
export function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as Volatile<T>).get() as T
  }
  return field as T
}

/**
 * The schema is left to inference rather than annotated with `z<Config>`: a
 * volatile field's parsed output is a `Volatile` reference while its accepted
 * input stays the plain value, so the two sides no longer share one shape and
 * the annotation would reject the schema the Host must be given.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  executablePath: z.string().default('').volatile(),
  port: z.number().default(0).volatile(),
  userDataDir: z.string().default('').volatile(),
  headless: z.boolean().default(true).volatile(),
  captureIntervalMs: z.number().min(250).max(10_000).default(1000).volatile(),
  captureScale: z.number().min(0.2).max(1).default(0.5).volatile(),
  selectionPopup: z.boolean().default(true).volatile(),
  agentTools: z.boolean().default(true).volatile(),
  defaultUrl: z.string().default('https://chat.deepseek.com/').volatile(),
  shortcuts: z.string().default('').volatile(),
  targetLanguage: z.string().default('zh-Hans').volatile(),
  translationEngine: z.string().default('auto').volatile(),
})

/** The registry face the agent tools register into. */
interface AgentToolRegistry {
  register(definition: ToolDefinition): () => void
}

/**
 * The prompt-assembler face the announcement registers into.
 *
 * The real contract is `section({ name, order, text })`: `order` must be a finite
 * number or the assembler throws a TypeError, and the rendered body is read from
 * `text`. There is no `content` field, so a section carrying one would register
 * without error and then render as nothing.
 */
interface PromptSectionRegistry {
  section(section: { name: string, order: number, text: string }): () => void
}

/**
 * Resolve the optional agent-tool registry.
 *
 * Like the task board, the browser's most important consumer is the sidebar, so
 * a deployment serving no registry must still mount the whole thing.
 * @param ctx - the plugin context.
 * @returns the registry, or undefined when this deployment serves none.
 */
export function resolveToolRegistry(ctx: Context): AgentToolRegistry | undefined {
  try {
    const tools = ctx.get('tools') as AgentToolRegistry | undefined
    return tools !== undefined && typeof tools.register === 'function' ? tools : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the optional system-prompt assembler.
 * @param ctx - the plugin context.
 * @returns the assembler, or undefined when this deployment serves none.
 */
export function resolvePromptRegistry(ctx: Context): PromptSectionRegistry | undefined {
  try {
    const prompt = ctx.get('systemPrompt') as PromptSectionRegistry | undefined
    return prompt !== undefined && typeof prompt.section === 'function' ? prompt : undefined
  } catch {
    return undefined
  }
}

/**
 * What the model is told about this plugin, in the house style: one dense
 * paragraph ending in a `Triggers:` line of the words a user would actually say.
 *
 * The announcement matters more here than for most plugins, because the tools
 * are otherwise invisible — the user opens a page in the sidebar and the model
 * has no reason to suspect it can see it at all.
 */
export const SIDEBROWSER_GUIDANCE = [
  '本机已安装 dsh-sidebrowser 插件（DSH Web GUI 的右侧栏浏览器）：右侧栏可打开 DeepSeek 网页版、Bing、有道词典/必应翻译或任意网址。Host 驱动一个真实的 Chrome（这些站点禁止被 iframe 嵌套，所以无法内嵌），默认以无窗口方式运行，右侧栏直接显示它的实时画面；需要时可调出真实窗口（例如让用户手动登录 DeepSeek），登录态存在独立 profile 目录里，关掉窗口不会掉线。',
  '另注册 browser_* 代理工具：browser_open 打开网址、browser_read 读取当前页面文字（可带结构清单）、browser_act 执行导航/点击/输入/按键/滚动、browser_tabs 管理标签页、browser_screenshot 截图并返回主机文件路径。',
  '因此你可以看到并操作用户正在浏览的页面；用户选中对话中的单词或句子时，右侧栏还会出现「AI解释」（走 DeepSeek 网页版会话）与「翻译」入口。',
  '用户提到「打开网页、浏览器、右侧栏、查一下、搜一下、翻译、AI解释」时即可使用本插件。',
].join(' ')

/**
 * Single-instance guard: run at most one mount of this package per process.
 *
 * Two live mounts would fight over one Chrome profile directory (Chrome refuses
 * a second process on the same user-data-dir) and would double-register the
 * routes. The name is released when the holder's fiber disposes, so a Host
 * reload can mount again.
 * @param packageName - npm package identity shared by every install source.
 * @param fn - the original plugin apply.
 * @returns an apply of the same shape.
 */
export function mountOnce<T extends (...args: never[]) => unknown>(packageName: string, fn: T): T {
  const MOUNTED = Symbol.for('dsh-sidebrowser.mounted')
  const mounted = ((globalThis as Record<symbol, unknown>)[MOUNTED] ??= new Set<string>()) as Set<string>
  const mount = (...args: never[]): unknown => {
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0] as { effect?: (effect: () => unknown) => unknown } | undefined
    ctx?.effect?.(() => () => { mounted.delete(packageName) })
    return fn(...args)
  }
  return mount as T
}

/**
 * Activate the side browser's host half: the Chrome driver, the screenshot
 * stream, the control routes, and the agent tools.
 *
 * The whole lifetime lives inside one `ctx.effect`, so unloading the row tears
 * down the routes, the tools, the capture timer, and the Chrome process
 * together. Nothing is launched eagerly: the first tool call, route hit, or
 * sidebar mount pulls the browser up, because mounting a plugin must not pop a
 * browser window on every Host start.
 * @param ctx - the plugin context (webServer injected).
 * @param config - resolved plugin config (schema defaults applied by the Host).
 */
export const apply = mountOnce('@dsh-external/dsh-client-ui-sidebrowser', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  /** Current master switch. */
  const enabled = (): boolean => readConfigField(config?.enabled, true)

  /**
   * Whether the agent-facing surface is wanted.
   *
   * Separate from {@link enabled} on purpose: turning the whole plugin off
   * should also close the routes, but a deployment that wants the sidebar
   * without giving the model browser control should be able to say so. Both
   * switches are read at use time because volatile config fields commit in
   * place rather than remounting the fiber.
   */
  const agentToolsEnabled = (): boolean => enabled() && readConfigField(config?.agentTools, true)

  const driver = new BrowserDriver({
    executablePath: readConfigField(config?.executablePath, '') || undefined,
    port: readConfigField(config?.port, 0),
    userDataDir: readConfigField(config?.userDataDir, '') || undefined,
    headless: readConfigField(config?.headless, true),
  })
  const stream = new ScreenshotStream(driver, {
    intervalMs: readConfigField(config?.captureIntervalMs, 1000),
    scale: readConfigField(config?.captureScale, 0.5),
    // A failed capture is almost always "the browser is not attached yet",
    // which resolves on the next tick; logging every miss would spam the Host
    // console on an idle sidebar.
    onError: () => undefined,
  })

  // Agent tools share the driver with the sidebar, so a page the user opened is
  // a page the agent reads. Registration is deferred to the effect below and
  // released with it.
  let disposeTools: (() => void) | undefined
  const setToolsEnabled = (active: boolean): void => {
    if (!active) {
      disposeTools?.()
      disposeTools = undefined
      return
    }
    if (disposeTools !== undefined) return
    const registry = resolveToolRegistry(ctx)
    if (registry === undefined) return
    const disposers = buildSidebrowserTools(driver).map(tool => registry.register(tool))
    disposeTools = () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }

  /**
 * The plugin's current settings, as the client half should see them.
 *
 * Every field is volatile, so each value is read at use time rather than
 * captured once. Only plain, serialisable values are exposed: the client runs in
 * the browser and cannot hold a `Volatile` reference.
 * @returns the settings object served by `/api/sidebrowser/config`.
 */
const settingsSnapshot = (): Record<string, unknown> => ({
  enabled: enabled(),
  selectionPopup: readConfigField(config?.selectionPopup, true),
  agentTools: agentToolsEnabled(),
  defaultUrl: readConfigField(config?.defaultUrl, 'https://chat.deepseek.com/'),
  captureIntervalMs: readConfigField(config?.captureIntervalMs, 2_000),
  targetLanguage: readConfigField(config?.targetLanguage, 'zh-Hans'),
  translationEngine: readConfigField(config?.translationEngine, 'auto'),
  shortcuts: readConfigField(config?.shortcuts, ''),
  executablePath: readConfigField(config?.executablePath, ''),
  port: readConfigField(config?.port, 0),
  userDataDir: readConfigField(config?.userDataDir, ''),
  headless: readConfigField(config?.headless, true),
  captureScale: readConfigField(config?.captureScale, 0.5),
})

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeSidebrowserRoutes(driver, stream, settingsSnapshot)) disposers.push(ctx.webServer.register(route))
      setToolsEnabled(agentToolsEnabled())
      // The capture timer only runs while the row is mounted. It is started here
      // (not at apply time) so a disabled row costs nothing, and it never
      // launches Chrome on its own: a failed tick before first use is a no-op.
      if (enabled()) stream.start()

      // `tools` is resolved optionally above so a deployment that never serves a
      // registry still mounts the sidebar. The cost of that choice is that the
      // registry may activate *after* this row mounts, in which case the first
      // resolve found nothing and the tools would never attach. A scoped inject
      // re-runs the callback when `tools` actually becomes available, which
      // closes that ordering gap without making the row depend on the registry.
      //
      // `ctx.inject` returns a Fiber, not a disposer: it disposes itself with its
      // parent, so there is nothing to push onto `disposers` here.
      ctx.inject?.(['tools'], () => {
        setToolsEnabled(agentToolsEnabled())
        return () => setToolsEnabled(false)
      })
    } catch (error) {
      // A failed mount must not leave the tools bound to a driver whose effect
      // cleanup will never run.
      setToolsEnabled(false)
      for (const dispose of disposers) dispose()
      stream.dispose()
      void driver.dispose()
      throw error
    }

    // The system-prompt announcement is registered in its OWN effect, outside the
    // try above, on purpose. An optional surface must never be able to take down
    // the required one: `section()` throws on a malformed record, and a throw
    // inside that try would un-register all the routes and the agent tools this
    // plugin exists to provide, turning one bad optional call into a total
    // outage. Here a failure costs the announcement and nothing else.
    ctx.effect(() => {
      const prompt = resolvePromptRegistry(ctx)
      if (prompt === undefined) return () => {}
      try {
        return prompt.section({ name: 'sidebrowser', order: 100, text: SIDEBROWSER_GUIDANCE })
      } catch (error) {
        console.error('[dsh-sidebrowser] could not announce the browser to the agent:', error)
        return () => {}
      }
    }, 'sidebrowser: system prompt announcement')

    return () => {
      setToolsEnabled(false)
      for (const dispose of disposers.splice(0)) dispose()
      stream.dispose()
      void driver.dispose()
    }
  }, 'sidebrowser: chrome driver, control routes, and agent tools')
}
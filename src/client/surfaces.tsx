/**
 * The plugin's React surfaces and their slot registrations.
 *
 * ## What this file does
 *
 * It registers the plugin's tab type with the right Sidebar's registry (stage
 * one), contributes the tab body, its title and a menu item into the shell's
 * keyed seats (stage two), mounts the selection mini-popup as a document-level
 * host, and contributes a left-sidebar footer row plus a settings card. Both
 * registration stages are the documented public path an out-of-product tab
 * type uses — no shell edits, and nothing registered into the occupied
 * `rightbar` seat.
 *
 * It is a `.tsx` sibling rather than the entry itself because the entry has to
 * stay `index.ts` — the build's declared client entry — while this module needs
 * JSX. `index.ts` re-exports everything below, so the published surface is the
 * same either way.
 *
 * It registers the plugin's tab type with the right Sidebar's registry (stage
 * one), contributes the tab body, its title and a menu item into the shell's
 * keyed seats (stage two), mounts the selection mini-popup as a document-level
 * host, and contributes a left-sidebar footer row plus a settings card. Both
 * registration stages are the documented public path an out-of-product tab
 * type uses — no shell edits, and nothing registered into the occupied
 * `rightbar` seat.
 *
 * ## Why the kind is `sidebrowser-cdp` and not `browser`
 *
 * `@deepseek-ai/dsh-client-ui-sidebar-browser` ships in this deployment and
 * already registers the kind `browser`, with its own package name as the
 * implementation id. That is a **sandboxed iframe** browser: it renders pages
 * inside the app, which is exactly why it cannot show DeepSeek, Bing, Baidu or
 * Youdao — all of them refuse to be framed cross-origin.
 *
 * This plugin is a different thing: a **remote control for a real Chrome window
 * on the host, driven over CDP**, plus `browser_*` agent tools over the same
 * window and the selection mini-popup. It therefore registers its own kind and
 * its own id, and coexists with the shipped type: both tabs can be open at
 * once, neither shadows the other, because they are separate keys under
 * separate implementations. The `cdp` suffix also makes the distinction obvious
 * in a persisted layout.
 *
 * ## Failure policy
 *
 * A client plugin that throws during `apply` takes the whole web shell's boot
 * with it, so every registration here is guarded. A deployment without the
 * right Sidebar leaves this plugin absent; a refused slot registration logs and
 * continues; a Host with no browser attached leaves the panel showing an honest
 * "no browser" line rather than a spinner that never resolves.
 *
 * @module
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  SidebarRightTabDefinition,
  UseSidebarRightTabInfo,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SideBrowserApi } from './api.ts'
import { en, setRuntimeTranslate, t, zh, type SideBrowserKey } from './locales.ts'
import { parseShortcuts } from './shortcuts.ts'
import { SideBrowserPanel, resolveAddress } from './panel.tsx'
import { SelectionHost } from './selection-host.tsx'
import { TRANSLATION_ENGINES } from './deepseek-web.ts'
import {
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  SideBrowserSettingsCard,
  bindSettingsForm,
  createSettingsSubscription,
  effectiveSettings,
  type EffectiveSettings,
  type SideBrowserSettings,
} from './settings-card.tsx'
import css from './sidebrowser.module.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /**
     * The side-browser page's navigation parameters.
     *
     * Declared so `openTab('sidebrowser-cdp', { params: { url } })` typechecks
     * for any caller. A body narrows `navigation.params` by its own address,
     * exactly as the shipped Browser page narrows its `{ url?: string }`.
     */
    'sidebrowser-cdp': {
      /** URL the tab should open when it appears. */
      readonly url?: string
    }
  }
}

/** Locale namespace this plugin owns. */
const NS = 'sidebrowser'

/**
 * This implementation's identity in the tab system: unique across every
 * registration, and the key the body and title register under.
 *
 * A package name is the natural value and the one the shipped Browser type
 * uses, so this follows that convention while staying distinct from it.
 */
export const SIDEBROWSER_TAB_ID = '@dsh-external/dsh-client-ui-sidebrowser'

/**
 * This implementation's tab kind — what `openTab` names and the shell dispatches
 * by. Deliberately not `browser`, which the shipped iframe tab already owns.
 */
export const SIDEBROWSER_TAB_KIND = 'sidebrowser-cdp'

/**
 * How long a popup waits for a DeepSeek answer before giving up.
 *
 * DeepSeek reasons before it answers, so this is generous; the popup reports a
 * timeout as its own outcome rather than leaving the user watching a spinner.
 */
const ANSWER_TIMEOUT_MS = 90_000

/** The one route client every surface shares, so remounts do not restart polls. */
const api = new SideBrowserApi()

/**
 * Services this half consumes.
 *
 * These are **not** the `dsh.client.inject` profile entry ids; that array names
 * the plugin entries to load before this half and is owned by `package.json`.
 * The entry ids this half needs there are the right Sidebar (which declares the
 * seats and provides `sidebarRight`/`sidebarRightTabs`), the layout plugin, the
 * locale service and the slot framework's renderer.
 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'layout']

/** The structural slice of the slot registry this half uses. */
interface SlotRegistry {
  /** Register a contribution once the named seat is declared. */
  inject(key: string, callback: () => () => void): () => void
  /** Contribute one entry to a declared seat. */
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * Read one service, tolerating its absence.
 *
 * An absent service is the "this deployment does not ship that plugin" case
 * rather than a failure, so every read here is guarded and the plugin degrades.
 * Cordis returns `undefined` for an unserved service (verified against
 * @deepseek-ai/cordis 4.0.4) rather than throwing, but a client context can also
 * be a plain object without `get` at all, and a throwing stub must not take the
 * whole apply down — hence the shape check and the catch together.
 * @param ctx - the client context.
 * @param name - the service name.
 * @returns the service, or undefined when it is absent.
 */
function optionalService<T>(ctx: ClientContext | undefined, name: string): T | undefined {
  if (ctx === undefined) return undefined
  try {
    const get = (ctx as unknown as { get?: (key: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Read the slot registry, tolerating a shell that does not serve it.
 * @param ctx - the client context.
 * @returns the registry, or undefined when the shell has none.
 */
function slotRegistry(ctx: ClientContext): SlotRegistry | undefined {
  const service = (ctx as unknown as { slots?: unknown }).slots ?? optionalService<unknown>(ctx, 'slots')
  const candidate = service as Partial<SlotRegistry> | undefined
  if (typeof candidate?.inject !== 'function' || typeof candidate?.register !== 'function') return undefined
  return candidate as SlotRegistry
}

/** Live settings, readable by every surface and updated on each change. */
interface SettingsFeed {
  /** The effective settings right now. */
  read(): SideBrowserSettings
  /** Observe changes; returns an unsubscribe. */
  subscribe(listener: (settings: SideBrowserSettings) => void): () => void
}

/**
 * The settings feed the surfaces read.
 *
 * Assigned by `apply` before any body mounts. The default reads empty, and every
 * surface resolves `undefined` against {@link DEFAULT_SETTINGS}, so a body that
 * somehow renders first still works.
 */
let settingsFeed: SettingsFeed = {
  read: () => ({}),
  subscribe: () => () => {},
}

/**
 * The Host's settings, held for every surface to read.
 *
 * This is what makes the plugin's configuration real. The `configForms` client
 * service the settings used to be bound through is not served by any shipped
 * DSH package, so `bindSettingsForm` always produced an unavailable form and
 * the client silently ran on its compiled-in defaults - which is why a chosen
 * translation site, capture interval or target language never took effect.
 * Reading `/api/sidebrowser/config` uses the channel that actually exists: the
 * Host owns the schema and the volatile fields.
 *
 * The feed object is created once and never replaced, so a surface that
 * subscribed before the first fetch is still notified when values arrive.
 */
let hostSettings: Record<string, unknown> = {}
const settingsListeners = new Set<() => void>()

/** Publish new settings to every mounted surface. */
function publishHostSettings(next: Record<string, unknown>): void {
  hostSettings = next
  for (const listener of [...settingsListeners]) listener()
}

/** The stable feed: reads the latest Host settings, notifies on change. */
const hostSettingsFeed: SettingsFeed = {
  read: () => effectiveSettings(hostSettings),
  subscribe: (listener: (settings: SideBrowserSettings) => void): (() => void) => {
    const wrapped = (): void => listener(effectiveSettings(hostSettings))
    settingsListeners.add(wrapped)
    return () => { settingsListeners.delete(wrapped) }
  },
}

/**
 * Ask the Host for its settings and publish them.
 * @param api - the route client.
 * @returns nothing; a failed read leaves the compiled-in defaults in place.
 */
async function loadHostSettings(api: SideBrowserApi): Promise<void> {
  const result = await api.config()
  if (!result.ok) return
  publishHostSettings(result.value)
}

/**
 * The client context, captured for components that receive no props.
 *
 * The footer row and the menu item are registered as bare components with no
 * injected props, so they cannot close over the context through props. Holding
 * it here — once, at apply time — is what lets them reach `ctx.sidebarRight`.
 */
let clientContext: ClientContext | undefined

/**
 * The tab type this plugin contributes.
 *
 * A **page** type: it declares no `patterns`, because it recognizes no resource
 * address and is opened by kind. It sets no `priority`, because the default band
 * is `extension` — the correct one for a type from outside the product, and the
 * band that may take over a builtin's kind were that ever wanted.
 *
 * `multiple` is on because two side-browser tabs over one host window are not
 * obviously useful, but deduplication is a decision this plugin's users should
 * make rather than one the shell imposes. `keepMounted` is off: a browser view is
 * cheap to rebuild (one state read plus a frame poll) and holding a poll loop
 * alive for a hidden tab would waste a capture cycle per second.
 * @returns the definition to register.
 */
function sideBrowserDefinition(): SidebarRightTabDefinition {
  return {
    id: SIDEBROWSER_TAB_ID,
    kind: SIDEBROWSER_TAB_KIND,
    multiple: true,
    keepMounted: false,
    title: () => t('panel.title'),
    guide: [
      {
        id: 'open',
        order: 40,
        title: () => t('panel.title'),
        description: () => t('panel.windowOnDesktopShort'),
      },
    ],
  }
}

/**
 * Subscribe a component to the plugin's live settings, with defaults applied.
 *
 * Returns the *effective* shape rather than the raw stored one so a caller gets
 * a total value: no consumer has to remember that `defaultUrl` may be absent, or
 * that the capture interval is stored in milliseconds and used in seconds.
 * @returns the settings with every field defaulted and units converted.
 */
function useLiveSettings(): EffectiveSettings {
  const [settings, setSettings] = useState<SideBrowserSettings>(() => settingsFeed.read())
  useEffect(() => settingsFeed.subscribe(setSettings), [])
  return effectiveSettings(settings)
}

/**
 * Pick a translation engine by id, or undefined to let the selection decide.
 *
 * `auto` (the default) hands the choice to `engineForSelection`, which sends a
 * single word to 有道 and a sentence to Bing — a word is an explanation request
 * and a sentence is a translation request, and 有道's URL form only answers the
 * first. Any other id is an explicit pin and is honoured as written.
 * @param id - the configured engine id.
 * @returns the pinned engine, or undefined when the setting is `auto`.
 */
function engineFor(id: string | undefined): (typeof TRANSLATION_ENGINES)[number] | undefined {
  if (id === undefined || id === '' || id === 'auto') return undefined
  return TRANSLATION_ENGINES.find(engine => engine.id === id)
}

/**
 * The tab body, rendered by the shell for every side-browser tab.
 * @param props - the shell's injected props.
 * @returns the panel.
 */
function SideBrowserTabBody(props: Record<string, unknown>): React.ReactElement | null {
  // The slot framework exposes an injected hook as `use<Name>`, and the seat
  // declares its factory under the key `tabInfo` — so the prop the shell
  // actually passes is `useTabInfo`, not `useSidebarRightTabInfo` (which is only
  // the TypeScript type's name). Reading the type name here renders null
  // forever, which is a tab that opens to a blank pane with no error anywhere.
  const useTabInfo = props.useTabInfo as UseSidebarRightTabInfo | undefined
  if (useTabInfo === undefined) return null
  return <SideBrowserTabBodyInner useTabInfo={useTabInfo} />
}

/**
 * The body as a component, so React can subscribe through the injected hook.
 * @param props - the tab-information reader.
 * @returns the panel.
 */
function SideBrowserTabBodyInner(props: {
  useTabInfo: UseSidebarRightTabInfo
}): React.ReactElement {
  const info = props.useTabInfo()
  const navigation = info.tab.navigation
  const settings = useLiveSettings()
  // Command binding is a method on the tab's own action bag, not a second prop:
  // `bindCommands` returns a disposer that must not drop a newer registration,
  // so it is rebound whenever the shell hands this body a different action bag.
  const actions = info.tab.actions
  const bind = useCallback<(commands: { refresh?: () => void }) => () => void>(
    commands => actions.bindCommands(commands),
    [actions],
  )

  // A caller may open this tab with a URL (`openTab('sidebrowser-cdp', {
  // params: { url } })`). Honour it once per navigation revision, then leave the
  // URL to the user — re-navigating on every render would throw away their
  // typing and fight their own back button.
  const appliedRevision = useRef<number>(-1)
  const requestedUrl = navigation.params !== undefined && 'url' in navigation.params
    ? (navigation.params as { url?: string }).url
    : undefined
  if (navigation.revision !== appliedRevision.current) {
    appliedRevision.current = navigation.revision
    const target = resolveAddress(requestedUrl ?? settings.defaultUrl ?? DEFAULT_SETTINGS.defaultUrl)
    // Revision 0 is a seeded record nobody opened by address; navigating then
    // would fight the user every time the shell restores a tab from a layout.
    if (navigation.revision > 0 && target !== '') {
      void api.navigate(target)
    }
  }

  return (
    <SideBrowserPanel
      api={api}
      pollIntervalSeconds={settings.pollIntervalSeconds}
      extraShortcuts={parseShortcuts(settings.shortcuts ?? '')}
      visible={info.tab.visible}
      signal={info.tab.signal}
      bindCommands={bind}
    />
  )
}

/**
 * The tab's chip title: the live host page title.
 *
 * A live title is worth contributing because the chip is what a user reads when
 * several tabs are open, and a chip that always says "侧边浏览器" tells them
 * nothing about which page is where.
 * @returns the title text.
 */
function SideBrowserTabTitle(): React.ReactElement {
  const [title, setTitle] = useState('')
  useEffect(() => {
    let alive = true
    const read = async (): Promise<void> => {
      const result = await api.state()
      if (alive && result.ok && result.value.title !== '') setTitle(result.value.title)
    }
    void read()
    const handle = setInterval(() => { void read() }, 3_000)
    return () => {
      alive = false
      clearInterval(handle)
    }
  }, [])
  return <span>{title === '' ? t('panel.title') : title}</span>
}

/**
 * Open this plugin's tab in the right Sidebar.
 *
 * The single navigation entry point, shared by the footer row and by the guide
 * entry the shell renders. Failures are logged rather than thrown: the shell
 * calls this from a click handler, and a throw there would surface as an
 * unhandled rejection in someone else's plugin.
 */
function openSideBrowserTab(): void {
  try {
    optionalService<{ openTab(kind: string): void }>(clientContext, 'sidebarRight')
      ?.openTab(SIDEBROWSER_TAB_KIND)
  } catch (error) {
    console.error('[dsh-sidebrowser] could not open the side-browser tab:', error)
  }
}

/**
 * The left-sidebar footer row: opens the tab and expands the column.
 * @returns the button.
 */
function SideBrowserFooterButton(): React.ReactElement {
  return (
    <button
      type="button"
      className={css.textButton}
      onClick={openSideBrowserTab}
    >
      {t('panel.title')}
    </button>
  )
}

/**
 * An extra item in this tab's actions menu: force an explicit capture.
 *
 * The menu is the kit's and closes only on its own actions, so an item that
 * acts must dismiss it — otherwise it leaves a menu floating over the page the
 * action just revealed.
 * @param props - the tab whose menu is open, and the dismiss callback.
 * @returns the menu item.
 */
function SideBrowserTabMenuItem(props: Record<string, unknown>): React.ReactElement {
  const dismiss = props.dismiss as (() => void) | undefined
  return (
    <button
      type="button"
      className={css.textButton}
      onClick={() => {
        dismiss?.()
        // An explicit capture is what a user pressing this wants: the page as it
        // is now, not as it was on the last poll.
        void api.screenshot()
      }}
    >
      {t('panel.nav.reload')}
    </button>
  )
}

/**
 * Profile entry ids this package's row carries, most likely first.
 *
 * A standalone install's patch row is `ui-sidebrowser` (see
 * `cordis.patch.yml`); the bare namespace is the last resort for a Host whose
 * descriptor is keyed by the namespace itself.
 */
export const SETTINGS_ENTRY_IDS = [ 'ui-sidebrowser', SETTINGS_NAMESPACE ]

/**
 * The settings every surface currently sees.
 *
 * Exposed for tests that assert the Host's values actually reach the browser
 * half; production code reads {@link settingsFeed} directly.
 * @returns the effective settings.
 */
export function readCurrentSettings(): SideBrowserSettings {
  return settingsFeed.read()
}

/**
 * Register this plugin's dictionaries.
 *
 * `ctx.locale` comes from the locale plugin, whose type merge is not present in
 * every build of this package, so it is reached structurally. A deployment
 * without the locale service is not an error: the module-level
 * document-language fallback in `locales.ts` takes over.
 * @param ctx - the client context.
 * @returns a disposer, or undefined when no locale service is present.
 */
function registerDictionaries(ctx: ClientContext): (() => void) | undefined {
  const locale = (ctx as unknown as {
    locale?: {
      register(ns: string, dictionaries: { zh: unknown; en: unknown }): () => void
      bind(ns: string): (key: string, params?: Record<string, string>) => string
    }
  }).locale
  if (locale === undefined) return undefined
  try {
    const dispose = locale.register(NS, { zh, en })
    // Wire the SDK translate seat so a language change reaches an
    // already-mounted panel with the next render, instead of needing a reload.
    setRuntimeTranslate(locale.bind(NS) as (key: SideBrowserKey, params?: Record<string, string>) => string)
    return dispose
  } catch {
    return undefined
  }
}

/**
 * Mount the side browser.
 *
 * Every registration happens inside `ctx.effect`, so the loader's unload or hot
 * reload removes them together and a rebuilt bundle can claim the same seats
 * again in the same page.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // A duplicated client injection (the module factory running twice in one
  // page) would otherwise mount two tab bodies and two popup hosts. The flag
  // lives on globalThis so independent factory runs still share one guard.
  const globals = globalThis as { __dshSideBrowserApplied?: boolean }
  if (globals.__dshSideBrowserApplied === true) return
  globals.__dshSideBrowserApplied = true
  ctx.effect(() => () => {
    globals.__dshSideBrowserApplied = undefined
  }, 'sidebrowser: apply claim')

  clientContext = ctx

  // Copy first: every surface below renders through `t`, and a first render
  // before the dictionaries exist would show raw keys to the user.
  ctx.effect(() => registerDictionaries(ctx) ?? (() => {}), 'sidebrowser: dictionaries')

  // Settings come from the Host, which is where they actually live: it owns the
  // schema and the volatile fields, and serves them at
  // `/api/sidebrowser/config`. The settings CARD still binds through
  // `configForms` so a Host that serves it stays editable, but that service is
  // absent from every shipped DSH package today - depending on it alone meant
  // the browser ran on compiled-in defaults no matter what the Host held, which
  // is why a chosen translation site or capture interval never took effect.
  const settingsForm = bindSettingsForm(ctx, SETTINGS_ENTRY_IDS)
  // A Host that serves no configuration form - which is every shipped DSH
  // package today - leaves the form "unavailable", and a subscription to it can
  // only ever yield the client's own defaults. In that case the Host's
  // `/api/sidebrowser/config` is the only source of the real values, so it
  // becomes the feed. When a form IS served, it stays authoritative for editing
  // and the config read only refreshes it.
  const formAvailable = settingsForm.getSnapshot().status !== 'unavailable'
  settingsFeed = formAvailable ? createSettingsSubscription(settingsForm) : hostSettingsFeed
  const routes = api
  if (routes !== undefined) {
    void loadHostSettings(routes)
  }

  const slots = slotRegistry(ctx)
  if (slots === undefined) {
    // No slot registry means no shell to contribute to. The popup host below
    // still mounts, which is the more useful half on its own.
    console.warn('[dsh-sidebrowser] the slot registry is unavailable; the sidebar tab will not render')
  }

  // --- Stage one: the tab type --------------------------------------------
  const registry = optionalService<{
    register(definition: SidebarRightTabDefinition): () => void
  }>(ctx, 'sidebarRightTabs')
  if (registry !== undefined) {
    try {
      registry.register(sideBrowserDefinition())
    } catch (error) {
      // A kind or id collision with another plugin is a wiring mistake worth
      // surfacing loudly, but it must not stop the popup from mounting.
      console.error('[dsh-sidebrowser] tab type registration failed:', error)
    }
  }

  if (slots !== undefined) {
    // --- Stage two: the tab body, keyed by the definition's own id --------
    // The registry contract is explicit: the `id` is also the key the type's
    // body and title register under. Using the kind here would leave the seat
    // with no occupant and the tab rendering "nothing can view this".
    ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: SIDEBROWSER_TAB_ID,
      inject: () => ({
        // The framework-injected hook factory turns a tab's record into a live
        // subscription; the body reads it as `useSidebarRightTabInfo`.
        hooks: {
          tabInfo: (_standard: unknown, useTabInfo: UseSidebarRightTabInfo) => useTabInfo,
        },
      }),
    }, SideBrowserTabBody)), 'sidebrowser: tab body')

    ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: SIDEBROWSER_TAB_ID,
    }, SideBrowserTabTitle)), 'sidebrowser: tab title')

    // --- The tab's own menu item -----------------------------------------
    // A list seat takes no key, so the entry identifies itself by id and is
    // rendered for every tab; its own label is what the user reads.
    ctx.effect(() => slots.inject('sidebar.right.tab.menu.item', () => slots.register({
      name: 'sidebar.right.tab.menu.item',
      id: 'sidebrowser-capture',
      order: 10,
      label: () => t('panel.nav.reload'),
    }, SideBrowserTabMenuItem)), 'sidebrowser: tab menu item')

    // --- The discoverable trigger ----------------------------------------
    ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
      name: 'sidebar.footer.action',
      id: 'sidebrowser-open',
      order: 30,
      label: () => t('panel.title'),
    }, SideBrowserFooterButton)), 'sidebrowser: footer row')

    // --- The settings card ------------------------------------------------
    // A contribution, not an assumption: `slots.inject` declares "when a
    // `settings.section` seat exists, fill it", so on a Host whose settings page
    // declares no such seat the callback simply never fires and this costs
    // nothing. It does NOT exist in the shipped client packages as of
    // dsh-client-ui-* 0.2.0-rc.2 — so today the card is unreachable from the
    // settings page, and the plugin is configured through its cordis patch row
    // instead. The registration is kept so the card lights up on the first Host
    // that does declare the seat, rather than needing the whole surface redone.
    ctx.effect(() => slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'sidebrowser',
      order: 120,
      label: () => t('settings.title'),
      locale: NS,
      inject: (): Record<string, unknown> => ({ form: settingsForm }),
    }, SideBrowserSettingsCard as never)), 'sidebrowser: settings card')
  }

  ctx.effect(() => () => {
    // Release the module-scoped references so a rebuilt bundle in the same page
    // does not read a form belonging to a dead fiber.
    settingsFeed = { read: () => ({}), subscribe: () => () => {} }
    clientContext = undefined
  }, 'sidebrowser: module state')

  // --- The selection mini-popup -------------------------------------------
  // A document-level host of its own: the popup listens for selections across
  // the whole conversation, which no component inside the shell's own tree can
  // do reliably. It is mounted through a dedicated root so its lifetime is
  // exactly this fiber's.
  const host = document.createElement('div')
  host.setAttribute('data-dsh-sidebrowser', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  const renderPopup = (): void => {
    const current = settingsFeed.read()
    root.render(
      <SelectionHost
        enabled={current.selectionPopup ?? DEFAULT_SETTINGS.selectionPopup}
        api={api}
        engine={engineFor(current.translationEngine)}
        targetLanguage={current.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage}
        answerTimeoutMs={ANSWER_TIMEOUT_MS}
      />,
    )
  }
  renderPopup()
  ctx.effect(() => {
    const unsubscribe = settingsFeed.subscribe(renderPopup)
    return () => {
      unsubscribe()
      // Unmount before removing the host node: React refuses to unmount from a
      // container that is already detached, and a bare `remove()` would leave
      // the root's listeners attached to an orphaned tree.
      root.unmount()
      host.remove()
    }
  }, 'sidebrowser: selection popup')
}

export { SideBrowserSettingsCard }
export type { SideBrowserSettings }
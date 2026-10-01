/**
 * The plugin's own settings card.
 *
 * The card follows the same staged-form model the task-board family uses: the
 * user types into drafts, nothing is written until they save, and a save is a
 * single revision-fenced document mutation. That is not ceremony — the settings
 * document is durable, shared state, and writing each keystroke would both
 * make the UI lie about what is stored and make a half-typed URL persistent.
 *
 * ## Why this plugin's settings are read through a plain ConfigForm
 *
 * The card binds the `sidebrowser` namespace through `ctx.configForms`, which
 * the `configForms` service exposes. It does not depend on the family binder
 * (`ctx.webUiSettings`) that some DSH Web UI deployments publish, because this
 * plugin is standalone and must work without that group: a missing optional
 * group must degrade the card, never prevent the plugin from loading.
 *
 * @module
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useState } from 'react'
import { t } from './locales.ts'
import { isUsableUrl, parseShortcuts } from './shortcuts.ts'
import { clampPollMs } from './panel/use-live-frame.ts'
import { TARGET_LANGUAGES, TRANSLATION_ENGINES } from './deepseek-web.ts'
import css from './sidebrowser.module.css'

/** The settings namespace this plugin's own row is filed under. */
export const SETTINGS_NAMESPACE = 'sidebrowser'

/**
 * Every field the settings card edits.
 *
 * The names are the Host schema's, because the card binds to this plugin's own
 * settings entry (see `SETTINGS_ENTRY_IDS`) and the Host rejects a key its
 * schema does not declare. Only one field is renamed on the way in and out —
 * the capture interval, which the Host stores in milliseconds and the card shows
 * in seconds — and that conversion happens at the two boundaries below, so no
 * consumer ever has to remember which unit it holds.
 */
export interface SideBrowserSettings {
  /** Master switch: when false the Host closes the routes and stops the tools. */
  enabled?: boolean
  /** Whether the selection mini-popup appears. */
  selectionPopup?: boolean
  /** Whether the Host registers the `browser_*` agent tools. */
  agentTools?: boolean
  /** URL the panel opens by default. */
  defaultUrl?: string
  /** Host capture interval, in milliseconds (the Host schema's own unit). */
  captureIntervalMs?: number
  /** Target language code for the translation shortcut, as a BCP 47 tag. */
  targetLanguage?: string
  /** Which translation site 翻译 prefers. */
  translationEngine?: string
  /** Extra quick-launch shortcuts, one `name url` per line. */
  shortcuts?: string
}

/** The snapshot a field as the card renders it. */
interface FieldState {
  /** Draft text. */
  text: string
  /** Whether a user-layer entry overrides the composition default. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** What the settings form reports. */
type FormSnapshot<T> = {
  /** Whether the namespace has answered. */
  status: 'loading' | 'ready' | 'unavailable'
  /** The effective value, when ready. */
  value: T | undefined
  /** Whether the document accepts writes. */
  writable: boolean
}

/** The shared mirror of which namespaces the Host serves. */
interface ConfigFormsFace<T> {
  /** Bind one profile entry's settings form. */
  get<S = T>(entryId: string): ConfigFormFace<S>
  /** The mirror of which namespaces the Host serves to this client. */
  describe(): {
    /** The mirror's current snapshot. */
    getSnapshot(): { view?: { namespaces?: ReadonlyArray<{ ns: string }> } | undefined }
  }
}

/** One durable write inside a save's single atomic form mutation. */
interface StagedWrite {
  /** Field this write targets. */
  field: string
  /** `set` stores a value; `unset` drops the user-layer entry. */
  op: 'set' | 'unset'
  /** Value for `set`; absent for `unset`. */
  value?: unknown
}

/** One entry's staged form. */
interface ConfigFormFace<T> {
  /** The current snapshot. */
  getSnapshot(): FormSnapshot<T>
  /** Observe changes. */
  subscribe(listener: () => void): () => void
  /** Write one field. */
  set(field: string, value: unknown): Promise<boolean>
  /** Drop one field's user-layer entry. */
  unset(field: string): Promise<boolean>
  /** Write several fields atomically, fenced on the revision read. */
  mutate(ops: readonly StagedWrite[], expectedRevision: number): Promise<boolean>
}

/** Where the card gets its form from, so the entry can supply it. */
export interface SettingsCardProps {
  /** The bound form for the plugin's namespace. */
  form: ConfigFormFace<SideBrowserSettings>
}

/** Bound form plus the settings values the panel reads live. */
export interface SettingsSubscription {
  /** The effective settings, updated whenever the form answers. */
  read(): SideBrowserSettings
  /** Subscribe to settings changes. */
  subscribe(listener: (settings: SideBrowserSettings) => void): () => void
}

/** Default values used when the Host has no user-layer entry. */
export const DEFAULT_SETTINGS: Required<Pick<SideBrowserSettings,
  'enabled' | 'selectionPopup' | 'agentTools' | 'defaultUrl' | 'captureIntervalMs' | 'targetLanguage' | 'translationEngine'
>> = {
  enabled: true,
  selectionPopup: true,
  agentTools: true,
  defaultUrl: 'https://chat.deepseek.com/',
  captureIntervalMs: 2000,
  targetLanguage: 'zh-Hans',
  translationEngine: 'youdao',
}

/**
 * The settings the panel and the popup actually read, with the capture interval
 * in the **seconds** the UI shows rather than the milliseconds the Host stores.
 *
 * Only that one field is renamed, and only in this type: the card converts at
 * the boundary where a user types seconds and at the boundary where it renders
 * them, so no consumer has to know the Host's unit exists.
 */
export interface EffectiveSettings extends Omit<Required<Omit<SideBrowserSettings, 'shortcuts'>>, 'captureIntervalMs'> {
  /** Capture interval in seconds, as the settings card presents it. */
  pollIntervalSeconds: number
  /** Extra quick-launch shortcuts, one `name url` per line. */
  shortcuts: string
}

/**
 * Resolve stored settings over the defaults.
 *
 * Returning the *filled* shape (rather than the partial one) is what lets the
 * card hand `value.defaultUrl` straight to a control that wants a `string`,
 * instead of threading `?? DEFAULT` through every call site.
 * @param settings - the stored settings, possibly partial or absent.
 * @returns every field, defaulted.
 */
export function effectiveSettings(settings: SideBrowserSettings | undefined): EffectiveSettings {
  return {
    enabled: settings?.enabled ?? DEFAULT_SETTINGS.enabled,
    selectionPopup: settings?.selectionPopup ?? DEFAULT_SETTINGS.selectionPopup,
    agentTools: settings?.agentTools ?? DEFAULT_SETTINGS.agentTools,
    defaultUrl: settings?.defaultUrl ?? DEFAULT_SETTINGS.defaultUrl,
    pollIntervalSeconds: (settings?.captureIntervalMs ?? DEFAULT_SETTINGS.captureIntervalMs) / 1_000,
    targetLanguage: settings?.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage,
    translationEngine: settings?.translationEngine ?? DEFAULT_SETTINGS.translationEngine,
    shortcuts: settings?.shortcuts ?? '',
  }
}

/**
 * Map a draft field name onto the Host schema field it is written to.
 *
 * Exactly one field differs: the card shows the capture interval in seconds
 * under `pollIntervalSeconds`, while the Host stores `captureIntervalMs`. The
 * Host validates against its own schema and rejects an unknown key, so the
 * rename has to happen where the write is built rather than in the UI.
 * @param field - the draft field name the card edited.
 * @returns the Host schema field name to write.
 */
export function hostFieldOf(field: string): string {
  return field === 'pollIntervalSeconds' ? 'captureIntervalMs' : field
}

/** Render one stored value as draft text. */
function format(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

/**
 * Read the effective settings from a bound form and keep subscribers current.
 *
 * This is the panel's and the popup's only dependency on configuration: they ask
 * for the settings they need through this subscription, so a settings save
 * reaches an already-mounted panel without a reload.
 * @param form - the bound form.
 * @returns the subscription the surfaces read.
 */
export function createSettingsSubscription(
  form: ConfigFormFace<SideBrowserSettings>,
): SettingsSubscription {
  const listeners = new Set<(settings: SideBrowserSettings) => void>()
  let current = effectiveSettings(form.getSnapshot().value)

  const publish = (): void => {
    current = effectiveSettings(form.getSnapshot().value)
    for (const listener of [...listeners]) listener(current)
  }

  // The form's subscription lives as long as the card does, which is as long
  // as the plugin's client fiber: both are created and torn down together.
  form.subscribe(publish)

  return {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Bind the settings form for a profile entry, resolving the entry id the Host
 * actually serves.
 *
 * Under the current settings model a form is addressed by profile entry id, not
 * by namespace, so the candidate ids are tried in order and the mirror decides
 * which one is real. The bare namespace is the last resort for a Host whose
 * descriptor is keyed by it.
 * @param ctx - the client context.
 * @param entryIds - the candidate profile entry ids, most likely first.
 * @returns the bound form.
 */
export function bindSettingsForm(ctx: ClientContext, entryIds: readonly string[]): ConfigFormFace<SideBrowserSettings> {
  const forms = ctx.get('configForms') as unknown as ConfigFormsFace<SideBrowserSettings> | undefined
  if (forms === undefined) return unavailableForm()
  let served: readonly string[] = []
  try {
    const namespaces = forms.describe().getSnapshot().view?.namespaces
    served = namespaces === undefined ? [] : namespaces.map(row => row.ns)
  } catch {
    // A describe face that refuses the read is unanswered, not empty; keeping
    // the empty list sends the search below to its documented last resort.
    served = []
  }
  // An empty candidate list means there is no entry id to bind at all, which is
  // a wiring mistake on the caller's side; reporting "unavailable" is the honest
  // outcome, and the card then explains how to edit settings.yaml instead.
  const last = entryIds[entryIds.length - 1]
  if (last === undefined) return unavailableForm()
  const entry = entryIds.find(id => served.includes(id)) ?? last
  try {
    return forms.get<SideBrowserSettings>(entry)
  } catch {
    return unavailableForm()
  }
}

/**
 * A form that reports the namespace as unavailable.
 *
 * Used when the deployment exposes no configuration form at all. The card
 * renders its "not exposed" notice rather than pretending the settings are
 * editable, which is the honest outcome: the fields exist in `settings.yaml`
 * whether or not this build will let the GUI touch them.
 * @returns the standing form.
 */
function unavailableForm(): ConfigFormFace<SideBrowserSettings> {
  return {
    getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false }),
    subscribe: () => () => {},
    set: async () => false,
    unset: async () => false,
    mutate: async () => false,
  }
}

/**
 * Read a field's draft from the form.
 * @param form - the bound form.
 * @param field - the draft field name the card edits.
 * @param fallback - the default value's text.
 * @returns the field state the card renders.
 */
function fieldState(form: ConfigFormFace<SideBrowserSettings>, field: string, fallback: string): FieldState {
  const snapshot = form.getSnapshot()
  const raw = (snapshot.value as Record<string, unknown> | undefined)?.[hostFieldOf(field)]
  const text = field === 'pollIntervalSeconds' && typeof raw === 'number'
    // Read back in the unit the field is edited in, so a stored 2500 shows as
    // "2.5" and not "2500". See `hostFieldOf`.
    ? String(raw / 1_000)
    : format(raw)
  return {
    text: text === '' ? fallback : text,
    overridden: raw !== undefined,
    invalid: false,
  }
}

/**
 * Render the settings card.
 *
 * @param props - the bound form.
 * @returns the card.
 */
export function SideBrowserSettingsCard(props: SettingsCardProps): React.ReactElement {
  const form = props.form
  const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  useEffect(() => form.subscribe(() => { setSnapshot(form.getSnapshot()) }), [form])

  const value = effectiveSettings(snapshot.value)
  const dirty = Object.keys(drafts).length > 0

  const draft = useCallback((field: string, fallback: string): string => {
    const staged = drafts[field]
    if (staged !== undefined) return staged
    const state = fieldState(form, field, fallback)
    return state.text
  }, [drafts, form])

  const edit = useCallback((field: string, text: string): void => {
    setDrafts(current => ({ ...current, [field]: text }))
    setSaved(false)
    // Validate as the user types, so an unusable value is visible before the
    // save button rather than after it fails.
    setInvalid(current => ({ ...current, [field]: validate(field, text) !== undefined }))
  }, [])

  const discard = useCallback((): void => {
    setDrafts({})
    setInvalid({})
    setFailed(undefined)
    setSaved(false)
  }, [])

  const save = useCallback(async (): Promise<void> => {
    if (Object.values(invalid).some(Boolean)) return
    setSaving(true)
    setFailed(undefined)
    const revision = (form.getSnapshot() as FormSnapshot<SideBrowserSettings> & { revision?: number }).revision ?? 0
    const ops: StagedWrite[] = []
    for (const [field, text] of Object.entries(drafts)) {
      const parsed = validate(field, text)
      // A draft that no longer validates is skipped here; `invalid` already
      // blocks the save before this runs, so reaching it means a race the user
      // resolved by typing again.
      if (parsed === undefined) continue
      if (parsed === null) {
        ops.push({ field: hostFieldOf(field), op: 'unset' })
        continue
      }
      ops.push({ field: hostFieldOf(field), op: 'set', value: parsed })
    }
    const accepted = await form.mutate(ops, revision)
    setSaving(false)
    if (accepted) {
      setDrafts({})
      setSaved(true)
      return
    }
    setFailed(t('settings.saveFailed'))
  }, [drafts, form, invalid])

  if (snapshot.status === 'unavailable') {
    return (
      <div className={css.root} data-dsh-sidebrowser-settings="">
        <h3>{t('settings.title')}</h3>
        <p className={css.hint}>{t('settings.notExposed')}</p>
      </div>
    )
  }

  return (
    <div className={css.root} data-dsh-sidebrowser-settings="">
      <div className={css.topBar}>
        <button
          type="button"
          className={css.textButton}
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          {open ? t('settings.collapse') : t('settings.expand')}
        </button>
        <span className={css.hint}>{t('settings.description')}</span>
      </div>
      {open && (
        <>
          <ToggleField
            label={t('settings.enablePopup')}
            hint={t('settings.enablePopupHint')}
            checked={draft('selectionPopup', String(value.selectionPopup)) === 'true'}
            disabled={!snapshot.writable}
            onChange={next => { edit('selectionPopup', String(next)) }}
          />
          <ToggleField
            label={t('settings.enableAgentTools')}
            hint={t('settings.enableAgentToolsHint')}
            checked={draft('agentTools', String(value.agentTools)) === 'true'}
            disabled={!snapshot.writable}
            onChange={next => { edit('agentTools', String(next)) }}
          />
          <TextField
            label={t('settings.defaultUrl')}
            hint={t('settings.defaultUrlHint')}
            text={draft('defaultUrl', value.defaultUrl)}
            disabled={!snapshot.writable}
            invalid={invalid.defaultUrl === true}
            onChange={next => { edit('defaultUrl', next) }}
          />
          <TextField
            label={t('settings.pollInterval')}
            hint={t('settings.pollIntervalHint')}
            text={draft('pollIntervalSeconds', String(value.pollIntervalSeconds))}
            disabled={!snapshot.writable}
            invalid={invalid.pollIntervalSeconds === true}
            onChange={next => { edit('pollIntervalSeconds', next) }}
          />
          <SelectField
            label={t('settings.translationEngine')}
            hint={t('settings.translationEngineHint')}
            text={draft('translationEngine', value.translationEngine)}
            disabled={!snapshot.writable}
            options={TRANSLATION_ENGINES.map(engine => ({ value: engine.id, label: engine.name }))}
            onChange={next => { edit('translationEngine', next) }}
          />
          <SelectField
            label={t('settings.targetLanguage')}
            hint={t('settings.targetLanguageHint')}
            text={draft('targetLanguage', value.targetLanguage)}
            disabled={!snapshot.writable}
            options={TARGET_LANGUAGES.map(language => ({ value: language.code, label: language.name }))}
            onChange={next => { edit('targetLanguage', next) }}
          />
          <TextField
            label={t('settings.shortcuts')}
            hint={t('settings.shortcutsHint')}
            text={draft('shortcuts', value.shortcuts ?? '')}
            multiline
            disabled={!snapshot.writable}
            invalid={invalid.shortcuts === true}
            onChange={next => { edit('shortcuts', next) }}
          />
          <div className={css.topBar}>
            <button
              type="button"
              className={`${css.textButton} ${css.popupPrimary}`}
              disabled={!dirty || saving || Object.values(invalid).some(Boolean)}
              onClick={() => { void save() }}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
            <button
              type="button"
              className={css.textButton}
              disabled={!dirty || saving}
              onClick={discard}
            >
              {t('settings.discard')}
            </button>
            {saved && <span className={css.statusLine}>{t('settings.shortcutsSaved')}</span>}
            {failed !== undefined && <span className={css.popupError}>{failed}</span>}
          </div>
        </>
      )}
    </div>
  )
}

/** Props shared by the card's field controls. */
interface FieldProps {
  /** Field label. */
  label: string
  /** One-line explanation under the label. */
  hint: string
  /** Whether the field is currently uneditable. */
  disabled: boolean
  /** Whether the draft is not a value this field accepts. */
  invalid?: boolean
}

/**
 * A labelled on/off control.
 * @param props - the label, hint, and current value.
 * @returns the control row.
 */
function ToggleField(props: FieldProps & { checked: boolean; onChange: (next: boolean) => void }): React.ReactElement {
  return (
    <label className={css.root} style={{ gap: 2, padding: 0 }}>
      <span className={css.topBar}>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={event => { props.onChange(event.target.checked) }}
        />
        <span>{props.label}</span>
      </span>
      <span className={css.hint}>{props.hint}</span>
    </label>
  )
}

/**
 * A labelled single-line text control.
 * @param props - the label, hint, and draft text.
 * @returns the control row.
 */
function TextField(props: FieldProps & {
  text: string
  multiline?: boolean
  onChange: (next: string) => void
}): React.ReactElement {
  return (
    <label className={css.root} style={{ gap: 2, padding: 0 }}>
      <span>{props.label}</span>
      {props.multiline
        ? (
          <textarea
            className={css.shortcutInput}
            style={{ minHeight: 72 }}
            rows={4}
            value={props.text}
            disabled={props.disabled}
            onChange={event => { props.onChange(event.target.value) }}
          />
        )
        : (
          <input
            className={css.shortcutInput}
            value={props.text}
            disabled={props.disabled}
            onChange={event => { props.onChange(event.target.value) }}
          />
        )}
      <span className={props.invalid === true ? css.popupError : css.hint}>
        {props.invalid === true ? t('settings.invalidNumber') : props.hint}
      </span>
    </label>
  )
}

/**
 * A labelled choice control.
 * @param props - the label, hint, options, and the current value.
 * @returns the control row.
 */
function SelectField(props: FieldProps & {
  text: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (next: string) => void
}): React.ReactElement {
  return (
    <label className={css.root} style={{ gap: 2, padding: 0 }}>
      <span>{props.label}</span>
      <select
        className={css.shortcutInput}
        value={props.text}
        disabled={props.disabled}
        onChange={event => { props.onChange(event.target.value) }}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className={css.hint}>{props.hint}</span>
    </label>
  )
}

/**
 * Validate one field's draft.
 *
 * Returns the value to write, `null` for "clear this field", or `undefined`
 * for "not a value this field accepts" — which is what blocks the save rather
 * than silently discarding what the user typed.
 * @param field - the field name.
 * @param text - the draft text.
 * @returns the parsed value, `null` to clear, or `undefined` when invalid.
 */
export function validate(field: string, text: string): unknown | null | undefined {
  const trimmed = text.trim()
  switch (field) {
    case 'selectionPopup':
    case 'agentTools':
    case 'enabled':
      if (trimmed === 'true' || trimmed === '') return true
      if (trimmed === 'false') return false
      return undefined
    case 'pollIntervalSeconds': {
      if (trimmed === '') return null
      const seconds = Number(trimmed)
      if (!Number.isFinite(seconds)) return undefined
      // The same bounds the capture loop clamps to, checked here so the user
      // learns about an out-of-range value before the save rather than after.
      const ms = clampPollMs(seconds)
      if (ms / 1_000 !== seconds) return undefined
      // Milliseconds, because that is the unit the Host field stores. See
      // `hostFieldOf` for why the conversion belongs here.
      return ms
    }
    case 'defaultUrl':
      if (trimmed === '') return null
      return isUsableUrl(trimmed) ? trimmed : undefined
    case 'translationEngine':
      if (trimmed === '') return null
      return TRANSLATION_ENGINES.some(engine => engine.id === trimmed) ? trimmed : undefined
    case 'targetLanguage':
      if (trimmed === '') return null
      return TARGET_LANGUAGES.some(language => language.code === trimmed) ? trimmed : undefined
    case 'shortcuts':
      if (trimmed === '') return null
      // The field is free text, so it is validated by whether every line with a
      // label has a usable URL; an unfinished line is the user's business.
      for (const line of trimmed.split('\n')) {
        const candidate = line.trim()
        if (candidate === '') continue
        const spaceAt = candidate.indexOf(' ')
        if (spaceAt > 0 && !isUsableUrl(candidate.slice(spaceAt + 1).trim())) return undefined
      }
      return parseShortcuts(trimmed).length === trimmed.split('\n').filter(line => line.trim() !== '').length
        ? trimmed
        : trimmed
    default:
      return trimmed === '' ? null : trimmed
  }
}
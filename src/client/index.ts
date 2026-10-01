/**
 * The side-browser client entry.
 *
 * The client half is a `.ts` module because the loader composes it like any
 * other client plugin — it reads `inject` and calls `apply(ctx)` — while every
 * JSX surface lives in the sibling `surfaces.tsx`, which this module
 * re-exports. Keeping the entry JSX-free is what lets the build declare this
 * exact path as its client entry without a `.tsx` extension in the config.
 *
 * @module
 */

export { apply, inject } from './surfaces.tsx'
export {
  SETTINGS_ENTRY_IDS,
  SIDEBROWSER_TAB_ID,
  SIDEBROWSER_TAB_KIND,
  SideBrowserSettingsCard,
} from './surfaces.tsx'
export type { SideBrowserSettings } from './surfaces.tsx'
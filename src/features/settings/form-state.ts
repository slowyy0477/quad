/**
 * Form state for the settings actions.
 *
 * Beside `actions.ts` rather than inside it: a `'use server'` module may only export
 * async functions, so a shared constant or type exported from there throws at module
 * evaluation. See docs/ARCHITECTURE.md §2.
 */
export type SettingsFormState =
  | { status: 'idle' }
  | { status: 'error'; message?: string; fieldErrors?: Record<string, string> }
  | { status: 'saved'; message: string }

export const SETTINGS_IDLE: SettingsFormState = { status: 'idle' }

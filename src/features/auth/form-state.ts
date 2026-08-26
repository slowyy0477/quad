/**
 * Form state shapes for the auth actions.
 *
 * Separate from actions.ts because a `'use server'` module may only export async
 * functions — every export becomes a callable server endpoint, so a plain object
 * has nowhere to go. Next enforces it at module evaluation, which is a good rule
 * hiding behind a confusing error message.
 */
export type AuthFormState = {
  status: 'idle' | 'error'
  /** A form-level message: wrong password, rate limited, service unavailable. */
  message?: string
  /** Field-level messages, keyed by input name. */
  fieldErrors?: Partial<Record<string, string>>
  /**
   * What to put back in the inputs after a failed submit. Never the password:
   * re-rendering a password into HTML puts it in the page source, in browser
   * history, and in anything that reports errors by serialising the DOM.
   */
  values?: { email?: string; displayName?: string }
}

export const emptyAuthState: AuthFormState = { status: 'idle' }

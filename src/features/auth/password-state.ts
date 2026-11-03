export type PasswordFormState = {
  status: 'idle' | 'error' | 'changed_unrevoked'
  message?: string
  fieldErrors?: Partial<Record<'currentPassword' | 'password' | 'confirm', string>>
  /** The one-time link was consumed/invalid; request a new link, not a second update. */
  recoveryInvalid?: boolean
}

export const emptyPasswordState: PasswordFormState = { status: 'idle' }

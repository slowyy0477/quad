/** See the note in features/auth/form-state.ts on why this is not in actions.ts. */
export type ProfileFormState = {
  status: 'idle' | 'error' | 'success'
  message?: string
  fieldErrors?: Partial<Record<string, string>>
  /**
   * What to put back in the inputs after a rejected submit. A form with eight
   * fields that clears itself because one of them was wrong is worse than no
   * validation at all.
   */
  values?: Record<string, string>
}

export const emptyProfileState: ProfileFormState = { status: 'idle' }

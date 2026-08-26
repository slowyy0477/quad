/** See the note in features/auth/form-state.ts on why this is not in actions.ts. */
export type PostFormState = {
  status: 'idle' | 'error' | 'success'
  message?: string
  fieldErrors?: Partial<Record<'body' | 'visibility', string>>
  /** Kept so a rejected post is not silently thrown away. */
  body?: string
}

export const emptyPostState: PostFormState = { status: 'idle' }

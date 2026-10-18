/** See the note in features/auth/form-state.ts on why this is not in actions.ts. */
export type PostFormState = {
  status: 'idle' | 'error' | 'success'
  message?: string
  fieldErrors?: Partial<Record<'body' | 'visibility' | 'projectId' | 'goalId', string>>
  /** Kept so a rejected post is not silently thrown away. */
  body?: string
  /** The attachment the reader chose, so a rejected post keeps it too. */
  projectId?: string
  goalId?: string
}

export const emptyPostState: PostFormState = { status: 'idle' }

export type CommentFormState = {
  status: 'idle' | 'error' | 'success'
  message?: string
  fieldErrors?: Partial<Record<'body', string>>
  body?: string
}

export const emptyCommentState: CommentFormState = { status: 'idle' }

/**
 * The result of a like or a save.
 *
 * `active` is the state the server actually holds after the write, not the state
 * the browser asked for. It is the reconciliation the optimistic update needs: if
 * the two disagree — because the write failed, or because another tab got there
 * first — the control is set from this value, so the interface ends up showing what
 * is true rather than what was hoped.
 */
export type InteractionResult = { ok: true; active: boolean } | { ok: false; message: string }

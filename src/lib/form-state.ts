/**
 * The shape every Server Action in this app returns.
 *
 * One type rather than one per feature, because they all do the same three things:
 * say whether the write happened, carry per-field messages, and carry back what was
 * typed so a rejected form does not clear itself.
 *
 * It lives in `lib` and not next to any action because a `'use server'` module may
 * only export async functions -- exporting a type from one is a build error.
 */
export type FormState = {
  status: 'idle' | 'error' | 'success'
  message?: string
  fieldErrors?: Partial<Record<string, string>>
  /**
   * What to put back in the inputs after a rejected submit. A form with ten fields
   * that empties itself because one of them was wrong is worse than no validation.
   */
  values?: Record<string, string>
}

export const emptyFormState: FormState = { status: 'idle' }

/** First message per field. Later issues on the same field are noise once one is shown. */
export function fieldErrorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

/** Every posted string value, so a rejected form can be re-rendered as the user left it. */
export function echoValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Turns a PostgREST write error into a sentence a person can act on.
 *
 * The full error goes to the server log and never to the browser: a PostgREST
 * message names tables, columns and constraints, which is a free map of the schema
 * for anyone probing it.
 *
 * The codes that matter:
 *
 *   23505  unique violation      -- something is already taken
 *   23514  check violation       -- a value broke a rule the form should have caught
 *   23503  foreign key violation -- points at a row that does not exist (or is
 *                                  invisible to this reader, which is the same
 *                                  thing from here)
 *   42501  insufficient privilege -- a column GRANT refused it
 *   PGRST116  zero rows where one was required -- almost always RLS declining an
 *                                  update rather than a genuinely missing row
 *
 * An RLS refusal on UPDATE is not an error at all in Postgres: the statement
 * succeeds and affects zero rows. That is why the actions below check the returned
 * row count instead of trusting `error === null`.
 */
export function describeWriteError(
  error: { code?: string; message?: string; hint?: string | null; details?: string | null },
  context: string,
  overrides: Partial<Record<string, string>> = {},
): FormState {
  console.error(`[${context}]`, error.code, error.message)

  if (error.code && overrides[error.code]) {
    return { status: 'error', message: overrides[error.code] }
  }

  switch (error.code) {
    case '23505':
      return { status: 'error', message: 'Something with that name already exists.' }
    case '23514':
      return {
        status: 'error',
        message: 'One of those values was not accepted. Check the fields above.',
      }
    case '23503':
      return { status: 'error', message: 'That refers to something that no longer exists.' }
    case '42501':
      return { status: 'error', message: 'You are not allowed to change that.' }
    case 'PGRST116':
      return {
        status: 'error',
        message: 'That is not yours to change, or it no longer exists.',
      }
    default:
      return { status: 'error', message: 'That could not be saved. Please try again.' }
  }
}

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import {
  describeWriteError,
  echoValues,
  fieldErrorsOf,
  type FormState,
} from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import { mutate } from '@/lib/local/db'
import { claimUniversitySchema, universityRequestSchema } from '@/features/universities/schemas'

/**
 * University writes.
 *
 * Three facts about the schema shape everything here.
 *
 * 1. **The affiliation is one column.** `profiles.university_id` holds it, so
 *    "I study here" is an UPDATE and claiming a second institution moves the
 *    affiliation rather than adding a second claim. There is no row to duplicate
 *    and no table to keep in step.
 *
 * 2. **`department_id` has to be cleared at the same time.** The
 *    `profiles_validate_affiliation` trigger refuses a department that does not
 *    belong to the chosen university, so switching university while a department
 *    from the old one is still set would raise a constraint error instead of
 *    moving the affiliation. One statement, both columns.
 *
 * 3. **A filed institution cannot approve itself.** `status`, `submitted_by` and
 *    the counters are set by `app.universities_before_insert` on the way in, and
 *    `app.reject_protected_column_change` refuses them on the way through. No
 *    form field here names any of them.
 *
 * LOCAL MODE
 * ----------
 * Claiming and leaving work, because `profiles.university_id` exists in the
 * store and there is nothing else to keep in step. Two things do not:
 *
 *   - The ids in the store are not uuids (`uni_…`), so `claimUniversitySchema`
 *     would reject every institution the directory lists. The local branch
 *     validates against the store instead: the id has to name a row that is
 *     there.
 *   - There is no institution-request table and no `status` column, so filing an
 *     institution is refused with an explanation rather than written somewhere it
 *     does not belong. See `requestUniversityAction`.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so an institution cannot be set or filed.',
}

/**
 * Claim or clear the reader's affiliation in the local store.
 *
 * `department` and `programme` are cleared with the institution for the reason in
 * note 2 above: in the local store they are plain strings with no foreign key, so
 * nothing would stop a department from one institution sitting beside another
 * institution's id. Clearing them keeps the row internally consistent.
 */
async function setLocalAffiliation(
  userId: string,
  universityId: string | null,
): Promise<FormState> {
  const outcome = await mutate((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === userId)
    if (!profile) return 'no-profile' as const
    if (universityId !== null && !db.universities.some((row) => row.id === universityId)) {
      return 'no-university' as const
    }

    profile.university_id = universityId
    profile.department = null
    profile.programme = null
    return 'ok' as const
  })

  if (outcome === 'no-profile') {
    return { status: 'error', message: 'Your profile could not be updated. Reload the page and try again.' }
  }
  if (outcome === 'no-university') {
    return {
      status: 'error',
      message: 'That institution is no longer in the directory. Reload the page and pick another.',
    }
  }

  // The header and the profile both render the affiliation, so the cached shell is
  // now wrong in more than one place.
  revalidatePath('/', 'layout')
  revalidatePath('/universities')
  revalidatePath('/me')
  revalidatePath('/connections')

  return { status: 'success', message: 'Saved.' }
}

/** Only the two columns that decide the affiliation are ever sent. */
async function setAffiliation(
  universityId: string | null,
  context: string,
): Promise<FormState> {
  const user = await getUser()
  if (!user) redirect('/login?next=/universities')

  if (isLocalMode()) return setLocalAffiliation(user.id, universityId)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .update({ university_id: universityId, department_id: null, program_id: null })
    .eq('id', user.id)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, context)

  // RLS declining an UPDATE is not an error: the statement succeeds and changes
  // nothing. A missing row here means the write did not happen.
  if (!data) {
    return { status: 'error', message: 'Your profile could not be updated. Reload the page and try again.' }
  }

  // The header and the profile both render the affiliation, so the cached shell is
  // now wrong in more than one place.
  revalidatePath('/', 'layout')
  revalidatePath('/universities')
  revalidatePath('/me')
  revalidatePath('/connections')

  return { status: 'success', message: 'Saved.' }
}

// -----------------------------------------------------------------------------
// "I study here"
// -----------------------------------------------------------------------------

export async function claimUniversityAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  if (isLocalMode()) {
    // The store's ids are not uuids, so the shared schema cannot be used here; the
    // affiliation is checked against the rows that exist instead.
    const universityId = String(formData.get('universityId') ?? '')
    if (!universityId) {
      return { status: 'error', fieldErrors: { universityId: 'Choose an institution from the list' } }
    }

    const state = await setAffiliation(universityId, 'universities:claim')
    if (state.status !== 'success') return state

    return { status: 'success', message: 'Your profile now says this is your university.' }
  }

  const parsed = claimUniversitySchema.safeParse({
    universityId: String(formData.get('universityId') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const state = await setAffiliation(parsed.data.universityId, 'universities:claim')
  if (state.status !== 'success') return state

  // The student count on the institution changed, because it is maintained by the
  // profiles trigger rather than by this action. In local mode it is derived on
  // read, so the same statement is true there for a different reason.
  return { status: 'success', message: 'Your profile now says this is your university.' }
}

// -----------------------------------------------------------------------------
// Leaving it
// -----------------------------------------------------------------------------

/**
 * Reverse of the above, and the reason the claim is reversible in practice
 * rather than only in the schema.
 */
export async function leaveUniversityAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  // The institution is read from the form so the confirmation can name it, but it
  // is never used to decide which column to write: only the reader's own row is
  // writable, and only to null.
  const name = String(formData.get('name') ?? '')

  const state = await setAffiliation(null, 'universities:leave')
  if (state.status !== 'success') return state

  return {
    status: 'success',
    message: name
      ? `You are no longer listed at ${name}. You can claim it again at any time.`
      : 'Your profile no longer names a university.',
  }
}

// -----------------------------------------------------------------------------
// Requesting an institution that is not listed
// -----------------------------------------------------------------------------

/**
 * Files a `pending` row for a moderator to review.
 *
 * The list in migration 0017 is a starting set, not a complete one, so this is the
 * path for everything missing from it — the same path the migration header
 * describes. What is deliberately not sent: `slug` (derived from the name), and
 * `status`, which the before-insert trigger pins to `pending` for any caller that
 * is not a moderator.
 *
 * LOCAL MODE: not available, and it says so.
 *
 * The store has `universities` but nothing that records a *request*: no `status`,
 * no `submitted_by`, no moderation queue, and no `university_requests` table. The
 * one thing this could do is insert straight into `universities` — which would put
 * an unreviewed institution into the public directory and make the form's promise
 * ("a moderator reviews new institutions") false. Inserting into `reports`, the
 * only other table with a free-text column, would be worse: it would file an
 * institution as a complaint about something. So the form keeps its fields, its
 * validation and its error state, and reports the absence.
 */
export async function requestUniversityAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/universities')

  const parsed = universityRequestSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    shortName: String(formData.get('shortName') ?? ''),
    city: String(formData.get('city') ?? ''),
    country: String(formData.get('country') ?? ''),
    website: String(formData.get('website') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) {
    return {
      status: 'error',
      message:
        'Local mode cannot file an institution: there is no request table and no moderator to review one, and adding it straight to the directory would be a claim nobody checked. Nothing was saved.',
      values: echoValues(formData),
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('universities').insert({
    name: parsed.data.name,
    short_name: parsed.data.shortName ?? null,
    city: parsed.data.city ?? null,
    country: parsed.data.country ?? null,
    website: parsed.data.website ?? null,
  })

  if (error) {
    console.error('[universities:request]', error.code, error.message)
    // 23505 is the duplicate guard: a unique index on (normalized_name, country)
    // in 0003. Saying which of the two cases it is would require reading rows the
    // caller may not see, so it names both.
    if (error.code === '23505') {
      return {
        status: 'error',
        message:
          'That institution is already in the directory, or someone has already filed it.',
        values: echoValues(formData),
      }
    }
    return { ...describeWriteError(error, 'universities:request'), values: echoValues(formData) }
  }

  revalidatePath('/universities')

  return {
    status: 'success',
    message:
      'Filed. A moderator reviews new institutions; until one does, this appears only to you, in your pending list.',
  }
}

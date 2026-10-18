'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { Database } from '@/lib/db/database.types'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { id, mutate, now, type LocalOpportunity } from '@/lib/local/db'
import { describeWriteError, echoValues, fieldErrorsOf, type FormState } from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { canViewOpportunity, localOpportunitySlug } from '@/features/opportunities/queries'
import { opportunityCreateSchema, opportunitySkillIds, type OpportunityCreateInput } from '@/features/opportunities/schemas'

/**
 * Opportunity writes.
 *
 * Three rules, all of them consequences of how 0013 is built.
 *
 * 1. **`posted_by`, `slug`, `source`, `university_id` and `save_count` are never sent.**
 *    `app.opportunities_before_write` sets every one of them from the session and the
 *    poster's profile on insert, and `source` is constrained to `user_submitted` so a
 *    forged provenance is overwritten rather than merely refused.
 *
 * 2. **Applying is not a write.** There is no applications table on this schema:
 *    `apply_url` and `apply_email` are the routes, and the organisation receives the
 *    application. Nothing here records "applied", because nothing stores it -- saving a
 *    listing is the only per-reader state that exists, and it is called Saved.
 *
 * 3. **A refusal is mapped, never echoed.** PostgREST messages name tables and
 *    constraints; they go to the server log and a sentence goes to the reader.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so listings cannot be saved.',
}

type OpportunityInsert = Database['public']['Tables']['opportunities']['Insert']

/**
 * The columns an author writes.
 *
 * The generated Insert type requires `slug` and `posted_by` because those columns are NOT
 * NULL; the trigger assigns both on every insert (`app.unique_slug` from the title, and
 * `auth.uid()` as the poster), so sending them would be both inert and a claim that the
 * author chose them. The narrowing says that once, here, instead of putting a fake slug or
 * a forged author in the payload.
 */
type OpportunityWrite = Omit<OpportunityInsert, 'slug' | 'posted_by'>

function opportunityRow(data: {
  title: string
  organisation: string
  description: string
  type: string
  workMode: string
  visibility: string
  compensation?: string
  location?: string
  applyUrl?: string
  applyEmail?: string
  deadline?: string
  startsOn?: string
}): OpportunityWrite {
  return {
    title: data.title,
    organisation: data.organisation,
    description: data.description,
    type: data.type,
    work_mode: data.workMode,
    visibility: data.visibility,
    compensation: data.compensation ?? null,
    location: data.location ?? null,
    apply_url: data.applyUrl ?? null,
    apply_email: data.applyEmail ?? null,
    deadline: data.deadline ?? null,
    starts_on: data.startsOn ?? null,
  }
}

function readForm(formData: FormData) {
  return {
    title: String(formData.get('title') ?? ''),
    organisation: String(formData.get('organisation') ?? ''),
    description: String(formData.get('description') ?? ''),
    type: String(formData.get('type') ?? 'internship'),
    workMode: String(formData.get('workMode') ?? 'onsite'),
    visibility: String(formData.get('visibility') ?? 'public'),
    compensation: String(formData.get('compensation') ?? ''),
    location: String(formData.get('location') ?? ''),
    applyUrl: String(formData.get('applyUrl') ?? ''),
    applyEmail: String(formData.get('applyEmail') ?? ''),
    deadline: String(formData.get('deadline') ?? ''),
    startsOn: String(formData.get('startsOn') ?? ''),
  }
}

// -----------------------------------------------------------------------------
// Post a listing
// -----------------------------------------------------------------------------

export async function createOpportunityAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/opportunities/new')

  const parsed = opportunityCreateSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const parsedSkills = opportunitySkillIds.safeParse(formData.getAll('skillIds'))
  if (!parsedSkills.success) {
    return {
      status: 'error',
      message: parsedSkills.error.issues[0]?.message ?? 'Those skills could not be read.',
      values: echoValues(formData),
    }
  }

  if (isLocalMode()) return createOpportunityLocal(user.id, parsed.data, parsedSkills.data.length, formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('opportunities')
    .insert(opportunityRow(parsed.data) as OpportunityInsert)
    // The slug is generated by the trigger from the title, and `app.unique_slug` walks a
    // counter until it clears the unique index -- so it is only knowable after the
    // insert, and it is what the redirect needs.
    .select('id, slug, visibility')
    .single<{ id: string; slug: string; visibility: string }>()

  if (error) {
    return { ...describeWriteError(error, 'opportunities:create'), values: echoValues(formData) }
  }

  let skillsFailed = false
  if (parsedSkills.data.length > 0) {
    const { error: skillError } = await supabase.from('opportunity_skills').insert(
      parsedSkills.data.map((skillId) => ({
        opportunity_id: data.id,
        skill_id: skillId,
        // The form's checkbox is "required"; every chosen skill is asked for. A softer
        // "nice to have" list would need a second control, and inventing the distinction
        // in the UI without storing it would be worse than not offering it.
        is_required: true,
      })),
    )

    if (skillError) {
      // The listing is real and must not be lost because its enrichment failed. The
      // detail page says so rather than showing an empty skills section as if the author
      // had chosen none.
      console.error('[opportunities:create:skills]', skillError.code, skillError.message)
      skillsFailed = true
    }
  }

  revalidatePath('/opportunities')

  // A university-scoped listing on a profile with no university is stored as public by
  // the trigger. Saying so on arrival is better than letting the author assume it stayed
  // inside their university.
  const clamped = parsed.data.visibility !== data.visibility
  const query = [skillsFailed ? 'skills=failed' : null, clamped ? 'clamped=1' : null]
    .filter(Boolean)
    .join('&')

  redirect(`/opportunities/${data.slug}?created=1${query ? `&${query}` : ''}`)
}

// -----------------------------------------------------------------------------
// Saving a listing
// -----------------------------------------------------------------------------

/**
 * Save or unsave.
 *
 * The current state is posted from the form rather than read first. Reading it would not
 * make this safe -- the primary key and the policy decide -- and a double-click produces
 * 23505, which is treated as "already saved" rather than as an error worth showing.
 *
 * `save_count` is the trigger's counter, so the number the button renders is the number
 * of rows in `opportunity_saves` and not a local increment.
 */
export async function toggleOpportunitySaveAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const opportunityId = String(formData.get('opportunityId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const saved = String(formData.get('saved') ?? '') === 'true'

  if (!opportunityId) return { status: 'error', message: 'That listing could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/opportunities/${slug}`)

  if (isLocalMode()) return toggleSaveLocal(user.id, opportunityId, slug, saved)

  const supabase = await createClient()

  if (saved) {
    const { error } = await supabase
      .from('opportunity_saves')
      .delete()
      .eq('opportunity_id', opportunityId)
      .eq('profile_id', user.id)

    if (error) return describeWriteError(error, 'opportunities:unsave')
  } else {
    // profile_id is set by the trigger from auth.uid(); it is sent because the column is
    // NOT NULL and the insert policy's WITH CHECK reads it.
    const { error } = await supabase
      .from('opportunity_saves')
      .insert({ opportunity_id: opportunityId, profile_id: user.id })

    if (error && error.code !== '23505') {
      return describeWriteError(error, 'opportunities:save', {
        '42501': 'That listing is not one you can see, so it cannot be saved.',
      })
    }
  }

  if (slug) revalidatePath(`/opportunities/${slug}`)
  revalidatePath('/opportunities')
  return { status: 'success' }
}

// =============================================================================
// Local mode
//
// The store has no policies, so the checks below are the authorisation, and the
// trigger behaviour they mirror is named at each one: the btrim and the
// university fallback from `opportunities_before_write`, `app.unique_slug`, and
// `opportunity_saves_before_insert`'s "you cannot save what you cannot see".
// The writes go through `mutate`, the `FormState`s are unchanged, and the same
// `revalidatePath` calls are made.
//
// `opportunity_saves` in the store reuses the `LocalSave` row type, whose key
// column is `post_id`; the listing's id is written there. There is no `note`
// column, so a saved listing's private note does not exist locally.
// =============================================================================

const NO_PROFILE: FormState = {
  status: 'error',
  message: 'This account has no profile in the local store, so nothing can be saved under it.',
}

async function createOpportunityLocal(
  userId: string,
  data: OpportunityCreateInput,
  skillCount: number,
  formData: FormData,
): Promise<FormState> {
  const created = await mutate((db) => {
    const poster = db.profiles.find((profile) => profile.user_id === userId)
    if (!poster) return null

    // `opportunities_before_write`: a university-scoped listing on a profile with
    // no university is stored public, because otherwise it would be invisible to
    // everyone including its author. An opportunity is *not* clamped to the
    // poster's profile visibility -- the listing is about the employer.
    const visibility =
      data.visibility === 'university' && !poster.university_id ? 'public' : data.visibility

    const row: LocalOpportunity = {
      id: id('opp'),
      // The trigger sets `posted_by` from `auth.uid()`; locally that is the
      // reader's profile, which is also what `opportunities_insert_own` checks.
      posted_by: poster.id,
      title: data.title.trim(),
      organisation: data.organisation.trim(),
      description: data.description,
      type: data.type,
      work_mode: data.workMode,
      visibility,
      compensation: data.compensation ?? null,
      location: data.location ?? null,
      apply_url: data.applyUrl ?? null,
      apply_email: data.applyEmail ? data.applyEmail.trim().toLowerCase() : null,
      deadline: data.deadline ?? null,
      starts_on: data.startsOn ?? null,
      status: 'open',
      created_at: now(),
      deleted_at: null,
    }

    // Push first, then ask the read path what slug this row was given: one
    // derivation, so the URL this redirects to is the URL the detail page serves.
    db.opportunities.push(row)
    const slug = localOpportunitySlug(db, row.id)

    return { slug, visibility, requested: data.visibility }
  })

  if (!created) return { ...NO_PROFILE, values: echoValues(formData) }

  revalidatePath('/opportunities')

  // `save_count` is not written: it is derived from the rows on read, exactly as
  // the trigger would have kept it.
  const clamped = created.requested !== created.visibility
  // No `skills` or `opportunity_skills` table exists in the store, so chosen
  // skills cannot be stored. Saying so on arrival is better than a listing that
  // silently asks for nothing.
  const query = [skillCount > 0 ? 'skills=failed' : null, clamped ? 'clamped=1' : null]
    .filter(Boolean)
    .join('&')

  redirect(`/opportunities/${created.slug}?created=1${query ? `&${query}` : ''}`)
}

async function toggleSaveLocal(
  userId: string,
  opportunityId: string,
  slug: string,
  saved: boolean,
): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'no-profile'

    const listing = db.opportunities.find(
      (row) => row.id === opportunityId && row.deleted_at === null,
    )
    // `opportunity_saves_before_insert`: a listing you cannot see cannot be
    // saved, which the Supabase path receives as 42501.
    if (!listing || !canViewOpportunity(db, listing, viewer)) return 'not-visible'

    const existing = db.opportunity_saves.findIndex(
      (row) => row.post_id === opportunityId && row.profile_id === viewer.id,
    )

    if (saved) {
      // Idempotent: unsaving something that is not saved changes nothing.
      if (existing >= 0) db.opportunity_saves.splice(existing, 1)
      return 'ok'
    }

    // Also idempotent: a double-click or a stale `saved=false` produces one row,
    // which is the same conclusion as the 23505 branch on the Supabase path.
    if (existing < 0) {
      db.opportunity_saves.push({
        id: id('sav'),
        post_id: opportunityId,
        profile_id: viewer.id,
        created_at: now(),
      })
    }
    return 'ok'
  })

  if (result === 'no-profile') return NO_PROFILE
  if (result === 'not-visible') {
    return { status: 'error', message: 'That listing is not one you can see, so it cannot be saved.' }
  }

  if (slug) revalidatePath(`/opportunities/${slug}`)
  revalidatePath('/opportunities')
  return { status: 'success' }
}

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
import { localFormWrite } from '@/lib/local/write-result'
import { ideaParticipationLocal } from './local'
import { canReadContent, localActor } from '@/lib/local/access'
import { id, mutate, now, type LocalIdea, type LocalProject, type Tables } from '@/lib/local/db'
import { clampVisibility } from '@/features/projects/queries'
import { inviteIdeaParticipantsLocal, projectInvitationFailure, validProjectInvitationId } from '@/features/projects/invitations'
import { enforceMutationLimits } from '@/lib/local/mutation-limits'
import { RATE_LIMITS } from '@/lib/rate-limit/budgets'
import {
  ideaCreateSchema,
  ideaEditSchema,
  ideaInterestSchema,
  type IdeaCreateInput,
  type IdeaEditInput,
} from '@/features/ideas/schemas'

/**
 * Idea writes.
 *
 * The same three rules the project actions follow, for the same reasons: `author_id`
 * is never sent (the trigger sets it from `auth.uid()`), the counters and the
 * conversion columns are absent from the UPDATE grant, and an update that affects
 * zero rows is a refusal rather than a success.
 *
 * Conversion is the one action here that calls a database function rather than
 * writing a table, because creating the project and marking the idea converted have
 * to happen together. `converted_project_id` is deliberately not client-writable, so
 * a half-converted idea cannot be produced by two separate statements.
 *
 * LOCAL MODE
 * ----------
 * As in projects/actions, the "not yours" checks written here are the only
 * authorisation the local store has, so `idea.author_id !== viewer.id` is what keeps
 * one person's idea out of another's hands. Votes and offers of help have nowhere to
 * go -- the local store has no `idea_votes` or `idea_interest` table -- so those
 * actions refuse instead of reporting a write that did not happen.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so ideas cannot be saved.',
}


// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export async function createIdeaAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/ideas')

  const parsed = ideaCreateSchema.safeParse({
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    category: String(formData.get('category') ?? 'other'),
    lookingFor: String(formData.get('lookingFor') ?? ''),
    visibility: String(formData.get('visibility') ?? 'public'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) return localFormWrite(() => createIdeaLocal(user.id, parsed.data, formData), formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ideas')
    .insert({
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      looking_for: parsed.data.lookingFor ?? null,
      visibility: parsed.data.visibility,
    })
    .select('id')
    .single<{ id: string }>()

  if (error) {
    return { ...describeWriteError(error, 'ideas:create'), values: echoValues(formData) }
  }

  revalidatePath('/ideas')
  redirect(`/ideas/${data.id}`)
}

// -----------------------------------------------------------------------------
// Edit and close (the author's own)
// -----------------------------------------------------------------------------

/**
 * Edit an idea.
 *
 * `status` is writable here, but `converted` is not offered by the form and the
 * trigger refuses a direct change to `converted_project_id` anyway: an idea becomes a
 * project through the conversion function and not by editing a dropdown.
 */
export async function updateIdeaAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  if (!ideaId) return { status: 'error', message: 'That idea could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  const parsed = ideaEditSchema.safeParse({
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    category: String(formData.get('category') ?? 'other'),
    lookingFor: String(formData.get('lookingFor') ?? ''),
    status: String(formData.get('status') ?? 'open'),
    visibility: String(formData.get('visibility') ?? 'public'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) return localFormWrite(() => updateIdeaLocal(user.id, ideaId, parsed.data), formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ideas')
    .update({
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      looking_for: parsed.data.lookingFor ?? null,
      status: parsed.data.status,
      visibility: parsed.data.visibility,
    })
    .eq('id', ideaId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) {
    return { ...describeWriteError(error, 'ideas:update'), values: echoValues(formData) }
  }
  if (!data) return { status: 'error', message: 'That idea is not yours to edit.' }

  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/ideas')
  return { status: 'success', message: 'Saved.' }
}

/** Close an idea: it is no longer looking for anyone. Reversible through edit. */
export async function closeIdeaAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  const user = await getUser()
  if (!user) redirect('/login')

  if (isLocalMode()) return localFormWrite(() => closeIdeaLocal(user.id, ideaId), formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ideas')
    .update({ status: 'closed' })
    .eq('id', ideaId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'ideas:close')
  if (!data) return { status: 'error', message: 'That idea is not yours to close.' }

  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/ideas')
  return { status: 'success', message: 'Closed. It stays visible as a record.' }
}

// -----------------------------------------------------------------------------
// Votes and interest
// -----------------------------------------------------------------------------

/**
 * Upvote or un-upvote.
 *
 * A vote is `(idea_id, profile_id)` and the primary key is what makes it one per
 * person. The state arrives from the form rather than being read first, and a
 * duplicate insert from a double-click produces 23505, which is treated as
 * "already voted" rather than an error worth showing anyone.
 */
export async function voteIdeaAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  const voted = String(formData.get('voted') ?? '') === 'true'

  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  // There is no `idea_votes` table in the local store. Bumping `upvote_count`
  // instead would be worse than refusing: `hasVoted` can only answer false, so the
  // same person could vote on every reload and the number would never mean anything.
  if (isLocalMode()) { const result = await localFormWrite(() => ideaParticipationLocal(formData, 'vote'), formData); if (result.status === 'success') { revalidatePath('/ideas'); revalidatePath(`/ideas/${ideaId}`) }; return result }

  const supabase = await createClient()

  if (voted) {
    const { error } = await supabase.from('idea_votes').delete().eq('idea_id', ideaId).eq('profile_id', user.id)
    if (error) return describeWriteError(error, 'ideas:unvote')
  } else {
    // profile_id is forced to auth.uid() by the trigger; it is posted only because
    // the NOT NULL column cannot be omitted and the WITH CHECK reads it.
    const { error } = await supabase.from('idea_votes').insert({ idea_id: ideaId, profile_id: user.id })
    if (error && error.code !== '23505') return describeWriteError(error, 'ideas:vote')
  }

  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/ideas')
  return { status: 'success' }
}

/**
 * "I would help build this."
 *
 * `profile_id` is never sent. The trigger overwrites it with `auth.uid()` and refuses
 * two things outright: the idea's own author expressing interest in their own idea,
 * and anyone on either side of a block. Both arrive as Postgres errors and become one
 * sentence each.
 */
export async function expressInterestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  if (!ideaId) return { status: 'error', message: 'That idea could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  const parsed = ideaInterestSchema.safeParse({
    message: String(formData.get('message') ?? ''),
    offering: String(formData.get('offering') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  // No `idea_interest` table in the local store: the offer has nowhere to be kept,
  // and `listIdeaInterests` would still return nothing afterwards.
  if (isLocalMode()) { const result = await localFormWrite(() => ideaParticipationLocal(formData, 'interest'), formData); if (result.status === 'success') revalidatePath(`/ideas/${ideaId}`); return result }

  const supabase = await createClient()
  const { error } = await supabase.from('idea_interest').insert({
    idea_id: ideaId,
    message: parsed.data.message ?? null,
    offering: parsed.data.offering ?? null,
  })

  if (error) {
    return describeWriteError(error, 'ideas:expressInterest', {
      '23514': 'This is your own idea.',
      '23505': 'You have already said you would help with this one.',
      '42501': 'You cannot offer to help with this idea.',
    })
  }

  revalidatePath(`/ideas/${ideaId}`)
  return { status: 'success', message: 'The author can see your offer.' }
}

/** Take back an offer to help. Only the reader's own row. */
export async function withdrawInterestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  // Nothing was recorded, so there is nothing to take back.
  if (isLocalMode()) { const result = await localFormWrite(() => ideaParticipationLocal(formData, 'withdraw'), formData); if (result.status === 'success') revalidatePath(`/ideas/${ideaId}`); return result }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('idea_interest')
    .delete()
    .eq('idea_id', ideaId)
    .eq('profile_id', user.id)
    .select('profile_id')
    .maybeSingle<{ profile_id: string }>()

  if (error) return describeWriteError(error, 'ideas:withdrawInterest')
  if (!data) return { status: 'error', message: 'There was no offer of yours to take back.' }

  revalidatePath(`/ideas/${ideaId}`)
  return { status: 'success', message: 'Your offer was taken back.' }
}

// -----------------------------------------------------------------------------
// Conversion: the idea becomes a project
// -----------------------------------------------------------------------------

/**
 * Turn an idea into a project.
 *
 * 0036's caller-RLS RPC atomically creates the project, copies required skills,
 * records conversion, and invites eligible interested people. Blocks, current
 * privacy/preferences and mandatory budgets may exclude people. The count is
 * actual inserted invitations, never a promise to invite every interest.
 *
 * Local mode has the same locked transaction and bodyless notifications. Neither
 * path makes an invited person a member until they explicitly accept.
 */
export async function convertIdeaToProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  if (!validProjectInvitationId(ideaId)) return { status: 'error', message: 'That idea could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  if (isLocalMode()) return localFormWrite(() => convertIdeaLocal(user.id, ideaId), formData)

  let conversion: { data: unknown; error: { code?: string; hint?: string | null } | null }
  try {
    const supabase = await createClient()
    conversion = await supabase.rpc('convert_idea_to_project_with_invites', { p_idea_id: ideaId })
  } catch {
    return { status: 'error', message: 'The conversion could not be confirmed. Reload the idea before trying again.' }
  }
  const { data, error } = conversion

  if (error) return projectInvitationFailure(error)
  const project = Array.isArray(data) && data.length === 1 ? data[0] as Record<string, unknown> : null
  if (!project || typeof project.project_id !== 'string' || !validProjectInvitationId(project.project_id, false) ||
      typeof project.project_slug !== 'string' || project.project_slug.length > 128 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.project_slug) ||
      typeof project.invited_count !== 'number' || !Number.isSafeInteger(project.invited_count) ||
      project.invited_count < 0 || project.invited_count > 29) {
    return { status: 'error', message: 'The conversion could not be confirmed. Reload the idea before trying again.' }
  }

  revalidatePath('/ideas')
  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/projects')
  revalidatePath(`/projects/${project.project_slug}`)
  revalidatePath('/notifications')
  redirect(`/projects/${project.project_slug}?converted=1&invited=${project.invited_count}`)
}

// =============================================================================
// Local mode
//
// The author checks below are the only thing standing between one person's idea and
// another person's form: there is no `ideas_update_own` policy here. The conversion
// is `public.convert_idea_to_project` written out by hand, in one `mutate`, so the
// project and the `converted` marker cannot come apart.
//
// Columns the local row does not have (`looking_for`, `moderation_status`,
// `converted_at`) are accepted by the forms and not stored. See the port notes in
// .scratch/projects-ideas-local.
// =============================================================================

/** `app.slugify`: lowercase, words joined by single hyphens. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** `app.unique_slug`: `-2`, `-3`, … until the existing slugs are cleared. */
function uniqueSlug(db: Tables, base: string): string {
  const seed = base === '' ? 'project' : base
  if (!db.projects.some((project) => project.slug === seed)) return seed

  let counter = 2
  while (db.projects.some((project) => project.slug === `${seed}-${counter}`)) counter += 1
  return `${seed}-${counter}`
}

const NO_PROFILE: FormState = {
  status: 'error',
  message: 'This account has no profile in the local store, so nothing can be saved under it.',
}

async function createIdeaLocal(
  userId: string,
  data: IdeaCreateInput,
  formData: FormData,
): Promise<FormState> {
  const created = await mutate((db) => {
    const author = localActor(db, userId)
    if (!author) return null

    const idea: LocalIdea = {
      id: id('dea'),
      // `ideas_before_write`: the author is the caller, never a posted field.
      author_id: author.id,
      title: data.title.trim(),
      description: data.description.trim(),
      category: data.category,
      // The insert trigger forces `open`: an idea cannot be born closed or
      // converted.
      status: 'open',
      visibility: data.visibility as LocalIdea['visibility'],
      upvote_count: 0,
      interest_count: 0,
      converted_project_id: null,
      created_at: now(),
      deleted_at: null,
    }

    // `looking_for` has no local column, so the "who are you looking for" prose is
    // not stored here.
    db.ideas.push(idea)
    return idea.id
  })

  if (!created) return { ...NO_PROFILE, values: echoValues(formData) }

  revalidatePath('/ideas')
  redirect(`/ideas/${created}`)
}

async function updateIdeaLocal(
  userId: string,
  ideaId: string,
  data: IdeaEditInput,
): Promise<FormState> {
  const updated = await mutate((db) => {
    const viewer = localActor(db, userId)
    if (!viewer) return false

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    // `ideas_update_own`: the author, and nobody else.
    if (!idea || idea.author_id !== viewer.id || !canReadContent(db, idea, idea.author_id, viewer, 'idea')) return false

    idea.title = data.title.trim()
    idea.description = data.description.trim()
    idea.category = data.category
    // The local status union says `in_progress` where the app's vocabulary says
    // `forming`; the read shape is `string` and the label helper handles both, so
    // the requested value is stored as given.
    idea.status = data.status as LocalIdea['status']
    idea.visibility = data.visibility as LocalIdea['visibility']

    // lookingFor has no local column.
    return true
  })

  if (!updated) return { status: 'error', message: 'That idea is not yours to edit.' }

  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/ideas')
  return { status: 'success', message: 'Saved.' }
}

async function closeIdeaLocal(userId: string, ideaId: string): Promise<FormState> {
  const closed = await mutate((db) => {
    const viewer = localActor(db, userId)
    if (!viewer) return false

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    if (!idea || idea.author_id !== viewer.id || !canReadContent(db, idea, idea.author_id, viewer, 'idea')) return false

    idea.status = 'closed'
    return true
  })

  if (!closed) return { status: 'error', message: 'That idea is not yours to close.' }

  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/ideas')
  return { status: 'success', message: 'Closed. It stays visible as a record.' }
}

async function convertIdeaLocal(userId: string, ideaId: string): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = localActor(db, userId)
    if (!viewer) return 'not-found'

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    if (!idea || !canReadContent(db, idea, idea.author_id, viewer, 'idea')) return 'not-found'

    // `convert_idea_to_project`: the author, or an admin.
    if (idea.author_id !== viewer.id) return 'forbidden'
    if (idea.status === 'converted') return 'already'

    const requiredSkills = db.idea_skills.filter(row => row.idea_id === idea.id)
    if (requiredSkills.some(row => !db.skills.some(skill => skill.id === row.skill_id &&
        (skill.is_approved || skill.created_by === viewer.id)))) return 'skills'
    const before = structuredClone(db)
    const mutationNowMs = Date.now()
    const author = db.profiles.find((profile) => profile.id === idea.author_id)
    // The project is created on the author's behalf, so the owner-profile clamp
    // applies exactly as it would on a direct create.
    const visibility = clampVisibility(
      idea.visibility as LocalProject['visibility'],
      author?.visibility ?? 'private',
    )

    const created = now()
    const project: LocalProject = {
      id: id('prj'),
      owner_id: idea.author_id,
      slug: uniqueSlug(db, slugify(idea.title)),
      title: idea.title,
      // The database function copies `looking_for` into the project tagline, and
      // the local idea has no looking_for column -- so there is no one-liner to
      // copy. `''` keeps the column's type and reads as "not written yet".
      purpose: '',
      description: idea.description,
      category: idea.category,
      status: 'planning',
      visibility,
      // The function sets `true`; the trigger then forces it off for a private
      // project, which is the same rule applied here.
      is_seeking_members: visibility !== 'private',
      team_size_target: null,
      member_count: 1,
      created_at: created,
      deleted_at: null,
    }

    db.projects.push(project)
    db.project_members.push({
      id: id('mem'),
      project_id: project.id,
      profile_id: idea.author_id,
      role: 'owner',
      created_at: created,
    })
    for (const skill of requiredSkills) {
      if (!db.project_skills.some(row => row.project_id === project.id && row.skill_id === skill.skill_id)) {
        db.project_skills.push({ id: id('psk'), project_id: project.id, skill_id: skill.skill_id, is_required: true, created_at: created })
      }
    }

    // Both halves of the conversion, in the same mutation: the idea cannot end up
    // pointing at a project that was never written.
    idea.status = 'converted'
    idea.converted_project_id = project.id

    // A non-consuming preview INSIDE the store lock validates the existing
    // ledger and reserves no bypass. The real commit hook rechecks every actual
    // row. A refused base conversion rolls everything back; optional fan-out
    // only uses remaining slots and never edits/reset the ledger.
    const ledger = enforceMutationLimits(before, db, { actorUserId: userId, nowMs: mutationNowMs })
    const policy = RATE_LIMITS['project:write']
    const windowMs = policy.windowSeconds * 1000
    const start = Math.floor(mutationNowMs / windowMs) * windowMs
    const spent = ledger.find(row => row.bucket === 'project:write' &&
      row.subject === userId && row.window_start_ms === start)?.hits ?? 0
    const invited = inviteIdeaParticipantsLocal(db, idea.id, project, viewer, Math.max(0, policy.limit - spent), created)
    return { slug: project.slug, invited }
  })

  if (result === 'forbidden') {
    return { status: 'error', message: 'Only the person who proposed the idea can turn it into a project.' }
  }
  if (result === 'already') {
    return { status: 'error', message: 'This idea has already become a project.' }
  }
  if (result === 'not-found') {
    return { status: 'error', message: 'That idea no longer exists.' }
  }
  if (result === 'skills') {
    return { status: 'error', message: 'A required skill is no longer available, so nothing was converted.' }
  }

  revalidatePath('/ideas')
  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/projects')
  revalidatePath(`/projects/${result.slug}`)
  revalidatePath('/notifications')
  redirect(`/projects/${result.slug}?converted=1&invited=${result.invited}`)
}

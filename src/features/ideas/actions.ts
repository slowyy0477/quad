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
import { id, mutate, now, type LocalIdea, type LocalProject, type Tables } from '@/lib/local/db'
import { clampVisibility } from '@/features/projects/queries'
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

/** Neither `idea_votes` nor `idea_interest` exists in the local store. */
const NO_VOTES: FormState = {
  status: 'error',
  message:
    'Votes are not stored in local mode yet — the local store has no idea_votes table. Nothing was saved.',
}

const NO_INTEREST: FormState = {
  status: 'error',
  message:
    'Offers to help are not stored in local mode yet — the local store has no idea_interest table. Nothing was saved.',
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

  if (isLocalMode()) return createIdeaLocal(user.id, parsed.data, formData)

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

  if (isLocalMode()) return updateIdeaLocal(user.id, ideaId, parsed.data)

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

  if (isLocalMode()) return closeIdeaLocal(user.id, ideaId)

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
  if (isLocalMode()) return NO_VOTES

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
  if (isLocalMode()) return NO_INTEREST

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
  if (isLocalMode()) return NO_INTEREST

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
 * Three steps, in this order, and each one is necessary:
 *
 * 1. `public.convert_idea_to_project` creates the project from the idea's own fields,
 *    copies the required skills across into `project_skills`, and marks the idea
 *    `converted` with `converted_project_id` set — all inside one transaction, so an
 *    idea can never point at nothing. It refuses a second run with 23505.
 *
 * 2. Everyone who said they would help is invited. The function does not do this and
 *    no trigger does either, so the wizard's promise — "3 people interested will be
 *    invited" — is only true because this loop runs. Each invite goes in on its own so
 *    one person who has invites switched off cannot block the other two; the number
 *    reported back is the number that actually landed.
 *
 * 3. The reader is sent to the new project, which already lists them as its owner
 *    through the membership row the create trigger wrote.
 *
 * No notification row is written here. `project_invites_notify` in 0014 fires on the
 * invite insert and produces the notification, which is the whole reason the invites
 * are real rows rather than a message this action prints.
 */
export async function convertIdeaToProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const ideaId = String(formData.get('ideaId') ?? '')
  if (!ideaId) return { status: 'error', message: 'That idea could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/ideas/${ideaId}`)

  if (isLocalMode()) return convertIdeaLocal(user.id, ideaId)

  const supabase = await createClient()

  // Read the interested people first, so a failure to invite one of them cannot be
  // mistaken for there having been nobody to invite.
  const { data: interested, error: interestError } = await supabase
    .from('idea_interest')
    .select('profile_id')
    .eq('idea_id', ideaId)
    .returns<{ profile_id: string }[]>()

  if (interestError) {
    console.error('[ideas:convert:interest]', interestError.code, interestError.message)
    return { status: 'error', message: 'That idea could not be read, so nothing was converted.' }
  }

  const { data: projectId, error } = await supabase.rpc('convert_idea_to_project', {
    p_idea_id: ideaId,
  })

  if (error) {
    return describeWriteError(error, 'ideas:convert', {
      '42501': 'Only the person who proposed the idea can turn it into a project.',
      '23505': 'This idea has already become a project.',
      P0002: 'That idea no longer exists.',
    })
  }

  const newProjectId = projectId as unknown as string

  let invited = 0
  for (const person of interested ?? []) {
    const { error: inviteError } = await supabase.from('project_invites').insert({
      project_id: newProjectId,
      invitee_id: person.profile_id,
      // inviter_id and status are set by the trigger; sending them would be inert.
      message: 'You said you would help build this. It is a project now.',
    })
    if (inviteError) {
      // Logged and skipped: one person with invitations switched off must not stop
      // the rest. describeWriteError is not used because there is no form to answer.
      console.error('[ideas:convert:invite]', inviteError.code, inviteError.message)
    } else {
      invited += 1
    }
  }

  const { data: project, error: slugError } = await supabase
    .from('projects')
    .select('slug')
    .eq('id', newProjectId)
    .maybeSingle<{ slug: string }>()

  if (slugError || !project) {
    console.error('[ideas:convert:slug]', slugError?.code, slugError?.message)
    revalidatePath('/ideas')
    revalidatePath('/projects')
    return { status: 'success', message: 'The project was created. Find it under Projects.' }
  }

  revalidatePath('/ideas')
  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/projects')
  revalidatePath(`/projects/${project.slug}`)
  redirect(`/projects/${project.slug}?converted=1&invited=${invited}`)
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
    const author = db.profiles.find((profile) => profile.user_id === userId)
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
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return false

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    // `ideas_update_own`: the author, and nobody else.
    if (!idea || idea.author_id !== viewer.id) return false

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
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return false

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    if (!idea || idea.author_id !== viewer.id) return false

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
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'not-found'

    const idea = db.ideas.find((entry) => entry.id === ideaId && entry.deleted_at === null)
    if (!idea) return 'not-found'

    // `convert_idea_to_project`: the author, or an admin.
    if (idea.author_id !== viewer.id) return 'forbidden'
    if (idea.status === 'converted') return 'already'

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

    // Both halves of the conversion, in the same mutation: the idea cannot end up
    // pointing at a project that was never written.
    idea.status = 'converted'
    idea.converted_project_id = project.id

    return { slug: project.slug }
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

  // No `project_invites` table in the local store, so nobody is invited and the
  // page is told the truth: the project exists, and the author owns it.
  revalidatePath('/ideas')
  revalidatePath(`/ideas/${ideaId}`)
  revalidatePath('/projects')
  revalidatePath(`/projects/${result.slug}`)
  redirect(`/projects/${result.slug}?converted=1&invited=0`)
}

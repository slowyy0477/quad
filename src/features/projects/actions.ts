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
import { id, mutate, now, type LocalProject, type Tables } from '@/lib/local/db'
import { canManageProject, clampVisibility } from '@/features/projects/queries'
import {
  projectCreateSchema,
  projectEditSchema,
  projectJoinSchema,
  projectSeekingSchema,
  projectUpdateSchema,
  skillIdList,
  type ProjectCreateInput,
  type ProjectEditInput,
  type ProjectSeekingInput,
} from '@/features/projects/schemas'

/**
 * Project writes.
 *
 * Three rules this file follows, all of them because of how the database is built.
 *
 * 1. **`owner_id` is never sent.** `app.projects_before_write` sets it from
 *    `auth.uid()` on insert for any caller that is not a marked trusted write. A
 *    forged value is overwritten rather than rejected, which means sending one
 *    fails silently — so it is simply not sent.
 *
 * 2. **`slug`, the counters and `university_id` are never sent.** They are absent
 *    from the UPDATE grant. Relying on the refusal would make an error the safety
 *    mechanism.
 *
 * 3. **An update that affects zero rows is a failure.** RLS declining an UPDATE is
 *    not a Postgres error: the statement succeeds and changes nothing. Every update
 *    here therefore asks for the row back and treats an empty result as refusal.
 *
 * Membership, roles, accept/decline and the "seeking members" gate are all decided
 * by the policies in 0007. Nothing in this file re-implements one of them; it calls
 * the write and maps the refusal to a sentence.
 *
 * LOCAL MODE
 * ----------
 * There are no policies in the local store, so the checks written here are the only
 * authorisation there is: `canManageProject` (the `app.can_manage_project`
 * predicate) and the "not yours" refusals are load-bearing rather than belt-and-
 * braces. The writes go through `mutate`, the same `FormState`s come back, and the
 * `revalidatePath` calls are unchanged. Actions whose table does not exist in the
 * local store refuse with a message instead of claiming a write they did not make.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so projects cannot be saved.',
}

const NOT_FOUND: FormState = {
  status: 'error',
  message: 'That project could not be found, or it is not one you can change.',
}

/**
 * The local store has no `project_stars`, `project_applications` or
 * `project_invites` table. Those actions answer with one of these rather than
 * reporting success for a row nothing wrote.
 */
const NO_STARS: FormState = {
  status: 'error',
  message:
    'Stars are not stored in local mode yet — the local store has no project_stars table. Nothing was saved.',
}

const NO_APPLICATIONS: FormState = {
  status: 'error',
  message:
    'Join requests are not stored in local mode yet — the local store has no project_applications table. Nothing was saved.',
}

/** The columns a create and an edit both write, in the shape Postgres wants. */
function projectRow(data: {
  title: string
  tagline?: string
  description?: string
  category: string
  status: string
  visibility: string
  repoUrl?: string
  demoUrl?: string
  isSeekingMembers: boolean
  lookingFor?: string
  teamSizeTarget?: number
  startedAt?: string
}) {
  return {
    title: data.title,
    tagline: data.tagline ?? null,
    description: data.description ?? null,
    category: data.category,
    status: data.status,
    visibility: data.visibility,
    repo_url: data.repoUrl ?? null,
    demo_url: data.demoUrl ?? null,
    is_seeking_members: data.isSeekingMembers,
    looking_for: data.lookingFor ?? null,
    team_size_target: data.teamSizeTarget ?? null,
    started_at: data.startedAt ?? null,
  }
}

function readForm(formData: FormData) {
  return {
    title: String(formData.get('title') ?? ''),
    tagline: String(formData.get('tagline') ?? ''),
    description: String(formData.get('description') ?? ''),
    category: String(formData.get('category') ?? 'other'),
    status: String(formData.get('status') ?? 'planning'),
    visibility: String(formData.get('visibility') ?? 'public'),
    repoUrl: String(formData.get('repoUrl') ?? ''),
    demoUrl: String(formData.get('demoUrl') ?? ''),
    isSeekingMembers: String(formData.get('isSeekingMembers') ?? ''),
    lookingFor: String(formData.get('lookingFor') ?? ''),
    teamSizeTarget: String(formData.get('teamSizeTarget') ?? ''),
    startedAt: String(formData.get('startedAt') ?? ''),
  }
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export async function createProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/projects/new')

  const parsed = projectCreateSchema.safeParse(readForm(formData))
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) return createProjectLocal(user.id, parsed.data, formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .insert(projectRow(parsed.data))
    // The slug is generated by the trigger from the title, and `app.unique_slug`
    // walks a counter until it clears the unique index — so a second project with
    // the same title gets `-2` rather than a 23505. It is only knowable after the
    // insert, and it is what the redirect needs.
    .select('slug, visibility')
    .single<{ slug: string; visibility: string }>()

  if (error) {
    return { ...describeWriteError(error, 'projects:create'), values: echoValues(formData) }
  }

  revalidatePath('/projects')
  revalidatePath('/me')

  // If the owner's profile is not public, the trigger has already clamped this
  // project's visibility down. Saying so on arrival is better than letting them
  // discover later that nobody can see it.
  const clamped = parsed.data.visibility !== data.visibility
  // `welcome=1` is what turns on the "write your first update" offer on the page
  // the creator lands on. The offer is the composer that already lives there; the
  // parameter only decides whether the page points at it.
  redirect(`/projects/${data.slug}?welcome=1${clamped ? '&clamped=1' : ''}`)
}

// -----------------------------------------------------------------------------
// Edit
// -----------------------------------------------------------------------------

export async function updateProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const slug = String(formData.get('slug') ?? '')
  if (!slug) return { status: 'error', message: 'That project could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}/edit`)

  const parsed = projectEditSchema.safeParse({
    ...readForm(formData),
    completedAt: String(formData.get('completedAt') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) return updateProjectLocal(user.id, slug, parsed.data, formData)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .update({
      ...projectRow(parsed.data),
      completed_at: parsed.data.completedAt ?? null,
    })
    .eq('slug', slug)
    .select('slug')
    .maybeSingle<{ slug: string }>()

  if (error) {
    return { ...describeWriteError(error, 'projects:update'), values: echoValues(formData) }
  }

  // Zero rows: the policy declined. Either it is not theirs to edit or it is gone.
  if (!data) {
    return {
      status: 'error',
      message: 'That project is not yours to edit, or it no longer exists.',
      values: echoValues(formData),
    }
  }

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return { status: 'success', message: 'Saved.' }
}

// -----------------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------------

/**
 * Soft delete.
 *
 * `deleted_at` is in the UPDATE grant precisely so an owner can retire a project
 * without the row vanishing from under the posts, applications and memberships that
 * reference it. A hard DELETE would cascade through all of them.
 */
export async function deleteProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const slug = String(formData.get('slug') ?? '')
  if (!slug) return { status: 'error', message: 'That project could not be identified.' }

  const user = await getUser()
  if (!user) redirect('/login')

  if (isLocalMode()) return deleteProjectLocal(user.id, slug)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .update({ deleted_at: new Date().toISOString() })
    .eq('slug', slug)
    .is('deleted_at', null)
    .select('slug')
    .maybeSingle<{ slug: string }>()

  if (error) return describeWriteError(error, 'projects:delete')
  if (!data) {
    return { status: 'error', message: 'That project is not yours to delete, or it is already gone.' }
  }

  revalidatePath('/projects')
  revalidatePath('/me')
  redirect('/projects?deleted=1')
}

// -----------------------------------------------------------------------------
// Stars
// -----------------------------------------------------------------------------

/**
 * Star or unstar.
 *
 * The current state arrives from the form rather than being read first. Reading it
 * would not make this safe -- the primary key and the delete policy are what decide
 * -- and a duplicate insert from a double-click produces 23505, which is treated as
 * "already starred" rather than an error worth showing anyone.
 */
export async function toggleStarAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const starred = String(formData.get('starred') ?? '') === 'true'

  if (!projectId) return { status: 'error', message: 'That project could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  // No `project_stars` table in the local store: a star has nowhere to go, and
  // `hasStarred` always answers false, so the button would flip back on the next
  // render even if this reported success.
  if (isLocalMode()) return NO_STARS

  const supabase = await createClient()

  if (starred) {
    const { error } = await supabase
      .from('project_stars')
      .delete()
      .eq('project_id', projectId)
      .eq('profile_id', user.id)
    if (error) return describeWriteError(error, 'projects:unstar')
  } else {
    // profile_id is set by the trigger from auth.uid(); it is sent here only
    // because the insert policy's WITH CHECK reads the column, and a NOT NULL
    // column cannot be omitted from the statement.
    const { error } = await supabase
      .from('project_stars')
      .insert({ project_id: projectId, profile_id: user.id })
    if (error && error.code !== '23505') return describeWriteError(error, 'projects:star')
  }

  if (slug) revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return { status: 'success' }
}

// -----------------------------------------------------------------------------
// Joining: the applicant's side
// -----------------------------------------------------------------------------

/**
 * Ask to join.
 *
 * `applicant_id` is never sent: `app.project_applications_before_write` forces it to
 * `auth.uid()` and forces the status to `pending`, so the applicant cannot write
 * themselves onto the team. The triggers also refuse an application from the owner,
 * from an existing member, and to a project that is not seeking members — three
 * refusals that arrive as Postgres errors and become one sentence each.
 */
export async function requestToJoinAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  if (!projectId) return { status: 'error', message: 'That project could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  const parsed = projectJoinSchema.safeParse({
    message: String(formData.get('message') ?? ''),
    desiredRole: String(formData.get('desiredRole') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  // No `project_applications` table in the local store, so the request cannot be
  // recorded. Refusing is the only honest answer: a success message would send the
  // applicant away believing the owners could see a note that does not exist.
  if (isLocalMode()) return NO_APPLICATIONS

  const supabase = await createClient()
  const { error } = await supabase.from('project_applications').insert({
    project_id: projectId,
    message: parsed.data.message ?? null,
    desired_role: parsed.data.desiredRole ?? null,
  })

  if (error) {
    return describeWriteError(error, 'projects:requestToJoin', {
      '23514': 'You cannot ask to join this project — you may already be on it.',
      '42501': 'This project is not taking new members right now.',
    })
  }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'Your request was sent. The project’s owners will see it.' }
}

/** Withdraw a request that has not been answered. Only the applicant's own row. */
export async function withdrawApplicationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  if (isLocalMode()) return NO_APPLICATIONS

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_applications')
    .update({ status: 'withdrawn' })
    .eq('project_id', projectId)
    .eq('applicant_id', user.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'projects:withdrawApplication')
  if (!data) return { status: 'error', message: 'That request was already answered.' }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'Your request was withdrawn.' }
}

// -----------------------------------------------------------------------------
// Membership: the owner's side
// -----------------------------------------------------------------------------

/** Accept or decline a join request. Accepting creates the membership by trigger. */
export async function reviewApplicationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const applicationId = String(formData.get('applicationId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const decision = String(formData.get('decision') ?? '')

  if (!applicationId) return { status: 'error', message: 'That request could not be identified.' }
  if (decision !== 'accepted' && decision !== 'rejected') {
    return { status: 'error', message: 'That decision is not one of the two this control posts.' }
  }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  // No applications were ever written locally, so there is nothing to answer.
  if (isLocalMode()) return NO_APPLICATIONS

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_applications')
    .update({ status: decision, reviewed_by: user.id })
    .eq('id', applicationId)
    // An answered request is not a live one; the policy also requires it to be this
    // project's to manage, but asking for a pending row keeps a double-click from
    // rewriting a decision.
    .eq('status', 'pending')
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'projects:reviewApplication')
  if (!data) {
    return { status: 'error', message: 'That request is not yours to answer, or it was already answered.' }
  }

  revalidatePath(`/projects/${slug}`)
  return {
    status: 'success',
    message: decision === 'accepted' ? 'They are on the project.' : 'The request was declined.',
  }
}

/** Change a member's role between `member` and `maintainer`. Never `owner`. */
export async function changeMemberRoleAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const profileId = String(formData.get('profileId') ?? '')
  const role = String(formData.get('role') ?? '')

  // The owner role is deliberately absent. Ownership moves only through
  // transfer_project_ownership, which the trigger enforces even if a client asks.
  if (role !== 'member' && role !== 'maintainer') {
    return { status: 'error', message: 'Roles are member or maintainer. Ownership is transferred, not set.' }
  }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  if (isLocalMode()) return changeMemberRoleLocal(user.id, slug, projectId, profileId, role)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .update({ role })
    .eq('project_id', projectId)
    .eq('profile_id', profileId)
    .select('profile_id')
    .maybeSingle<{ profile_id: string }>()

  if (error) return describeWriteError(error, 'projects:changeMemberRole')
  if (!data) {
    return { status: 'error', message: 'That is not yours to change, or the owner cannot be demoted.' }
  }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'Role updated.' }
}

/** Remove a member. The owner cannot be removed; the trigger refuses it. */
export async function removeMemberAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const profileId = String(formData.get('profileId') ?? '')

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  if (isLocalMode()) return removeMemberLocal(user.id, slug, projectId, profileId)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('profile_id', profileId)
    .select('profile_id')
    .maybeSingle<{ profile_id: string }>()

  if (error) {
    return describeWriteError(error, 'projects:removeMember', {
      '42501': 'The owner cannot be removed. Transfer ownership first.',
    })
  }
  if (!data) return { status: 'error', message: 'That member is not yours to remove.' }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'They were removed from the project.' }
}

/**
 * Hand the project to another member.
 *
 * Two rows change in one statement inside the database: the old owner drops to
 * maintainer and the new owner takes the owner slot, without the single-owner index
 * ever seeing two owners. Doing it with two client UPDATEs cannot be made atomic.
 */
export async function transferOwnershipAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const projectId = String(formData.get('projectId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const newOwner = String(formData.get('profileId') ?? '')

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  if (isLocalMode()) return transferOwnershipLocal(user.id, slug, projectId, newOwner)

  const supabase = await createClient()
  const { error } = await supabase.rpc('transfer_project_ownership', {
    p_project_id: projectId,
    p_new_owner: newOwner,
  })

  if (error) {
    return describeWriteError(error, 'projects:transferOwnership', {
      '42501': 'Only the current owner can transfer a project.',
      '23514': 'The new owner has to be a member of the project already.',
      P0002: 'That project could not be found.',
    })
  }

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return { status: 'success', message: 'Ownership transferred. You are now a maintainer.' }
}

// -----------------------------------------------------------------------------
// "Seeking members": the flag, the target and the required skills
// -----------------------------------------------------------------------------

/**
 * Save the team-finder settings.
 *
 * Two writes, and the order matters: the flags on `projects` first, then the required
 * skills. `project_skills` is the machine-readable half of the ask, so a project that
 * says it wants a designer must actually list the skill or the team-finder rows will
 * not carry it.
 *
 * The skill set is replaced rather than merged: a skill the form did not post is a
 * skill the owner unchecked. Rows the owner did not manage here (`is_required =
 * false`, the portfolio signal) are left alone, so this control cannot quietly delete
 * them.
 */
export async function saveSeekingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const slug = String(formData.get('slug') ?? '')
  if (!slug) return { status: 'error', message: 'That project could not be identified.' }

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  const parsed = projectSeekingSchema.safeParse({
    isSeekingMembers: String(formData.get('isSeekingMembers') ?? ''),
    teamSizeTarget: String(formData.get('teamSizeTarget') ?? ''),
    lookingFor: String(formData.get('lookingFor') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const parsedSkills = skillIdList.safeParse(formData.getAll('skillIds'))
  if (!parsedSkills.success) {
    return { status: 'error', message: parsedSkills.error.issues[0]?.message ?? 'Those skills could not be read.' }
  }

  if (isLocalMode()) return saveSeekingLocal(user.id, slug, parsed.data, formData)

  const supabase = await createClient()

  const { data: project, error: readError } = await supabase
    .from('projects')
    .select('id, visibility')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; visibility: string }>()

  if (readError) {
    console.error('[projects:saveSeeking:read]', readError.code, readError.message)
    return NOT_FOUND
  }
  if (!project) return NOT_FOUND

  // A private project cannot advertise: the trigger forces the flag off on write, so
  // the form never offers more than the database will store. Asking for the honest
  // value here means the reader is not told a setting was saved that was discarded.
  const wantsSeeking = project.visibility === 'private' ? false : parsed.data.isSeekingMembers

  const { data: updated, error } = await supabase
    .from('projects')
    .update({
      is_seeking_members: wantsSeeking,
      team_size_target: parsed.data.teamSizeTarget ?? null,
      looking_for: parsed.data.lookingFor ?? null,
    })
    .eq('id', project.id)
    .select('slug')
    .maybeSingle<{ slug: string }>()

  if (error) return describeWriteError(error, 'projects:saveSeeking')
  if (!updated) return NOT_FOUND

  const wanted = parsedSkills.data

  // Clear the required rows the owner just unchecked, and promote any of the newly
  // chosen skills that already existed as a non-required portfolio signal. A single
  // delete keeps the primary key (project_id, skill_id) from colliding on insert.
  let clear = supabase.from('project_skills').delete().eq('project_id', project.id)
  clear =
    wanted.length > 0
      ? clear.or(`is_required.eq.true,skill_id.in.(${wanted.join(',')})`)
      : clear.eq('is_required', true)

  const { error: clearError } = await clear
  if (clearError) return describeWriteError(clearError, 'projects:saveSeeking:clear')

  if (wanted.length > 0) {
    const { error: insertError } = await supabase
      .from('project_skills')
      .insert(wanted.map((skillId) => ({ project_id: project.id, skill_id: skillId, is_required: true })))
    if (insertError) return describeWriteError(insertError, 'projects:saveSeeking:skills')
  }

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return {
    status: 'success',
    message: project.visibility === 'private'
      ? 'Saved. A private project cannot advertise, so it stays out of the open list.'
      : 'Saved.',
    values: echoValues(formData),
  }
}

// -----------------------------------------------------------------------------
// Project updates
// -----------------------------------------------------------------------------

/**
 * Post an update on the project.
 *
 * An update is a real `posts` row anchored to the project (`type = 'project_update'`,
 * `project_id` set), which is what puts it in the update stream, in the feed when it
 * is shared, and in `projects.post_count` through the existing trigger. `author_id`
 * is never sent: it defaults to `auth.uid()` and the trigger overwrites it.
 *
 * Visibility is the only choice the reader makes, and it is honest about what it
 * does. `posts` RLS has no "project members" clause — a post is readable by whoever
 * its own `visibility` admits — so:
 *
 *   * "post to the feed" -> `university`, which is also what makes it appear in
 *     `/feed` for classmates;
 *   * left as a note -> `private`, readable by nobody but its author.
 *
 * A private project can never offer the first option: a shared update renders the
 * project's title wherever the post appears, which would leak a project the reader
 * chose to keep private.
 *
 * Members are not notified here, and no notification row is written by hand.
 * Notification fan-out belongs to the triggers in 0014; there is no trigger for a
 * project update yet, so this action does not claim one exists.
 */
export async function postUpdateAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isLocalMode() && !isSupabaseConfigured()) return UNAVAILABLE

  const slug = String(formData.get('slug') ?? '')
  const share = String(formData.get('share') ?? '') === 'on'

  const user = await getUser()
  if (!user) redirect(`/login?next=/projects/${slug}`)

  const parsed = projectUpdateSchema.safeParse({ body: String(formData.get('body') ?? '') })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  if (isLocalMode()) return postUpdateLocal(user.id, slug, parsed.data.body, share)

  const supabase = await createClient()

  const { data: project, error: readError } = await supabase
    .from('projects')
    .select('id, visibility')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; visibility: string }>()

  if (readError) {
    console.error('[projects:postUpdate:read]', readError.code, readError.message)
    return NOT_FOUND
  }
  if (!project) return NOT_FOUND

  const visibility = share && project.visibility !== 'private' ? 'university' : 'private'

  const { error } = await supabase.from('posts').insert({
    body: parsed.data.body,
    type: 'project_update',
    project_id: project.id,
    visibility,
  })

  if (error) {
    return describeWriteError(error, 'projects:postUpdate', {
      '42501': 'Only members of this project can post an update to it.',
    })
  }

  revalidatePath(`/projects/${slug}`)
  if (visibility !== 'private') revalidatePath('/feed')
  return {
    status: 'success',
    message:
      visibility === 'private'
        ? 'Saved on the project page. Only you can see it.'
        : 'Posted, and shared to the feed as well.',
  }
}

// =============================================================================
// Local mode
//
// No policies, so the checks below are the authorisation. The trigger behaviour
// they mirror is named at each one: the visibility clamp, the owner membership
// row, the counter maintenance, and `app.prevent_owner_removal`.
//
// Columns the local row does not have (`repo_url`, `demo_url`, `looking_for`,
// `started_at`, `completed_at`) are accepted by the forms and not stored -- see the
// port notes in .scratch/projects-ideas-local.
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

async function createProjectLocal(
  userId: string,
  data: ProjectCreateInput,
  formData: FormData,
): Promise<FormState> {
  const created = await mutate((db) => {
    const owner = db.profiles.find((profile) => profile.user_id === userId)
    if (!owner) return null

    // `projects_before_write`'s clamp: a project is never more visible than its
    // owner's profile. A private profile therefore publishes nothing.
    const visibility = clampVisibility(
      data.visibility as LocalProject['visibility'],
      owner.visibility,
    )

    const created = now()
    const project: LocalProject = {
      id: id('prj'),
      owner_id: owner.id,
      slug: uniqueSlug(db, slugify(data.title)),
      title: data.title.trim(),
      // The local column for the one-line summary is `purpose`; the form calls it
      // the tagline. `''` rather than null because the column is not nullable.
      purpose: data.tagline ?? '',
      description: data.description ?? null,
      category: data.category,
      // The local row's status union is narrower than the app's vocabulary
      // ('paused' and 'abandoned' are not in it). The store is JSON, the read
      // shape is `string`, and the label helper handles any value, so the
      // requested status is stored as given.
      status: data.status as LocalProject['status'],
      visibility,
      // The trigger's rule: a private project cannot advertise.
      is_seeking_members: visibility === 'private' ? false : data.isSeekingMembers,
      team_size_target: data.teamSizeTarget ?? null,
      member_count: 1,
      created_at: created,
      deleted_at: null,
    }

    db.projects.push(project)

    // `app.projects_after_insert`: the owner is on their own project from the
    // first moment, which is also what makes member_count read 1 rather than 0.
    db.project_members.push({
      id: id('mem'),
      project_id: project.id,
      profile_id: owner.id,
      role: 'owner',
      created_at: created,
    })

    return { slug: project.slug, visibility, requested: data.visibility }
  })

  if (!created) return { ...NO_PROFILE, values: echoValues(formData) }

  revalidatePath('/projects')
  revalidatePath('/me')

  const clamped = created.requested !== created.visibility
  redirect(`/projects/${created.slug}?welcome=1${clamped ? '&clamped=1' : ''}`)
}

async function updateProjectLocal(
  userId: string,
  slug: string,
  data: ProjectEditInput,
  formData: FormData,
): Promise<FormState> {
  const updated = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return false

    const project = db.projects.find((entry) => entry.slug === slug && entry.deleted_at === null)
    // `projects_update_manage`: only a manager may edit, and an update that finds
    // no row it may change is the refusal, not an error.
    if (!project || !canManageProject(db, project, viewer.id)) return false

    const owner = db.profiles.find((profile) => profile.id === project.owner_id)
    // The trigger runs on UPDATE as well, so the clamp applies every time the
    // visibility is written, not only at creation.
    const visibility = clampVisibility(
      data.visibility as LocalProject['visibility'],
      owner?.visibility ?? 'private',
    )

    project.title = data.title.trim()
    project.purpose = data.tagline ?? ''
    project.description = data.description ?? null
    project.category = data.category
    project.status = data.status as LocalProject['status']
    project.visibility = visibility
    project.is_seeking_members = visibility === 'private' ? false : data.isSeekingMembers
    project.team_size_target = data.teamSizeTarget ?? null

    // repoUrl, demoUrl, startedAt and completedAt have no local column and are
    // dropped here rather than being reported as saved.
    return true
  })

  if (!updated) {
    return {
      status: 'error',
      message: 'That project is not yours to edit, or it no longer exists.',
      values: echoValues(formData),
    }
  }

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return { status: 'success', message: 'Saved.' }
}

async function deleteProjectLocal(userId: string, slug: string): Promise<FormState> {
  const deleted = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return false

    const project = db.projects.find((entry) => entry.slug === slug && entry.deleted_at === null)
    if (!project || !canManageProject(db, project, viewer.id)) return false

    // Soft, like the Supabase path: the posts and memberships that point at this
    // project keep pointing at something.
    project.deleted_at = now()
    return true
  })

  if (!deleted) {
    return { status: 'error', message: 'That project is not yours to delete, or it is already gone.' }
  }

  revalidatePath('/projects')
  revalidatePath('/me')
  redirect('/projects?deleted=1')
}

async function changeMemberRoleLocal(
  userId: string,
  slug: string,
  projectId: string,
  profileId: string,
  role: 'member' | 'maintainer',
): Promise<FormState> {
  const changed = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    const project = db.projects.find((entry) => entry.id === projectId && entry.deleted_at === null)
    if (!viewer || !project || !canManageProject(db, project, viewer.id)) return false

    const member = db.project_members.find(
      (entry) => entry.project_id === projectId && entry.profile_id === profileId,
    )
    // `project_members_before_write`: "Cannot demote the project owner". The owner
    // role is not settable here at all -- ownership moves by transfer.
    if (!member || member.role === 'owner') return false

    member.role = role
    return true
  })

  if (!changed) {
    return { status: 'error', message: 'That is not yours to change, or the owner cannot be demoted.' }
  }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'Role updated.' }
}

async function removeMemberLocal(
  userId: string,
  slug: string,
  projectId: string,
  profileId: string,
): Promise<FormState> {
  const removed = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    const project = db.projects.find((entry) => entry.id === projectId && entry.deleted_at === null)
    if (!viewer || !project) return 'not-found'

    const member = db.project_members.find(
      (entry) => entry.project_id === projectId && entry.profile_id === profileId,
    )
    if (!member) return 'not-found'

    // `project_members_delete_manage` or `project_members_delete_self`: a manager
    // may remove anyone, and anyone may leave.
    const allowed = canManageProject(db, project, viewer.id) || member.profile_id === viewer.id
    if (!allowed) return 'forbidden'

    // `app.prevent_owner_removal`.
    if (member.role === 'owner') return 'owner'

    db.project_members.splice(db.project_members.indexOf(member), 1)
    // `app.sync_project_member_count`, kept in step even though reads derive it.
    project.member_count = Math.max(0, project.member_count - 1)
    return 'ok'
  })

  if (removed === 'owner') {
    return { status: 'error', message: 'The owner cannot be removed. Transfer ownership first.' }
  }
  if (removed !== 'ok') {
    return { status: 'error', message: 'That member is not yours to remove.' }
  }

  revalidatePath(`/projects/${slug}`)
  return { status: 'success', message: 'They were removed from the project.' }
}

async function transferOwnershipLocal(
  userId: string,
  slug: string,
  projectId: string,
  newOwner: string,
): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'not-found'

    const project = db.projects.find((entry) => entry.id === projectId && entry.deleted_at === null)
    if (!project) return 'not-found'

    // `transfer_project_ownership`: only the current owner may transfer. Not
    // maintainers.
    if (project.owner_id !== viewer.id) return 'forbidden'
    if (newOwner === project.owner_id) return 'ok'

    const target = db.project_members.find(
      (entry) => entry.project_id === projectId && entry.profile_id === newOwner,
    )
    if (!target) return 'not-member'

    const outgoing = db.project_members.find(
      (entry) => entry.project_id === projectId && entry.profile_id === project.owner_id,
    )
    // The two role writes and the owner_id move happen together, so the single-
    // owner rule is never broken even for an instant.
    if (outgoing) outgoing.role = 'maintainer'
    project.owner_id = newOwner
    target.role = 'owner'
    return 'ok'
  })

  if (result === 'forbidden') {
    return { status: 'error', message: 'Only the current owner can transfer a project.' }
  }
  if (result === 'not-member') {
    return { status: 'error', message: 'The new owner has to be a member of the project already.' }
  }
  if (result === 'not-found') {
    return { status: 'error', message: 'That project could not be found.' }
  }

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return { status: 'success', message: 'Ownership transferred. You are now a maintainer.' }
}

async function saveSeekingLocal(
  userId: string,
  slug: string,
  data: ProjectSeekingInput,
  formData: FormData,
): Promise<FormState> {
  const saved = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return null

    const project = db.projects.find((entry) => entry.slug === slug && entry.deleted_at === null)
    if (!project || !canManageProject(db, project, viewer.id)) return null

    // The trigger's rule, repeated for the same reason it exists: a private
    // project cannot advertise, so the form is told what was actually stored.
    const wantsSeeking = project.visibility === 'private' ? false : data.isSeekingMembers
    project.is_seeking_members = wantsSeeking
    project.team_size_target = data.teamSizeTarget ?? null

    // `looking_for` has no local column, and there is no `project_skills` table,
    // so neither the prose nor the chosen skill ids are stored here.
    return project.visibility
  })

  if (saved === null) return NOT_FOUND

  revalidatePath(`/projects/${slug}`)
  revalidatePath('/projects')
  return {
    status: 'success',
    message:
      saved === 'private'
        ? 'Saved. A private project cannot advertise, so it stays out of the open list.'
        : 'Saved.',
    values: echoValues(formData),
  }
}

async function postUpdateLocal(
  userId: string,
  slug: string,
  body: string,
  share: boolean,
): Promise<FormState> {
  const result = await mutate((db) => {
    const viewer = db.profiles.find((profile) => profile.user_id === userId)
    if (!viewer) return 'not-found'

    const project = db.projects.find((entry) => entry.slug === slug && entry.deleted_at === null)
    if (!project) return 'not-found'

    // `posts_select` makes a project update readable by whoever the post's own
    // visibility admits, and the insert policy requires membership. Membership is
    // therefore the check, not manage rights.
    const isMember = db.project_members.some(
      (member) => member.project_id === project.id && member.profile_id === viewer.id,
    )
    if (!isMember) return 'not-member'

    const visibility = share && project.visibility !== 'private' ? 'university' : 'private'

    db.posts.push({
      id: id('pst'),
      author_id: viewer.id,
      body,
      visibility,
      project_id: project.id,
      goal_id: null,
      moderation_status: 'active',
      // The triggers maintain these from the like and comment rows.
      like_count: 0,
      comment_count: 0,
      created_at: now(),
      deleted_at: null,
    })

    return visibility
  })

  if (result === 'not-member') {
    return { status: 'error', message: 'Only members of this project can post an update to it.' }
  }
  if (result === 'not-found') return NOT_FOUND

  revalidatePath(`/projects/${slug}`)
  if (result !== 'private') revalidatePath('/feed')
  return {
    status: 'success',
    message:
      result === 'private'
        ? 'Saved on the project page. Only you can see it.'
        : 'Posted, and shared to the feed as well.',
  }
}

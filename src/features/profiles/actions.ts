'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import { mutate } from '@/lib/local/db'
import { localActor } from '@/lib/local/access'
import {
  onboardingSchema,
  profileEditSchema,
  localOnboardingSchema,
  localProfileEditSchema,
  type OnboardingInput,
  type ProfileEditInput,
} from '@/features/profiles/schemas'
import type { ProfileFormState } from '@/features/profiles/form-state'
import { planDepartmentChange, type DepartmentReference } from './departments'

/**
 * Profile writes.
 *
 * Two things this file has to get right.
 *
 * 1. **Username uniqueness is decided inside the write.** In cloud mode, checking
 *    "is this handle free?" before the update is worse than not checking: it
 *    returns an answer that is only true until the next request, and two people
 *    submitting the same handle simultaneously would both be told yes. The unique
 *    index on `lower(username)` is the only thing that can decide, so the update
 *    runs and 23505 is translated into a message about that field. Locally the
 *    check and update run together inside the locked `mutate` snapshot.
 *
 * 2. **No column the client must not control is ever named in an update.** The
 *    grant list in 0004 already refuses the rest -- `status`, the counters,
 *    `username_changed_at` -- but sending them and relying on the refusal would
 *    make an error the safety mechanism. They are simply not sent.
 */

const UNAVAILABLE: ProfileFormState = {
  status: 'error',
  message: 'This deployment has no database connection, so profiles cannot be saved.',
}

const ONBOARDING_FIELDS = [
  'username', 'displayName', 'universityId', 'departmentId', 'degree', 'semester',
  'graduationYear', 'headline', 'bio', 'visibility',
] as const
const EDIT_FIELDS = [
  'displayName', 'universityId', 'departmentId', 'degree', 'semester', 'graduationYear',
  'headline', 'bio', 'location', 'website', 'githubUsername', 'visibility',
] as const

function inputOf(formData: FormData, fields: readonly string[]) {
  return Object.fromEntries(fields.map((key) => [
    key, formData.get(key) ?? (key === 'departmentId' ? undefined : ''),
  ]))
}

function fieldErrorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

/** Only editable values are echoed; identity, roles and arbitrary columns are not. */
function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of new Set<string>([...ONBOARDING_FIELDS, ...EDIT_FIELDS])) {
    const value = formData.get(key)
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function revalidateProfiles() {
  revalidatePath('/', 'layout')
  revalidatePath('/me')
  revalidatePath('/me/edit')
  // Onboarding can change the handle, including the previously cached URL.
  revalidatePath('/u/[username]', 'page')
}

async function saveLocalProfile(
  userId: string,
  change: { onboarding: true; data: OnboardingInput } | { onboarding: false; data: ProfileEditInput },
): Promise<ProfileFormState> {
  try {
    return await mutate((db): ProfileFormState => {
      const account = db.users.find((row) => row.id === userId)
      const profile = localActor(db, userId)
      if (!account || account.disabled_at || !profile) {
        return {
          status: 'error',
          message: db.profiles.some((row) => row.user_id === userId)
            ? 'Your account is not active, so your profile cannot be changed.'
            : 'Your account has no profile. Nothing was saved.',
        }
      }

      const { data } = change
      if (data.universityId !== undefined && !db.universities.some((row) => row.id === data.universityId)) {
        return {
          status: 'error',
          fieldErrors: { universityId: 'That university is no longer in the directory. Choose one from the list.' },
        }
      }
      const department = planDepartmentChange({
        currentUniversityId: profile.university_id,
        currentDepartmentId: profile.department_id,
        universityId: data.universityId ?? null,
        departmentId: data.departmentId,
        reference: db.departments.find((row) => row.id === data.departmentId),
      })
      if (!department.ok) {
        return { status: 'error', fieldErrors: { departmentId: department.message } }
      }

      if (change.onboarding) {
        if (profile.onboarding_completed === true) {
          return { status: 'error', message: 'Onboarding is already complete. Use Edit profile to change your details.' }
        }
        const username = change.data.username.trim().toLowerCase()
        if (db.profiles.some((row) => row.id !== profile.id && row.username.trim().toLowerCase() === username)) {
          return { status: 'error', fieldErrors: { username: 'That username is already taken.' } }
        }
        profile.username = username
        if (change.data.visibility !== undefined) profile.visibility = change.data.visibility
        profile.onboarding_completed = true
        profile.onboarding_step = 12
      } else {
        profile.location = change.data.location ?? null
        profile.website = change.data.website ?? null
        profile.github_username = change.data.githubUsername ?? null
        profile.visibility = change.data.visibility
      }

      profile.display_name = data.displayName
      profile.university_id = data.universityId ?? null
      if (department.departmentId !== undefined) {
        profile.department_id = department.departmentId
        // Discovery's legacy local adapter reads this text. Only an explicit
        // directory choice (or clear) changes it; degree/programme never does.
        profile.department = department.departmentName ?? null
      }
      profile.degree = data.degree ?? null
      profile.semester = data.semester === undefined ? null : String(data.semester)
      profile.graduation_year = data.graduationYear ?? null
      profile.headline = data.headline ?? null
      profile.bio = data.bio ?? null
      return { status: 'success', message: 'Saved.' }
    })
  } catch {
    // The atomic store leaves the old snapshot intact on a failed commit.
    return { status: 'error', message: 'Your profile could not be saved to the local store. Please try again.' }
  }
}

type CloudAffiliation = {
  id: string
  university_id: string | null
  department_id: string | null
  program_id: string | null
}

/**
 * Curated references are checked with the caller's client, never service-role.
 * Older clients send no department column at all. SQL still rejects carrying a
 * scoped legacy FK across campuses (affiliation_mismatch).
 */
async function prepareCloudDepartment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  universityId: string | null,
  departmentId: string | null | undefined,
): Promise<
  | { ok: false; state: ProfileFormState }
  | {
      ok: true
      patch: { department_id?: string | null; program_id?: null }
      snapshot?: CloudAffiliation
    }
> {
  if (departmentId === undefined) return { ok: true, patch: {} }

  const { data: snapshot, error: readError } = await supabase
    .from('profiles')
    .select('id, university_id, department_id, program_id')
    .eq('id', userId)
    .maybeSingle<CloudAffiliation>()
  if (readError || !snapshot || snapshot.id !== userId) {
    return {
      ok: false,
      state: { status: 'error', message: 'Your current campus details could not be read. Nothing was saved. Reload and try again.' },
    }
  }

  let reference: DepartmentReference | null = null
  if (departmentId !== null && universityId) {
    const { data, error } = await supabase
      .from('departments')
      .select(`
        id, university_id, name, is_verified,
        university:universities!departments_university_id_fkey!inner ( status )
      `)
      .eq('id', departmentId)
      .eq('university_id', universityId)
      .eq('is_verified', true)
      .eq('university.status', 'approved')
      .maybeSingle<DepartmentReference & { university: { status: string } }>()
    if (error) {
      return {
        ok: false,
        state: { status: 'error', fieldErrors: { departmentId: 'The department list could not be checked. Nothing was saved. Please try again.' } },
      }
    }
    if (data?.university?.status === 'approved') reference = data
  }

  const plan = planDepartmentChange({
    currentUniversityId: snapshot.university_id,
    currentDepartmentId: snapshot.department_id,
    universityId,
    departmentId,
    reference,
  })
  if (!plan.ok) return { ok: false, state: { status: 'error', fieldErrors: { departmentId: plan.message } } }

  return {
    ok: true,
    snapshot,
    patch: {
      department_id: plan.departmentId,
      // A linked program FK would otherwise reject a clear/reselection. Keep it
      // for an unchanged department; free-text degree is always independent.
      ...(plan.clearProgram ? { program_id: null } : {}),
    },
  }
}

function readOnlyRoleError(formData: FormData): ProfileFormState | null {
  if (!['role', 'roles', 'user_roles'].some((key) => formData.has(key))) return null
  return {
    status: 'error',
    message: 'Staff roles are read-only here and cannot be changed through a profile.',
    values: echo(formData),
  }
}

/**
 * Turns a PostgREST write error into a sentence.
 *
 * The hints (`reserved_username`, `numeric_username`, `username_cooldown`) are
 * raised by the triggers in 0004 using `using hint = ...` precisely so this
 * function can distinguish them without matching on message text, which is not a
 * stable interface.
 */
function describeWriteError(
  error: { code?: string; message?: string; hint?: string | null },
  context: string,
): ProfileFormState {
  console.error(`[profiles:${context}]`, error.code, error.message)

  if (error.code === '23505') {
    return { status: 'error', fieldErrors: { username: 'That username is already taken.' } }
  }

  if (error.code === '23514') {
    const hint = error.hint ?? ''
    if (hint.includes('reserved')) {
      return { status: 'error', fieldErrors: { username: 'That username is reserved.' } }
    }
    if (hint.includes('numeric')) {
      return {
        status: 'error',
        fieldErrors: { username: 'A username cannot be only digits.' },
      }
    }
    if (hint.includes('cooldown')) {
      return {
        status: 'error',
        fieldErrors: {
          username: 'A username can only be changed once every 30 days.',
        },
      }
    }
    if (hint.includes('affiliation')) {
      return {
        status: 'error',
        fieldErrors: { departmentId: 'Your department and linked programme must belong to your university. Reselect or clear the department, then save again.' },
      }
    }
    return { status: 'error', message: 'Some of those details were not accepted. Check the fields above.' }
  }
  if (error.code === '23503') {
    return { status: 'error', fieldErrors: { departmentId: 'The university or department is no longer available. Choose from the current lists again.' } }
  }

  if (error.code === '42501') {
    return { status: 'error', message: 'You are not allowed to change that.' }
  }

  return { status: 'error', message: 'Your profile could not be saved. Please try again.' }
}

// -----------------------------------------------------------------------------
// Onboarding
// -----------------------------------------------------------------------------

export async function completeOnboardingAction(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const local = isLocalMode()
  if (!local && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/onboarding')

  if (local) {
    const roleError = readOnlyRoleError(formData)
    if (roleError) return roleError
  }

  const parsed = (local ? localOnboardingSchema : onboardingSchema).safeParse(inputOf(formData, ONBOARDING_FIELDS))

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echo(formData) }
  }

  if (local) {
    const state = await saveLocalProfile(user.id, { onboarding: true, data: parsed.data })
    if (state.status !== 'success') return { ...state, values: echo(formData) }
    revalidateProfiles()
    redirect('/me')
  }

  const supabase = await createClient()
  const department = await prepareCloudDepartment(
    supabase, user.id, parsed.data.universityId ?? null, parsed.data.departmentId,
  )
  if (!department.ok) return { ...department.state, values: echo(formData) }

  // `eq('id', user.id)` is belt to the policy's braces. The update policy already
  // restricts this to the caller's own row; naming the id means a policy edit
  // cannot silently widen what this action writes.
  let update = supabase
    .from('profiles')
    .update({
      username: parsed.data.username,
      display_name: parsed.data.displayName,
      university_id: parsed.data.universityId ?? null,
      ...department.patch,
      degree: parsed.data.degree ?? null,
      semester: parsed.data.semester ?? null,
      graduation_year: parsed.data.graduationYear ?? null,
      headline: parsed.data.headline ?? null,
      bio: parsed.data.bio ?? null,
      ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
      onboarding_completed: true,
      onboarding_step: 12,
    })
    .eq('id', user.id)
    .eq('onboarding_completed', false)
  if (department.snapshot) {
    // Do not clear a newly changed linked program using an earlier read.
    const before = department.snapshot
    update = before.university_id === null ? update.is('university_id', null) : update.eq('university_id', before.university_id)
    update = before.department_id === null ? update.is('department_id', null) : update.eq('department_id', before.department_id)
    update = before.program_id === null ? update.is('program_id', null) : update.eq('program_id', before.program_id)
  }
  const { data: saved, error } = await update
    .select('id')
    .maybeSingle()

  if (error) {
    const state = describeWriteError(error, 'completeOnboarding')
    return { ...state, values: echo(formData) }
  }
  if (!saved || saved.id !== user.id) {
    return {
      status: 'error',
      message: 'No unfinished profile was saved. Onboarding may already be complete; use Edit profile.',
      values: echo(formData),
    }
  }

  // The header renders the handle and avatar, so the cached shell is now wrong.
  revalidateProfiles()
  redirect('/me')
}

// -----------------------------------------------------------------------------
// Editing
// -----------------------------------------------------------------------------

export async function updateProfileAction(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const local = isLocalMode()
  if (!local && !isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/me/edit')

  if (local) {
    const roleError = readOnlyRoleError(formData)
    if (roleError) return roleError
  }

  const parsed = (local ? localProfileEditSchema : profileEditSchema).safeParse(inputOf(formData, EDIT_FIELDS))

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echo(formData) }
  }

  if (local) {
    const state = await saveLocalProfile(user.id, { onboarding: false, data: parsed.data })
    if (state.status !== 'success') return { ...state, values: echo(formData) }
    revalidateProfiles()
    return state
  }

  const supabase = await createClient()
  const department = await prepareCloudDepartment(
    supabase, user.id, parsed.data.universityId ?? null, parsed.data.departmentId,
  )
  if (!department.ok) return { ...department.state, values: echo(formData) }

  let update = supabase
    .from('profiles')
    .update({
      display_name: parsed.data.displayName,
      university_id: parsed.data.universityId ?? null,
      ...department.patch,
      degree: parsed.data.degree ?? null,
      semester: parsed.data.semester ?? null,
      graduation_year: parsed.data.graduationYear ?? null,
      headline: parsed.data.headline ?? null,
      bio: parsed.data.bio ?? null,
      location: parsed.data.location ?? null,
      website: parsed.data.website ?? null,
      github_username: parsed.data.githubUsername ?? null,
      visibility: parsed.data.visibility,
    })
    .eq('id', user.id)
  if (department.snapshot) {
    const before = department.snapshot
    update = before.university_id === null ? update.is('university_id', null) : update.eq('university_id', before.university_id)
    update = before.department_id === null ? update.is('department_id', null) : update.eq('department_id', before.department_id)
    update = before.program_id === null ? update.is('program_id', null) : update.eq('program_id', before.program_id)
  }
  const { data: saved, error } = await update.select('id').maybeSingle()

  if (error) {
    const state = describeWriteError(error, 'updateProfile')
    return { ...state, values: echo(formData) }
  }
  if (!saved || saved.id !== user.id) {
    return {
      status: 'error',
      message: 'Nothing was saved. Your campus details may have changed elsewhere, or your profile is no longer editable. Reload and try again.',
      values: echo(formData),
    }
  }

  revalidateProfiles()
  return { status: 'success', message: 'Saved.' }
}

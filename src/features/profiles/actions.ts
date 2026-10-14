'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import { createClient, getUser } from '@/lib/supabase/server'
import { onboardingSchema, profileEditSchema } from '@/features/profiles/schemas'
import type { ProfileFormState } from '@/features/profiles/form-state'

/**
 * Profile writes.
 *
 * Two things this file has to get right.
 *
 * 1. **Username uniqueness is decided by the database, not here.** Checking
 *    "is this handle free?" before the update is worse than not checking: it
 *    returns an answer that is only true until the next request, and two people
 *    submitting the same handle simultaneously would both be told yes. The unique
 *    index on `lower(username)` is the only thing that can decide, so the update
 *    runs and 23505 is translated into a message about that field.
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

function fieldErrorsOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

/** Every posted value, so a rejected form can be re-rendered as the user left it. */
function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value
  }
  return out
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
    return { status: 'error', message: 'Some of those details were not accepted. Check the fields above.' }
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
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/onboarding')

  const parsed = onboardingSchema.safeParse({
    username: String(formData.get('username') ?? ''),
    displayName: String(formData.get('displayName') ?? ''),
    universityId: String(formData.get('universityId') ?? ''),
    degree: String(formData.get('degree') ?? ''),
    semester: String(formData.get('semester') ?? ''),
    graduationYear: String(formData.get('graduationYear') ?? ''),
    headline: String(formData.get('headline') ?? ''),
    bio: String(formData.get('bio') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echo(formData) }
  }

  const supabase = await createClient()

  // `eq('id', user.id)` is belt to the policy's braces. The update policy already
  // restricts this to the caller's own row; naming the id means a policy edit
  // cannot silently widen what this action writes.
  const { error } = await supabase
    .from('profiles')
    .update({
      username: parsed.data.username,
      display_name: parsed.data.displayName,
      university_id: parsed.data.universityId ?? null,
      degree: parsed.data.degree ?? null,
      semester: parsed.data.semester ?? null,
      graduation_year: parsed.data.graduationYear ?? null,
      headline: parsed.data.headline ?? null,
      bio: parsed.data.bio ?? null,
      onboarding_completed: true,
      onboarding_step: 12,
    })
    .eq('id', user.id)

  if (error) {
    const state = describeWriteError(error, 'completeOnboarding')
    return { ...state, values: echo(formData) }
  }

  // The header renders the handle and avatar, so the cached shell is now wrong.
  revalidatePath('/', 'layout')
  redirect('/me')
}

// -----------------------------------------------------------------------------
// Editing
// -----------------------------------------------------------------------------

export async function updateProfileAction(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const user = await getUser()
  if (!user) redirect('/login?next=/me/edit')

  const parsed = profileEditSchema.safeParse({
    displayName: String(formData.get('displayName') ?? ''),
    universityId: String(formData.get('universityId') ?? ''),
    degree: String(formData.get('degree') ?? ''),
    semester: String(formData.get('semester') ?? ''),
    graduationYear: String(formData.get('graduationYear') ?? ''),
    headline: String(formData.get('headline') ?? ''),
    bio: String(formData.get('bio') ?? ''),
    location: String(formData.get('location') ?? ''),
    website: String(formData.get('website') ?? ''),
    githubUsername: String(formData.get('githubUsername') ?? ''),
    visibility: String(formData.get('visibility') ?? 'public'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echo(formData) }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('profiles')
    .update({
      display_name: parsed.data.displayName,
      university_id: parsed.data.universityId ?? null,
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

  if (error) {
    const state = describeWriteError(error, 'updateProfile')
    return { ...state, values: echo(formData) }
  }

  revalidatePath('/', 'layout')
  revalidatePath('/me')
  return { status: 'success', message: 'Saved.' }
}

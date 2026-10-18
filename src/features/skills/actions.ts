'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import { describeWriteError, fieldErrorsOf, type FormState } from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import {
  attachSkillSchema,
  interestIdSchema,
  proposeInterestSchema,
  proposeSkillSchema,
  skillIdSchema,
  updateProfileSkillSchema,
} from '@/features/skills/schemas'

/**
 * Skill and interest writes.
 *
 * `profile_id` and `created_by` are never taken from a form field. Both triggers —
 * `app.profile_skills_before_write` and `app.profile_interests_before_insert` —
 * overwrite them with `auth.uid()`, so a forged value would be silently corrected
 * rather than trusted; not sending one at all is clearer than relying on that.
 *
 * `endorsement_count` and `usage_count` are absent for a different reason: they are
 * counters maintained by triggers on the rows they count, and they are not in the
 * UPDATE grant either, so a client cannot inflate them by 400.
 *
 * The honesty rule that shapes the copy rather than the code: a level here is
 * **self-declared**. Nothing measures competence, and no part of this file may
 * imply that anything did.
 *
 * LOCAL MODE
 * ----------
 * Not available, and every action says so. The local store has no `skills`,
 * `interests`, `profile_skills` or `profile_interests` table — `Tables` in
 * `src/lib/local/db.ts` is the whole store — so there is nowhere to record a
 * claim. Every action returns a FormState naming the missing tables and stating
 * that nothing was changed, which is what the editor renders next to the row that
 * was submitted.
 *
 * The tables are not added here on purpose. A catalogue is a decided piece of the
 * schema — uniqueness, approval, usage counts, one join table per kind — and
 * inventing a version of it inside a feature module would be a second schema that
 * the Postgres deployment would then have to match or contradict.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so nothing can be saved.',
}

const LOCAL_SKILLS: FormState = {
  status: 'error',
  message:
    'Local mode has no skills catalogue or profile_skills table, so there is nowhere to record a skill. Nothing was changed.',
}

const LOCAL_INTERESTS: FormState = {
  status: 'error',
  message:
    'Local mode has no interests catalogue or profile_interests table, so there is nowhere to record an interest. Nothing was changed.',
}

function revalidateProfile() {
  revalidatePath('/me')
  revalidatePath('/me/skills')
}

/**
 * A slug to compare a proposed name against.
 *
 * This mirrors `app.slugify` closely enough for a lookup, and it is only ever used
 * to *find* an existing row: the slug a new row receives is still assigned by
 * `app.unique_slug` inside the trigger. Guessing a slug to write would be the
 * mistake; guessing one to look up costs nothing if it misses.
 */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Escapes the two ilike wildcards so a name containing them matches itself. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

/**
 * Finds an existing catalogue row for a name, or creates one.
 *
 * The lookup comes first because the uniqueness guard does not cover this case:
 * `app.unique_slug` appends a random suffix when a slug is taken rather than
 * failing, so filing "Machine Learning" when "Machine Learning" already exists
 * would quietly create a second entry with a near-identical name. A catalogue with
 * near-duplicates is exactly the graffiti wall 0006's header says it wants to
 * avoid.
 *
 * What comes back is either an id the caller may attach to (approved, or proposed
 * by them) or `existing-but-not-yours` — an entry someone else proposed that is
 * still awaiting review. That second case is a real answer, not an error.
 */
async function findOrCreateCatalogueEntry({
  table,
  name,
  category,
  userId,
}: {
  table: 'skills' | 'interests'
  name: string
  category: string
  userId: string
}): Promise<{ id: string | null; state: 'existing' | 'created' | 'taken' | 'error'; formState?: FormState }> {
  if (isLocalMode()) {
    // Unreachable from the actions below, which return before this point, and kept
    // as a guard so a future caller cannot reach `createClient()` in local mode.
    return {
      id: null,
      state: 'error',
      formState: {
        status: 'error',
        message:
          'Local mode has no skills or interests catalogue, so there is nothing to look up or create.',
      },
    }
  }

  const supabase = await createClient()

  const { data: matches, error: lookupError } = await supabase
    .from(table)
    .select('id, is_approved, created_by')
    .ilike('name', escapeLike(name))
    .limit(5)
    .returns<{ id: string; is_approved: boolean; created_by: string | null }[]>()

  if (lookupError) {
    return { id: null, state: 'error', formState: describeWriteError(lookupError, `skills:lookup:${table}`) }
  }

  // `ilike` with an escaped, wildcard-free term is an exact case-insensitive
  // match — the same trick profiles/queries uses on usernames. So the first row
  // back is the entry with this name, if there is one.
  const exact = (matches ?? [])[0]
  if (exact) {
    if (exact.is_approved || exact.created_by === userId) {
      return { id: exact.id, state: 'existing' }
    }
    // Someone else's unapproved entry: attachable by nobody but its author, so
    // saying so is more useful than a foreign-key error.
    return { id: null, state: 'taken' }
  }

  if (slugOf(name) === '') {
    return {
      id: null,
      state: 'error',
      formState: { status: 'error', message: 'That name needs at least one letter or number.' },
    }
  }

  const { data: created, error: createError } = await supabase
    .from(table)
    .insert({ name, category })
    .select('id')
    .single<{ id: string }>()

  if (createError) {
    return { id: null, state: 'error', formState: describeWriteError(createError, `skills:create:${table}`) }
  }

  return { id: created.id, state: 'created' }
}

// -----------------------------------------------------------------------------
// Skills
// -----------------------------------------------------------------------------

/** Claims a skill that is already in the catalogue. */
export async function attachSkillAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_SKILLS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = attachSkillSchema.safeParse({
    skillId: String(formData.get('skillId') ?? ''),
    level: String(formData.get('level') ?? 'learning'),
    isLearning: formData.get('isLearning') !== null,
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const supabase = await createClient()
  const { error } = await supabase.from('profile_skills').insert({
    profile_id: user.id,
    skill_id: parsed.data.skillId,
    level: parsed.data.level,
    is_learning: parsed.data.isLearning,
  })

  if (error) {
    if (error.code === '23505') {
      return { status: 'error', message: 'That skill is already on your profile.' }
    }
    return describeWriteError(error, 'skills:attach', {
      '42501': 'That skill is not available to claim yet.',
      '23503': 'That skill no longer exists.',
    })
  }

  revalidateProfile()
  return { status: 'success', message: 'Skill added.' }
}

/**
 * Proposes a skill that is not in the catalogue and claims it in the same step.
 *
 * `is_approved` is not sent. The before-write trigger pins it to false for any
 * client, so the new entry is visible to its author and to moderators and to
 * nobody else until someone reviews it — which is what the interface tells the
 * reader rather than promising it will be public immediately.
 */
export async function proposeSkillAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_SKILLS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = proposeSkillSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    category: String(formData.get('category') ?? 'other'),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const found = await findOrCreateCatalogueEntry({
    table: 'skills',
    name: parsed.data.name,
    category: parsed.data.category,
    userId: user.id,
  })

  if (!found.id) {
    if (found.state === 'taken') {
      return {
        status: 'error',
        message: 'That skill exists but is waiting for review, so it cannot be claimed yet.',
      }
    }
    return found.formState ?? { status: 'error', message: 'That skill could not be added.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('profile_skills').insert({
    profile_id: user.id,
    skill_id: found.id,
    level: 'learning',
    is_learning: true,
  })

  if (error) {
    if (error.code === '23505') {
      return { status: 'error', message: 'That skill is already on your profile.' }
    }
    return describeWriteError(error, 'skills:propose')
  }

  revalidateProfile()
  return {
    status: 'success',
    message:
      found.state === 'created'
        ? 'Added. New skills are reviewed by a moderator, so for now this is on your profile and visible only to you.'
        : 'Added to your profile.',
  }
}

/** Changes the level or the "currently learning" flag. Nothing else is writable. */
export async function updateProfileSkillAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_SKILLS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = updateProfileSkillSchema.safeParse({
    skillId: String(formData.get('skillId') ?? ''),
    level: String(formData.get('level') ?? 'learning'),
    isLearning: formData.get('isLearning') !== null,
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profile_skills')
    .update({ level: parsed.data.level, is_learning: parsed.data.isLearning })
    .eq('profile_id', user.id)
    .eq('skill_id', parsed.data.skillId)
    .select('skill_id')
    .maybeSingle<{ skill_id: string }>()

  if (error) return describeWriteError(error, 'skills:update')

  // RLS declining an UPDATE succeeds and changes nothing.
  if (!data) return { status: 'error', message: 'That skill is not on your profile.' }

  revalidateProfile()
  return { status: 'success', message: 'Saved.' }
}

export async function removeSkillAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_SKILLS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = skillIdSchema.safeParse({ skillId: String(formData.get('skillId') ?? '') })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profile_skills')
    .delete()
    .eq('profile_id', user.id)
    .eq('skill_id', parsed.data.skillId)
    .select('skill_id')

  if (error) return describeWriteError(error, 'skills:remove')
  if (!data || data.length === 0) return { status: 'error', message: 'That skill was already removed.' }

  revalidateProfile()
  return { status: 'success', message: 'Removed.' }
}

// -----------------------------------------------------------------------------
// Interests
// -----------------------------------------------------------------------------

/** Tags an interest that is already in the catalogue. */
export async function addInterestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_INTERESTS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = interestIdSchema.safeParse({
    interestId: String(formData.get('interestId') ?? ''),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const supabase = await createClient()
  const { error } = await supabase
    .from('profile_interests')
    .insert({ profile_id: user.id, interest_id: parsed.data.interestId })

  if (error) {
    if (error.code === '23505') return { status: 'error', message: 'That is already on your profile.' }
    return describeWriteError(error, 'skills:interest:add', {
      '42501': 'That topic is not available yet.',
      '23503': 'That topic no longer exists.',
    })
  }

  revalidateProfile()
  return { status: 'success', message: 'Interest added.' }
}

/** Proposes one that is not in the catalogue yet, and tags it straight away. */
export async function proposeInterestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_INTERESTS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = proposeInterestSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    category: String(formData.get('category') ?? 'other'),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const found = await findOrCreateCatalogueEntry({
    table: 'interests',
    name: parsed.data.name,
    category: parsed.data.category,
    userId: user.id,
  })

  if (!found.id) {
    if (found.state === 'taken') {
      return { status: 'error', message: 'That topic is waiting for review, so it cannot be used yet.' }
    }
    return found.formState ?? { status: 'error', message: 'That interest could not be added.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('profile_interests')
    .insert({ profile_id: user.id, interest_id: found.id })

  if (error) {
    if (error.code === '23505') return { status: 'error', message: 'That is already on your profile.' }
    return describeWriteError(error, 'skills:interest:propose')
  }

  revalidateProfile()
  return {
    status: 'success',
    message:
      found.state === 'created'
        ? 'Added. New topics go to a moderator, so for now this is on your profile and visible only to you.'
        : 'Interest added.',
  }
}

export async function removeInterestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_INTERESTS
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = interestIdSchema.safeParse({
    interestId: String(formData.get('interestId') ?? ''),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profile_interests')
    .delete()
    .eq('profile_id', user.id)
    .eq('interest_id', parsed.data.interestId)
    .select('interest_id')

  if (error) return describeWriteError(error, 'skills:interest:remove')
  if (!data || data.length === 0) return { status: 'error', message: 'That was already removed.' }

  revalidateProfile()
  return { status: 'success', message: 'Removed.' }
}

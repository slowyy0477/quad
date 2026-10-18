import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'

/**
 * Skill and interest reads.
 *
 * Both are catalogues plus a join table, which is the shape 0006 chose on purpose:
 * "React", "react" and "ReactJS" as three `text[]` entries could never answer the
 * question the product is built around. So a profile claims a catalogue id, and
 * what is rendered for a name is a row that exists.
 *
 * The one thing worth understanding before reading the mapping code below:
 * **an unapproved catalogue entry is invisible to everyone but its author and
 * moderators.** A profile row pointing at one is still readable — the policy on
 * `profile_skills` only asks whether the *profile* is visible — so the join comes
 * back with a null name. Those rows are dropped here rather than rendered as a
 * blank line, which is what makes "your new skill is on your profile and nobody
 * else can see it yet" true rather than approximately true.
 *
 * LOCAL MODE
 * ----------
 * The local store has no catalogue tables and no join tables: `Tables` in
 * `src/lib/local/db.ts` contains no `skills`, `interests`, `profile_skills` or
 * `profile_interests`. Every read here therefore returns an empty list, which is
 * what "this profile claims nothing" looks like — and it is also the literal truth
 * about a store that cannot hold a claim. The matching actions say the same thing
 * in a FormState rather than writing somewhere else; see `./actions`.
 *
 * An empty catalogue also means the editor has nothing to offer: the picker is
 * empty because there is no catalogue, not because nobody has proposed a skill.
 */

export type SkillLevel = 'learning' | 'familiar' | 'proficient' | 'advanced'

export type ProfileSkill = {
  skill_id: string
  name: string
  slug: string
  category: string
  level: SkillLevel
  is_learning: boolean
  endorsement_count: number
  display_order: number
  /** False while the catalogue entry itself is waiting for a moderator. */
  is_approved: boolean
}

export type ProfileInterest = {
  interest_id: string
  name: string
  slug: string
  category: string
  is_approved: boolean
}

export type SkillOption = {
  id: string
  name: string
  category: string
  usage_count: number
  is_approved: boolean
}

export type InterestOption = {
  id: string
  name: string
  category: string
  usage_count: number
  is_approved: boolean
}

type SkillEmbed = { name: string; slug: string; category: string; is_approved: boolean } | null

/** The skills one profile claims, in the order they chose. */
export async function listProfileSkills(profileId: string): Promise<ProfileSkill[]> {
  if (isLocalMode()) return []

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('profile_skills')
    .select(
      `skill_id, level, is_learning, endorsement_count, display_order,
       skill:skills!profile_skills_skill_id_fkey ( name, slug, category, is_approved )`,
    )
    .eq('profile_id', profileId)
    .order('display_order')
    .order('created_at')
    .returns<
      {
        skill_id: string
        level: string
        is_learning: boolean
        endorsement_count: number
        display_order: number
        skill: SkillEmbed
      }[]
    >()

  if (error) {
    console.error('[skills:listProfileSkills]', error.code, error.message)
    return []
  }

  return (data ?? [])
    // A null embed is a skill this reader may not see. See the file header.
    .filter((row) => row.skill !== null)
    .map((row) => ({
      skill_id: row.skill_id,
      name: row.skill!.name,
      slug: row.skill!.slug,
      category: row.skill!.category,
      level: row.level as SkillLevel,
      is_learning: row.is_learning,
      endorsement_count: row.endorsement_count,
      display_order: row.display_order,
      is_approved: row.skill!.is_approved,
    }))
}

/** The interests one profile has tagged, alphabetical. */
export async function listProfileInterests(profileId: string): Promise<ProfileInterest[]> {
  if (isLocalMode()) return []

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('profile_interests')
    .select(
      `interest_id,
       interest:interests!profile_interests_interest_id_fkey ( name, slug, category, is_approved )`,
    )
    .eq('profile_id', profileId)
    .order('created_at')
    .returns<
      {
        interest_id: string
        interest: { name: string; slug: string; category: string; is_approved: boolean } | null
      }[]
    >()

  if (error) {
    console.error('[skills:listProfileInterests]', error.code, error.message)
    return []
  }

  return (data ?? [])
    .filter((row) => row.interest !== null)
    .map((row) => ({
      interest_id: row.interest_id,
      name: row.interest!.name,
      slug: row.interest!.slug,
      category: row.interest!.category,
      is_approved: row.interest!.is_approved,
    }))
}

/**
 * What the reader may attach.
 *
 * No `is_approved` filter, because the policy is the filter: approved entries are
 * readable by everyone, and an unapproved one is readable by the person who
 * proposed it. That is exactly the set that may be claimed — the
 * `profile_skills_before_write` trigger refuses anything else — so the list here
 * and the list the database accepts are the same list.
 *
 * Ranked by `usage_count`, a trigger-maintained column, so the entries people
 * actually use float to the top of the picker rather than being ordered
 * arbitrarily. It is not a quality score and the interface does not call it one.
 */
export async function listSkillCatalogue(limit = 200): Promise<SkillOption[]> {
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('skills')
    .select('id, name, category, usage_count, is_approved')
    .order('usage_count', { ascending: false })
    .order('name')
    .limit(limit)
    .returns<SkillOption[]>()

  if (error) {
    console.error('[skills:listSkillCatalogue]', error.code, error.message)
    return []
  }
  return data ?? []
}

export async function listInterestCatalogue(limit = 200): Promise<InterestOption[]> {
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('interests')
    .select('id, name, category, usage_count, is_approved')
    .order('usage_count', { ascending: false })
    .order('name')
    .limit(limit)
    .returns<InterestOption[]>()

  if (error) {
    console.error('[skills:listInterestCatalogue]', error.code, error.message)
    return []
  }
  return data ?? []
}

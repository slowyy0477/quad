import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'

/**
 * Profile reads.
 *
 * As in the feed module, there is no visibility filter in these selects. RLS
 * decides what each reader may see, inside Postgres, and a second copy of the rule
 * in TypeScript is a copy that can drift from the one an attacker cannot skip.
 *
 * The consequence worth understanding: a profile that exists but is not visible to
 * you comes back as zero rows, exactly like one that does not exist. That is the
 * correct behaviour -- distinguishing them would confirm the account exists to
 * someone who is not allowed to see it -- so "not found" is the honest thing to
 * render for both.
 */

export type ProfileSummary = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  headline: string | null
}

export type FullProfile = ProfileSummary & {
  bio: string | null
  degree: string | null
  semester: number | null
  graduation_year: number | null
  location: string | null
  website: string | null
  github_username: string | null
  linkedin_url: string | null
  twitter_username: string | null
  visibility: string
  onboarding_completed: boolean
  follower_count: number
  following_count: number
  connection_count: number
  post_count: number
  project_count: number
  created_at: string
  university_id: string | null
  university: { id: string; name: string; short_name: string | null; slug: string } | null
}

const FULL_SELECT = `
  id, username, display_name, avatar_url, headline, bio,
  degree, semester, graduation_year, location, website,
  github_username, linkedin_url, twitter_username,
  visibility, onboarding_completed,
  follower_count, following_count, connection_count, post_count, project_count,
  created_at, university_id,
  university:universities!profiles_university_id_fkey ( id, name, short_name, slug )
`

/**
 * The signed-in user's own profile.
 *
 * Returns `null` for "no session" and `'missing'` for "session, but no profile
 * row". Those are different problems with different fixes and collapsing them into
 * one null loses the distinction: a missing row means the 0016 backfill has not
 * been applied to this project, which is worth saying out loud rather than
 * rendering as a blank page.
 */
export async function getMyProfile(): Promise<
  { state: 'signed-out' } | { state: 'missing'; userId: string } | { state: 'ok'; profile: FullProfile }
> {
  const user = await getUser()
  if (!user) return { state: 'signed-out' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select(FULL_SELECT)
    .eq('id', user.id)
    .maybeSingle<FullProfile>()

  if (error) {
    console.error('[profiles:getMyProfile]', error.code, error.message)
    return { state: 'missing', userId: user.id }
  }

  return data ? { state: 'ok', profile: data } : { state: 'missing', userId: user.id }
}

/** A profile by handle. Case-insensitive, matching the unique index. */
export async function getProfileByUsername(username: string): Promise<FullProfile | null> {
  const supabase = await createClient()

  // `ilike` with no wildcards is an exact case-insensitive match, which is what
  // the unique index on lower(username) enforces. Escaped so a handle containing
  // % or _ cannot turn into a pattern -- it cannot today, because the check
  // constraint forbids both, but the escape costs nothing and outlives the
  // constraint.
  const { data, error } = await supabase
    .from('profiles')
    .select(FULL_SELECT)
    .ilike('username', username.replace(/[%_\\]/g, '\\$&'))
    .is('deleted_at', null)
    .maybeSingle<FullProfile>()

  if (error) {
    console.error('[profiles:getProfileByUsername]', error.code, error.message)
    return null
  }

  return data
}

export type UniversityOption = {
  id: string
  name: string
  short_name: string | null
  country: string | null
}

/**
 * The universities a person may choose from.
 *
 * Only approved ones are readable by a normal user -- that is the RLS policy, not
 * a filter here -- so this list is whatever moderators have accepted. 0017 ships a
 * starting set; anything missing goes through the submission path, which is why the
 * form says the list is incomplete instead of pretending it is exhaustive.
 */
export async function listUniversities(): Promise<UniversityOption[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('universities')
    .select('id, name, short_name, country')
    .order('name')
    .returns<UniversityOption[]>()

  if (error) {
    console.error('[profiles:listUniversities]', error.code, error.message)
    return []
  }
  return data ?? []
}

/** Recently active people, for the "find someone" list. Not a recommendation engine. */
export async function listRecentProfiles(limit = 12): Promise<ProfileSummary[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, headline')
    .is('deleted_at', null)
    .eq('status', 'active')
    .order('last_active_at', { ascending: false })
    .limit(limit)
    .returns<ProfileSummary[]>()

  if (error) {
    console.error('[profiles:listRecentProfiles]', error.code, error.message)
    return []
  }
  return data ?? []
}

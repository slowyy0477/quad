import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { readStore, type LocalProfile, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'

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
 *
 * LOCAL MODE
 * ----------
 * There is no RLS here, so the rule the policies implement is written out in
 * TypeScript below and applied literally — `canViewLocalProfile` is
 * `app.can_view_profile` from 0005, translated:
 *
 *     p.id = auth.uid()                                  -- yourself, always
 *     or ( p.visibility = 'public' )
 *     or ( p.visibility = 'university' and app.share_university(p.id, auth.uid()) )
 *     or ( p.visibility = 'connections' and app.are_connected(p.id, auth.uid()) )
 *
 * `are_connected` cannot be true in the local store because it has no
 * `connections` table, so a `connections`-scoped profile is visible to its author
 * and to nobody else. That is a narrower answer than Postgres would give once the
 * graph exists, and it is the honest one for this store.
 *
 * Two shapes need explaining, because the local store has fewer columns than
 * `profiles` does:
 *
 *   - `headline`, `location`, `graduation_year`, `linkedin_url`,
 *     `twitter_username` and `onboarding_completed` have no column in
 *     `LocalProfile`. They are returned as null / true rather than invented.
 *     `onboarding_completed` is true because the local sign-up assigns a handle
 *     immediately, so there is no half-created profile state to warn about.
 *   - `follower_count`, `following_count` and `connection_count` are counts of
 *     tables the store does not have, so they are zero — and therefore true.
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

// -----------------------------------------------------------------------------
// Local-mode mapping
// -----------------------------------------------------------------------------

/**
 * Who is reading.
 *
 * `profileId` is the *profile* id, not the account id: unlike Postgres, where
 * `profiles.id` is `auth.users.id`, the local store keeps them apart
 * (`LocalProfile.id` and `LocalProfile.user_id`). Everything the store's foreign
 * keys point at — `posts.author_id`, `projects.owner_id`, `project_members.profile_id`
 * — is a profile id, so a profile id is what the rest of the application calls
 * "a person" and what these reads return.
 */
export type LocalViewer = {
  profileId: string | null
  universityId: string | null
}

/** The reader's profile in the local store, or null when there is no session. */
export function localViewer(db: Tables, userId: string | null): LocalViewer {
  if (!userId) return { profileId: null, universityId: null }
  const profile = db.profiles.find((candidate) => candidate.user_id === userId)
  return { profileId: profile?.id ?? null, universityId: profile?.university_id ?? null }
}

/**
 * `app.can_view_profile`, in TypeScript.
 *
 * The block check is absent rather than forgotten: there is no `blocks` table, so
 * nobody can be blocked, so there is nothing to exclude.
 */
export function canViewLocalProfile(target: LocalProfile, viewer: LocalViewer): boolean {
  if (viewer.profileId !== null && target.id === viewer.profileId) return true

  switch (target.visibility) {
    case 'public':
      return true
    case 'university':
      // `app.share_university`: both sides named, and the same institution.
      return Boolean(
        viewer.universityId &&
          target.university_id &&
          viewer.universityId === target.university_id,
      )
    case 'connections':
      // `app.are_connected` needs a `connections` table. There is none, so only
      // the author (handled above) may see it.
      return false
    case 'private':
    default:
      return false
  }
}

/** The row shape every list embeds, from a `LocalProfile`. */
export function toProfileSummary(profile: LocalProfile): ProfileSummary {
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    // No `headline` column in the local store.
    headline: null,
  }
}

/** A slug for an institution. Derived, never written back — see the header. */
function localSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'institution'
  )
}

function localUniversityEmbed(db: Tables, id: string | null): FullProfile['university'] {
  if (!id) return null
  const university = db.universities.find((row) => row.id === id)
  if (!university) return null

  return {
    id: university.id,
    name: university.name,
    short_name: university.short_name,
    slug: localSlug(university.name),
  }
}

/**
 * `profiles.semester` is an integer in Postgres and a label in the local store
 * ("Semester 3"). The number is read out of the label so the shape matches; a
 * label with no number in it becomes null rather than a guess.
 */
function localSemester(value: string | null): number | null {
  if (!value) return null
  const digits = value.match(/\d+/)
  return digits ? Number(digits[0]) : null
}

/** `profiles.github_username` is a handle; the local column may hold a URL. */
function localGithub(value: string | null): string | null {
  if (!value) return null
  const handle = value.trim().match(/github\.com\/([A-Za-z0-9-]+)/i)?.[1] ?? value.trim()
  const cleaned = handle.replace(/^@/, '')
  return cleaned === '' ? null : cleaned
}

/**
 * A local profile, in the shape the interface expects.
 *
 * The two counts that *can* be derived are derived from the arrays, because in
 * local mode there is no trigger maintaining the stored number and the stored
 * number in the seed is illustrative:
 *
 *   post_count     `app.sync_profile_post_count` — live posts by the author.
 *   project_count  `app.sync_profile_project_count` — live projects they own.
 */
function localFullProfile(db: Tables, profile: LocalProfile): FullProfile {
  const postCount = db.posts.filter(
    (post) =>
      post.author_id === profile.id &&
      post.deleted_at === null &&
      post.moderation_status === 'active',
  ).length

  const projectCount = db.projects.filter(
    (project) => project.owner_id === profile.id && project.deleted_at === null,
  ).length

  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    headline: null,
    bio: profile.bio,
    // `degree` is the programme the profile names ("BS Software Engineering"),
    // falling back to the department when no programme is set.
    degree: profile.programme ?? profile.department,
    semester: localSemester(profile.semester),
    graduation_year: null,
    location: null,
    website: profile.website,
    github_username: localGithub(profile.github),
    linkedin_url: null,
    twitter_username: null,
    visibility: profile.visibility,
    onboarding_completed: true,
    follower_count: 0,
    following_count: 0,
    connection_count: 0,
    post_count: postCount,
    project_count: projectCount,
    created_at: profile.created_at,
    university_id: profile.university_id,
    university: localUniversityEmbed(db, profile.university_id),
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

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

  if (isLocalMode()) {
    const db = await readStore()
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return { state: 'missing', userId: user.id }
    return { state: 'ok', profile: localFullProfile(db, profile) }
  }

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

/**
 * A profile by handle. Case-insensitive, matching the unique index.
 *
 * A profile the reader may not see returns null, not a partial row: the page
 * renders 404 for it, which is the same answer a handle that does not exist gets.
 */
export async function getProfileByUsername(username: string): Promise<FullProfile | null> {
  if (isLocalMode()) {
    const db = await readStore()
    const wanted = username.trim().toLowerCase()
    const profile = db.profiles.find((candidate) => candidate.username.toLowerCase() === wanted)
    if (!profile) return null

    const user = await getUser()
    if (!canViewLocalProfile(profile, localViewer(db, user?.id ?? null))) return null
    return localFullProfile(db, profile)
  }

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
 *
 * The local store has no `status` column, so every institution in it is offered:
 * there is no moderation queue in local mode to hold one back.
 */
export async function listUniversities(): Promise<UniversityOption[]> {
  if (isLocalMode()) {
    const db = await readStore()
    return db.universities
      .map((university) => ({
        id: university.id,
        name: university.name,
        short_name: university.short_name,
        country: university.country,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

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

/**
 * Recently active people, for the "find someone" list. Not a recommendation engine.
 *
 * The local store records no `last_active_at` and no `status`, so the order is
 * account age — the only activity-shaped timestamp it keeps — and the two filters
 * that still mean something are applied instead: `searchable`, which the settings
 * page promises, and the visibility rule above, which is what would stop a
 * private profile appearing in a list.
 */
export async function listRecentProfiles(limit = 12): Promise<ProfileSummary[]> {
  if (isLocalMode()) {
    const db = await readStore()
    const user = await getUser()
    const viewer = localViewer(db, user?.id ?? null)

    return db.profiles
      .filter((profile) => profile.searchable && canViewLocalProfile(profile, viewer))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(toProfileSummary)
  }

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

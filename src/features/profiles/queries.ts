import 'server-only'

import { unstable_rethrow } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { readStore, type LocalProfile, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { canReadContent, canReadProfile, localActor } from '@/lib/local/access'
import { localGraphCounts } from '@/features/connections/graph-local'
import { getGraphCounts } from '@/features/connections/graph-reads'
import { approvedDepartmentOptions, type DepartmentOption, type DepartmentReference } from './departments'

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
 * There is no RLS here. All local reads use the shared access predicates, which
 * include visibility, accepted connections, blocks and account suspension.
 * Graph counts are derived from readable counterpart profiles, not stored
 * counters. Legacy rows retain their programme/GitHub mappings and completed
 * onboarding fallback; newer rows return the canonical values actually saved.
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
  /** Null means this graph is unavailable or its read failed, never zero. */
  follower_count: number | null
  following_count: number | null
  /** Always null for a foreign profile, including a public profile. */
  connection_count: number | null
  graph_counts_error?: string | null
  post_count: number
  project_count: number
  created_at: string
  university_id: string | null
  university: { id: string; name: string; short_name: string | null; slug: string } | null
  // Optional for existing callers/fixtures; real reads now populate the ID/embed.
  department_id?: string | null
  department?: DepartmentOption | null
  /** Only old local rows have a text-only affiliation, never an inferred ID. */
  legacy_department?: string | null
}

const FULL_SELECT = `
  id, username, display_name, avatar_url, headline, bio,
  degree, semester, graduation_year, location, website,
  github_username, linkedin_url, twitter_username,
  visibility, onboarding_completed,
  post_count, project_count,
  created_at, university_id, department_id,
  university:universities!profiles_university_id_fkey ( id, name, short_name, slug ),
  department:departments!profiles_department_id_fkey ( id, university_id, name )
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
  db: Tables
}

/** The reader's profile in the local store, or null when there is no session. */
export function localViewer(db: Tables, userId: string | null): LocalViewer {
  const profile = localActor(db, userId)
  return { profileId: profile?.id ?? null, universityId: profile?.university_id ?? null, db }
}

/** Every caller must supply the store so blocks and suspension cannot be skipped. */
export function canViewLocalProfile(target: LocalProfile, viewer: LocalViewer): boolean {
  const profile = viewer.db.profiles.find((row) => row.id === viewer.profileId)
  return canReadProfile(viewer.db, target, localActor(viewer.db, profile?.user_id ?? null))
}

/** The row shape every list embeds, from a `LocalProfile`. */
export function toProfileSummary(
  profile: Pick<LocalProfile, 'id' | 'username' | 'display_name' | 'avatar_url' | 'headline'>,
): ProfileSummary {
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    headline: profile.headline ?? null,
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

/** A committed local profile, in the shape the interface expects. */
function localFullProfile(db: Tables, profile: LocalProfile, viewer: LocalProfile | null): FullProfile {
  const graph = localGraphCounts(db, profile, viewer)
  const department = db.departments.find((row) =>
    row.id === profile.department_id && row.university_id === profile.university_id)
  const postCount = db.posts.filter(
    (post) =>
      post.author_id === profile.id &&
      post.moderation_status === 'active' &&
      canReadContent(db, post, profile.id, viewer, 'post'),
  ).length

  const projectCount = db.projects.filter(
    (project) => project.owner_id === profile.id &&
      canReadContent(db, project, profile.id, viewer, 'project'),
  ).length

  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    headline: profile.headline ?? null,
    bio: profile.bio,
    // An explicit clear must not resurrect an older programme/department.
    degree: profile.degree === undefined ? profile.programme ?? profile.department : profile.degree,
    semester: localSemester(profile.semester),
    graduation_year: profile.graduation_year ?? null,
    location: profile.location ?? null,
    website: profile.website,
    github_username: profile.github_username === undefined ? localGithub(profile.github) : profile.github_username,
    linkedin_url: profile.linkedin_url ?? null,
    twitter_username: profile.twitter_username ?? null,
    visibility: profile.visibility,
    onboarding_completed: profile.onboarding_completed ?? true,
    follower_count: graph?.follower_count ?? null,
    following_count: graph?.following_count ?? null,
    connection_count: graph?.connection_count ?? null,
    graph_counts_error: null,
    post_count: postCount,
    project_count: projectCount,
    created_at: profile.created_at,
    university_id: profile.university_id,
    university: localUniversityEmbed(db, profile.university_id),
    department_id: profile.department_id ?? null,
    department: department
      ? { id: department.id, university_id: department.university_id, name: department.name }
      : null,
    legacy_department: profile.department_id === undefined ? profile.department : null,
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

const PROFILE_READ_ERROR = 'The profile could not be loaded. Please try again.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type ProfileRow = Omit<FullProfile,
  'follower_count' | 'following_count' | 'connection_count' | 'graph_counts_error'>
export type MyProfileRead =
  | { state: 'signed-out' }
  | { state: 'missing'; userId: string }
  | { state: 'error'; message: string }
  | { state: 'ok'; profile: FullProfile }
export type ProfileRead =
  | { state: 'missing' }
  | { state: 'error'; message: string }
  | { state: 'ok'; profile: FullProfile }

function providerProfile(value: unknown): ProfileRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.username !== 'string' || !row.username.trim() ||
      typeof row.display_name !== 'string' || !row.display_name.trim() ||
      typeof row.visibility !== 'string' ||
      !['public', 'university', 'connections', 'private'].includes(row.visibility) ||
      typeof row.onboarding_completed !== 'boolean' ||
      typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)) ||
      !Number.isSafeInteger(row.post_count) || Number(row.post_count) < 0 ||
      !Number.isSafeInteger(row.project_count) || Number(row.project_count) < 0) return null
  for (const key of [
    'avatar_url', 'headline', 'bio', 'degree', 'location', 'website',
    'github_username', 'linkedin_url', 'twitter_username', 'university_id',
  ]) {
    if (!(row[key] === null || typeof row[key] === 'string')) return null
  }
  for (const key of ['semester', 'graduation_year']) {
    if (!(row[key] === null || Number.isSafeInteger(row[key]))) return null
  }
  if (row.department_id !== undefined &&
      !(row.department_id === null || typeof row.department_id === 'string')) return null
  if (row.university !== null) {
    if (!row.university || typeof row.university !== 'object' || Array.isArray(row.university)) return null
    const university = row.university as Record<string, unknown>
    if (typeof university.id !== 'string' || typeof university.name !== 'string' ||
        typeof university.slug !== 'string' ||
        !(university.short_name === null || typeof university.short_name === 'string')) return null
  }
  if (row.department !== undefined && row.department !== null) {
    if (typeof row.department !== 'object' || Array.isArray(row.department)) return null
    const department = row.department as Record<string, unknown>
    if (typeof department.id !== 'string' || typeof department.university_id !== 'string' ||
        typeof department.name !== 'string') return null
  }

  // Copy only the projection. Provider extras, notably maintained graph
  // counters and account/security fields, never enter the presentation DTO.
  const profile = row as unknown as ProfileRow
  return {
    id: profile.id, username: profile.username, display_name: profile.display_name,
    avatar_url: profile.avatar_url, headline: profile.headline, bio: profile.bio,
    degree: profile.degree, semester: profile.semester, graduation_year: profile.graduation_year,
    location: profile.location, website: profile.website,
    github_username: profile.github_username, linkedin_url: profile.linkedin_url,
    twitter_username: profile.twitter_username, visibility: profile.visibility,
    onboarding_completed: profile.onboarding_completed, post_count: profile.post_count,
    project_count: profile.project_count, created_at: profile.created_at,
    university_id: profile.university_id,
    university: profile.university ? {
      id: profile.university.id, name: profile.university.name,
      short_name: profile.university.short_name, slug: profile.university.slug,
    } : null,
    department_id: profile.department_id ?? null,
    department: profile.department ? {
      id: profile.department.id, university_id: profile.department.university_id,
      name: profile.department.name,
    } : null,
  }
}

async function withGraphCounts(profile: ProfileRow): Promise<FullProfile> {
  const graph = await getGraphCounts(profile.id)
  return {
    ...profile,
    follower_count: graph.counts?.follower_count ?? null,
    following_count: graph.counts?.following_count ?? null,
    connection_count: graph.counts?.connection_count ?? null,
    graph_counts_error: graph.error,
  }
}

/**
 * The signed-in user's own profile.
 *
 * Returns `'signed-out'` for no session and `'missing'` for a session without a
 * readable profile. The existing result contract uses `'missing'` for an inactive
 * local account too; no suspended row is exposed as a fallback. A genuinely
 * absent cloud row may require the 0016 backfill rather than a blank form.
 */
export async function getMyProfile(): Promise<MyProfileRead> {
  try {
    const user = await getUser()
    if (!user) return { state: 'signed-out' }

    if (isLocalMode()) {
      const db = await readStore()
      const profile = localActor(db, user.id)
      if (!profile) return { state: 'missing', userId: user.id }
      return { state: 'ok', profile: localFullProfile(db, profile, profile) }
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('profiles')
      .select(FULL_SELECT)
      .eq('id', user.id)
      .maybeSingle<ProfileRow>()
    if (error) return { state: 'error', message: PROFILE_READ_ERROR }
    if (data === null) return { state: 'missing', userId: user.id }
    const profile = providerProfile(data)
    if (!profile || profile.id !== user.id) return { state: 'error', message: PROFILE_READ_ERROR }
    return { state: 'ok', profile: await withGraphCounts(profile) }
  } catch (error) {
    unstable_rethrow(error)
    return { state: 'error', message: PROFILE_READ_ERROR }
  }
}

/**
 * A profile by handle. Case-insensitive, matching the unique index.
 *
 * A profile the reader may not see returns null, not a partial row: the page
 * renders 404 for it, which is the same answer a handle that does not exist gets.
 */
export async function getProfileByUsernameResult(username: string): Promise<ProfileRead> {
  try {
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 64) {
      return { state: 'missing' }
    }
    const wanted = username.trim()
    if (isLocalMode()) {
      const db = await readStore()
      const matches = db.profiles.filter(
        candidate => candidate.username.trim().toLowerCase() === wanted.toLowerCase(),
      )
      if (matches.length !== 1) return { state: 'missing' }
      const user = await getUser()
      const viewer = localActor(db, user?.id ?? null)
      const profile = matches[0]!
      if (!canReadProfile(db, profile, viewer)) return { state: 'missing' }
      return { state: 'ok', profile: localFullProfile(db, profile, viewer) }
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('profiles')
      .select(FULL_SELECT)
      .ilike('username', wanted.replace(/[%_\\]/g, '\\$&'))
      .is('deleted_at', null)
      .maybeSingle<ProfileRow>()
    if (error) return { state: 'error', message: PROFILE_READ_ERROR }
    if (data === null) return { state: 'missing' }
    const profile = providerProfile(data)
    if (!profile || profile.username.trim().toLowerCase() !== wanted.toLowerCase()) {
      return { state: 'error', message: PROFILE_READ_ERROR }
    }
    return { state: 'ok', profile: await withGraphCounts(profile) }
  } catch (error) {
    unstable_rethrow(error)
    return { state: 'error', message: PROFILE_READ_ERROR }
  }
}

/** Compatibility callers get null only for an absent/unreadable profile. */
export async function getProfileByUsername(username: string): Promise<FullProfile | null> {
  const result = await getProfileByUsernameResult(username)
  if (result.state === 'error') throw new Error(result.message)
  return result.state === 'ok' ? result.profile : null
}

export type UniversityOption = {
  id: string
  name: string
  short_name: string | null
  country: string | null
  /** Optional for older consumers; listUniversities always supplies this list. */
  departments?: DepartmentOption[]
}

/**
 * The universities a person may choose from.
 *
 * Offer approved universities and curated department references only. RLS also
 * allows a submitter to read their own pending campus; that does not make it an
 * approved option. is_verified describes a directory reference, not a student's
 * claim. Existing unlisted affiliations can be preserved by the edit form.
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
        departments: approvedDepartmentOptions(db.departments, university.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('universities')
    .select(`
      id, name, short_name, country,
      departments:departments!departments_university_id_fkey ( id, university_id, name, is_verified )
    `)
    .eq('status', 'approved')
    .eq('departments.is_verified', true)
    .order('name')
    .returns<(Omit<UniversityOption, 'departments'> & { departments: DepartmentReference[] | null })[]>()

  if (error) {
    console.error('[profiles:listUniversities]', error.code, error.message)
    return []
  }
  return (data ?? []).map((university) => ({
    ...university,
    departments: approvedDepartmentOptions(university.departments ?? [], university.id),
  }))
}

/**
 * Recently active people, for the "find someone" list. Not a recommendation engine.
 *
 * The local order is account age, not a fabricated activity score. Searchability
 * and the shared visibility/block/suspension predicate still apply.
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

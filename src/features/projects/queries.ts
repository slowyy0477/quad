import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { decodeCursor, type Cursor } from '@/lib/cursor'
import { isLocalMode } from '@/lib/mode'
import {
  readStore,
  type LocalPost,
  type LocalProfile,
  type LocalProject,
  type Tables,
} from '@/lib/local/db'

/**
 * Project reads.
 *
 * No visibility filter in any select, for the reason given in features/feed/queries:
 * RLS decides that inside Postgres, and a second copy of the rule in TypeScript is a
 * copy that can drift from the one an attacker cannot skip.
 *
 * `deleted_at` and `moderation_status` *are* filtered, because they are not
 * access-control questions -- the policies deliberately leave a hidden project
 * readable so a moderator can review it, and this app is not the moderation queue.
 *
 * The one filter that is neither access control nor moderation is the "open to join"
 * lens dropping projects whose slots are already filled. That is a discovery rule, not
 * a permission: `is_seeking_members` is the flag the owner set, and a project with
 * `member_count >= team_size_target` has no room left. It is computed from two stored
 * columns, so it needs no manual step to take effect.
 *
 * LOCAL MODE
 * ----------
 * There is no Postgres to hold the policy, so every read here with an `if
 * (isLocalMode())` at the top falls through to a function at the bottom of this file
 * that reproduces `projects_select` in TypeScript and derives the trigger-maintained
 * counters from the rows. The Supabase body is untouched, because the deployment is
 * still the target.
 */

export type ProjectListItem = {
  id: string
  slug: string
  title: string
  tagline: string | null
  category: string
  status: string
  visibility: string
  is_seeking_members: boolean
  member_count: number
  star_count: number
  created_at: string
  owner: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  } | null
}

export type ProjectDetail = ProjectListItem & {
  description: string | null
  repo_url: string | null
  demo_url: string | null
  looking_for: string | null
  team_size_target: number | null
  started_at: string | null
  completed_at: string | null
  application_count: number
  post_count: number
  updated_at: string
  owner_id: string
  university: { id: string; name: string; short_name: string | null; slug: string } | null
}

export type ProjectMember = {
  role: string
  title: string | null
  joined_at: string
  profile: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

/** A member as the list needs it: the two fields the avatars render. */
export type ProjectMemberChip = {
  profile_id: string
  profile: { id: string; username: string; display_name: string; avatar_url: string | null } | null
}

/** A required skill on a project, plus the required flag. */
export type ProjectSkillRow = {
  skill_id: string
  is_required: boolean
  skill: { id: string; name: string; slug: string } | null
}

const OWNER = `owner:profiles!projects_owner_id_fkey ( id, username, display_name, avatar_url )`

const LIST_SELECT = `
  id, slug, title, tagline, category, status, visibility,
  is_seeking_members, member_count, star_count, created_at,
  ${OWNER}
`

const DETAIL_SELECT = `
  ${LIST_SELECT},
  description, repo_url, demo_url, looking_for, team_size_target,
  started_at, completed_at, application_count, post_count, updated_at, owner_id,
  university:universities!projects_university_id_fkey ( id, name, short_name, slug )
`

/**
 * The discovery row's shape. Everything the row renders arrives in one query --
 * member avatars and required skills are embedded rather than fetched per row,
 * because a page of twenty-four projects firing twenty-four follow-up queries is
 * the N+1 that ENGINEERING.md calls a bug.
 */
export type ProjectListRow = ProjectListItem & {
  team_size_target: number | null
  members: ProjectMemberChip[]
  skills: ProjectSkillRow[]
}

const MEMBER_CHIP_SELECT = `project_members ( profile_id, profile:profiles!project_members_profile_id_fkey ( id, username, display_name, avatar_url ) )`
const SKILL_SELECT = `project_skills ( skill_id, is_required, skill:skills!project_skills_skill_id_fkey ( id, name, slug ) )`

export type ProjectFilter = {
  category?: string
  seeking?: boolean
  limit?: number
}

/** The discovery list. Newest first — not a ranking, and not described as one. */
export async function listProjects({
  category,
  seeking,
  limit = 24,
}: ProjectFilter = {}): Promise<{ projects: ProjectListItem[]; error: string | null }> {
  if (isLocalMode()) return listProjectsLocal({ category, seeking, limit })

  const supabase = await createClient()

  let query = supabase
    .from('projects')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (category) query = query.eq('category', category)
  if (seeking) query = query.eq('is_seeking_members', true)

  const { data, error } = await query.returns<ProjectListItem[]>()

  if (error) {
    console.error('[projects:listProjects]', error.code, error.message)
    return { projects: [], error: 'Projects could not be loaded. Please try again.' }
  }
  return { projects: data ?? [], error: null }
}

/**
 * Projects owned by one person, for their profile and for "my projects".
 *
 * The embedded members and skills make this the same round-trip shape as the
 * discovery list, so the row component is fed one type from both lenses.
 */
export async function listProjectsByOwner(ownerId: string): Promise<ProjectListItem[]> {
  if (isLocalMode()) return listProjectsByOwnerLocal(ownerId)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select(LIST_SELECT)
    .eq('owner_id', ownerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .returns<ProjectListItem[]>()

  if (error) {
    console.error('[projects:listProjectsByOwner]', error.code, error.message)
    return []
  }
  return data ?? []
}

/** Every project the signed-in user owns or is a member of. */
export async function listMyProjects(): Promise<ProjectListItem[]> {
  const user = await getUser()
  if (!user) return []

  if (isLocalMode()) return listMyProjectsLocal(user.id)

  const supabase = await createClient()

  // Two queries rather than an `or` across a join: PostgREST cannot express
  // "owner_id = me OR exists(member row)" in one filter, and an inner join on
  // project_members would drop projects with no members yet.
  const [owned, memberships] = await Promise.all([
    listProjectsByOwner(user.id),
    supabase
      .from('project_members')
      .select(`project:projects!project_members_project_id_fkey ( ${LIST_SELECT} )`)
      .eq('profile_id', user.id)
      .returns<{ project: ProjectListItem | null }[]>(),
  ])

  if (memberships.error) {
    console.error('[projects:listMyProjects]', memberships.error.code, memberships.error.message)
    return owned
  }

  const seen = new Set(owned.map((project) => project.id))
  const joined = (memberships.data ?? [])
    .map((row) => row.project)
    .filter((project): project is ProjectListItem => Boolean(project) && !seen.has(project!.id))

  return [...owned, ...joined].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** One project by slug. Null covers both "no such project" and "not visible to you". */
export async function getProjectBySlug(slug: string): Promise<ProjectDetail | null> {
  if (isLocalMode()) return getProjectBySlugLocal(slug)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select(DETAIL_SELECT)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle<ProjectDetail>()

  if (error) {
    console.error('[projects:getProjectBySlug]', error.code, error.message)
    return null
  }
  return data
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  if (isLocalMode()) return listProjectMembersLocal(projectId)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_members')
    .select(
      `role, title, joined_at,
       profile:profiles!project_members_profile_id_fkey ( id, username, display_name, avatar_url, headline )`,
    )
    .eq('project_id', projectId)
    .order('joined_at')
    .returns<ProjectMember[]>()

  if (error) {
    console.error('[projects:listProjectMembers]', error.code, error.message)
    return []
  }
  return data ?? []
}

// -----------------------------------------------------------------------------
// Discovery lens: "Open to join"
// -----------------------------------------------------------------------------

export type OpenProjectsPage = {
  projects: ProjectListRow[]
  nextCursor: Cursor | null
  error: string | null
}

/**
 * The "open to join" lens: projects the owner is recruiting for that are not full.
 *
 * The `is_seeking_members` filter is the owner's explicit flag. "Not full" is
 * `team_size_target is null or member_count < team_size_target`, and it is applied
 * here rather than in SQL because PostgREST cannot compare two columns in a filter.
 * A project therefore drops out of this list the moment its last slot is taken,
 * with no manual step -- which is the promise the screen makes when it says the
 * badge shows the remaining slots.
 *
 * The cursor is taken from the last *scanned* row, not the last kept one, so a page
 * that was entirely full still advances the reader instead of looping on it.
 */
export async function listOpenProjects({
  skillId,
  universityId,
  cursor,
  limit = 24,
}: {
  skillId?: string
  universityId?: string
  cursor?: string | string[]
  limit?: number
} = {}): Promise<OpenProjectsPage> {
  if (isLocalMode()) return listOpenProjectsLocal({ skillId, universityId, cursor, limit })

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  const skills = skillId ? `project_skills!inner ( skill_id, is_required, skill:skills!project_skills_skill_id_fkey ( id, name, slug ) )` : SKILL_SELECT

  let query = supabase
    .from('projects')
    .select(
      `id, slug, title, tagline, category, status, visibility,
       is_seeking_members, member_count, star_count, team_size_target, created_at,
       ${OWNER}, ${MEMBER_CHIP_SELECT}, ${skills}`,
    )
    .eq('is_seeking_members', true)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (skillId) query = query.eq('project_skills.skill_id', skillId)
  if (universityId) query = query.eq('university_id', universityId)

  if (decoded) {
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<ProjectListRow[]>()

  if (error) {
    console.error('[projects:listOpenProjects]', error.code, error.message)
    return { projects: [], nextCursor: null, error: 'Open projects could not be loaded. Please try again.' }
  }

  const scanned = data ?? []
  const open = scanned.filter(
    (project) => project.team_size_target == null || project.member_count < project.team_size_target,
  )

  const last = scanned.at(-1)
  return {
    projects: open,
    nextCursor: scanned.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

/**
 * "My projects" for the lens, with the same embedded shape as the open lens so both
 * tabs render one row component. Reuses listMyProjects for the id set, then asks for
 * the rich rows in a single query rather than one per project.
 */
export async function listMyProjectRows(): Promise<{ projects: ProjectListRow[]; error: string | null }> {
  const mine = await listMyProjects()
  if (mine.length === 0) return { projects: [], error: null }

  if (isLocalMode()) return listMyProjectRowsLocal(mine.map((project) => project.id))

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select(
      `id, slug, title, tagline, category, status, visibility,
       is_seeking_members, member_count, star_count, team_size_target, created_at,
       ${OWNER}, ${MEMBER_CHIP_SELECT}, ${SKILL_SELECT}`,
    )
    .in(
      'id',
      mine.map((project) => project.id),
    )
    .order('created_at', { ascending: false })
    .returns<ProjectListRow[]>()

  if (error) {
    console.error('[projects:listMyProjectRows]', error.code, error.message)
    return { projects: [], error: 'Your projects could not be loaded. Please try again.' }
  }
  return { projects: data ?? [], error: null }
}

// -----------------------------------------------------------------------------
// Filters: skills and universities
// -----------------------------------------------------------------------------

export type SkillOption = { id: string; name: string; slug: string; category: string }

/** The approved skills a filter or a form may offer. Unapproved ones are RLS-hidden. */
export async function listSkillOptions(limit = 200): Promise<SkillOption[]> {
  // There is no `skills` table in the local store, so there is no catalogue to
  // offer. An empty list is the honest answer: the filter and the seeking form
  // render their "nothing to choose from" state instead of inventing tags.
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('skills')
    .select('id, name, slug, category')
    .order('name')
    .limit(limit)
    .returns<SkillOption[]>()

  if (error) {
    console.error('[projects:listSkillOptions]', error.code, error.message)
    return []
  }
  return data ?? []
}

export type UniversityFilterOption = { id: string; name: string; short_name: string | null }

export async function listUniversityOptions(limit = 200): Promise<UniversityFilterOption[]> {
  if (isLocalMode()) {
    const db = await readStore()
    return db.universities
      .map((university) => ({
        id: university.id,
        name: university.name,
        short_name: university.short_name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('universities')
    .select('id, name, short_name')
    .order('name')
    .limit(limit)
    .returns<UniversityFilterOption[]>()

  if (error) {
    console.error('[projects:listUniversityOptions]', error.code, error.message)
    return []
  }
  return data ?? []
}

// -----------------------------------------------------------------------------
// A project's required skills, and how many members can actually fill them
// -----------------------------------------------------------------------------

export type RequiredSkill = {
  skillId: string
  name: string
  slug: string
  /** Members who declare this skill. A real count over profile_skills rows. */
  filled: number
}

export async function listProjectSkillsWithFilled(
  projectId: string,
): Promise<{ required: RequiredSkill[]; all: ProjectSkillRow[] }> {
  // No `project_skills`, `profile_skills` or `skills` table in the local store:
  // no project declares a required skill there, so both halves are empty. The
  // detail page hides the "Skills needed" section rather than showing zeros.
  if (isLocalMode()) return { required: [], all: [] }

  const supabase = await createClient()

  const [skillsResult, membersResult] = await Promise.all([
    supabase
      .from('project_skills')
      .select(`skill_id, is_required, skill:skills!project_skills_skill_id_fkey ( id, name, slug )`)
      .eq('project_id', projectId)
      .returns<ProjectSkillRow[]>(),
    supabase.from('project_members').select('profile_id').eq('project_id', projectId).returns<{ profile_id: string }[]>(),
  ])

  if (skillsResult.error) {
    console.error('[projects:listProjectSkillsWithFilled]', skillsResult.error.code, skillsResult.error.message)
    return { required: [], all: [] }
  }

  const all = skillsResult.data ?? []
  const memberIds = (membersResult.data ?? []).map((row) => row.profile_id)
  const required = all.filter((row) => row.is_required && row.skill)

  if (memberIds.length === 0 || required.length === 0) {
    return { required: [], all }
  }

  // One query for the whole matrix, aggregated here. A query per skill would be the
  // N+1 this module is explicitly against.
  const { data: skillRows, error: skillError } = await supabase
    .from('profile_skills')
    .select('profile_id, skill_id')
    .in('profile_id', memberIds)
    .in('skill_id', required.map((row) => row.skill_id))
    .returns<{ profile_id: string; skill_id: string }[]>()

  if (skillError) {
    console.error('[projects:listProjectSkillsWithFilled]', skillError.code, skillError.message)
    return { required: required.map((row) => ({ skillId: row.skill_id, name: row.skill!.name, slug: row.skill!.slug, filled: 0 })), all }
  }

  const counts = new Map<string, number>()
  for (const row of skillRows ?? []) {
    counts.set(row.skill_id, (counts.get(row.skill_id) ?? 0) + 1)
  }

  return {
    required: required.map((row) => ({
      skillId: row.skill_id,
      name: row.skill!.name,
      slug: row.skill!.slug,
      filled: counts.get(row.skill_id) ?? 0,
    })),
    all,
  }
}

// -----------------------------------------------------------------------------
// The update stream
// -----------------------------------------------------------------------------

export type ProjectUpdate = {
  id: string
  type: string
  title: string | null
  body: string | null
  visibility: string
  like_count: number
  comment_count: number
  created_at: string
  is_edited: boolean
  author: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

/**
 * The project's update stream.
 *
 * These are `posts` rows anchored to the project (`type = 'project_update'`), read
 * through the same RLS that governs the feed. No membership filter is added here --
 * the policy on `posts` decides what the reader may see, and a copy of that rule in
 * TypeScript is a copy an attacker talking to PostgREST directly would not face.
 * `deleted_at` and `moderation_status` are filtered because they are not access
 * control.
 */
export async function listProjectUpdates({
  projectId,
  cursor,
  limit = 20,
}: {
  projectId: string
  cursor?: string | string[]
  limit?: number
}): Promise<{ updates: ProjectUpdate[]; nextCursor: Cursor | null; error: string | null }> {
  if (isLocalMode()) return listProjectUpdatesLocal({ projectId, cursor, limit })

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('posts')
    .select(
      `id, type, title, body, visibility, like_count, comment_count, created_at, is_edited,
       author:profiles!posts_author_id_fkey ( id, username, display_name, avatar_url, headline )`,
    )
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<ProjectUpdate[]>()

  if (error) {
    console.error('[projects:listProjectUpdates]', error.code, error.message)
    return { updates: [], nextCursor: null, error: 'The update stream could not be loaded.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)
  return {
    updates: rows,
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

// -----------------------------------------------------------------------------
// The owner's side: pending requests, and what the reader may do
// -----------------------------------------------------------------------------

export type ProjectApplicationRow = {
  id: string
  message: string | null
  desired_role: string | null
  status: string
  created_at: string
  applicant: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

/**
 * Pending join requests for a project. RLS restricts this to the applicant, a
 * project manager or a moderator -- so a plain member reading this sees nothing,
 * which is the intended answer rather than an empty state to explain away.
 */
export async function listPendingApplications(projectId: string): Promise<ProjectApplicationRow[]> {
  // The local store has no `project_applications` table, so there is nothing to
  // read and nothing that `requestToJoinAction` could have written. The Requests
  // tab renders its empty state.
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_applications')
    .select(
      `id, message, desired_role, status, created_at,
       applicant:profiles!project_applications_applicant_id_fkey ( id, username, display_name, avatar_url, headline )`,
    )
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .order('created_at')
    .returns<ProjectApplicationRow[]>()

  if (error) {
    console.error('[projects:listPendingApplications]', error.code, error.message)
    return []
  }
  return data ?? []
}

export type ProjectViewerState = {
  userId: string | null
  /** Owner and maintainer may manage; plain members may not. */
  canManage: boolean
  isMember: boolean
  role: 'owner' | 'maintainer' | 'member' | null
  /** The reader already has a live request to join. */
  hasPendingApplication: boolean
  /** The reader has been invited and has not answered. */
  hasPendingInvite: boolean
}

/**
 * What the reader may do on this project.
 *
 * The flags only decide which controls to render; every write is checked again by
 * the policies, so a stale flag here produces a refusal, never a privilege. The role
 * is read from the reader's own membership row rather than inferred from `owner_id`,
 * because a maintainer can manage and the two must not be conflated.
 */
export async function getProjectViewerState(projectId: string): Promise<ProjectViewerState> {
  const user = await getUser()
  const empty: ProjectViewerState = {
    userId: null,
    canManage: false,
    isMember: false,
    role: null,
    hasPendingApplication: false,
    hasPendingInvite: false,
  }
  if (!user) return empty

  if (isLocalMode()) return getProjectViewerStateLocal(projectId, user.id)

  const supabase = await createClient()

  const [membership, applications, invites] = await Promise.all([
    supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('profile_id', user.id)
      .maybeSingle<{ role: string }>(),
    supabase
      .from('project_applications')
      .select('id')
      .eq('project_id', projectId)
      .eq('applicant_id', user.id)
      .eq('status', 'pending')
      .maybeSingle<{ id: string }>(),
    supabase
      .from('project_invites')
      .select('id')
      .eq('project_id', projectId)
      .eq('invitee_id', user.id)
      .eq('status', 'pending')
      .maybeSingle<{ id: string }>(),
  ])

  const role = (membership.data?.role ?? null) as ProjectViewerState['role']

  return {
    userId: user.id,
    isMember: Boolean(membership.data),
    canManage: role === 'owner' || role === 'maintainer',
    role,
    hasPendingApplication: Boolean(applications.data),
    hasPendingInvite: Boolean(invites.data),
  }
}

/**
 * Whether the signed-in reader has starred this project.
 *
 * A miss and "not signed in" are both `false`, which is what the button needs to
 * render. The insert is still authoritative: a stale `false` here produces a
 * duplicate-key error, not a duplicate star.
 */
export async function hasStarred(projectId: string): Promise<boolean> {
  const user = await getUser()
  if (!user) return false

  // No `project_stars` table in the local store, so nothing is ever starred there
  // and `toggleStarAction` refuses rather than claiming a write it did not make.
  if (isLocalMode()) return false

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('project_stars')
    .select('project_id')
    .eq('project_id', projectId)
    .eq('profile_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[projects:hasStarred]', error.code, error.message)
    return false
  }
  return Boolean(data)
}

// =============================================================================
// Local mode
//
// The same reads, against `data/local.json`. Two things change and nothing else:
//
// 1. The visibility rule that `projects_select` enforces inside Postgres is
//    reproduced literally below, because with no policy there is nothing else to
//    stop a private project reaching a reader.
// 2. The counters (`member_count`, `star_count`, `post_count`) are derived from
//    the arrays. In Postgres they are trigger-maintained caches; here there is no
//    trigger, and a stored number would be a number nobody updates.
//
// Everything absent from the local schema (`skills`, `project_skills`,
// `project_stars`, `project_applications`, `project_invites`) is answered with an
// empty result and a comment at the read that needs it.
// =============================================================================

type ProjectVisibility = LocalProject['visibility']

/** `app.visibility_rank` (0001). Higher is more visible. */
const VISIBILITY_RANK: Record<ProjectVisibility, number> = {
  public: 3,
  university: 2,
  connections: 1,
  private: 0,
}

/** `app.clamp_visibility` (0001): the less visible of the two levels. */
export function clampVisibility(
  requested: ProjectVisibility,
  ceiling: ProjectVisibility,
): ProjectVisibility {
  return VISIBILITY_RANK[requested] <= VISIBILITY_RANK[ceiling] ? requested : ceiling
}

/**
 * `app.can_manage_project`: the owner, or a membership row whose role is
 * `maintainer`. A plain member may not manage -- that is the whole difference
 * between the two roles, and the reason the role is read rather than inferred
 * from `owner_id`.
 */
export function canManageProject(db: Tables, project: LocalProject, profileId: string | null): boolean {
  if (!profileId) return false
  if (project.owner_id === profileId) return true
  return db.project_members.some(
    (member) =>
      member.project_id === project.id && member.profile_id === profileId && member.role === 'maintainer',
  )
}

/** The reader, as a profile row. `getUser()` also writes the seed on first run. */
async function localContext(): Promise<{ db: Tables; viewer: LocalProfile | null }> {
  const user = await getUser()
  const db = await readStore()
  const viewer = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  return { db, viewer }
}

/**
 * `projects_select`, in TypeScript.
 *
 *     deleted_at is null
 *     and moderation_status = 'active'
 *     and (
 *       visibility = 'public'
 *       or (visibility = 'university' and same university as the reader)
 *       or (visibility = 'connections' and app.are_connected(reader, owner))
 *     )
 *     or owner_id = auth.uid()
 *     or app.is_project_member(id)
 *
 * `moderation_status` is not modelled in the local store, so there is no hidden
 * row to drop here. `connections` is reproduced as "author only", because the
 * local store has no connections table and therefore nobody is connected to
 * anybody: the owner/member clauses are the only way such a row is readable.
 */
export function canSeeProject(db: Tables, project: LocalProject, viewer: LocalProfile | null): boolean {
  if (project.deleted_at) return false

  if (viewer) {
    if (project.owner_id === viewer.id) return true
    if (db.project_members.some((member) => member.project_id === project.id && member.profile_id === viewer.id)) {
      return true
    }
  }

  switch (project.visibility) {
    case 'public':
      return true
    case 'university': {
      const owner = db.profiles.find((profile) => profile.id === project.owner_id)
      return Boolean(
        viewer?.university_id && owner?.university_id && owner.university_id === viewer.university_id,
      )
    }
    case 'connections':
    case 'private':
    default:
      return false
  }
}

/** `posts_select`, for the project update stream. */
function canSeePost(db: Tables, post: LocalPost, viewer: LocalProfile | null): boolean {
  if (post.deleted_at) return false
  if (post.moderation_status !== 'active') return false
  if (viewer && post.author_id === viewer.id) return true

  switch (post.visibility) {
    case 'public':
      return true
    case 'university': {
      const author = db.profiles.find((profile) => profile.id === post.author_id)
      return Boolean(
        viewer?.university_id && author?.university_id && author.university_id === viewer.university_id,
      )
    }
    case 'connections':
    case 'private':
    default:
      return false
  }
}

/** Newest first, `(created_at, id)` descending -- the index the migration builds. */
function newestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
}

/**
 * A cursor from the local store.
 *
 * `decodeCursor` in lib/cursor insists the id is a uuid, which every local id
 * (`prj_…`, `dea_…`) is not -- so it would reject every cursor this app issues
 * and pin the reader to the first page forever. The timestamp check is kept.
 */
function decodeLocalCursor(raw: string | string[] | undefined): Cursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null

  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) return null

  const createdAt = decoded.slice(0, separator)
  const cursorId = decoded.slice(separator + 1)
  if (!cursorId) return null
  if (Number.isNaN(Date.parse(createdAt))) return null

  return { createdAt, id: cursorId }
}

/** `(created_at, id) < cursor`, the keyset predicate the PostgREST filter encodes. */
function afterCursor(row: { created_at: string; id: string }, cursor: Cursor | null): boolean {
  if (!cursor) return true
  if (row.created_at < cursor.createdAt) return true
  return row.created_at === cursor.createdAt && row.id < cursor.id
}

function memberCountOf(db: Tables, projectId: string): number {
  // `projects.member_count` is a trigger cache (app.sync_project_member_count).
  // There is no trigger here, so the number comes from the membership rows.
  return db.project_members.filter((member) => member.project_id === projectId).length
}

function ownerChip(db: Tables, ownerId: string): ProjectListItem['owner'] {
  const profile = db.profiles.find((entry) => entry.id === ownerId)
  if (!profile) return null
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
  }
}

/** The four profile fields the update stream and the applications render. */
function headlineChip(db: Tables, profileId: string): ProjectUpdate['author'] {
  const profile = db.profiles.find((entry) => entry.id === profileId)
  if (!profile) return null
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    // The local profile has no headline column; the shape keeps the key.
    headline: null,
  }
}

function memberChips(db: Tables, projectId: string): ProjectMemberChip[] {
  return db.project_members
    .filter((member) => member.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((member) => {
      const profile = db.profiles.find((entry) => entry.id === member.profile_id)
      return {
        profile_id: member.profile_id,
        profile: profile
          ? {
              id: profile.id,
              username: profile.username,
              display_name: profile.display_name,
              avatar_url: profile.avatar_url,
            }
          : null,
      }
    })
}

function projectItem(db: Tables, project: LocalProject): ProjectListItem {
  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    // The local column is `purpose`; the shape and every component call it
    // `tagline`. Same field -- "a one-line purpose" -- so it is mapped, not
    // dropped, or every local project would read "No one-line purpose written yet."
    tagline: project.purpose === '' ? null : project.purpose,
    category: project.category,
    status: project.status,
    visibility: project.visibility,
    is_seeking_members: project.is_seeking_members,
    member_count: memberCountOf(db, project.id),
    // No project_stars table in the local store: nothing can be starred.
    star_count: 0,
    created_at: project.created_at,
    owner: ownerChip(db, project.owner_id),
  }
}

function projectListRow(db: Tables, project: LocalProject): ProjectListRow {
  return {
    ...projectItem(db, project),
    team_size_target: project.team_size_target,
    members: memberChips(db, project.id),
    // No project_skills table, so no project carries a skill chip here.
    skills: [],
  }
}

function projectDetail(db: Tables, project: LocalProject): ProjectDetail {
  return {
    ...projectListRow(db, project),
    description: project.description,
    // repo_url, demo_url, looking_for, started_at and completed_at have no local
    // column. They are returned as null because the shape is consumed unchanged;
    // see docs/plan/LOCAL-MODE.md and the port notes in .scratch/projects-ideas-local.
    repo_url: null,
    demo_url: null,
    looking_for: null,
    started_at: null,
    completed_at: null,
    // No project_applications table.
    application_count: 0,
    post_count: db.posts.filter((post) => post.project_id === project.id && post.deleted_at === null).length,
    // The local project has no updated_at column; created_at is the only instant
    // the store records for it.
    updated_at: project.created_at,
    owner_id: project.owner_id,
    // The local university row has no `slug` and the project has no university_id,
    // so there is no addressable university to link to. Null, not a fabricated slug.
    university: null,
  }
}

async function listProjectsLocal({
  category,
  seeking,
  limit = 24,
}: ProjectFilter): Promise<{ projects: ProjectListItem[]; error: string | null }> {
  const { db, viewer } = await localContext()

  const projects = db.projects
    .filter((project) => canSeeProject(db, project, viewer))
    .filter((project) => (category ? project.category === category : true))
    .filter((project) => (seeking ? project.is_seeking_members : true))
    .sort(newestFirst)
    .slice(0, limit)
    .map((project) => projectItem(db, project))

  return { projects, error: null }
}

async function listProjectsByOwnerLocal(ownerId: string): Promise<ProjectListItem[]> {
  const { db, viewer } = await localContext()

  return db.projects
    .filter((project) => project.owner_id === ownerId)
    .filter((project) => canSeeProject(db, project, viewer))
    .sort(newestFirst)
    .map((project) => projectItem(db, project))
}

async function listMyProjectsLocal(userId: string): Promise<ProjectListItem[]> {
  const db = await readStore()
  const viewer = db.profiles.find((profile) => profile.user_id === userId) ?? null
  if (!viewer) return []

  // Owner or member, deduplicated the way the Supabase path does it: the owner
  // also has a membership row, and would otherwise appear twice.
  const mine = db.projects.filter(
    (project) =>
      project.deleted_at === null &&
      (project.owner_id === viewer.id ||
        db.project_members.some((member) => member.project_id === project.id && member.profile_id === viewer.id)),
  )

  return mine.sort(newestFirst).map((project) => projectItem(db, project))
}

async function getProjectBySlugLocal(slug: string): Promise<ProjectDetail | null> {
  const { db, viewer } = await localContext()
  const project = db.projects.find((entry) => entry.slug === slug)
  // The same answer for "no such project" and "not visible to you", which is what
  // `maybeSingle` under RLS returns: nothing.
  if (!project || !canSeeProject(db, project, viewer)) return null
  return projectDetail(db, project)
}

async function listProjectMembersLocal(projectId: string): Promise<ProjectMember[]> {
  const { db, viewer } = await localContext()
  const project = db.projects.find((entry) => entry.id === projectId)
  // `project_members_select` reads through `app.can_view_project`.
  if (!project || !canSeeProject(db, project, viewer)) return []

  return db.project_members
    .filter((member) => member.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((member) => {
      const profile = db.profiles.find((entry) => entry.id === member.profile_id)
      return {
        role: member.role,
        // No `title` column on local membership rows.
        title: null,
        // The local column is `created_at`; the shape calls it `joined_at`.
        joined_at: member.created_at,
        profile: profile
          ? {
              id: profile.id,
              username: profile.username,
              display_name: profile.display_name,
              avatar_url: profile.avatar_url,
              headline: null,
            }
          : null,
      }
    })
}

async function listOpenProjectsLocal({
  skillId,
  universityId,
  cursor,
  limit = 24,
}: {
  skillId?: string
  universityId?: string
  cursor?: string | string[]
  limit?: number
}): Promise<OpenProjectsPage> {
  const { db, viewer } = await localContext()

  // No project_skills table: nothing in the local store declares a skill, so a
  // skill filter matches no project rather than being silently ignored.
  if (skillId) return { projects: [], nextCursor: null, error: null }

  const universityOf = (project: LocalProject) =>
    db.profiles.find((profile) => profile.id === project.owner_id)?.university_id ?? null

  const decoded = decodeLocalCursor(cursor)

  const scanned = db.projects
    .filter((project) => project.is_seeking_members && canSeeProject(db, project, viewer))
    .filter((project) => (universityId ? universityOf(project) === universityId : true))
    .sort(newestFirst)
    .filter((project) => afterCursor(project, decoded))
    .slice(0, limit)

  const open = scanned.filter(
    (project) =>
      project.team_size_target == null || memberCountOf(db, project.id) < project.team_size_target,
  )

  const last = scanned.at(-1)

  return {
    projects: open.map((project) => projectListRow(db, project)),
    nextCursor: scanned.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

async function listMyProjectRowsLocal(ids: string[]): Promise<{ projects: ProjectListRow[]; error: string | null }> {
  const { db, viewer } = await localContext()
  const wanted = new Set(ids)

  const projects = db.projects
    .filter((project) => wanted.has(project.id) && canSeeProject(db, project, viewer))
    .sort(newestFirst)
    .map((project) => projectListRow(db, project))

  return { projects, error: null }
}

async function listProjectUpdatesLocal({
  projectId,
  cursor,
  limit = 20,
}: {
  projectId: string
  cursor?: string | string[]
  limit?: number
}): Promise<{ updates: ProjectUpdate[]; nextCursor: Cursor | null; error: string | null }> {
  const { db, viewer } = await localContext()
  const decoded = decodeLocalCursor(cursor)

  const rows = db.posts
    .filter((post) => post.project_id === projectId && canSeePost(db, post, viewer))
    .sort(newestFirst)
    .filter((post) => afterCursor(post, decoded))
    .slice(0, limit)

  const updates = rows.map((post) => ({
    id: post.id,
    // The local post has no `type` column: every post anchored to a project is an
    // update in this store, which is the same set the select above returns.
    type: 'project_update',
    // Nor a title: local updates are body-only.
    title: null,
    body: post.body,
    visibility: post.visibility,
    // Derived rather than stored, exactly as `like_count`/`comment_count` would
    // be maintained by the triggers in Postgres.
    like_count: db.post_likes.filter((like) => like.post_id === post.id).length,
    comment_count: db.comments.filter((comment) => comment.post_id === post.id && comment.deleted_at === null).length,
    created_at: post.created_at,
    // No edit history in the local store.
    is_edited: false,
    author: headlineChip(db, post.author_id),
  }))

  const last = rows.at(-1)
  return {
    updates,
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

async function getProjectViewerStateLocal(projectId: string, userId: string): Promise<ProjectViewerState> {
  const db = await readStore()
  const viewer = db.profiles.find((profile) => profile.user_id === userId) ?? null
  if (!viewer) {
    return {
      userId: null,
      canManage: false,
      isMember: false,
      role: null,
      hasPendingApplication: false,
      hasPendingInvite: false,
    }
  }

  const membership = db.project_members.find(
    (member) => member.project_id === projectId && member.profile_id === viewer.id,
  )
  const role = membership?.role ?? null

  return {
    userId,
    isMember: Boolean(membership),
    canManage: role === 'owner' || role === 'maintainer',
    role,
    // No project_applications or project_invites table in the local store.
    hasPendingApplication: false,
    hasPendingInvite: false,
  }
}

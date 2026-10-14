import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'

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

/** Projects owned by one person, for their profile and for "my projects". */
export async function listProjectsByOwner(ownerId: string): Promise<ProjectListItem[]> {
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

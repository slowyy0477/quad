import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { decodeCursor, type Cursor } from '@/lib/cursor'
import { isLocalMode } from '@/lib/mode'
import { readStore, type LocalIdea, type LocalProfile, type Tables } from '@/lib/local/db'
import { canSeeProject } from '@/features/projects/queries'

/**
 * Idea reads.
 *
 * As everywhere else, no visibility filter appears in these selects. RLS decides what
 * each reader may see, and the rule that matters for moderation is already in the
 * `ideas_select` policy: a hidden idea is readable by its author and by moderators and
 * by nobody else. Repeating that in TypeScript would give one reader a different
 * answer from the one an attacker gets by calling PostgREST directly.
 *
 * `deleted_at` is filtered, because a soft-deleted idea is gone for everyone,
 * including its author -- the same treatment a deleted post gets.
 *
 * Note what is NOT filtered: `moderation_status`. A hidden idea is *supposed* to stay
 * in its author's own list so they can see what happened to it; filtering it here
 * would hide it from them and leave the moderation state unexplainable.
 *
 * LOCAL MODE
 * ----------
 * With no policy in place the visibility rule is reproduced in TypeScript at the
 * bottom of this file (`canSeeIdea`), together with the `ideas_select` author clause
 * that keeps a private idea readable by the person who wrote it. The stored counters
 * are returned as stored: the local store has no `idea_votes` or `idea_interest`
 * table, so nothing could be derived from rows that do not exist.
 */

export type IdeaListItem = {
  id: string
  title: string
  description: string
  category: string
  status: string
  looking_for: string | null
  visibility: string
  moderation_status: string
  upvote_count: number
  comment_count: number
  interest_count: number
  converted_project_id: string | null
  converted_at: string | null
  created_at: string
  updated_at: string
  author: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

export type IdeaSkill = {
  skill_id: string
  skill: { id: string; name: string; slug: string } | null
}

const IDEA_SELECT = `
  id, title, description, category, status, looking_for, visibility,
  moderation_status, upvote_count, comment_count, interest_count,
  converted_project_id, converted_at, created_at, updated_at,
  author:profiles!ideas_author_id_fkey ( id, username, display_name, avatar_url, headline )
`

export type IdeasPage = {
  ideas: IdeaListItem[]
  nextCursor: Cursor | null
  error: string | null
}

/**
 * The vault, newest first.
 *
 * Most-supported-first would be the obvious board ordering, and it is the wrong
 * default here: an idea with no votes yet would sit permanently at the bottom and
 * never collect any. Newest-first gives every idea its day; the vote count is shown
 * on the card for anyone who wants to sort by eye.
 */
export async function listIdeas({
  limit = 20,
  cursor,
}: { limit?: number; cursor?: string | string[] } = {}): Promise<IdeasPage> {
  if (isLocalMode()) return listIdeasLocal({ limit, cursor })

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('ideas')
    .select(IDEA_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<IdeaListItem[]>()

  if (error) {
    console.error('[ideas:listIdeas]', error.code, error.message)
    return { ideas: [], nextCursor: null, error: 'Ideas could not be loaded. Please try again.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)
  return {
    ideas: rows,
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

export type IdeaDetail = IdeaListItem

/**
 * One idea. Null covers "no such idea" and "not visible to you" with the same answer,
 * which is the correct behaviour: a distinguishing 403 would confirm the idea exists
 * to someone not allowed to see it.
 */
export async function getIdeaById(id: string): Promise<IdeaDetail | null> {
  if (isLocalMode()) return getIdeaByIdLocal(id)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ideas')
    .select(IDEA_SELECT)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<IdeaDetail>()

  if (error) {
    console.error('[ideas:getIdeaById]', error.code, error.message)
    return null
  }
  return data
}

/** The skills an idea asks for. The machine-readable half of the pitch. */
export async function listIdeaSkills(ideaId: string): Promise<IdeaSkill[]> {
  // No `idea_skills` or `skills` table in the local store: no idea asks for a
  // skill there, so the list is empty rather than invented.
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('idea_skills')
    .select(`skill_id, skill:skills!idea_skills_skill_id_fkey ( id, name, slug )`)
    .eq('idea_id', ideaId)
    .returns<IdeaSkill[]>()

  if (error) {
    console.error('[ideas:listIdeaSkills]', error.code, error.message)
    return []
  }
  return data ?? []
}

export type IdeaInterestRow = {
  profile_id: string
  message: string | null
  offering: string | null
  created_at: string
  profile: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

/**
 * Who said they would help build it.
 *
 * RLS narrows this without help: an idea's author reads every interest row, everyone
 * else reads only their own. So a visitor viewing the page sees their own offer and
 * the stored `interest_count`, never the list of other people's pitches.
 */
export async function listIdeaInterests(ideaId: string): Promise<IdeaInterestRow[]> {
  // No `idea_interest` table in the local store, so no offers are stored and this
  // list is empty. `expressInterestAction` refuses rather than pretending
  // otherwise; see the port notes in .scratch/projects-ideas-local.
  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('idea_interest')
    .select(
      `profile_id, message, offering, created_at,
       profile:profiles!idea_interest_profile_id_fkey ( id, username, display_name, avatar_url, headline )`,
    )
    .eq('idea_id', ideaId)
    .order('created_at')
    .returns<IdeaInterestRow[]>()

  if (error) {
    console.error('[ideas:listIdeaInterests]', error.code, error.message)
    return []
  }
  return data ?? []
}

export type IdeaViewerState = {
  userId: string | null
  isAuthor: boolean
  hasVoted: boolean
  hasExpressedInterest: boolean
  /** Only the author (or an admin) may convert, and only an un-converted idea. */
  canConvert: boolean
  /** The reader's own interest row, so the form can be shown as already answered. */
  ownInterest: { message: string | null; offering: string | null } | null
}

/**
 * What the reader may do on this idea.
 *
 * Same contract as the project version: these flags decide which controls render, and
 * every write is checked again by a policy or a trigger. A stale flag produces a
 * refusal, never a privilege.
 */
export async function getIdeaViewerState(idea: IdeaDetail): Promise<IdeaViewerState> {
  const user = await getUser()
  if (!user) {
    return {
      userId: null,
      isAuthor: false,
      hasVoted: false,
      hasExpressedInterest: false,
      canConvert: false,
      ownInterest: null,
    }
  }

  if (isLocalMode()) {
    const db = await readStore()
    const viewer = db.profiles.find((profile) => profile.user_id === user.id) ?? null
    const isAuthor = Boolean(viewer && idea.author?.id === viewer.id)

    return {
      userId: user.id,
      isAuthor,
      // No idea_votes table in the local store: no vote exists to read.
      hasVoted: false,
      // No idea_interest table: nobody has an offer on file.
      hasExpressedInterest: false,
      canConvert: isAuthor && idea.status !== 'converted' && idea.status !== 'closed',
      ownInterest: null,
    }
  }

  const supabase = await createClient()

  const [vote, interest] = await Promise.all([
    supabase
      .from('idea_votes')
      .select('idea_id')
      .eq('idea_id', idea.id)
      .eq('profile_id', user.id)
      .maybeSingle<{ idea_id: string }>(),
    supabase
      .from('idea_interest')
      .select('message, offering')
      .eq('idea_id', idea.id)
      .eq('profile_id', user.id)
      .maybeSingle<{ message: string | null; offering: string | null }>(),
  ])

  const isAuthor = idea.author?.id === user.id

  return {
    userId: user.id,
    isAuthor,
    hasVoted: Boolean(vote.data),
    hasExpressedInterest: Boolean(interest.data),
    canConvert: isAuthor && idea.status !== 'converted' && idea.status !== 'closed',
    ownInterest: interest.data ?? null,
  }
}

/** An idea the signed-in author has, for "your ideas" links on a profile. */
export async function listMyIdeas(): Promise<IdeaListItem[]> {
  const user = await getUser()
  if (!user) return []

  const db = isLocalMode() ? await readStore() : null
  if (db) {
    const viewer = db.profiles.find((profile) => profile.user_id === user.id) ?? null
    if (!viewer) return []
    return db.ideas
      .filter((idea) => idea.author_id === viewer.id && idea.deleted_at === null)
      .sort(newestFirst)
      .map((idea) => ideaItem(db, idea))
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ideas')
    .select(IDEA_SELECT)
    .eq('author_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .returns<IdeaListItem[]>()

  if (error) {
    console.error('[ideas:listMyIdeas]', error.code, error.message)
    return []
  }
  return data ?? []
}

/**
 * The slug of the project an idea became.
 *
 * Read straight from `projects` because the link an idea needs is a slug, and the
 * `projects_select` policy means an idea the reader can see is an idea whose project
 * they can also see. A missing row (a deleted project) returns null rather than
 * throwing, and the caller falls back to wording that does not promise a link.
 */
export async function getConvertedProjectSlug(projectId: string): Promise<string | null> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const project = db.projects.find((entry) => entry.id === projectId)
    // `projects_select` again, literally: a project the reader may not see has no
    // slug to hand out.
    if (!project || !canSeeProject(db, project, viewer)) return null
    return project.slug
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select('slug')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle<{ slug: string }>()

  if (error) {
    console.error('[ideas:getConvertedProjectSlug]', error.code, error.message)
    return null
  }
  return data?.slug ?? null
}

// =============================================================================
// Local mode
//
// `ideas_select`, reproduced literally:
//
//     deleted_at is null
//     and moderation_status = 'active'
//     and (
//       visibility = 'public'
//       or (visibility = 'university' and the author's university is the reader's)
//       or (visibility = 'connections' and app.are_connected(reader, author))
//     )
//     or author_id = auth.uid()
//
// The last clause is the reason a private (or hidden) idea stays in its author's
// own list: the author branch of the policy is checked first and admits the row
// regardless of visibility. That is reproduced here as `idea.author_id === viewer.id`
// before the switch, and the card flags a non-active moderation state rather than
// the list dropping the row.
//
// `connections` collapses to "author only": the local store has no connections
// table, so nobody is connected to anybody.
// =============================================================================

async function localContext(): Promise<{ db: Tables; viewer: LocalProfile | null }> {
  const user = await getUser()
  const db = await readStore()
  const viewer = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  return { db, viewer }
}

function canSeeIdea(db: Tables, idea: LocalIdea, viewer: LocalProfile | null): boolean {
  if (idea.deleted_at) return false
  if (viewer && idea.author_id === viewer.id) return true

  switch (idea.visibility) {
    case 'public':
      return true
    case 'university': {
      const author = db.profiles.find((profile) => profile.id === idea.author_id)
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

/** Newest first, `(created_at, id)` descending. */
function newestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
}

/**
 * A cursor from the local store. `decodeCursor` requires a uuid id and local ids
 * are not uuids, so it would throw every local cursor away and pin the reader to
 * page one. The timestamp half of the check is kept.
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

function afterCursor(row: { created_at: string; id: string }, cursor: Cursor | null): boolean {
  if (!cursor) return true
  if (row.created_at < cursor.createdAt) return true
  return row.created_at === cursor.createdAt && row.id < cursor.id
}

function ideaItem(db: Tables, idea: LocalIdea): IdeaListItem {
  const author = db.profiles.find((profile) => profile.id === idea.author_id)

  return {
    id: idea.id,
    title: idea.title,
    description: idea.description,
    category: idea.category,
    status: idea.status,
    // No `looking_for` column on the local idea row.
    looking_for: null,
    visibility: idea.visibility,
    // No moderation queue in the local store, so every row is active. The field
    // is kept because every component reads it: `!== 'active'` is what renders
    // the "Hidden from other people" badge.
    moderation_status: 'active',
    // No idea_votes table: the stored number is the only record, and there is no
    // trigger here to disagree with it. Same for interest_count below.
    upvote_count: idea.upvote_count,
    // Ideas have no comments in the local store (there is no idea comment table).
    comment_count: 0,
    interest_count: idea.interest_count,
    converted_project_id: idea.converted_project_id,
    // No `converted_at` column on the local idea row.
    converted_at: null,
    created_at: idea.created_at,
    // Nor an `updated_at`; the store records only when the idea was written.
    updated_at: idea.created_at,
    author: author
      ? {
          id: author.id,
          username: author.username,
          display_name: author.display_name,
          avatar_url: author.avatar_url,
          headline: null,
        }
      : null,
  }
}

async function listIdeasLocal({
  limit = 20,
  cursor,
}: { limit?: number; cursor?: string | string[] } = {}): Promise<IdeasPage> {
  const { db, viewer } = await localContext()
  const decoded = decodeLocalCursor(cursor)

  const rows = db.ideas
    .filter((idea) => canSeeIdea(db, idea, viewer))
    .sort(newestFirst)
    .filter((idea) => afterCursor(idea, decoded))
    .slice(0, limit)

  const last = rows.at(-1)
  return {
    ideas: rows.map((idea) => ideaItem(db, idea)),
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

async function getIdeaByIdLocal(id: string): Promise<IdeaDetail | null> {
  const { db, viewer } = await localContext()
  const idea = db.ideas.find((entry) => entry.id === id)
  if (!idea || !canSeeIdea(db, idea, viewer)) return null
  return ideaItem(db, idea)
}

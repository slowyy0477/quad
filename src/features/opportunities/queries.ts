import 'server-only'

import { decodeCursor, encodeCursor, type Cursor } from '@/lib/cursor'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import {
  readStore,
  type LocalOpportunity,
  type LocalProfile,
  type Tables,
} from '@/lib/local/db'
import { addDays, opportunityIsClosed, todayInPakistan } from '@/features/opportunities/board'
import { deadlineWindowDays } from '@/features/opportunities/constants'
import {
  UNDATED_SENTINEL,
  afterDeadlineFilter,
  boardNextCursor,
  canonicalDate,
  closedLensFilter,
  decodeBoardCursor,
  encodeBoardCursor,
  type BoardCursor,
} from '@/features/opportunities/paging'

/**
 * Opportunity reads.
 *
 * As in every other `queries.ts` here, there is no visibility filter: RLS decides who
 * may see a listing, inside Postgres, and a second copy of that rule in TypeScript is a
 * copy an attacker talking to PostgREST directly would not face.
 *
 * `deleted_at` and `moderation_status` *are* filtered, because they are not
 * access-control questions -- the policies deliberately leave a hidden listing readable
 * so a moderator can review it, and a discovery board is not the moderation queue.
 *
 * The board's own ordering is a product decision, not a permission: the open lens is
 * sorted by closing date because a dated listing is more urgent than an undated one, and
 * the closed lens is sorted by when it was posted because nothing about a closed listing
 * is urgent.
 */

export type OpportunityUniversity = { id: string; name: string; short_name: string | null }

export type OpportunityListRow = {
  id: string
  slug: string
  title: string
  organisation: string
  type: string
  work_mode: string
  location: string | null
  compensation: string | null
  deadline: string | null
  status: string
  visibility: string
  save_count: number
  created_at: string
  university: OpportunityUniversity | null
}

/** A list row plus the reader's own stored bookmark, which is the only per-reader state here. */
export type OpportunityBoardRow = OpportunityListRow & { saved: boolean }

const LIST_SELECT = `
  id, slug, title, organisation, type, work_mode, location, compensation,
  deadline, status, visibility, save_count, created_at,
  university:universities!opportunities_university_id_fkey ( id, name, short_name )
`

export type OpportunitySkillRow = {
  skill_id: string
  is_required: boolean
  skill: { id: string; name: string; slug: string } | null
}

export type OpportunityDetail = OpportunityListRow & {
  description: string
  apply_url: string | null
  apply_email: string | null
  starts_on: string | null
  posted_by: string
  source: string
  updated_at: string
  poster: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
  opportunity_skills: OpportunitySkillRow[]
}

const DETAIL_SELECT = `
  ${LIST_SELECT},
  description, apply_url, apply_email, starts_on, posted_by, source, updated_at,
  poster:profiles!opportunities_posted_by_fkey ( id, username, display_name, avatar_url, headline ),
  opportunity_skills ( skill_id, is_required, skill:skills!opportunity_skills_skill_id_fkey ( id, name, slug ) )
`

export type BoardFilter = {
  type?: string
  workMode?: string
  /** The `?window=` value: 7, 30 or 90 days. Ignored when it is not one of those. */
  window?: string
}

export type OpportunityPage = {
  opportunities: OpportunityBoardRow[]
  /** Already encoded, because the two lenses page on different columns. */
  nextCursor: string | null
  error: string | null
}

const EMPTY: OpportunityPage = { opportunities: [], nextCursor: null, error: null }

/**
 * Every id on this page the reader has saved.
 *
 * One query for the whole page rather than one per row: the N+1 that ENGINEERING.md
 * calls a bug. `opportunity_saves` is readable only by its owner under the policy, so
 * this cannot see anyone else's bookmarks even if the ids were guessed.
 */
async function savedIdsFor(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()

  const user = await getUser()
  if (!user) return new Set()

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('opportunity_saves')
    .select('opportunity_id')
    .eq('profile_id', user.id)
    .in('opportunity_id', ids)
    .returns<{ opportunity_id: string }[]>()

  if (error) {
    // A failed bookmark lookup must not turn the board into an error page: the rows are
    // the content, and the button simply renders in its unsaved state.
    console.error('[opportunities:savedIdsFor]', error.code, error.message)
    return new Set()
  }
  return new Set((data ?? []).map((row) => row.opportunity_id))
}

async function withSaved(rows: OpportunityListRow[]): Promise<OpportunityBoardRow[]> {
  const saved = await savedIdsFor(rows.map((row) => row.id))
  return rows.map((row) => ({ ...row, saved: saved.has(row.id) }))
}

// =============================================================================
// Local mode
//
// The store is one JSON file, so the board is an array sort instead of two
// PostgREST requests. Two things the Supabase path does are deliberately NOT
// reproduced, and the reason is worth stating rather than leaving in the diff:
//
//   * the dated/undated two-phase read. That split exists only because PostgREST
//     cannot say "`deadline` is null sorts last" in the same `or` expression as
//     the cursor, so it fetches the dated bucket, then the undated one once the
//     first runs short. A comparator says "nulls last" in one line, so this is a
//     single sort and one slice -- the workaround's cause does not exist here.
//     The cursor is unchanged: still `(deadline, id)`, still encoded by
//     `encodeBoardCursor`, so a board URL written against Postgres still works.
//   * the absence of a visibility filter. In Postgres `opportunities_select`
//     decides who may see a listing; LOCAL-MODE.md step 4 says reproduce the
//     policy literally, so `canViewOpportunity` below is that policy written out.
// =============================================================================

/** `app.slugify`: lowercase, ASCII, any run of other characters becomes one hyphen. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * `app.unique_slug`: the base, truncated to 60, with `-2`, `-3`, … until free.
 *
 * The store has no `slug` column on `opportunities`, so the slug a Supabase row
 * carries in a column is derived here from the title -- which is exactly the
 * input the trigger uses. Derivation has to be deterministic or a listing's URL
 * would change between two requests, so the suffix is computed against every row
 * that exists, in the order the trigger would have run for them: oldest first.
 * A row added later therefore cannot rename an older one.
 */
function uniqueAgainst(used: Set<string>, title: string): string {
  const base = (slugify(title) || 'item').slice(0, 60)
  if (!used.has(base)) return base

  let counter = 2
  let candidate = `${base.slice(0, 55)}-${counter}`
  while (used.has(candidate)) {
    counter += 1
    candidate = `${base.slice(0, 55)}-${counter}`
  }
  return candidate
}

/** Every listing's derived slug, keyed by id. */
function localSlugs(rows: LocalOpportunity[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()

  // `created_at` is an ISO instant, so lexicographic order is chronological; the
  // id breaks a tie inside the same millisecond, which is all the trigger's
  // insertion order can be reconstructed from.
  const ordered = [...rows].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )

  for (const row of ordered) {
    const slug = uniqueAgainst(used, row.title)
    used.add(slug)
    out.set(row.id, slug)
  }
  return out
}

/**
 * The slug this row is served under.
 *
 * Asked of the same derivation the reads use, so a create cannot redirect to a
 * URL the detail page does not answer: the write's slug is not computed by a
 * second rule, it is looked up after the push.
 */
export function localOpportunitySlug(db: Tables, opportunityId: string): string {
  return localSlugs(db.opportunities).get(opportunityId) ?? opportunityId
}

/**
 * `app.can_view_opportunity` / `opportunities_select`, in TypeScript:
 *
 *   posted_by = auth.uid()
 *   or (deleted_at is null and moderation_status = 'active'
 *       and (visibility = 'public'
 *            or (visibility = 'university' and university_id is not null
 *                and the viewer is at that university)))
 *
 * `moderation_status` has no local column, and every stored listing is the
 * active one, so there is nothing to check for it. `university_id` was
 * denormalised from the poster's profile by `opportunities_before_write`, so the
 * poster's current profile is the same value the column would hold.
 */
export function canViewOpportunity(
  db: Tables,
  opportunity: LocalOpportunity,
  viewer: LocalProfile | null,
): boolean {
  if (viewer && opportunity.posted_by === viewer.id) return true
  if (opportunity.deleted_at !== null) return false
  if (opportunity.visibility === 'public') return true
  if (opportunity.visibility !== 'university') return false

  const poster = db.profiles.find((profile) => profile.id === opportunity.posted_by)
  return Boolean(
    viewer?.university_id && poster?.university_id && viewer.university_id === poster.university_id,
  )
}

/** The reader's profile and the store, resolved once per request. */
async function localContext(): Promise<{ db: Tables; viewer: LocalProfile | null }> {
  const db = await readStore()
  const user = await getUser()
  const viewer = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  return { db, viewer }
}

/**
 * A cursor from the local store.
 *
 * `decodeCursor` insists the id half is a uuid, and local ids (`opp_…`) are not,
 * so it would reject every cursor this page issues and pin the reader to the
 * first page for ever. The encoding is unchanged; only the uuid check is
 * dropped, and only for the store, whose ids are opaque strings.
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

/** The board cursor, decoded the same way, with the undated sentinel mapped back to null. */
function decodeLocalBoardCursor(raw: string | string[] | undefined): BoardCursor | null {
  const decoded = decodeLocalCursor(raw)
  if (!decoded) return null
  if (decoded.createdAt === UNDATED_SENTINEL) return { deadline: null, id: decoded.id }

  const deadline = canonicalDate(decoded.createdAt)
  return deadline ? { deadline, id: decoded.id } : null
}

/** The open lens' order: deadline ascending, undated last, id as the tiebreak. */
function openOrder(a: { deadline: string | null; id: string }, b: { deadline: string | null; id: string }) {
  if (a.deadline !== b.deadline) {
    if (a.deadline === null) return 1
    if (b.deadline === null) return -1
    return a.deadline < b.deadline ? -1 : 1
  }
  return a.id.localeCompare(b.id)
}

/** Newest posted first: `(created_at, id)` descending, the index the migration builds. */
function newestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
}

/** `(created_at, id) < cursor`, the keyset predicate the PostgREST `or` encodes. */
function afterCreatedCursor(row: { created_at: string; id: string }, cursor: Cursor | null): boolean {
  if (!cursor) return true
  if (row.created_at < cursor.createdAt) return true
  return row.created_at === cursor.createdAt && row.id < cursor.id
}

/**
 * Who saved what, out of the rows on this page.
 *
 * `opportunity_saves` in the local store reuses the `LocalSave` row type, whose
 * second column is called `post_id`; there is no `opportunity_id` column to read.
 * The value stored there is the listing's id (see the write in `actions.ts`), so
 * that is what is matched. It is a naming fault in `db.ts`, not a second table.
 */
function savedIdsIn(db: Tables, profileId: string, ids: string[]): Set<string> {
  const asked = new Set(ids)
  return new Set(
    db.opportunity_saves
      .filter((save) => save.profile_id === profileId && asked.has(save.post_id))
      .map((save) => save.post_id),
  )
}

/** The university a listing is filed under: the poster's, as the trigger would denormalise. */
function universityOf(db: Tables, opportunity: LocalOpportunity): OpportunityUniversity | null {
  const poster = db.profiles.find((profile) => profile.id === opportunity.posted_by)
  const university = poster?.university_id
    ? db.universities.find((entry) => entry.id === poster.university_id)
    : undefined
  if (!university) return null
  return { id: university.id, name: university.name, short_name: university.short_name }
}

function localListRow(db: Tables, row: LocalOpportunity, slug: string): OpportunityListRow {
  return {
    id: row.id,
    slug,
    title: row.title,
    organisation: row.organisation,
    type: row.type,
    work_mode: row.work_mode,
    location: row.location,
    compensation: row.compensation,
    deadline: row.deadline,
    status: row.status,
    visibility: row.visibility,
    // Derived from the save rows, never the stored counter: there is no trigger
    // in the store to keep `save_count` in step with the bookmarks.
    save_count: db.opportunity_saves.filter((save) => save.post_id === row.id).length,
    created_at: row.created_at,
    university: universityOf(db, row),
  }
}

function localPoster(db: Tables, profileId: string): OpportunityDetail['poster'] {
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

function localDetailRow(db: Tables, row: LocalOpportunity, slug: string): OpportunityDetail {
  return {
    ...localListRow(db, row, slug),
    description: row.description,
    apply_url: row.apply_url,
    apply_email: row.apply_email,
    starts_on: row.starts_on,
    posted_by: row.posted_by,
    // The local row has no `source` column, and the CHECK permits exactly one
    // value, which makes it the one a local row can honestly claim.
    source: 'user_submitted',
    // No `updated_at` column: created_at is the only instant the store records.
    updated_at: row.created_at,
    poster: localPoster(db, row.posted_by),
    // No `skills` or `opportunity_skills` table in the store, so no listing here
    // asks for a skill. The detail page says so in its own words.
    opportunity_skills: [],
  }
}

/**
 * The open lens: still open, and not past its deadline.
 *
 * Read in two buckets, because `deadline` is nullable and the board sorts "no closing
 * date" last:
 *
 *   1. dated rows, `deadline >= today`, ascending;
 *   2. undated rows, by id, only once bucket 1 is exhausted.
 *
 * Bucket 2 is fetched only when bucket 1 returned fewer rows than the page size, which
 * is exactly the page where the dated rows run out -- so the undated ones are reached
 * without a second round trip on every page, and without an `or` that would have to
 * express "deadline > x or deadline is null" on each request.
 */
export async function listOpenOpportunities({
  type,
  workMode,
  window,
  cursor,
  now,
  limit = 20,
}: BoardFilter & {
  cursor?: string | string[]
  now: Date
  limit?: number
}): Promise<OpportunityPage> {
  const today = todayInPakistan(now)
  const days = deadlineWindowDays(window)

  if (isLocalMode()) {
    // One sort, one slice. See the note above the local helpers for why the
    // dated/undated split is not reproduced.
    const { db, viewer } = await localContext()
    const start = decodeLocalBoardCursor(cursor)
    const slugs = localSlugs(db.opportunities)
    const latest = days == null ? null : addDays(today, days)

    const rows = db.opportunities
      // `status = 'open'` and `deleted_at is null`, plus the deadline still ahead.
      // An undated listing is still open, which is why it is not dropped here.
      .filter((row) => row.status === 'open' && row.deleted_at === null)
      .filter((row) => row.deadline === null || row.deadline >= today)
      .filter((row) => latest === null || row.deadline === null || row.deadline <= latest)
      .filter((row) => (type ? row.type === type : true))
      .filter((row) => (workMode ? row.work_mode === workMode : true))
      // `opportunities_select`, written out: a listing this reader may not see is
      // dropped before it reaches the shape, which is what the policy does.
      .filter((row) => canViewOpportunity(db, row, viewer))
      .sort(openOrder)
      // The cursor is a position in that same order, not an offset: a row written
      // between two requests cannot push a page boundary onto a duplicate.
      .filter((row) => (start ? openOrder(row, start) > 0 : true))
      .slice(0, limit)

    const saved = viewer ? savedIdsIn(db, viewer.id, rows.map((row) => row.id)) : new Set<string>()
    const next = boardNextCursor(rows, limit)

    return {
      opportunities: rows.map((row) => ({
        ...localListRow(db, row, slugs.get(row.id) ?? row.id),
        saved: saved.has(row.id),
      })),
      nextCursor: next ? encodeBoardCursor(next) : null,
      error: null,
    }
  }

  const decoded = decodeBoardCursor(cursor)

  const supabase = await createClient()

  const dated = (pageCursor: { deadline: string; id: string } | null, size: number) => {
    let query = supabase
      .from('opportunities')
      .select(LIST_SELECT)
      .eq('status', 'open')
      .not('deadline', 'is', null)
      .gte('deadline', today)
      .is('deleted_at', null)
      .eq('moderation_status', 'active')
      .order('deadline', { ascending: true })
      .order('id', { ascending: true })
      .limit(size)

    if (days != null) query = query.lte('deadline', addDays(today, days))
    if (type) query = query.eq('type', type)
    if (workMode) query = query.eq('work_mode', workMode)
    if (pageCursor) query = query.or(afterDeadlineFilter(pageCursor))

    return query.returns<OpportunityListRow[]>()
  }

  const undated = (afterId: string | null, size: number) => {
    let query = supabase
      .from('opportunities')
      .select(LIST_SELECT)
      .eq('status', 'open')
      .is('deadline', null)
      .is('deleted_at', null)
      .eq('moderation_status', 'active')
      .order('id', { ascending: true })
      .limit(size)

    if (type) query = query.eq('type', type)
    if (workMode) query = query.eq('work_mode', workMode)
    if (afterId) query = query.gt('id', afterId)

    return query.returns<OpportunityListRow[]>()
  }

  // A cursor with `deadline: null` means the previous page ended among undated rows, so
  // there is no reason to read the dated ones again.
  const inUndated = decoded?.deadline === null

  const first = inUndated
    ? { data: [] as OpportunityListRow[], error: null }
    : await dated(decoded?.deadline ? { deadline: decoded.deadline, id: decoded.id } : null, limit)

  if (first.error) {
    console.error('[opportunities:listOpen]', first.error.code, first.error.message)
    return { ...EMPTY, error: 'Opportunities could not be loaded. Please try again.' }
  }

  const datedRows = first.data ?? []
  let rows = datedRows

  if (inUndated || datedRows.length < limit) {
    const second = await undated(inUndated ? (decoded?.id ?? null) : null, limit - datedRows.length)
    if (second.error) {
      console.error('[opportunities:listOpen:undated]', second.error.code, second.error.message)
      return { ...EMPTY, error: 'Opportunities could not be loaded. Please try again.' }
    }
    rows = [...datedRows, ...(second.data ?? [])]
  }

  const next = boardNextCursor(rows, limit)

  return {
    opportunities: await withSaved(rows),
    nextCursor: next ? encodeBoardCursor(next) : null,
    error: null,
  }
}

/**
 * The closed lens: the poster closed or filled it, or the deadline went by.
 *
 * Both conditions are stored columns. A listing whose deadline passed still carries
 * `status = 'open'` -- nothing rewrites it -- so "closed" here is the honest reading of
 * the date, and the row says which of the two reasons applies.
 *
 * Ordered newest posted first: a closed listing has no urgency order, and ordering by a
 * deadline the row may not have would drop the undated ones from every page after the
 * first.
 */
export async function listClosedOpportunities({
  type,
  workMode,
  cursor,
  now,
  limit = 20,
}: BoardFilter & {
  cursor?: string | string[]
  now: Date
  limit?: number
}): Promise<OpportunityPage> {
  const today = todayInPakistan(now)

  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const start = decodeLocalCursor(cursor)
    const slugs = localSlugs(db.opportunities)

    // `closedLensFilter` states this as a four-term disjunction because PostgREST
    // takes one `or` per query; `opportunityIsClosed` asks the same two questions
    // of the row -- did the poster close or fill it, has the deadline gone.
    const rows = db.opportunities
      .filter((row) => row.deleted_at === null)
      .filter((row) => canViewOpportunity(db, row, viewer))
      .filter((row) => opportunityIsClosed(row, today))
      .filter((row) => (type ? row.type === type : true))
      .filter((row) => (workMode ? row.work_mode === workMode : true))
      .sort(newestFirst)
      .filter((row) => afterCreatedCursor(row, start))
      .slice(0, limit)

    const saved = viewer ? savedIdsIn(db, viewer.id, rows.map((row) => row.id)) : new Set<string>()
    const last = rows.at(-1)

    return {
      opportunities: rows.map((row) => ({
        ...localListRow(db, row, slugs.get(row.id) ?? row.id),
        saved: saved.has(row.id),
      })),
      nextCursor:
        rows.length === limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
      error: null,
    }
  }

  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  const supabase = await createClient()

  let query = supabase
    .from('opportunities')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (type) query = query.eq('type', type)
  if (workMode) query = query.eq('work_mode', workMode)

  query = query.or(
    closedLensFilter(today, decoded ? { createdAt: new Date(decoded.createdAt).toISOString(), id: decoded.id } : null),
  )

  const { data, error } = await query.returns<OpportunityListRow[]>()

  if (error) {
    console.error('[opportunities:listClosed]', error.code, error.message)
    return { ...EMPTY, error: 'Closed opportunities could not be loaded. Please try again.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)

  return {
    opportunities: await withSaved(rows),
    nextCursor: rows.length === limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    error: null,
  }
}

/** One listing by slug. `null` covers both "no such listing" and "not visible to you". */
export async function getOpportunityBySlug(slug: string): Promise<OpportunityDetail | null> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const derived = localSlugs(db.opportunities)

    // The slug is derived from the title (see `localSlugs`), so the lookup is a
    // scan of the derived map rather than a column match. Same answer for "no
    // such listing" and "not visible to you", which is what `maybeSingle` under
    // RLS returns: nothing.
    const row = db.opportunities.find(
      (entry) => entry.deleted_at === null && derived.get(entry.id) === slug,
    )
    if (!row || !canViewOpportunity(db, row, viewer)) return null

    return localDetailRow(db, row, derived.get(row.id) ?? row.id)
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('opportunities')
    .select(DETAIL_SELECT)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle<OpportunityDetail>()

  if (error) {
    console.error('[opportunities:getBySlug]', error.code, error.message)
    return null
  }
  return data
}

/**
 * Whether the reader has saved this listing, and the note they left themselves.
 *
 * A miss and "not signed in" are both `false`, which is what the button needs to render.
 * The insert is still authoritative: a stale `false` produces a duplicate-key error,
 * which the action treats as "already saved".
 */
export async function getOpportunitySave(
  opportunityId: string,
): Promise<{ saved: boolean; note: string | null }> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    if (!viewer) return { saved: false, note: null }

    // The bookmark row's key column is `post_id` in the store (the table reuses
    // `LocalSave`); the listing's id is what is written there. There is no `note`
    // column, so the note is always null rather than an invented string -- the
    // local row cannot hold one.
    const save = db.opportunity_saves.find(
      (row) => row.post_id === opportunityId && row.profile_id === viewer.id,
    )
    return { saved: Boolean(save), note: null }
  }

  const user = await getUser()
  if (!user) return { saved: false, note: null }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('opportunity_saves')
    .select('note')
    .eq('opportunity_id', opportunityId)
    .eq('profile_id', user.id)
    .maybeSingle<{ note: string | null }>()

  if (error) {
    console.error('[opportunities:getSave]', error.code, error.message)
    return { saved: false, note: null }
  }
  return { saved: Boolean(data), note: data?.note ?? null }
}

export type SkillOption = { id: string; name: string; slug: string; category: string }

/** The approved skills a form may offer. Unapproved ones are RLS-hidden. */
export async function listSkillOptions(limit = 200): Promise<SkillOption[]> {
  if (isLocalMode()) {
    // There is no `skills` table in the store, so the picker offers nothing. An
    // empty list is the truth; a list invented here would be ids nothing can join
    // to, and a listing could then claim skills that do not exist.
    return []
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('skills')
    .select('id, name, slug, category')
    .order('name')
    .limit(limit)
    .returns<SkillOption[]>()

  if (error) {
    console.error('[opportunities:listSkillOptions]', error.code, error.message)
    return []
  }
  return data ?? []
}

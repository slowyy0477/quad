import 'server-only'

import { decodeCursor, encodeCursor, type Cursor } from '@/lib/cursor'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import { readStore, type LocalEvent, type LocalProfile, type Tables } from '@/lib/local/db'
import { eventHasPassed } from '@/features/events/when'

/**
 * Event reads.
 *
 * No visibility filter, for the reason in features/feed/queries: RLS decides who may see
 * an event, inside Postgres. `deleted_at` and `moderation_status` are filtered because
 * they are not access-control questions, and cancelled events are filtered out of both
 * lists because a cancelled event is not something to turn up to -- its page still exists
 * for anyone holding the link, and says it was cancelled there.
 *
 * The counts on a row are `attendee_count` and `interested_count`: trigger-maintained
 * columns over `event_attendees`, recomputed rather than incremented, so they cannot drift
 * from the rows they describe.
 */

export type EventUniversity = { id: string; name: string; short_name: string | null }

export type EventListRow = {
  id: string
  slug: string
  title: string
  type: string
  starts_at: string
  ends_at: string | null
  time_zone: string
  is_all_day: boolean
  attendance_mode: string
  location: string | null
  join_url: string | null
  visibility: string
  capacity: number | null
  attendee_count: number
  interested_count: number
  status: string
  university: EventUniversity | null
}

/** A list row plus the reader's own RSVP, which is `null` when they have not answered. */
export type EventBoardRow = EventListRow & { myStatus: string | null }

const LIST_SELECT = `
  id, slug, title, type, starts_at, ends_at, time_zone, is_all_day, attendance_mode,
  location, join_url, visibility, capacity, attendee_count, interested_count, status,
  university:universities!events_university_id_fkey ( id, name, short_name )
`

export type EventHost = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  headline: string | null
}

export type EventDetail = EventListRow & {
  description: string | null
  location_url: string | null
  created_by: string
  project: { id: string; slug: string; title: string } | null
  host: EventHost | null
}

const DETAIL_SELECT = `
  ${LIST_SELECT},
  description, location_url, created_by,
  project:projects!events_project_id_fkey ( id, slug, title ),
  host:profiles!events_created_by_fkey ( id, username, display_name, avatar_url, headline )
`

export type EventAttendee = {
  profile_id: string
  status: string
  profile: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  } | null
}

export type EventPage = {
  events: EventBoardRow[]
  nextCursor: string | null
  error: string | null
}

const EMPTY: EventPage = { events: [], nextCursor: null, error: null }

/** The reader's own RSVPs for a page of events, in one query rather than one per row. */
async function myStatusFor(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()

  const user = await getUser()
  if (!user) return new Map()

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('event_attendees')
    .select('event_id, status')
    .eq('profile_id', user.id)
    .in('event_id', ids)
    .returns<{ event_id: string; status: string }[]>()

  if (error) {
    // The rows are the content; a failed RSVP lookup must not turn the calendar into an
    // error page. The buttons simply render in their unanswered state.
    console.error('[events:myStatusFor]', error.code, error.message)
    return new Map()
  }
  return new Map((data ?? []).map((row) => [row.event_id, row.status]))
}

async function withStatus(rows: EventListRow[]): Promise<EventBoardRow[]> {
  const statuses = await myStatusFor(rows.map((row) => row.id))
  return rows.map((row) => ({ ...row, myStatus: statuses.get(row.id) ?? null }))
}

// =============================================================================
// Local mode
//
// The store's `events` rows are narrower than the Postgres table: they carry
// `timezone` instead of `time_zone`, no `slug`, no `type`, no `is_all_day`, no
// `attendance_mode`, no `join_url`, no `location_url`, no `project_id` and no
// counters. What has a faithful local answer is derived; what has none is stated
// as a constant at the point it is returned, never stored:
//
//   slug            derived from the title, the same way `app.unique_slug` does
//   time_zone       the local `timezone` column, same IANA zone
//   type            `other` -- nothing in the row says what kind of event it is
//   is_all_day      `false` -- the store has no such column, so no event claims it
//   attendance_mode inferred from whether a venue was given, which is the only
//                   evidence the row carries; a "hybrid" event reads as on site
//   join_url        `null` -- an online event's link is not stored locally
//   counts          derived from `event_attendees`, exactly as the trigger would
//   university      the creator's, which is what `events_before_write` denormalises
//
// Visibility is not optional: `events_select` is reproduced in TypeScript by
// `canViewEvent` below, with the policy quoted above it.
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

/** `app.unique_slug`: the base, truncated to 60, with `-2`, `-3`, … until free. */
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

/**
 * Every event's derived slug, keyed by id.
 *
 * Assigned oldest first so that adding an event cannot rename an existing one:
 * the suffix a row receives depends only on the rows that came before it, which
 * is the order the insert trigger would have run in.
 */
function localSlugs(rows: LocalEvent[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()

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

/** The slug this event is served under, from the same derivation the reads use. */
export function localEventSlug(db: Tables, eventId: string): string {
  return localSlugs(db.events).get(eventId) ?? eventId
}

/**
 * `app.can_view_event` / `events_select`, in TypeScript:
 *
 *   created_by = auth.uid()
 *   or (deleted_at is null and moderation_status = 'active'
 *       and (project membership
 *            or visibility = 'public'
 *            or (visibility = 'university' and university_id is not null
 *                and the viewer is at that university)
 *            or (visibility = 'connections' and the two are connected)))
 *
 * There is no project on a local event and no `connections` table in the store,
 * so those two clauses can only ever admit the creator -- who is admitted by the
 * first clause anyway. `moderation_status` has no local column and every stored
 * event is the active one. So what is left is public, and university for a reader
 * at the creator's university, which is the value the trigger denormalised.
 */
export function canViewEvent(db: Tables, event: LocalEvent, viewer: LocalProfile | null): boolean {
  if (viewer && event.created_by === viewer.id) return true
  if (event.deleted_at !== null) return false
  if (event.visibility === 'public') return true
  if (event.visibility !== 'university') return false

  const creator = db.profiles.find((profile) => profile.id === event.created_by)
  return Boolean(
    viewer?.university_id && creator?.university_id && viewer.university_id === creator.university_id,
  )
}

async function localContext(): Promise<{ db: Tables; viewer: LocalProfile | null }> {
  const db = await readStore()
  const user = await getUser()
  const viewer = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  return { db, viewer }
}

/**
 * A cursor from the local store: same encoding, without the uuid check.
 *
 * `decodeCursor` insists the id is a uuid and local ids (`evt_…`) are not, so it
 * would reject every cursor this page issued and pin the reader to page one for
 * ever. The timestamp check is kept -- a mangled cursor still means "first page".
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

/** `starts_at` as milliseconds. An unparseable instant sorts first rather than as NaN. */
function startMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : ms
}

/** `(starts_at, id)` ascending for upcoming, descending for past. */
function startOrder(
  a: { starts_at: string; id: string },
  b: { starts_at: string; id: string },
  ascending: boolean,
): number {
  const at = startMs(a.starts_at)
  const bt = startMs(b.starts_at)
  if (at !== bt) return ascending ? at - bt : bt - at
  return ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
}

/** `(starts_at, id)` strictly after the cursor, in the direction the lens sorts. */
function afterStartCursor(
  row: { starts_at: string; id: string },
  cursor: Cursor | null,
  ascending: boolean,
): boolean {
  if (!cursor) return true

  const at = startMs(row.starts_at)
  const ct = startMs(cursor.createdAt)
  if (at !== ct) return ascending ? at > ct : at < ct
  return ascending ? row.id > cursor.id : row.id < cursor.id
}

/** Only `going` takes a place; `interested` is the quieter answer and takes none. */
function attendeeCounts(db: Tables, eventId: string): { going: number; interested: number } {
  const rows = db.event_attendees.filter((attendee) => attendee.event_id === eventId)
  return {
    going: rows.filter((attendee) => attendee.status === 'going').length,
    interested: rows.filter((attendee) => attendee.status === 'interested').length,
  }
}

/** The university an event is filed under: the creator's, as the trigger denormalises. */
function universityOf(db: Tables, event: LocalEvent): EventUniversity | null {
  const creator = db.profiles.find((profile) => profile.id === event.created_by)
  const university = creator?.university_id
    ? db.universities.find((entry) => entry.id === creator.university_id)
    : undefined
  if (!university) return null
  return { id: university.id, name: university.name, short_name: university.short_name }
}

function localMode(row: LocalEvent): string {
  // No `attendance_mode` column: the only evidence in the row is whether a venue
  // was written down. Stated here so every reader of the shape sees the inference
  // in one place rather than in each caller.
  return row.location ? 'onsite' : 'online'
}

function localListRow(db: Tables, row: LocalEvent, slug: string): EventListRow {
  const counts = attendeeCounts(db, row.id)
  return {
    id: row.id,
    slug,
    title: row.title,
    // No `type` column, and nothing in the row that implies one.
    type: 'other',
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    time_zone: row.timezone,
    // No `is_all_day` column: an all-day event cannot be stored here, and
    // claiming it for every event would be a bigger lie than a stated time.
    is_all_day: false,
    attendance_mode: localMode(row),
    location: row.location,
    // No `join_url` column: an online event's link is not kept locally.
    join_url: null,
    visibility: row.visibility,
    capacity: row.capacity,
    // Derived from the attendee rows, never the stored counter: the store has no
    // trigger keeping `attendee_count` in step.
    attendee_count: counts.going,
    interested_count: counts.interested,
    status: row.status,
    university: universityOf(db, row),
  }
}

function localHost(db: Tables, profileId: string): EventDetail['host'] {
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

function localDetailRow(db: Tables, row: LocalEvent, slug: string): EventDetail {
  return {
    ...localListRow(db, row, slug),
    description: row.description,
    // No `location_url` column.
    location_url: null,
    created_by: row.created_by,
    // No `project_id` column: no local event belongs to a project.
    project: null,
    host: localHost(db, row.created_by),
  }
}

/**
 * Upcoming or past.
 *
 * Split on `starts_at` against one clock, and both halves page on `(starts_at, id)` --
 * `starts_at` is an instant and two events can start in the same second, so the id is the
 * tiebreak that stops a page boundary from repeating one of them.
 */
export async function listEvents({
  lens,
  type,
  mode,
  cursor,
  now,
  limit = 20,
}: {
  lens: 'upcoming' | 'past'
  type?: string
  mode?: string
  cursor?: string | string[]
  now: Date
  limit?: number
}): Promise<EventPage> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const start = decodeLocalCursor(cursor)
    const slugs = localSlugs(db.events)
    const upcoming = lens === 'upcoming'

    const rows = db.events
      // `deleted_at is null`, `status <> 'cancelled'`: a cancelled event is not
      // something to turn up to, and its page still exists for a shared link.
      .filter((row) => row.deleted_at === null && row.status !== 'cancelled')
      .filter((row) => canViewEvent(db, row, viewer))
      // Instants, not strings: `starts_at` is an ISO instant and the split is the
      // same comparison the page and `eventHasPassed` make.
      .filter((row) =>
        upcoming ? !eventHasPassed(row.starts_at, now) : eventHasPassed(row.starts_at, now),
      )
      // `type` has no local column, so every row reports `other`; a filter for a
      // kind the store cannot record matches nothing rather than everything.
      .filter(() => !type || type === 'other')
      .filter((row) => (mode ? localMode(row) === mode : true))
      .sort((a, b) => startOrder(a, b, upcoming))
      .filter((row) => afterStartCursor(row, start, upcoming))
      .slice(0, limit)

    const mine = viewer
      ? new Map(
          db.event_attendees
            .filter(
              (attendee) => attendee.profile_id === viewer.id && attendee.status !== 'cancelled',
            )
            .map((attendee) => [attendee.event_id, attendee.status]),
        )
      : new Map<string, string>()

    const last = rows.at(-1)

    return {
      events: rows.map((row) => ({
        ...localListRow(db, row, slugs.get(row.id) ?? row.id),
        // A withdrawn answer leaves no row, so a missing row is "not answered";
        // a `cancelled` row is treated the same way rather than as an answer.
        myStatus: mine.get(row.id) ?? null,
      })),
      nextCursor:
        rows.length === limit && last ? encodeCursor({ createdAt: last.starts_at, id: last.id }) : null,
      error: null,
    }
  }

  const supabase = await createClient()
  const nowIso = now.toISOString()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)
  const upcoming = lens === 'upcoming'

  let query = supabase
    .from('events')
    .select(LIST_SELECT)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .neq('status', 'cancelled')
    .order('starts_at', { ascending: upcoming })
    .order('id', { ascending: upcoming })
    .limit(limit)

  query = upcoming ? query.gte('starts_at', nowIso) : query.lt('starts_at', nowIso)

  if (type) query = query.eq('type', type)
  if (mode) query = query.eq('attendance_mode', mode)

  if (decoded) {
    // Canonicalised from the parsed instant, so nothing that came out of a URL can reach
    // the filter grammar as received.
    const at = new Date(decoded.createdAt).toISOString()
    query = query.or(
      upcoming
        ? `starts_at.gt.${at},and(starts_at.eq.${at},id.gt.${decoded.id})`
        : `starts_at.lt.${at},and(starts_at.eq.${at},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<EventListRow[]>()

  if (error) {
    console.error('[events:list]', error.code, error.message)
    return { ...EMPTY, error: 'Events could not be loaded. Please try again.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)

  return {
    events: await withStatus(rows),
    nextCursor:
      rows.length === limit && last ? encodeCursor({ createdAt: last.starts_at, id: last.id }) : null,
    error: null,
  }
}

/** One event by slug. Null covers both "no such event" and "not visible to you". */
export async function getEventBySlug(slug: string): Promise<EventDetail | null> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const derived = localSlugs(db.events)

    const row = db.events.find((entry) => entry.deleted_at === null && derived.get(entry.id) === slug)
    if (!row || !canViewEvent(db, row, viewer)) return null

    return localDetailRow(db, row, derived.get(row.id) ?? row.id)
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(DETAIL_SELECT)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle<EventDetail>()

  if (error) {
    console.error('[events:getBySlug]', error.code, error.message)
    return null
  }
  return data
}

/**
 * The reader's own RSVP for one event, or null.
 *
 * A miss and "not signed in" are both null. The write is authoritative: a stale null
 * produces a duplicate-key error on insert, which the action treats as a state change
 * rather than a failure.
 */
export async function getMyRsvp(eventId: string): Promise<string | null> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    if (!viewer) return null

    const rsvp = db.event_attendees.find(
      (row) => row.event_id === eventId && row.profile_id === viewer.id,
    )
    // A miss and "not signed in" are both null, which is what the control needs.
    // A `cancelled` row is not an answer either: the app's vocabulary has three
    // states -- nothing, going, interested -- and cancelling removes the row.
    if (!rsvp || rsvp.status === 'cancelled') return null
    return rsvp.status
  }

  const user = await getUser()
  if (!user) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('event_attendees')
    .select('status')
    .eq('event_id', eventId)
    .eq('profile_id', user.id)
    .maybeSingle<{ status: string }>()

  if (error) {
    console.error('[events:getMyRsvp]', error.code, error.message)
    return null
  }
  return data?.status ?? null
}

/**
 * Who is going.
 *
 * Readable by anyone who can see the event, under `event_attendees_select` -- an attendee
 * list is part of what a public event is. The migration is explicit that this is a real
 * tradeoff and that `interested` is the quieter option, which is why the detail page
 * offers it in the same breath as "going".
 */
export async function listEventAttendees(eventId: string, limit = 12): Promise<EventAttendee[]> {
  if (isLocalMode()) {
    const { db, viewer } = await localContext()
    const event = db.events.find((entry) => entry.id === eventId && entry.deleted_at === null)
    // `event_attendees_select` reads through `app.can_view_event`: an attendee list
    // is part of what the event is, and is not readable for an event you cannot see.
    if (!event || !canViewEvent(db, event, viewer)) return []

    return db.event_attendees
      .filter((attendee) => attendee.event_id === eventId && attendee.status === 'going')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((attendee) => {
        const profile = db.profiles.find((entry) => entry.id === attendee.profile_id)
        return {
          profile_id: attendee.profile_id,
          status: attendee.status,
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

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('event_attendees')
    .select(
      `profile_id, status,
       profile:profiles!event_attendees_profile_id_fkey ( id, username, display_name, avatar_url )`,
    )
    .eq('event_id', eventId)
    .eq('status', 'going')
    .order('created_at')
    .limit(limit)
    .returns<EventAttendee[]>()

  if (error) {
    console.error('[events:listAttendees]', error.code, error.message)
    return []
  }
  return data ?? []
}

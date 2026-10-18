import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { readStore } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import {
  canViewLocalProfile,
  localViewer,
  toProfileSummary,
  type ProfileSummary,
} from '@/features/profiles/queries'

/**
 * Connection, follow and block reads.
 *
 * The most important property of this module is what is *not* in it: there is no
 * filter anywhere that removes a blocked person from a list. It does not need one.
 * `app.can_view_profile` refuses a profile when `app.is_blocked_either_way`
 * is true, so a block removes the other person from every list in the application
 * at once — this page, the directory, suggestions, search — because the row those
 * lists are built from is no longer readable. A TypeScript filter here would cover
 * this page and leave the next surface to be remembered separately.
 *
 * The same reasoning applies to `visibility`: a classmate with a
 * connection-only profile does not appear in the university suggestions because
 * the policy says so, not because a query asked it nicely.
 *
 * One thing this module genuinely cannot know: whether someone has blocked *you*.
 * `blocks_select_own` shows a blocker their own rows and nobody else's — being
 * blocked is not disclosed. What a reader sees instead is the absence: the
 * person's profile stops resolving and the follow and connection rows between you
 * are deleted by `app.blocks_after_insert`. Nothing here pretends otherwise.
 *
 * LOCAL MODE — WHAT IS MISSING
 * ----------------------------
 * The local store has **no `connections`, `follows` or `blocks` table**. It is
 * not an omission in this file: `src/lib/local/db.ts`'s `Tables` type is the whole
 * store, and those three are not in it. Inventing them here would mean writing a
 * schema that the Supabase deployment would then have to match, from a feature
 * module, which is the wrong place for that decision.
 *
 * So the reads degrade to the truth:
 *
 *   getViewerConnection   `'none'` — nobody is connected to anybody, because
 *                         there is nowhere to record it. The control that would
 *                         send a request says so instead of pretending.
 *   listConnections,
 *   listRequests,
 *   listFollows,
 *   listBlocked           empty, with `error: null`. An empty list is accurate
 *                         here, and it lets the pages' real empty states render
 *                         rather than a failure alert.
 *   listUniversitySuggestions
 *                         real. It is a read over `profiles` and `universities`,
 *                         both of which exist, so the people at the reader's
 *                         institution are listed with `state: 'none'`.
 */

/** Where the reader stands with one person. */
export type ConnectionState =
  | 'none'
  /** The reader asked, and has not been answered. */
  | 'outgoing'
  /** The other person asked, and the reader has not answered. */
  | 'incoming'
  | 'connected'
  /**
   * A row exists and its status is `rejected`. It is kept rather than deleted, so
   * this is the state that lets the interface offer a fresh request instead of
   * failing on the unique constraint with an impossible sentence.
   */
  | 'rejected'

const PERSON = 'id, username, display_name, avatar_url, headline'

export type FollowItem = {
  /** The other person's id. Also the keyset tiebreak for the cursor. */
  id: string
  created_at: string
  person: ProfileSummary | null
}

export type ConnectionListItem = {
  id: string
  created_at: string
  person: ProfileSummary | null
}

export type RequestItem = ConnectionListItem & {
  message: string | null
  direction: 'incoming' | 'outgoing'
}

export type BlockedItem = {
  id: string
  created_at: string
  reason: string | null
  person: ProfileSummary | null
}

export type Suggestion = {
  person: ProfileSummary
  state: ConnectionState
  isFollowing: boolean
}

// -----------------------------------------------------------------------------
// The reader's standing with one person
// -----------------------------------------------------------------------------

export type ViewerConnection = {
  state: ConnectionState
  connectionId: string | null
  isFollowing: boolean
  /** True when the reader has blocked the other person. The reverse is unknowable. */
  isBlockingThem: boolean
}

/**
 * Everything a profile page needs to decide what to offer.
 *
 * Three reads in one round trip: the connection row between the two, the reader's
 * follow, and the reader's block. All three are rows the reader is a party to, so
 * RLS returns them and nothing else.
 *
 * Local mode answers `'none'` for everyone: there are no rows to read, and
 * `'none'` is what "no relationship recorded" means. It is not a placeholder for
 * a connection that exists.
 */
export async function getViewerConnection(profileId: string): Promise<ViewerConnection | null> {
  const user = await getUser()
  if (!user) return null

  if (isLocalMode()) {
    return { state: 'none', connectionId: null, isFollowing: false, isBlockingThem: false }
  }

  if (user.id === profileId) return { state: 'none', connectionId: null, isFollowing: false, isBlockingThem: false }

  const supabase = await createClient()

  const [connection, follow, block] = await Promise.all([
    supabase
      .from('connections')
      .select('id, status, requester_id, addressee_id')
      .or(
        `and(requester_id.eq.${user.id},addressee_id.eq.${profileId}),and(requester_id.eq.${profileId},addressee_id.eq.${user.id})`,
      )
      .maybeSingle<{
        id: string
        status: string
        requester_id: string
        addressee_id: string
      }>(),
    supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', user.id)
      .eq('following_id', profileId)
      .maybeSingle(),
    supabase
      .from('blocks')
      .select('blocked_id')
      .eq('blocked_id', profileId)
      .maybeSingle(),
  ])

  for (const [label, result] of [
    ['connection', connection],
    ['follow', follow],
    ['block', block],
  ] as const) {
    if (result.error) console.error(`[connections:getViewerConnection:${label}]`, result.error.code, result.error.message)
  }

  let state: ConnectionState = 'none'
  if (connection.data) {
    if (connection.data.status === 'accepted') state = 'connected'
    else if (connection.data.status === 'rejected') state = 'rejected'
    else if (connection.data.requester_id === user.id) state = 'outgoing'
    else state = 'incoming'
  }

  return {
    state,
    connectionId: connection.data?.id ?? null,
    isFollowing: Boolean(follow.data),
    isBlockingThem: Boolean(block.data),
  }
}

/**
 * The reader's standing with everyone they have a row with.
 *
 * Two reads that cover every person the reader could meet in a list: their
 * connection rows (pending and accepted — the only ones the policy shows them) and
 * their follow rows. Lists that show people without a per-person query use this to
 * render the control that actually applies, rather than a Connect button next to
 * someone already connected — which would be a button that cannot work.
 *
 * A `rejected` row is deliberately not carried as a state here. It is a fact about
 * one pair, useful on a profile page; in a list of followers it would only mean
 * "you may ask again", which is what `none` already offers.
 *
 * Local mode: both tables are absent, so both collections are empty, which is the
 * truth rather than a failed read.
 */
export async function listMyGraphState(): Promise<{
  connectionStates: Map<string, ConnectionState>
  following: Set<string>
}> {
  const user = await getUser()
  if (!user) return { connectionStates: new Map(), following: new Set() }

  if (isLocalMode()) return { connectionStates: new Map(), following: new Set() }

  const supabase = await createClient()

  const [connections, follows] = await Promise.all([
    supabase
      .from('connections')
      .select('requester_id, addressee_id, status')
      .returns<{ requester_id: string; addressee_id: string; status: string }[]>(),
    supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', user.id)
      .returns<{ following_id: string }[]>(),
  ])

  for (const [label, result] of [
    ['connections', connections],
    ['follows', follows],
  ] as const) {
    if (result.error) console.error(`[connections:listMyGraphState:${label}]`, result.error.code, result.error.message)
  }

  const connectionStates = new Map<string, ConnectionState>()
  for (const row of connections.data ?? []) {
    const other = row.requester_id === user.id ? row.addressee_id : row.requester_id
    if (row.status === 'accepted') connectionStates.set(other, 'connected')
    else if (row.status === 'pending') {
      connectionStates.set(other, row.requester_id === user.id ? 'outgoing' : 'incoming')
    }
  }

  return {
    connectionStates,
    following: new Set((follows.data ?? []).map((row) => row.following_id)),
  }
}

// -----------------------------------------------------------------------------
// Lists
// -----------------------------------------------------------------------------

/**
 * Accepted connections, newest first.
 *
 * This is read straight from the shared table rather than through two
 * per-direction queries, because a connection is one row for the pair. The
 * "who is the other person" decision is made in TypeScript from the two ids, and
 * the embedded profile is the one the policy allows.
 *
 * Local mode: no `connections` table, so this is empty and has no error. The page
 * renders its "you have not connected with anyone yet" state, which is accurate.
 */
export async function listConnections({
  before,
  limit = 25,
}: { before?: string; limit?: number } = {}): Promise<{
  items: ConnectionListItem[]
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { items: [], error: null }

  if (isLocalMode()) return { items: [], error: null }

  const supabase = await createClient()

  let query = supabase
    .from('connections')
    .select(
      `id, created_at, requester_id, addressee_id,
       requester:profiles!connections_requester_id_fkey ( ${PERSON} ),
       addressee:profiles!connections_addressee_id_fkey ( ${PERSON} )`,
    )
    .eq('status', 'accepted')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query.returns<
    {
      id: string
      created_at: string
      requester_id: string
      addressee_id: string
      requester: ProfileSummary | null
      addressee: ProfileSummary | null
    }[]
  >()

  if (error) {
    console.error('[connections:listConnections]', error.code, error.message)
    return { items: [], error: 'Your connections could not be loaded. Please try again.' }
  }

  return {
    items: (data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      person: row.requester_id === user.id ? row.addressee : row.requester,
    })),
    error: null,
  }
}

/**
 * Pending requests in both directions.
 *
 * `addressee_id = me` and `requester_id = me` are not access control — the policy
 * already limits this table to rows the reader is one of the two parties to. They
 * are what separates the two lists, which is a presentation question.
 *
 * Local mode: no `connections` table, so both lists are empty and the page's
 * "no requests" state is the truth.
 */
export async function listRequests({
  before,
  limit = 25,
}: { before?: string; limit?: number } = {}): Promise<{
  incoming: RequestItem[]
  outgoing: RequestItem[]
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { incoming: [], outgoing: [], error: null }

  if (isLocalMode()) return { incoming: [], outgoing: [], error: null }

  const supabase = await createClient()

  const build = (direction: 'incoming' | 'outgoing') => {
    let query = supabase
      .from('connections')
      .select(
        `id, created_at, message,
         requester:profiles!connections_requester_id_fkey ( ${PERSON} ),
         addressee:profiles!connections_addressee_id_fkey ( ${PERSON} )`,
      )
      .eq('status', 'pending')
      .eq(direction === 'incoming' ? 'addressee_id' : 'requester_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (before) query = query.lt('created_at', before)

    return query.returns<
      {
        id: string
        created_at: string
        message: string | null
        requester: ProfileSummary | null
        addressee: ProfileSummary | null
      }[]
    >()
  }

  const [incoming, outgoing] = await Promise.all([build('incoming'), build('outgoing')])

  for (const [label, result] of [
    ['incoming', incoming],
    ['outgoing', outgoing],
  ] as const) {
    if (result.error) console.error(`[connections:listRequests:${label}]`, result.error.code, result.error.message)
  }

  if (incoming.error || outgoing.error) {
    return { incoming: [], outgoing: [], error: 'Your requests could not be loaded. Please try again.' }
  }

  return {
    incoming: (incoming.data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      message: row.message,
      direction: 'incoming' as const,
      person: row.requester,
    })),
    outgoing: (outgoing.data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      message: row.message,
      direction: 'outgoing' as const,
      person: row.addressee,
    })),
    error: null,
  }
}

/**
 * Followers and the people the reader follows.
 *
 * `follows` is keyed on (follower_id, following_id) rather than on a surrogate id,
 * so the id the cursor carries is whichever half is *not* the reader. That is
 * still a uuid and still stable, which is all `lib/cursor` needs; it is passed
 * through explicitly rather than relying on a column name.
 *
 * Local mode: no `follows` table, so both directions are empty.
 */
export async function listFollows({
  direction,
  before,
  limit = 25,
}: {
  direction: 'followers' | 'following'
  before?: string
  limit?: number
}): Promise<{ items: FollowItem[]; error: string | null }> {
  const user = await getUser()
  if (!user) return { items: [], error: null }

  if (isLocalMode()) return { items: [], error: null }

  const supabase = await createClient()
  const mine = direction === 'followers' ? 'following_id' : 'follower_id'
  const theirs = direction === 'followers' ? 'follower_id' : 'following_id'

  // The person column is aliased rather than indexed dynamically: `person_id` is
  // then a known key on every row, so the mapping below needs no index signature
  // and the type checker can hold the shape of the result.
  let query = supabase
    .from('follows')
    .select(
      `person_id:${theirs}, created_at, person:profiles!follows_${theirs}_fkey ( ${PERSON} )`,
    )
    .eq(mine, user.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query.returns<
    { person_id: string; created_at: string; person: ProfileSummary | null }[]
  >()

  if (error) {
    console.error(`[connections:listFollows:${direction}]`, error.code, error.message)
    return { items: [], error: 'That list could not be loaded. Please try again.' }
  }

  return {
    items: (data ?? []).map((row) => ({
      id: row.person_id,
      created_at: row.created_at,
      person: row.person,
    })),
    error: null,
  }
}

/**
 * People the reader has blocked.
 *
 * Local mode: no `blocks` table, so the list is empty. That is not the same claim
 * as "nobody is blocked" — it is that this store has no way to record a block,
 * which is also why `blockAction` refuses.
 */
export async function listBlocked({
  before,
  limit = 25,
}: { before?: string; limit?: number } = {}): Promise<{
  items: BlockedItem[]
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { items: [], error: null }

  if (isLocalMode()) return { items: [], error: null }

  const supabase = await createClient()

  let query = supabase
    .from('blocks')
    .select(`blocked_id, created_at, reason, person:profiles!blocks_blocked_id_fkey ( ${PERSON} )`)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query.returns<
    { blocked_id: string; created_at: string; reason: string | null; person: ProfileSummary | null }[]
  >()

  if (error) {
    console.error('[connections:listBlocked]', error.code, error.message)
    return { items: [], error: 'Your blocked list could not be loaded. Please try again.' }
  }

  return {
    items: (data ?? []).map((row) => ({
      id: row.blocked_id,
      created_at: row.created_at,
      reason: row.reason,
      person: row.person,
    })),
    error: null,
  }
}

// -----------------------------------------------------------------------------
// People from your university
// -----------------------------------------------------------------------------

/**
 * The suggestion strip on `/connections`.
 *
 * Not a recommendation engine, and it does not pretend to be one: it is the
 * people at the reader's own institution, most recently active first, which is a
 * query over stored rows rather than a score anyone invented.
 *
 * Three limits are visible in the code and all three come from real columns.
 * `searchable` is the reader's own preference — settings promises that turning it
 * off stops people appearing in search and suggestions, so a query that ignored it
 * would make that promise false. `status = 'active'` excludes suspended accounts.
 * `deleted_at is null` excludes deleted ones. Visibility is not in the list
 * because RLS decides it.
 *
 * People the reader is already connected to, or has a pending request with, are
 * left out: the strip exists to offer a Connect control, and a roster of them
 * would be a list of buttons that cannot do anything.
 *
 * Local mode: this one is real, because `profiles` and `universities` both exist.
 * What changes is the shape of the data rather than the query:
 *
 *   - There is no `last_active_at`, so the order is account age (`created_at`),
 *     which is the only date the store keeps. The page's sentence about "stored
 *     last-active time" is then describing a column this store does not have; the
 *     order is still deterministic and still not a score.
 *   - There is no `status`, so no account is suspended and no `deleted_at`, so
 *     none is deleted. `searchable` and the visibility rule are applied instead,
 *     and the exclusion of existing connections is moot: with no `connections`
 *     table nobody is excluded, and `state` is `'none'` for everyone.
 */
export async function listUniversitySuggestions({ limit = 12 }: { limit?: number } = {}): Promise<{
  suggestions: Suggestion[]
  /** The reader's institution name, or null when they have not set one. */
  universityName: string | null
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { suggestions: [], universityName: null, error: null }

  if (isLocalMode()) {
    const db = await readStore()
    const me = db.profiles.find((profile) => profile.user_id === user.id)
    const universityId = me?.university_id ?? null
    if (!me || !universityId) return { suggestions: [], universityName: null, error: null }

    const universityName =
      db.universities.find((university) => university.id === universityId)?.name ?? null
    const viewer = localViewer(db, user.id)

    const suggestions = db.profiles
      .filter(
        (profile) =>
          profile.id !== me.id &&
          profile.university_id === universityId &&
          profile.searchable &&
          canViewLocalProfile(profile, viewer),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((profile) => ({
        person: toProfileSummary(profile),
        state: 'none' as ConnectionState,
        isFollowing: false,
      }))

    return { suggestions, universityName, error: null }
  }

  const supabase = await createClient()

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('university_id, university:universities!profiles_university_id_fkey ( name )')
    .eq('id', user.id)
    .maybeSingle<{ university_id: string | null; university: { name: string } | null }>()

  if (profileError) {
    console.error('[connections:listUniversitySuggestions:profile]', profileError.code, profileError.message)
    return { suggestions: [], universityName: null, error: 'Your university could not be read.' }
  }

  const universityId = profile?.university_id ?? null
  if (!universityId) {
    return { suggestions: [], universityName: null, error: null }
  }

  // Over-fetch: the exclusion below happens in TypeScript, because PostgREST
  // cannot express "not in this set of pair ids" over the connections table in
  // one request. Eight extra rows covers the usual overlap without a second round
  // trip.
  const [peers, connections, follows] = await Promise.all([
    supabase
      .from('profiles')
      .select(PERSON)
      .eq('university_id', universityId)
      .eq('status', 'active')
      .eq('searchable', true)
      .neq('id', user.id)
      .is('deleted_at', null)
      .order('last_active_at', { ascending: false })
      .limit(limit + 8)
      .returns<ProfileSummary[]>(),
    supabase
      .from('connections')
      .select('requester_id, addressee_id, status')
      .returns<{ requester_id: string; addressee_id: string; status: string }[]>(),
    supabase.from('follows').select('following_id').eq('follower_id', user.id).returns<{ following_id: string }[]>(),
  ])

  if (peers.error) {
    console.error('[connections:listUniversitySuggestions:peers]', peers.error.code, peers.error.message)
    return { suggestions: [], universityName: profile?.university?.name ?? null, error: 'Suggestions could not be loaded.' }
  }

  for (const [label, result] of [
    ['connections', connections],
    ['follows', follows],
  ] as const) {
    if (result.error) console.error(`[connections:listUniversitySuggestions:${label}]`, result.error.code, result.error.message)
  }

  // Only connection rows the reader is a party to are readable, so this map is
  // theirs alone. A rejected row is not a reason to hide someone: it is the state
  // that makes the Connect control able to try again.
  const taken = new Set<string>()
  for (const row of connections.data ?? []) {
    if (row.status === 'pending' || row.status === 'accepted') {
      taken.add(row.requester_id === user.id ? row.addressee_id : row.requester_id)
    }
  }

  const followed = new Set((follows.data ?? []).map((row) => row.following_id))

  const suggestions = (peers.data ?? [])
    .filter((person) => !taken.has(person.id))
    .slice(0, limit)
    .map((person) => ({
      person,
      state: 'none' as ConnectionState,
      isFollowing: followed.has(person.id),
    }))

  return { suggestions, universityName: profile?.university?.name ?? null, error: null }
}

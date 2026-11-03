/**
 * PROPOSAL ONLY, 2026-11-02. Not installed or verified.
 * Intended path after main's review: src/features/connections/graph-local.ts.
 *
 * In-memory read-only graph boundary; imports repository shapes as TYPES only.
 * No readStore/mutate, sessions, env, provider clients or application/UI imports.
 * Main supplies an authenticated snapshot-derived viewer in its server adapter.
 */
import type { LocalProfile, Tables } from '@/lib/local/db'
import type { ProfileSummary } from '@/features/profiles/queries'
import {
  compareGraphIds, decodeGraphCursor, encodeGraphCursor, graphLimit,
  GRAPH_DIRECTION_ERROR, GRAPH_MAX_LIMIT, isGraphDirection, normalizeGraphTime,
  validGraphId,
  type GraphCounts, type GraphCursor, type GraphCursorResult, type GraphDirection,
  type GraphItem,
} from './graph-paging'

type SnapshotKey = 'users' | 'profiles' | 'follows' | 'connections' | 'blocks' |
  'profile_account_states' | 'account_deletion_jobs'
/** A full Tables snapshot is compatible; unit fixtures need only these arrays. */
export type LocalGraphSnapshot = {
  readonly [K in SnapshotKey]: readonly Tables[K][number][]
}
export type LocalGraphPageOptions = {
  cursor?: GraphCursor | string | null
  limit?: number
}
export type LocalGraphPage = {
  items: GraphItem[]
  nextCursor: string | null
  total: number | null
  error: string | null
  unavailable: boolean
}
export type LocalScopedRelationship = {
  state: 'none' | 'incoming' | 'outgoing' | 'connected' | 'rejected'
  connectionId: string | null
  isFollowing: boolean
  isBlockingThem: boolean
}
export type LocalScopedRelationships = {
  relationships: Record<string, LocalScopedRelationship>
  error: string | null
  unavailable: boolean
}

type Connection = Tables['connections'][number]
type TimedConnection = { row: Connection; at: string }
type Context = ReturnType<typeof readContext>
const PEER_SCOPE_ERROR = 'Relationship state requires at most 50 valid page peer IDs.'
const RELATIONSHIP_ERROR = 'Some page relationship states could not be read.'

function uniqueIndex<T extends { id: string }>(rows: readonly T[]): Map<string, T | null> {
  const index = new Map<string, T | null>()
  for (const row of rows) {
    if (!validGraphId(row.id)) continue
    index.set(row.id, index.has(row.id) ? null : row)
  }
  return index
}

function projectionValid(profile: LocalProfile): boolean {
  return validGraphId(profile.id) && validGraphId(profile.user_id) &&
    typeof profile.username === 'string' && profile.username.trim().length > 0 &&
    typeof profile.display_name === 'string' && profile.display_name.trim().length > 0 &&
    (profile.avatar_url == null || typeof profile.avatar_url === 'string') &&
    (profile.headline == null || typeof profile.headline === 'string') &&
    ['public', 'university', 'connections', 'private'].includes(profile.visibility)
}

function summary(profile: LocalProfile): ProfileSummary {
  return {
    id: profile.id, username: profile.username, display_name: profile.display_name,
    avatar_url: profile.avatar_url ?? null, headline: profile.headline ?? null,
  }
}

function readContext(db: LocalGraphSnapshot, suppliedViewer: LocalProfile | null) {
  const at = normalizeGraphTime(new Date().toISOString())!
  const profiles = uniqueIndex(db.profiles)
  const users = uniqueIndex(db.users)
  const availableCache = new Map<string, boolean>()
  const pendingUsers = new Set<string>()
  const pendingProfiles = new Set<string>()
  for (const job of db.account_deletion_jobs) {
    if (job.state === 'completed') continue
    if (job.user_id !== null) pendingUsers.add(job.user_id)
    if (job.profile_id !== null) pendingProfiles.add(job.profile_id)
  }
  function available(profile: LocalProfile): boolean {
    const cached = availableCache.get(profile.id)
    if (cached !== undefined) return cached
    const account = users.get(profile.user_id)
    let value = profiles.get(profile.id) === profile && projectionValid(profile) &&
      Boolean(account) && account?.disabled_at == null &&
      !pendingUsers.has(profile.user_id) && !pendingProfiles.has(profile.id)
    for (const state of db.profile_account_states) {
      if (state.profile_id !== profile.id) continue
      if (state.status === 'active') continue // Missing sidecar is legacy active.
      const until = state.suspended_until && normalizeGraphTime(state.suspended_until)
      if (state.status !== 'suspended' || !until || until > at) value = false
    }
    availableCache.set(profile.id, value)
    return value
  }
  function resolve(supplied: LocalProfile | null): LocalProfile | null {
    if (!supplied) return null
    const stored = profiles.get(supplied.id)
    return stored && stored.user_id === supplied.user_id && available(stored) ? stored : null
  }
  function peer(id: string): LocalProfile | null {
    const stored = profiles.get(id)
    return stored && available(stored) ? stored : null
  }
  function blocked(a: string, b: string | null): boolean {
    // Block endpoints remain authoritative even if an old row's date/ID/note is
    // malformed; dropping that row must not silently re-enable private reads.
    return b !== null && db.blocks.some(row =>
      (row.blocker_id === a && row.blocked_id === b) ||
      (row.blocker_id === b && row.blocked_id === a))
  }
  const viewer = resolve(suppliedViewer)
  const invalidViewer = suppliedViewer !== null && viewer === null
  const ownedConnections: TimedConnection[] = []
  const ambiguous = new Set<string>()
  const signatures = new Map<string, string>()
  const badConnectionPeers = new Set<string>()
  const ownFollows = new Set<string>()
  const badFollowPeers = new Set<string>()

  if (viewer) {
    const relevant = db.connections.filter(row =>
      row.requester_id === viewer.id || row.addressee_id === viewer.id)
    // A real mutation handle must not collide with a row outside the viewer's
    // scope either. Ignore exact legacy copies, refuse conflicting identities.
    for (const row of db.connections) {
      const signature = JSON.stringify([
        row.requester_id, row.addressee_id, row.status, normalizeGraphTime(row.created_at),
      ])
      if (signatures.has(row.id) && signatures.get(row.id) !== signature) ambiguous.add(row.id)
      signatures.set(row.id, signature)
    }
    for (const row of relevant) {
      const other = row.requester_id === viewer.id ? row.addressee_id : row.requester_id
      const time = normalizeGraphTime(row.created_at)
      if (!validGraphId(row.id) || !validGraphId(other) || other === viewer.id ||
          !time || ambiguous.has(row.id) ||
          !['pending', 'accepted', 'rejected'].includes(row.status)) {
        if (typeof other === 'string' && other !== viewer.id) badConnectionPeers.add(other)
        continue
      }
      if (peer(other) && !blocked(viewer.id, other)) ownedConnections.push({ row, at: time })
    }
    for (const row of db.follows) {
      if (row.follower_id !== viewer.id) continue
      if (!validGraphId(row.id) || !validGraphId(row.following_id) ||
          !normalizeGraphTime(row.created_at) || row.following_id === viewer.id) {
        if (typeof row.following_id === 'string' && row.following_id !== viewer.id) {
          badFollowPeers.add(row.following_id)
        }
        continue
      }
      ownFollows.add(row.following_id)
    }
  }
  return {
    db, viewer, invalidViewer, resolve, peer, blocked, ownedConnections,
    ownFollows, badConnectionPeers, badFollowPeers,
  }
}

function readablePeer(ctx: Context, peer: LocalProfile): boolean {
  if (peer.visibility === 'private' || ctx.blocked(peer.id, ctx.viewer?.id ?? null)) return false
  if (peer.id === ctx.viewer?.id || peer.visibility === 'public') return true
  if (!ctx.viewer) return false
  if (peer.visibility === 'university') {
    return Boolean(ctx.viewer.university_id &&
      ctx.viewer.university_id === peer.university_id)
  }
  return peer.visibility === 'connections' && ctx.ownedConnections.some(({ row }) =>
    row.status === 'accepted' &&
    (row.requester_id === peer.id || row.addressee_id === peer.id))
}

function permittedSubject(ctx: Context, supplied: LocalProfile): LocalProfile | null {
  if (ctx.invalidViewer) return null // Never downgrade a stale actor to anon.
  const subject = ctx.resolve(supplied)
  if (!subject || ctx.blocked(subject.id, ctx.viewer?.id ?? null)) return null
  return subject.id === ctx.viewer?.id || subject.visibility === 'public' ? subject : null
}

/** Descending timestamp, then REAL connection ID or follow counterpart ID. */
function newestItem(a: GraphItem, b: GraphItem): number {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1
  return -compareGraphIds(a.connectionId ?? a.id, b.connectionId ?? b.id)
}

function collect(ctx: Context, subject: LocalProfile, direction: GraphDirection): GraphItem[] {
  const canonical = new Map<string, GraphItem>()
  function add(peerId: string, time: string, connectionId: string | null) {
    const person = ctx.peer(peerId)
    if (!person || person.id === subject.id || ctx.blocked(subject.id, person.id) ||
        !readablePeer(ctx, person)) return
    const item: GraphItem = {
      id: person.id, person: summary(person), created_at: time, connectionId,
    }
    const prior = canonical.get(person.id)
    if (!prior || newestItem(item, prior) < 0) canonical.set(person.id, item)
  }
  if (direction === 'connections') {
    if (subject.id !== ctx.viewer?.id) return []
    for (const { row, at } of ctx.ownedConnections) {
      if (row.status !== 'accepted') continue
      add(row.requester_id === subject.id ? row.addressee_id : row.requester_id, at, row.id)
    }
  } else {
    for (const row of ctx.db.follows) {
      const mine = direction === 'followers' ? row.following_id : row.follower_id
      const other = direction === 'followers' ? row.follower_id : row.following_id
      if (mine !== subject.id || !validGraphId(row.id) || !validGraphId(other)) continue
      const time = normalizeGraphTime(row.created_at)
      if (time) add(other, time, null)
    }
  }
  return [...canonical.values()].sort(newestItem)
}

export function localGraphCounts(
  db: LocalGraphSnapshot,
  subject: LocalProfile,
  viewer: LocalProfile | null,
): GraphCounts | null {
  const ctx = readContext(db, viewer)
  const stored = permittedSubject(ctx, subject)
  if (!stored) return null
  return {
    follower_count: collect(ctx, stored, 'followers').length,
    following_count: collect(ctx, stored, 'following').length,
    connection_count: stored.id === ctx.viewer?.id ? collect(ctx, stored, 'connections').length : null,
  }
}

function requestedCursor(
  input: LocalGraphPageOptions['cursor'], subjectId: string, direction: GraphDirection,
): GraphCursorResult<GraphCursor> {
  if (input === undefined || input === null || typeof input === 'string') {
    return decodeGraphCursor(input, subjectId, direction)
  }
  const encoded = encodeGraphCursor(input)
  return encoded.cursor ? decodeGraphCursor(encoded.cursor, subjectId, direction) :
    { cursor: null, error: encoded.error }
}

function emptyPage(unavailable: boolean, error: string | null = null): LocalGraphPage {
  return { items: [], nextCursor: null, total: null, error, unavailable }
}

export function localGraphPage(
  db: LocalGraphSnapshot,
  subject: LocalProfile,
  viewer: LocalProfile | null,
  direction: GraphDirection,
  options: LocalGraphPageOptions = {},
): LocalGraphPage {
  if (!isGraphDirection(direction)) return emptyPage(false, GRAPH_DIRECTION_ERROR)
  const checked = requestedCursor(options.cursor, subject.id, direction)
  if (checked.error) return emptyPage(false, checked.error)
  const ctx = readContext(db, viewer)
  const stored = permittedSubject(ctx, subject)
  if (!stored || (direction === 'connections' && stored.id !== ctx.viewer?.id)) {
    return emptyPage(true)
  }
  const all = collect(ctx, stored, direction)
  const limit = graphLimit(options.limit)
  const cursor = checked.cursor
  const eligible = cursor ? all.filter(item =>
    item.created_at < cursor.createdAt ||
    (item.created_at === cursor.createdAt &&
      compareGraphIds(item.connectionId ?? item.id, cursor.id) < 0)) : all
  const lookahead = eligible.slice(0, limit + 1)
  const items = lookahead.slice(0, limit)
  const last = items.at(-1)
  let nextCursor: string | null = null
  if (lookahead.length > limit && last) {
    const encoded = encodeGraphCursor({
      subjectId: stored.id, direction, createdAt: last.created_at,
      id: last.connectionId ?? last.id,
    })
    if (encoded.error) return emptyPage(false, encoded.error)
    nextCursor = encoded.cursor
  }
  return { items, nextCursor, total: all.length, error: null, unavailable: false }
}

function newestRelationship(a: TimedConnection, b: TimedConnection): number {
  // Match accepted-page canonical choice even with defensive legacy duplicates.
  // Without any accepted row, use newest actual pending/rejected row.
  if ((a.row.status === 'accepted') !== (b.row.status === 'accepted')) {
    return a.row.status === 'accepted' ? -1 : 1
  }
  if (a.at !== b.at) return a.at > b.at ? -1 : 1
  return -compareGraphIds(a.row.id, b.row.id)
}

export function getLocalScopedRelationships(
  db: LocalGraphSnapshot,
  viewer: LocalProfile | null,
  peerIds: readonly string[],
): LocalScopedRelationships {
  if (!Array.isArray(peerIds) || peerIds.length > GRAPH_MAX_LIMIT ||
      peerIds.some(id => !validGraphId(id))) {
    return { relationships: {}, error: PEER_SCOPE_ERROR, unavailable: false }
  }
  const ctx = readContext(db, viewer)
  if (!ctx.viewer || ctx.invalidViewer) {
    return { relationships: {}, error: null, unavailable: true }
  }
  const relationships: Record<string, LocalScopedRelationship> = {}
  let error: string | null = null
  for (const id of new Set(peerIds)) {
    const person = ctx.peer(id)
    if (!person || person.id === ctx.viewer.id || !readablePeer(ctx, person)) continue
    if (ctx.badConnectionPeers.has(id) || ctx.badFollowPeers.has(id)) {
      error = RELATIONSHIP_ERROR // Do not turn corrupt relevant state into none.
      continue
    }
    const candidate = ctx.ownedConnections.filter(({ row }) =>
      row.requester_id === id || row.addressee_id === id).sort(newestRelationship)[0]
    const row = candidate?.row
    const state: LocalScopedRelationship['state'] = !row ? 'none' :
      row.status === 'accepted' ? 'connected' : row.status === 'rejected' ? 'rejected' :
        row.requester_id === ctx.viewer.id ? 'outgoing' : 'incoming'
    relationships[id] = {
      state, connectionId: row?.id ?? null,
      isFollowing: ctx.ownFollows.has(id),
      // These are visible page peers. Blocked-list management is separate.
      isBlockingThem: false,
    }
  }
  return { relationships, error, unavailable: false }
}

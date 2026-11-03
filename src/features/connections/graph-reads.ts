import 'server-only'

import { unstable_rethrow } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { readStore, type LocalProfile, type Tables } from '@/lib/local/db'
import { localActor } from '@/lib/local/access'
import { isLocalMode } from '@/lib/mode'
import type { ProfileSummary } from '@/features/profiles/queries'
import {
  getLocalScopedRelationships, localGraphCounts, localGraphPage,
  type LocalScopedRelationship,
} from './graph-local'
import {
  compareGraphIds, decodeGraphCursor, graphLimit, isGraphDirection, normalizeGraphTime, validGraphId,
  type GraphCounts, type GraphDirection, type GraphItem,
} from './graph-paging'
import { decodeScopedGraphCursor, encodeScopedGraphCursor, type GraphScope } from './graph-scope'

const READ_ERROR = 'This relationship list could not be loaded. Please try again.'
const COUNT_ERROR = 'Relationship counts could not be loaded. Please try again.'
const STATE_ERROR = 'Relationship controls could not be loaded. Please try again.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUBJECT_SELECT = 'id, username, display_name, avatar_url, headline, visibility'

type Subject = Omit<ProfileSummary, 'headline'> & { headline?: string | null; visibility: string }
type Context = {
  provider: 'local' | 'supabase'
  userId: string | null
  viewerId: string | null
  db: Tables | null
  viewer: LocalProfile | null
  invalidViewer: boolean
}
export type GraphCountsRead = {
  counts: GraphCounts | null
  error: string | null
  unavailable: boolean
}
export type GraphPageRead = {
  subject: ProfileSummary | null
  items: GraphItem[]
  total: number | null
  nextCursor: string | null
  error: string | null
  unavailable: boolean
}
export type PageRelationships = {
  viewerId: string | null
  relationships: Record<string, LocalScopedRelationship>
  error: string | null
}

function unavailable(): GraphPageRead {
  return { subject: null, items: [], total: null, nextCursor: null, error: null, unavailable: true }
}
function failed(subject: ProfileSummary | null, error = READ_ERROR): GraphPageRead {
  return { subject, items: [], total: null, nextCursor: null, error, unavailable: false }
}
function summary(subject: Subject): ProfileSummary {
  return {
    id: subject.id, username: subject.username, display_name: subject.display_name,
    avatar_url: subject.avatar_url, headline: subject.headline ?? null,
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function count(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
function subjectRow(value: unknown): Subject | null {
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.username !== 'string' || !row.username.trim() ||
      typeof row.display_name !== 'string' || !row.display_name.trim() ||
      !(row.avatar_url === null || typeof row.avatar_url === 'string') ||
      !(row.headline === null || typeof row.headline === 'string') ||
      typeof row.visibility !== 'string') return null
  return {
    id: row.id, username: row.username, display_name: row.display_name,
    avatar_url: row.avatar_url, headline: row.headline, visibility: row.visibility,
  }
}
async function context(): Promise<Context> {
  const user = await getUser()
  if (!isLocalMode()) {
    return {
      provider: 'supabase', userId: user?.id ?? null, viewerId: user?.id ?? null,
      db: null, viewer: null, invalidViewer: Boolean(user && !UUID.test(user.id)),
    }
  }
  const db = await readStore()
  const viewer = localActor(db, user?.id ?? null)
  return {
    provider: 'local', userId: user?.id ?? null, viewerId: viewer?.id ?? null,
    db, viewer, invalidViewer: Boolean(user && !viewer),
  }
}
async function countsFor(ctx: Context, subjectId: string): Promise<GraphCountsRead> {
  if (ctx.invalidViewer || !validGraphId(subjectId)) {
    return { counts: null, error: null, unavailable: true }
  }
  if (ctx.db) {
    const subject = ctx.db.profiles.find(row => row.id === subjectId)
    const counts = subject ? localGraphCounts(ctx.db, subject, ctx.viewer) : null
    return { counts, error: null, unavailable: counts === null }
  }
  if (!UUID.test(subjectId)) return { counts: null, error: null, unavailable: true }
  const client = await createClient()
  const result = await client.rpc('profile_graph_counts', { p_subject: subjectId })
  if (result.error || !Array.isArray(result.data)) {
    return { counts: null, error: COUNT_ERROR, unavailable: false }
  }
  if (result.data.length === 0) return { counts: null, error: null, unavailable: true }
  if (result.data.length !== 1) return { counts: null, error: COUNT_ERROR, unavailable: false }
  const row = record(result.data[0])
  const followers = count(row?.follower_count)
  const following = count(row?.following_count)
  const own = ctx.viewerId === subjectId
  const connections = own ? count(row?.connection_count) : null
  if (followers === null || following === null ||
      (own ? connections === null : row?.connection_count !== null)) {
    return { counts: null, error: COUNT_ERROR, unavailable: false }
  }
  return {
    counts: { follower_count: followers, following_count: following, connection_count: connections },
    error: null, unavailable: false,
  }
}

/** Caller-bound counts, never maintained raw counters or a service-role query. */
export async function getGraphCounts(subjectId: string): Promise<GraphCountsRead> {
  try {
    return await countsFor(await context(), subjectId)
  } catch (error) {
    unstable_rethrow(error)
    return { counts: null, error: COUNT_ERROR, unavailable: false }
  }
}

function scopeFor(ctx: Context, subjectId: string, direction: GraphDirection): GraphScope {
  return { provider: ctx.provider, viewerId: ctx.viewerId, subjectId, direction }
}
function pageItem(value: unknown, direction: GraphDirection): GraphItem | null {
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.username !== 'string' || !row.username.trim() ||
      typeof row.display_name !== 'string' || !row.display_name.trim() ||
      !(row.avatar_url === null || typeof row.avatar_url === 'string') ||
      !(row.headline === null || typeof row.headline === 'string') ||
      typeof row.created_at !== 'string') return null
  const time = normalizeGraphTime(row.created_at)
  const connectionId = direction === 'connections' ? row.connection_id : null
  if (!time || (direction === 'connections' &&
      (typeof connectionId !== 'string' || !UUID.test(connectionId)))) return null
  return {
    id: row.id, created_at: time, connectionId: connectionId as string | null,
    person: {
      id: row.id, username: row.username, display_name: row.display_name,
      avatar_url: row.avatar_url, headline: row.headline,
    },
  }
}
async function readPage(
  ctx: Context, subject: Subject, direction: GraphDirection, rawCursor: unknown, size?: number,
): Promise<GraphPageRead> {
  const authorized = await countsFor(ctx, subject.id)
  if (authorized.error) return failed(summary(subject), authorized.error)
  if (!authorized.counts || (direction === 'connections' && subject.id !== ctx.viewerId)) {
    return unavailable()
  }
  const scope = scopeFor(ctx, subject.id, direction)
  const checked = decodeScopedGraphCursor(rawCursor, scope)
  if (checked.error) return failed(summary(subject), checked.error)
  const limit = graphLimit(size)
  const total = direction === 'followers' ? authorized.counts.follower_count :
    direction === 'following' ? authorized.counts.following_count : authorized.counts.connection_count
  if (ctx.db) {
    const stored = ctx.db.profiles.find(row => row.id === subject.id)!
    const page = localGraphPage(ctx.db, stored, ctx.viewer, direction,
      { cursor: checked.cursor, limit })
    if (page.unavailable) return unavailable()
    if (page.error) return failed(summary(subject), page.error)
    let nextCursor: string | null = null
    if (page.nextCursor) {
      const next = decodeGraphCursor(page.nextCursor, subject.id, direction)
      if (!next.cursor) return failed(summary(subject))
      const scoped = encodeScopedGraphCursor(next.cursor, scope)
      if (!scoped.cursor) return failed(summary(subject))
      nextCursor = scoped.cursor
    }
    return { subject: summary(subject), ...page, nextCursor }
  }
  const client = await createClient()
  const cursorArgs = {
    p_after_created_at: checked.cursor?.createdAt ?? null,
    p_after_id: checked.cursor?.id ?? null, p_limit: limit,
  }
  const result = direction === 'connections'
    ? await client.rpc('my_connection_page', cursorArgs)
    : await client.rpc('profile_follow_page', {
      ...cursorArgs, p_subject: subject.id, p_direction: direction,
    })
  if (result.error || !Array.isArray(result.data) || result.data.length > limit + 1) {
    return failed(summary(subject))
  }
  const items = result.data.map(value => pageItem(value, direction))
  if (items.some(item => item === null)) return failed(summary(subject))
  const rows = items as GraphItem[]
  if (new Set(rows.map(row => row.id)).size !== rows.length ||
      rows.some(row => row.id === subject.id) ||
      rows.some((row, index) => {
        const prior = rows[index - 1]
        if (!prior) return false
        return prior.created_at < row.created_at ||
          (prior.created_at === row.created_at &&
            compareGraphIds(prior.connectionId ?? prior.id, row.connectionId ?? row.id) <= 0)
      }) ||
      (checked.cursor && rows.some(row => row.created_at > checked.cursor!.createdAt ||
        (row.created_at === checked.cursor!.createdAt &&
          compareGraphIds(row.connectionId ?? row.id, checked.cursor!.id) >= 0)))) {
    return failed(summary(subject))
  }
  const displayed = rows.slice(0, limit)
  const last = displayed.at(-1)
  let nextCursor: string | null = null
  if (rows.length > limit && last) {
    const next = encodeScopedGraphCursor({
      subjectId: subject.id, direction, createdAt: last.created_at,
      id: last.connectionId ?? last.id,
    }, scope)
    if (!next.cursor) return failed(summary(subject))
    nextCursor = next.cursor
  }
  return {
    subject: summary(subject), items: displayed, total, nextCursor,
    error: null, unavailable: false,
  }
}

export async function getOwnGraphPage(
  direction: GraphDirection, options: { cursor?: unknown; limit?: number } = {},
): Promise<GraphPageRead> {
  try {
    if (!isGraphDirection(direction)) return failed(null, 'Invalid graph direction.')
    const ctx = await context()
    if (!ctx.viewerId || ctx.invalidViewer) return unavailable()
    let subject: Subject | null
    if (ctx.db) {
      subject = ctx.db.profiles.find(row => row.id === ctx.viewerId) ?? null
    } else {
      const client = await createClient()
      const result = await client.from('profiles').select(SUBJECT_SELECT)
        .eq('id', ctx.viewerId).is('deleted_at', null).maybeSingle()
      if (result.error) return failed(null)
      subject = result.data === null ? null : subjectRow(result.data)
      if (result.data !== null && (!subject || subject.id !== ctx.viewerId)) return failed(null)
    }
    return subject ? await readPage(ctx, subject, direction, options.cursor, options.limit) : unavailable()
  } catch (error) {
    unstable_rethrow(error)
    return failed(null)
  }
}

export async function getPublicGraphPage(
  username: string, direction: 'followers' | 'following',
  options: { cursor?: unknown; limit?: number } = {},
): Promise<GraphPageRead> {
  try {
    if (direction !== 'followers' && direction !== 'following') return unavailable()
    if (typeof username !== 'string' || !username.trim() || username.length > 64) return unavailable()
    const ctx = await context()
    if (ctx.invalidViewer) return unavailable()
    let subject: Subject | null
    if (ctx.db) {
      const matches = ctx.db.profiles.filter(row => row.username.trim().toLowerCase() === username.trim().toLowerCase())
      subject = matches.length === 1 ? matches[0]! : null
    } else {
      const client = await createClient()
      const result = await client.from('profiles').select(SUBJECT_SELECT)
        .ilike('username', username.replace(/[%_\\]/g, '\\$&'))
        .is('deleted_at', null).maybeSingle()
      if (result.error) return failed(null)
      subject = result.data === null ? null : subjectRow(result.data)
      if (result.data !== null && !subject) return failed(null)
    }
    if (!subject || subject.visibility !== 'public') return unavailable()
    return await readPage(ctx, subject, direction, options.cursor, options.limit)
  } catch (error) {
    unstable_rethrow(error)
    return failed(null)
  }
}

/** Bounded actual-viewer-owned controls for already authorized page peers. */
export async function getPageRelationships(items: readonly GraphItem[]): Promise<PageRelationships> {
  try {
    const ctx = await context()
    if (!ctx.viewerId || ctx.invalidViewer) return { viewerId: null, relationships: {}, error: null }
    const ids = [...new Set(items.map(item => item.id))].filter(id => id !== ctx.viewerId)
    if (items.length > 50 || ids.some(id => !validGraphId(id))) {
      return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
    }
    if (ctx.db) {
      const result = getLocalScopedRelationships(ctx.db, ctx.viewer, ids)
      return { viewerId: ctx.viewerId, relationships: result.relationships, error: result.error }
    }
    if (!ids.length) return { viewerId: ctx.viewerId, relationships: {}, error: null }
    if (ids.some(id => !UUID.test(id))) return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
    const client = await createClient()
    const [connections, follows] = await Promise.all([
      client.from('connections').select('id, requester_id, addressee_id, status')
        .or(`and(requester_id.eq.${ctx.viewerId},addressee_id.in.(${ids.join(',')})),and(addressee_id.eq.${ctx.viewerId},requester_id.in.(${ids.join(',')}))`)
        .limit(51),
      client.from('follows').select('following_id').eq('follower_id', ctx.viewerId)
        .in('following_id', ids).limit(51),
    ])
    if (connections.error || follows.error || !Array.isArray(connections.data) ||
        !Array.isArray(follows.data) || connections.data.length > ids.length ||
        follows.data.length > ids.length) {
      return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
    }
    const relationships: Record<string, LocalScopedRelationship> = {}
    const wanted = new Set(ids)
    for (const id of ids) relationships[id] = {
      state: 'none', connectionId: null, isFollowing: false, isBlockingThem: false,
    }
    const seen = new Set<string>()
    for (const value of connections.data) {
      const row = record(value)
      if (!row || typeof row.id !== 'string' || !UUID.test(row.id) ||
          !(row.requester_id === ctx.viewerId || row.addressee_id === ctx.viewerId)) {
        return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
      }
      const peerId = row.requester_id === ctx.viewerId ? row.addressee_id : row.requester_id
      if (typeof peerId !== 'string' || !wanted.has(peerId) || seen.has(peerId) ||
          typeof row.status !== 'string' ||
          !['pending', 'accepted', 'rejected'].includes(row.status)) {
        return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
      }
      seen.add(peerId)
      relationships[peerId] = {
        state: row.status === 'accepted' ? 'connected' : row.status === 'rejected' ? 'rejected' :
          row.requester_id === ctx.viewerId ? 'outgoing' : 'incoming',
        connectionId: row.id, isFollowing: false, isBlockingThem: false,
      }
    }
    const seenFollows = new Set<string>()
    for (const value of follows.data) {
      const row = record(value)
      if (!row || typeof row.following_id !== 'string' || !wanted.has(row.following_id) ||
          seenFollows.has(row.following_id)) {
        return { viewerId: ctx.viewerId, relationships: {}, error: STATE_ERROR }
      }
      seenFollows.add(row.following_id)
      relationships[row.following_id]!.isFollowing = true
    }
    return { viewerId: ctx.viewerId, relationships, error: null }
  } catch (error) {
    unstable_rethrow(error)
    return { viewerId: null, relationships: {}, error: STATE_ERROR }
  }
}

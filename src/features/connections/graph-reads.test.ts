/**
 * FROZEN D-DRIVE PROPOSAL, 2026-11-02. Not installed or run/typechecked/linted.
 * Intended destination: src/features/connections/graph-reads.test.ts.
 *
 * Boundary unit tests ONLY, not hosted Auth/PostgREST/RLS or browser acceptance.
 * Only server-only, ordinary createClient/getUser, readStore and mode are mocked.
 * Paging, scoped cursors, localActor and local graph rules remain real.
 * Static source imports are intentional: missing/incompatible modules must fail.
 * Unexpected queries, mutations, projections and unqueued replies fail even if
 * the adapter catches their exception. There are no fallback replies or skips.
 */
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProfile, Tables } from '@/lib/local/db'
import type { ProfileSummary } from '@/features/profiles/queries'
import type { LocalGraphSnapshot } from '@/features/connections/graph-local'
import {
  encodeGraphCursor, GRAPH_CURSOR_ERROR, GRAPH_SCOPE_ERROR,
  type GraphCursor, type GraphDirection, type GraphItem,
} from '@/features/connections/graph-paging'
import {
  decodeScopedGraphCursor, encodeScopedGraphCursor, type GraphScope,
} from '@/features/connections/graph-scope'
import {
  getGraphCounts, getOwnGraphPage, getPageRelationships, getPublicGraphPage,
} from '@/features/connections/graph-reads'

type ApiResponse = { data: unknown; error: { code: string; message?: string } | null }
type Reply = ApiResponse | Error
type TableName = 'profiles' | 'connections' | 'follows'
type Step = [string, ...unknown[]]
type QueryCall = { table: TableName; steps: Step[] }
type RpcCall = { name: string; args: Record<string, unknown> }
type Query = {
  select(columns: string): Query
  eq(column: string, value: unknown): Query
  is(column: string, value: unknown): Query
  ilike(column: string, value: string): Query
  or(expression: string): Query
  in(column: string, values: readonly string[]): Query
  maybeSingle(): Promise<ApiResponse>
  limit(value: number): Promise<ApiResponse>
}
type Snapshot = {
  -readonly [K in keyof LocalGraphSnapshot]: Array<LocalGraphSnapshot[K][number]>
}

const boundary = vi.hoisted(() => ({
  local: false,
  createClient: vi.fn(),
  getUser: vi.fn(),
  readStore: vi.fn(),
  queries: [] as QueryCall[],
  rpcs: [] as RpcCall[],
  replies: new Map<string, Reply[]>(),
  violations: [] as string[],
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: boundary.createClient, getUser: boundary.getUser,
}))
vi.mock('@/lib/local/db', () => ({ readStore: boundary.readStore }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => boundary.local }))

const NOW = '2026-11-02T07:00:00.000Z'
const STAMP = '2026-11-01T07:00:00.123456Z'
const OFFSET_STAMP = '2026-11-01 12:00:00.123456+05'
const READ_ERROR = 'This relationship list could not be loaded. Please try again.'
const COUNT_ERROR = 'Relationship counts could not be loaded. Please try again.'
const STATE_ERROR = 'Relationship controls could not be loaded. Please try again.'
const SUBJECT_SELECT = 'id, username, display_name, avatar_url, headline, visibility'
const CONNECTION_SELECT = 'id, requester_id, addressee_id, status'
const FOLLOW_SELECT = 'following_id'
const RPC_FIELDS = {
  profile_graph_counts: ['p_subject'],
  profile_follow_page: ['p_after_created_at', 'p_after_id', 'p_direction', 'p_limit', 'p_subject'],
  my_connection_page: ['p_after_created_at', 'p_after_id', 'p_limit'],
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}
const OWNER = uuid(1)
const SUBJECT = uuid(2)
const OTHER = uuid(3)
const PEER = uuid(101)
const SECOND_PEER = uuid(102)

function forbidden(operation: string): never {
  boundary.violations.push(operation)
  throw new Error(`Unexpected graph adapter operation: ${operation}`)
}

/** Non-thenable ordinary client/query doubles; every unsupported API is fatal. */
function readOnly<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (key === 'then' && !Reflect.has(object, key)) return undefined
      if (typeof key === 'symbol' || Reflect.has(object, key)) {
        return Reflect.get(object, key, receiver)
      }
      return forbidden(`${label}.${String(key)}`)
    },
  })
}

function enqueue(key: string, reply: Reply): void {
  const replies = boundary.replies.get(key)
  if (replies) replies.push(reply)
  else boundary.replies.set(key, [reply])
}

function consume(key: string): ApiResponse {
  const reply = boundary.replies.get(key)?.shift()
  if (!reply) return forbidden(`unqueued reply ${key}`)
  if (reply instanceof Error) throw reply
  return reply
}

function builder(table: TableName): Query {
  const call: QueryCall = { table, steps: [] }
  boundary.queries.push(call)
  const projection = table === 'profiles' ? SUBJECT_SELECT :
    table === 'connections' ? CONNECTION_SELECT : FOLLOW_SELECT
  const query: Query = readOnly({
    select(columns: string) {
      call.steps.push(['select', columns])
      if (columns !== projection) return forbidden(`${table}.select(${columns})`)
      return query
    },
    eq(column: string, value: unknown) {
      call.steps.push(['eq', column, value])
      if (!((table === 'profiles' && column === 'id') ||
          (table === 'follows' && column === 'follower_id'))) {
        return forbidden(`${table}.eq(${column})`)
      }
      return query
    },
    is(column: string, value: unknown) {
      call.steps.push(['is', column, value])
      if (table !== 'profiles' || column !== 'deleted_at' || value !== null) {
        return forbidden(`${table}.is(${column})`)
      }
      return query
    },
    ilike(column: string, value: string) {
      call.steps.push(['ilike', column, value])
      if (table !== 'profiles' || column !== 'username') {
        return forbidden(`${table}.ilike(${column})`)
      }
      return query
    },
    or(expression: string) {
      call.steps.push(['or', expression])
      if (table !== 'connections') return forbidden(`${table}.or`)
      return query
    },
    in(column: string, values: readonly string[]) {
      call.steps.push(['in', column, [...values]])
      if (table !== 'follows' || column !== 'following_id') {
        return forbidden(`${table}.in(${column})`)
      }
      return query
    },
    async maybeSingle() {
      call.steps.push(['maybeSingle'])
      if (table !== 'profiles') return forbidden(`${table}.maybeSingle`)
      return consume(`table:${table}`)
    },
    async limit(value: number) {
      call.steps.push(['limit', value])
      if (table === 'profiles' || value !== 51) return forbidden(`${table}.limit(${value})`)
      return consume(`table:${table}`)
    },
  }, table)
  return query
}

function ordinaryClient() {
  return readOnly({
    from(table: string): Query {
      if (table !== 'profiles' && table !== 'connections' && table !== 'follows') {
        return forbidden(`from(${table})`)
      }
      return builder(table)
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<ApiResponse> {
      boundary.rpcs.push({ name, args: structuredClone(args) })
      const fields = RPC_FIELDS[name as keyof typeof RPC_FIELDS]
      if (!fields || Object.keys(args).sort().join(',') !== [...fields].sort().join(',')) {
        return forbidden(`rpc ${name} argument keys`)
      }
      if (name !== 'profile_graph_counts' &&
          (typeof args.p_limit !== 'number' || !Number.isInteger(args.p_limit) ||
            args.p_limit < 1 || args.p_limit > 50)) {
        return forbidden(`rpc ${name} unbounded limit`)
      }
      return consume(`rpc:${name}`)
    },
  }, 'ordinary client')
}

function reply(data: unknown, error: ApiResponse['error'] = null): ApiResponse {
  return { data, error }
}
function providerSubject(id = OWNER, overrides: Record<string, unknown> = {}) {
  return {
    id, username: `student_${id.slice(-4)}`, display_name: 'Synthetic Student',
    avatar_url: null, headline: null, visibility: 'public', ...overrides,
  }
}
function summary(person: ReturnType<typeof providerSubject>): ProfileSummary {
  return {
    id: person.id, username: person.username, display_name: person.display_name,
    avatar_url: person.avatar_url, headline: person.headline,
  }
}
function providerPeer(id = PEER, overrides: Record<string, unknown> = {}) {
  return {
    id, username: `peer_${id.slice(-4)}`, display_name: `Synthetic Peer ${id.slice(-4)}`,
    avatar_url: null, headline: null, created_at: STAMP, ...overrides,
  }
}
function item(id = PEER): GraphItem {
  return {
    id, person: {
      id, username: `peer_${id.slice(-4)}`, display_name: 'Synthetic Peer',
      avatar_url: null, headline: null,
    },
    created_at: STAMP, connectionId: null,
  }
}
function providerCounts(
  follower_count: unknown = 0, following_count: unknown = 0, connection_count: unknown = 0,
) {
  return { follower_count, following_count, connection_count }
}
function pageRpc(direction: GraphDirection): string {
  return direction === 'connections' ? 'my_connection_page' : 'profile_follow_page'
}
function queuePage(
  direction: GraphDirection, rows: unknown, options: {
    subject?: ReturnType<typeof providerSubject>
    counts?: unknown
    error?: ApiResponse['error']
  } = {},
): void {
  enqueue('table:profiles', reply(options.subject ?? providerSubject()))
  enqueue('rpc:profile_graph_counts', reply(options.counts ?? [providerCounts()]))
  enqueue(`rpc:${pageRpc(direction)}`, reply(rows, options.error ?? null))
}
function expectOwnSubjectQuery(viewerId = OWNER): void {
  expect(boundary.queries).toEqual([{
    table: 'profiles', steps: [
      ['select', SUBJECT_SELECT], ['eq', 'id', viewerId],
      ['is', 'deleted_at', null], ['maybeSingle'],
    ],
  }])
}
function expectControlsQueries(ids: readonly string[], viewerId = OWNER): void {
  expect(boundary.queries).toEqual([
    {
      table: 'connections', steps: [
        ['select', CONNECTION_SELECT],
        ['or', `and(requester_id.eq.${viewerId},addressee_id.in.(${ids.join(',')})),and(addressee_id.eq.${viewerId},requester_id.in.(${ids.join(',')}))`],
        ['limit', 51],
      ],
    },
    {
      table: 'follows', steps: [
        ['select', FOLLOW_SELECT], ['eq', 'follower_id', viewerId],
        ['in', 'following_id', [...ids]], ['limit', 51],
      ],
    },
  ])
  expect(boundary.rpcs).toEqual([])
}
function unavailablePage() {
  return {
    subject: null, items: [], total: null, nextCursor: null,
    error: null, unavailable: true,
  }
}
function failedPage(subject: ProfileSummary | null, error = READ_ERROR) {
  return {
    subject, items: [], total: null, nextCursor: null, error, unavailable: false,
  }
}
function scope(overrides: Partial<GraphScope> = {}): GraphScope {
  return {
    provider: 'supabase', viewerId: OWNER, subjectId: SUBJECT,
    direction: 'followers', ...overrides,
  }
}
function scopedToken(target: GraphScope, overrides: Partial<GraphCursor> = {}): string {
  const encoded = encodeScopedGraphCursor({
    subjectId: target.subjectId, direction: target.direction,
    createdAt: STAMP, id: PEER, ...overrides,
  }, target)
  expect(encoded.error).toBeNull()
  if (encoded.cursor === null) throw new Error('Valid scoped fixture cursor was refused.')
  return encoded.cursor
}

function localProfile(label: string, overrides: Partial<LocalProfile> = {}): LocalProfile {
  return {
    id: `prf_${label}`, user_id: `usr_${label}`, username: label,
    display_name: `Synthetic ${label}`, bio: 'PRIVATE fixture biography',
    avatar_url: null, university_id: 'uni_home', department: null, programme: null,
    semester: null, website: null, github: null, headline: null,
    visibility: 'public', searchable: true, created_at: STAMP, ...overrides,
  }
}
function snapshot(...people: LocalProfile[]): Snapshot {
  return {
    profiles: [...people],
    users: people.map(person => ({
      id: person.user_id, email: `${person.username}@boundary-fixture.invalid`,
      password_hash: 'PRIVATE synthetic non-authentication hash',
      created_at: STAMP, disabled_at: null,
    })),
    follows: [], connections: [], blocks: [], profile_account_states: [],
    account_deletion_jobs: [],
  }
}
function localFollow(
  from: LocalProfile, to: LocalProfile, suffix: string, at = STAMP,
): Tables['follows'][number] {
  return { id: `fol_${suffix}`, follower_id: from.id, following_id: to.id, created_at: at }
}
function localConnection(
  rowId: string, from: LocalProfile, to: LocalProfile,
  status: Tables['connections'][number]['status'] = 'accepted', at = STAMP,
): Tables['connections'][number] {
  return {
    id: rowId, requester_id: from.id, addressee_id: to.id, status,
    message: 'PRIVATE connection request', created_at: at,
    responded_at: status === 'pending' ? null : at,
  }
}
function useLocal(db: LocalGraphSnapshot, userId: string | null): void {
  boundary.local = true
  boundary.getUser.mockResolvedValue(userId === null ? null : { id: userId })
  boundary.readStore.mockResolvedValue(db)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  boundary.local = false
  boundary.queries.length = 0
  boundary.rpcs.length = 0
  boundary.violations.length = 0
  boundary.replies.clear()
  boundary.getUser.mockResolvedValue({ id: OWNER })
  boundary.createClient.mockImplementation(async () => {
    if (boundary.local) return forbidden('ordinary provider access in local mode')
    return ordinaryClient()
  })
  boundary.readStore.mockImplementation(async () => forbidden('unconfigured local snapshot read'))
})
afterEach(() => {
  vi.useRealTimers()
  expect(boundary.violations).toEqual([])
  expect([...boundary.replies.entries()].filter(([, replies]) => replies.length > 0)).toEqual([])
  expect(boundary.createClient.mock.calls.every(args => args.length === 0)).toBe(true)
  expect(boundary.getUser.mock.calls.every(args => args.length === 0)).toBe(true)
  expect(boundary.readStore.mock.calls.every(args => args.length === 0)).toBe(true)
  for (const query of boundary.queries) {
    expect(query.steps[0]).toEqual(['select', query.table === 'profiles' ? SUBJECT_SELECT :
      query.table === 'connections' ? CONNECTION_SELECT : FOLLOW_SELECT])
  }
})

describe('ordinary caller-bound count boundary (not hosted acceptance)', () => {
  it('uses only p_subject and returns canonical eligible counts, never raw counters or metadata', async () => {
    enqueue('rpc:profile_graph_counts', reply([{
      ...providerCounts('3', '0', '2'), role: 'PRIVATE role', user_id: 'PRIVATE owner',
    }]))
    expect(await getGraphCounts(OWNER)).toEqual({
      counts: { follower_count: 3, following_count: 0, connection_count: 2 },
      error: null, unavailable: false,
    })
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: OWNER } }])
    expect(boundary.queries).toEqual([])
    expect(boundary.createClient).toHaveBeenCalledTimes(1)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.readStore).not.toHaveBeenCalled()
  })

  it.each([OWNER, null])('keeps another public subject connections count null for reader %s', async readerId => {
    boundary.getUser.mockResolvedValue(readerId === null ? null : { id: readerId })
    enqueue('rpc:profile_graph_counts', reply([providerCounts(1, 2, null)]))
    expect(await getGraphCounts(SUBJECT)).toEqual({
      counts: { follower_count: 1, following_count: 2, connection_count: null },
      error: null, unavailable: false,
    })
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: SUBJECT } }])
    expect(boundary.queries).toEqual([])
  })

  it.each(['', 'prf_local', `${OWNER}\n`, 'not-an-id'])('refuses hosted subject %j before provider access', async id => {
    expect(await getGraphCounts(id)).toEqual({ counts: null, error: null, unavailable: true })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('never downgrades an invalid authenticated hosted identity to anonymous', async () => {
    boundary.getUser.mockResolvedValue({ id: 'usr_stale' })
    expect(await getGraphCounts(SUBJECT)).toEqual({ counts: null, error: null, unavailable: true })
    expect(await getPublicGraphPage('public_student', 'followers')).toEqual(unavailablePage())
    expect(await getOwnGraphPage('connections')).toEqual(unavailablePage())
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(boundary.readStore).not.toHaveBeenCalled()
  })

  it('distinguishes denied/no count row from available all-zero counts', async () => {
    enqueue('rpc:profile_graph_counts', reply([]))
    enqueue('rpc:profile_graph_counts', reply([providerCounts(0, 0, 0)]))
    expect(await getGraphCounts(OWNER)).toEqual({ counts: null, error: null, unavailable: true })
    expect(await getGraphCounts(OWNER)).toEqual({
      counts: { follower_count: 0, following_count: 0, connection_count: 0 },
      error: null, unavailable: false,
    })
  })

  it.each([
    ['null data', null], ['nonarray data', providerCounts()], ['null row', [null]],
    ['two rows', [providerCounts(), providerCounts()]],
    ['negative', [providerCounts(-1)]], ['fraction', [providerCounts(1.5)]],
    ['unsafe integer', [providerCounts(Number.MAX_SAFE_INTEGER + 1)]],
    ['noncanonical string', [providerCounts('01')]], ['signed string', [providerCounts('+1')]],
    ['coerced null', [providerCounts(null)]], ['missing following', [{ follower_count: 0, connection_count: 0 }]],
    ['own null connection aggregate', [providerCounts(0, 0, null)]],
  ])('reports malformed %s as error, not empty/unavailable success', async (_label, data) => {
    enqueue('rpc:profile_graph_counts', reply(data))
    expect(await getGraphCounts(OWNER)).toEqual({
      counts: null, error: COUNT_ERROR, unavailable: false,
    })
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: OWNER } }])
    expect(boundary.queries).toEqual([])
  })

  it.each([0, 1, '0', undefined])('refuses a foreign non-null connection aggregate %j', async connectionCount => {
    enqueue('rpc:profile_graph_counts', reply([{
      follower_count: 0, following_count: 0, connection_count: connectionCount,
    }]))
    expect(await getGraphCounts(SUBJECT)).toEqual({
      counts: null, error: COUNT_ERROR, unavailable: false,
    })
  })

  it('does not turn provider errors or thrown client failures into zero', async () => {
    enqueue('rpc:profile_graph_counts', reply([providerCounts()], {
      code: 'synthetic_provider_error', message: 'PRIVATE provider detail',
    }))
    expect(await getGraphCounts(OWNER)).toEqual({ counts: null, error: COUNT_ERROR, unavailable: false })
    boundary.createClient.mockRejectedValue(new Error('PRIVATE transport failure'))
    expect(await getGraphCounts(OWNER)).toEqual({ counts: null, error: COUNT_ERROR, unavailable: false })
    expect(boundary.readStore).not.toHaveBeenCalled()
  })
})

describe('subject projection and honest page outcomes', () => {
  it('reads only the own minimal profile projection and makes an explicit available empty page', async () => {
    const person = providerSubject(OWNER, {
      visibility: 'private', bio: 'PRIVATE biography', role: 'PRIVATE staff flag',
      follower_count: 999, following_count: 888, connection_count: 777,
    })
    queuePage('followers', [], { subject: person })
    expect(await getOwnGraphPage('followers')).toEqual({
      subject: summary(person), items: [], total: 0, nextCursor: null,
      error: null, unavailable: false,
    })
    expectOwnSubjectQuery()
    expect(boundary.rpcs).toEqual([
      { name: 'profile_graph_counts', args: { p_subject: OWNER } },
      { name: 'profile_follow_page', args: {
        p_subject: OWNER, p_direction: 'followers',
        p_after_created_at: null, p_after_id: null, p_limit: 25,
      } },
    ])
    expect(boundary.createClient).toHaveBeenCalledTimes(3)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.readStore).not.toHaveBeenCalled()
  })

  it('escapes literal username wildcard characters and projects a public subject, not a full profile', async () => {
    const username = 'Literal_%\\name'
    const person = providerSubject(SUBJECT, { username, bio: 'PRIVATE biography' })
    queuePage('following', [], { subject: person, counts: [providerCounts(0, 0, null)] })
    expect(await getPublicGraphPage(username, 'following')).toEqual({
      subject: summary(person), items: [], total: 0, nextCursor: null,
      error: null, unavailable: false,
    })
    expect(boundary.queries).toEqual([{
      table: 'profiles', steps: [
        ['select', SUBJECT_SELECT], ['ilike', 'username', 'Literal\\_\\%\\\\name'],
        ['is', 'deleted_at', null], ['maybeSingle'],
      ],
    }])
    expect(boundary.rpcs).toEqual([
      { name: 'profile_graph_counts', args: { p_subject: SUBJECT } },
      { name: 'profile_follow_page', args: {
        p_subject: SUBJECT, p_direction: 'following',
        p_after_created_at: null, p_after_id: null, p_limit: 25,
      } },
    ])
  })

  it.each(['private', 'university', 'connections'])('never exposes a foreign %s subject list', async visibility => {
    enqueue('table:profiles', reply(providerSubject(SUBJECT, { visibility })))
    expect(await getPublicGraphPage('subject', 'followers')).toEqual(unavailablePage())
    expect(boundary.rpcs).toEqual([])
  })

  it('refuses foreign connections and invalid public input without querying', async () => {
    expect(await getPublicGraphPage('subject', 'connections' as 'followers')).toEqual(unavailablePage())
    for (const username of ['', '   ', 'x'.repeat(65)]) {
      expect(await getPublicGraphPage(username, 'following')).toEqual(unavailablePage())
    }
    expect(await getOwnGraphPage('requests' as GraphDirection))
      .toEqual(failedPage(null, 'Invalid graph direction.'))
    expect(boundary.getUser).not.toHaveBeenCalled()
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('does not acquire own data while signed out', async () => {
    boundary.getUser.mockResolvedValue(null)
    expect(await getOwnGraphPage('followers')).toEqual(unavailablePage())
    expect(await getOwnGraphPage('connections')).toEqual(unavailablePage())
    expect(await getPageRelationships([item()])).toEqual({ viewerId: null, relationships: {}, error: null })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('keeps a missing profile, count denial and count error distinct from a valid empty page', async () => {
    enqueue('table:profiles', reply(null))
    expect(await getOwnGraphPage('following')).toEqual(unavailablePage())
    enqueue('table:profiles', reply(providerSubject()))
    enqueue('rpc:profile_graph_counts', reply([]))
    expect(await getOwnGraphPage('following', { cursor: 'malformed cursor' })).toEqual(unavailablePage())
    enqueue('table:profiles', reply(providerSubject()))
    enqueue('rpc:profile_graph_counts', reply(null, { code: 'synthetic_counts_failure' }))
    expect(await getOwnGraphPage('following')).toEqual(failedPage(summary(providerSubject()), COUNT_ERROR))
    expect(boundary.rpcs.every(call => call.name === 'profile_graph_counts')).toBe(true)
  })

  it.each([
    null, { code: 'synthetic_profile_failure' },
  ])('reports malformed/error profile reads without retrying another provider (%j)', async error => {
    enqueue('table:profiles', reply(error ? providerSubject() : { id: OWNER }, error))
    expect(await getOwnGraphPage('followers')).toEqual(failedPage(null))
    expect(boundary.rpcs).toEqual([])
    expect(boundary.readStore).not.toHaveBeenCalled()
  })

  it('refuses a mismatched own profile row before any graph RPC (draft defensive-contract defect)', async () => {
    enqueue('table:profiles', reply(providerSubject(SUBJECT)))
    expect(await getOwnGraphPage('followers')).toEqual(failedPage(null))
    expectOwnSubjectQuery()
    expect(boundary.rpcs).toEqual([])
  })

  it('preserves thrown auth failures as errors, not anonymous empty success', async () => {
    boundary.getUser.mockRejectedValue(new Error('PRIVATE auth transport detail'))
    expect(await getGraphCounts(OWNER)).toEqual({ counts: null, error: COUNT_ERROR, unavailable: false })
    expect(await getOwnGraphPage('followers')).toEqual(failedPage(null))
    expect(await getPublicGraphPage('subject', 'followers')).toEqual(failedPage(null))
    expect(await getPageRelationships([item()])).toEqual({ viewerId: null, relationships: {}, error: STATE_ERROR })
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(boundary.readStore).not.toHaveBeenCalled()
  })
})

describe('eligible lookahead, exact RPC tuple and projections', () => {
  it.each([
    [undefined, 25], [999, 50], [0, 1], [-10, 1], [1.9, 1], [Number.NaN, 25],
  ])('sends normalized numeric limit %s as %s, without a client-side wildcard query', async (requested, expected) => {
    queuePage('following', [])
    expect(await getOwnGraphPage('following', { limit: requested })).toMatchObject({
      items: [], total: 0, nextCursor: null, error: null, unavailable: false,
    })
    expect(boundary.rpcs).toEqual([
      { name: 'profile_graph_counts', args: { p_subject: OWNER } },
      { name: 'profile_follow_page', args: {
        p_subject: OWNER, p_direction: 'following',
        p_after_created_at: null, p_after_id: null, p_limit: expected,
      } },
    ])
  })

  it.each([
    { requested: undefined, displayed: 25, returned: 26 },
    { requested: 50, displayed: 50, returned: 51 },
  ])('uses only one eligible lookahead for requested limit $requested', async ({ requested, displayed, returned }) => {
    const rows = Array.from({ length: returned }, (_, index) => providerPeer(uuid(1000 + returned - index)))
    queuePage('followers', rows, { counts: [providerCounts(returned, 0, 0)] })
    const result = await getOwnGraphPage('followers', { limit: requested })
    expect(result.items.map(row => row.id)).toEqual(rows.slice(0, displayed).map(row => row.id))
    expect(result.total).toBe(returned)
    expect(result.error).toBeNull()
    expect(result.unavailable).toBe(false)
    expect(decodeScopedGraphCursor(result.nextCursor, scope({ subjectId: OWNER }))).toEqual({
      cursor: { subjectId: OWNER, direction: 'followers', createdAt: STAMP, id: rows[displayed - 1]!.id },
      error: null,
    })
    expect(result.items).toHaveLength(displayed)
  })

  it('does not infer another page from a positive count without an eligible lookahead row', async () => {
    queuePage('followers', [providerPeer()], { counts: [providerCounts(99, 0, 0)] })
    expect(await getOwnGraphPage('followers', { limit: 1 })).toMatchObject({
      items: [{ id: PEER }], total: 99, nextCursor: null, error: null, unavailable: false,
    })
  })

  it('preserves six-digit follow-peer boundaries and permits honest count changes between RPCs', async () => {
    const leading = providerPeer(uuid(200), { created_at: '2026-11-01T07:00:00.123457Z' })
    const boundaryRow = providerPeer(PEER, {
      created_at: OFFSET_STAMP, bio: 'PRIVATE biography', user_id: 'PRIVATE user',
      visibility: 'PRIVATE unused provider field', follower_count: 999,
    })
    const older = providerPeer(uuid(300), { created_at: '2026-11-01T07:00:00.123455Z' })
    queuePage('followers', [leading, boundaryRow, older], { counts: [providerCounts(3, 0, 0)] })
    const first = await getOwnGraphPage('followers', { limit: 2 })
    expect(first.items.map(row => row.id)).toEqual([leading.id, PEER])
    expect(first.items[1]).toEqual({
      id: PEER, person: {
        id: PEER, username: boundaryRow.username, display_name: boundaryRow.display_name,
        avatar_url: null, headline: null,
      },
      created_at: STAMP, connectionId: null,
    })
    expect(JSON.stringify(first)).not.toContain('PRIVATE')
    expect(decodeScopedGraphCursor(first.nextCursor, scope({ subjectId: OWNER }))).toEqual({
      cursor: { subjectId: OWNER, direction: 'followers', createdAt: STAMP, id: PEER }, error: null,
    })
    queuePage('followers', [older], { counts: [providerCounts(2, 0, 0)] })
    const second = await getOwnGraphPage('followers', { cursor: first.nextCursor, limit: 2 })
    expect(second).toMatchObject({
      items: [{ id: older.id }], total: 2, nextCursor: null, error: null, unavailable: false,
    })
    expect(boundary.rpcs).toEqual([
      { name: 'profile_graph_counts', args: { p_subject: OWNER } },
      { name: 'profile_follow_page', args: {
        p_subject: OWNER, p_direction: 'followers', p_limit: 2,
        p_after_created_at: null, p_after_id: null,
      } },
      { name: 'profile_graph_counts', args: { p_subject: OWNER } },
      { name: 'profile_follow_page', args: {
        p_subject: OWNER, p_direction: 'followers', p_limit: 2,
        p_after_created_at: STAMP, p_after_id: PEER,
      } },
    ])
  })

  it('uses real connection IDs, not peer IDs, for equal-time ordering and continuation', async () => {
    const rows = [
      providerPeer(PEER, { connection_id: uuid(900), created_at: OFFSET_STAMP }),
      providerPeer(uuid(300), { connection_id: uuid(800) }),
      providerPeer(uuid(200), { connection_id: uuid(700) }),
    ]
    queuePage('connections', rows, { counts: [providerCounts(0, 0, 3)] })
    const first = await getOwnGraphPage('connections', { limit: 2 })
    expect(first.items.map(row => [row.id, row.connectionId])).toEqual([
      [PEER, uuid(900)], [uuid(300), uuid(800)],
    ])
    const target = scope({ subjectId: OWNER, direction: 'connections' })
    expect(decodeScopedGraphCursor(first.nextCursor, target)).toEqual({
      cursor: { subjectId: OWNER, direction: 'connections', createdAt: STAMP, id: uuid(800) },
      error: null,
    })
    queuePage('connections', [rows[2]], { counts: [providerCounts(0, 0, 3)] })
    expect(await getOwnGraphPage('connections', { cursor: first.nextCursor, limit: 2 })).toMatchObject({
      items: [{ id: uuid(200), connectionId: uuid(700) }],
      total: 3, nextCursor: null, error: null, unavailable: false,
    })
    expect(boundary.rpcs.filter(call => call.name === 'my_connection_page')).toEqual([
      { name: 'my_connection_page', args: { p_after_created_at: null, p_after_id: null, p_limit: 2 } },
      { name: 'my_connection_page', args: { p_after_created_at: STAMP, p_after_id: uuid(800), p_limit: 2 } },
    ])
    expect(boundary.rpcs.every(call => call.name !== 'profile_follow_page')).toBe(true)
  })

  it.each([
    ['null data', null], ['object data', {}], ['null row', [null]],
    ['invalid ID', [providerPeer('prf_local')]],
    ['blank name', [providerPeer(PEER, { display_name: ' ' })]],
    ['missing projected headline', [providerPeer(PEER, { headline: undefined })]],
    ['invalid timestamp', [providerPeer(PEER, { created_at: '2026-11-01T07:00:00' })]],
    ['lossy timestamp', [providerPeer(PEER, { created_at: '2026-11-01T07:00:00.1234567Z' })]],
    ['duplicate peer', [providerPeer(), providerPeer(PEER, { created_at: '2026-11-01T07:00:00.123455Z' })]],
    ['subject self row', [providerPeer(OWNER)]],
    ['ascending ID tie', [providerPeer(PEER), providerPeer(SECOND_PEER)]],
    ['newer row after older', [providerPeer(), providerPeer(SECOND_PEER, { created_at: '2026-11-01T07:00:00.123457Z' })]],
    ['more than one lookahead', [providerPeer(uuid(104)), providerPeer(uuid(103)), providerPeer(uuid(102)), providerPeer(uuid(101))]],
  ])('fails the entire page on %s instead of filtering corrupt provider rows into empty success', async (_label, rows) => {
    queuePage('followers', rows)
    expect(await getOwnGraphPage('followers', { limit: 2 })).toEqual(failedPage(summary(providerSubject())))
  })

  it.each([undefined, 'con_local', ''])('requires a real UUID connection handle, not %j', async connectionId => {
    queuePage('connections', [providerPeer(PEER, { connection_id: connectionId })])
    expect(await getOwnGraphPage('connections')).toEqual(failedPage(summary(providerSubject())))
  })

  it.each([
    providerPeer(PEER),
    providerPeer(SECOND_PEER),
    providerPeer(uuid(100), { created_at: '2026-11-01T07:00:00.123457Z' }),
  ])('rejects rows at or ahead of the exact cursor tuple (%j)', async row => {
    queuePage('followers', [row])
    expect(await getOwnGraphPage('followers', {
      cursor: scopedToken(scope({ subjectId: OWNER })), limit: 2,
    })).toEqual(failedPage(summary(providerSubject())))
  })

  it('reports a page RPC error with no success items, total or continuation', async () => {
    queuePage('following', [providerPeer()], { error: { code: 'synthetic_page_failure' } })
    expect(await getOwnGraphPage('following')).toEqual(failedPage(summary(providerSubject())))
  })
})

describe('reader/provider/subject/direction scoped cursor boundary', () => {
  const foreignScopes: Array<[string, Partial<GraphScope>]> = [
    ['another reader', { viewerId: OTHER }],
    ['anonymous reader', { viewerId: null }],
    ['another subject', { subjectId: OTHER }],
    ['another direction', { direction: 'following' as GraphDirection }],
    ['connections direction', { direction: 'connections' as GraphDirection }],
    ['another provider', { provider: 'local' }],
  ]
  it.each(foreignScopes)('rechecks authorization and rejects %s without issuing a page RPC', async (_label, changes) => {
    enqueue('table:profiles', reply(providerSubject(SUBJECT)))
    enqueue('rpc:profile_graph_counts', reply([providerCounts(0, 0, null)]))
    const cursor = scopedToken(scope(changes))
    expect(await getPublicGraphPage('subject', 'followers', { cursor }))
      .toEqual(failedPage(summary(providerSubject(SUBJECT)), GRAPH_SCOPE_ERROR))
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: SUBJECT } }])
  })

  it('accepts the same anonymous scope but rejects that token after a reader signs in', async () => {
    boundary.getUser.mockResolvedValue(null)
    const cursor = scopedToken(scope({ viewerId: null }))
    queuePage('followers', [], { subject: providerSubject(SUBJECT), counts: [providerCounts(0, 0, null)] })
    expect(await getPublicGraphPage('subject', 'followers', { cursor })).toMatchObject({
      items: [], total: 0, nextCursor: null, error: null, unavailable: false,
    })
    boundary.getUser.mockResolvedValue({ id: OWNER })
    enqueue('table:profiles', reply(providerSubject(SUBJECT)))
    enqueue('rpc:profile_graph_counts', reply([providerCounts(0, 0, null)]))
    expect(await getPublicGraphPage('subject', 'followers', { cursor }))
      .toEqual(failedPage(summary(providerSubject(SUBJECT)), GRAPH_SCOPE_ERROR))
    expect(boundary.rpcs.filter(call => call.name === 'profile_follow_page')).toHaveLength(1)
  })

  it.each([
    '', ' ', 'A', 'not a cursor', [], {}, ['token'], 5, 'x'.repeat(2049),
    Buffer.from(JSON.stringify({ v: 2, scope: 'wrong', position: 'wrong' })).toString('base64url'),
  ])('does not silently replace present malformed cursor %j with a first page', async cursor => {
    enqueue('table:profiles', reply(providerSubject(SUBJECT)))
    enqueue('rpc:profile_graph_counts', reply([providerCounts(0, 0, null)]))
    expect(await getPublicGraphPage('subject', 'followers', { cursor }))
      .toEqual(failedPage(summary(providerSubject(SUBJECT)), GRAPH_CURSOR_ERROR))
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: SUBJECT } }])
  })

  it('refuses an otherwise valid unscoped position instead of accepting a legacy cross-reader cursor', async () => {
    const encoded = encodeGraphCursor({
      subjectId: SUBJECT, direction: 'followers', createdAt: STAMP, id: PEER,
    })
    expect(encoded.error).toBeNull()
    if (encoded.cursor === null) throw new Error('Valid inner fixture cursor was refused.')
    enqueue('table:profiles', reply(providerSubject(SUBJECT)))
    enqueue('rpc:profile_graph_counts', reply([providerCounts(0, 0, null)]))
    expect(await getPublicGraphPage('subject', 'followers', { cursor: encoded.cursor }))
      .toEqual(failedPage(summary(providerSubject(SUBJECT)), GRAPH_CURSOR_ERROR))
    expect(boundary.rpcs).toEqual([{ name: 'profile_graph_counts', args: { p_subject: SUBJECT } }])
  })

  it('rejects a hosted token in actual local mode, not only in a pure codec call', async () => {
    const viewer = localProfile('viewer', { id: OWNER })
    const subject = localProfile('subject', { id: SUBJECT })
    useLocal(snapshot(viewer, subject), viewer.user_id)
    expect(await getPublicGraphPage(subject.username, 'followers', { cursor: scopedToken(scope()) }))
      .toEqual(failedPage({
        id: subject.id, username: subject.username, display_name: subject.display_name,
        avatar_url: null, headline: null,
      }, GRAPH_SCOPE_ERROR))
    expect(boundary.createClient).not.toHaveBeenCalled()
  })
})

describe('actual-viewer and at-most-50-page-peer relationship controls', () => {
  it('uses exact own-party predicates, minimal projections and real IDs for every legitimate state', async () => {
    const ids = [uuid(101), uuid(102), uuid(103), uuid(104), uuid(105)]
    enqueue('table:connections', reply([
      { id: uuid(501), requester_id: ids[0], addressee_id: OWNER, status: 'pending', message: 'PRIVATE request' },
      { id: uuid(502), requester_id: OWNER, addressee_id: ids[1], status: 'pending' },
      { id: uuid(503), requester_id: ids[2], addressee_id: OWNER, status: 'accepted' },
      { id: uuid(504), requester_id: OWNER, addressee_id: ids[3], status: 'rejected' },
    ]))
    enqueue('table:follows', reply([{ following_id: ids[0] }, { following_id: ids[4] }]))
    const result = await getPageRelationships([...ids.map(id => item(id)), item(OWNER), item(ids[2])])
    expect(result).toEqual({
      viewerId: OWNER, relationships: {
        [ids[0]!]: { state: 'incoming', connectionId: uuid(501), isFollowing: true, isBlockingThem: false },
        [ids[1]!]: { state: 'outgoing', connectionId: uuid(502), isFollowing: false, isBlockingThem: false },
        [ids[2]!]: { state: 'connected', connectionId: uuid(503), isFollowing: false, isBlockingThem: false },
        [ids[3]!]: { state: 'rejected', connectionId: uuid(504), isFollowing: false, isBlockingThem: false },
        [ids[4]!]: { state: 'none', connectionId: null, isFollowing: true, isBlockingThem: false },
      }, error: null,
    })
    expectControlsQueries(ids)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.createClient).toHaveBeenCalledTimes(1)
    expect(boundary.readStore).not.toHaveBeenCalled()
  })

  it('permits exactly 50 distinct current page peers without expanding the party scope', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => uuid(1000 + index))
    enqueue('table:connections', reply([]))
    enqueue('table:follows', reply([]))
    const result = await getPageRelationships(ids.map(id => item(id)))
    expect(result.viewerId).toBe(OWNER)
    expect(result.error).toBeNull()
    expect(Object.keys(result.relationships)).toEqual(ids)
    for (const id of ids) {
      expect(result.relationships[id]).toEqual({
        state: 'none', connectionId: null, isFollowing: false, isBlockingThem: false,
      })
    }
    expectControlsQueries(ids)
  })

  it.each([
    Array.from({ length: 51 }, () => item()),
    [item('')], [item('prf_local')], [item(`${PEER},${OTHER}`)], [item(`${PEER}\n`)],
  ].map(items => [items] as const))('refuses invalid/raw-over-50 scope before provider reads (%j)', async items => {
    expect(await getPageRelationships(items)).toEqual({ viewerId: OWNER, relationships: {}, error: STATE_ERROR })
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(boundary.queries).toEqual([])
  })

  it.each([[], [item(OWNER)]].map(items => [items] as const))('does not query for empty/self-only page scope %j', async items => {
    expect(await getPageRelationships(items)).toEqual({ viewerId: OWNER, relationships: {}, error: null })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  const connectedRow = { id: uuid(501), requester_id: OWNER, addressee_id: PEER, status: 'accepted' }
  const malformedControlReplies: Array<[string, ApiResponse, ApiResponse]> = [
    ['connections provider error', reply([connectedRow], { code: 'synthetic_controls_failure' }), reply([])],
    ['follows provider error', reply([connectedRow]), reply([], { code: 'synthetic_follow_failure' })],
    ['nonarray connections', reply(null), reply([])],
    ['nonarray follows', reply([]), reply({})],
    ['foreign parties', reply([{ ...connectedRow, requester_id: OTHER }]), reply([])],
    ['unrequested peer', reply([{ ...connectedRow, addressee_id: OTHER }]), reply([])],
    ['invalid real handle', reply([{ ...connectedRow, id: 'con_fake' }]), reply([])],
    ['invalid status', reply([{ ...connectedRow, status: 'unknown' }]), reply([])],
    ['duplicate peer state', reply([connectedRow, { ...connectedRow, id: uuid(502) }]), reply([])],
    ['unrequested follow', reply([]), reply([{ following_id: OTHER }])],
    ['duplicate follow', reply([]), reply([{ following_id: PEER }, { following_id: PEER }])],
    ['missing follow ID', reply([]), reply([{}])],
    ['too many connection rows', reply([connectedRow, connectedRow, connectedRow]), reply([])],
    ['too many follow rows', reply([]), reply([{ following_id: PEER }, { following_id: SECOND_PEER }, { following_id: OTHER }])],
  ]
  it.each(malformedControlReplies)('hides controls on %s; never fabricates none for an error', async (_label, connections, follows) => {
    enqueue('table:connections', connections)
    enqueue('table:follows', follows)
    expect(await getPageRelationships([item(), item(SECOND_PEER)]))
      .toEqual({ viewerId: OWNER, relationships: {}, error: STATE_ERROR })
    expectControlsQueries([PEER, SECOND_PEER])
  })

  it('rejects a non-string provider status instead of coercing it (draft contract defect)', async () => {
    enqueue('table:connections', reply([{ ...connectedRow, status: ['accepted'] }]))
    enqueue('table:follows', reply([]))
    expect(await getPageRelationships([item()])).toEqual({
      viewerId: OWNER, relationships: {}, error: STATE_ERROR,
    })
    expectControlsQueries([PEER])
  })

  it('returns an explicit controls error on a thrown ordinary query, not an invented none map', async () => {
    enqueue('table:connections', new Error('PRIVATE query transport detail'))
    enqueue('table:follows', reply([]))
    expect(await getPageRelationships([item()])).toEqual({
      viewerId: null, relationships: {}, error: STATE_ERROR,
    })
    expectControlsQueries([PEER])
  })
})

describe('real in-memory local snapshots through the server boundary', () => {
  it('binds the authenticated user to its stored profile ID and ignores persisted raw counters', async () => {
    const viewer = Object.assign(localProfile('viewer', { visibility: 'private' }), {
      follower_count: 999, following_count: 888, connection_count: 777,
    })
    const peer = localProfile('peer')
    const outside = localProfile('outside')
    const db = snapshot(viewer, peer, outside)
    db.follows.push(localFollow(peer, viewer, 'incoming'), localFollow(viewer, peer, 'outgoing'))
    db.connections.push(
      localConnection('con_real', peer, viewer),
      localConnection('con_foreign', peer, outside),
    )
    const before = structuredClone(db)
    useLocal(freeze(db), viewer.user_id)
    expect(await getGraphCounts(viewer.id)).toEqual({
      counts: { follower_count: 1, following_count: 1, connection_count: 1 },
      error: null, unavailable: false,
    })
    const page = await getOwnGraphPage('connections')
    expect(page).toEqual({
      subject: {
        id: viewer.id, username: viewer.username, display_name: viewer.display_name,
        avatar_url: null, headline: null,
      },
      items: [{
        id: peer.id, person: {
          id: peer.id, username: peer.username, display_name: peer.display_name,
          avatar_url: null, headline: null,
        },
        created_at: STAMP, connectionId: 'con_real',
      }],
      total: 1, nextCursor: null, error: null, unavailable: false,
    })
    expect(await getPageRelationships(page.items)).toEqual({
      viewerId: viewer.id, relationships: {
        [peer.id]: { state: 'connected', connectionId: 'con_real', isFollowing: true, isBlockingThem: false },
      }, error: null,
    })
    expect(JSON.stringify(page)).not.toContain('PRIVATE')
    expect(db).toEqual(before)
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(boundary.queries).toEqual([])
    expect(boundary.rpcs).toEqual([])
  })

  it('omits persisted private/blocked/suspended/deleting/disabled/orphan peers before counts or lookahead', async () => {
    const viewer = localProfile('viewer')
    const subject = localProfile('subject')
    const visible = localProfile('visible')
    const hidden = localProfile('hidden', { visibility: 'private' })
    const blocked = localProfile('blocked')
    const suspended = localProfile('suspended')
    const deleting = localProfile('deleting')
    const disabled = localProfile('disabled')
    const orphan = localProfile('orphan')
    const peers = [visible, hidden, blocked, suspended, deleting, disabled, orphan]
    const db = snapshot(viewer, subject, ...peers)
    for (const peer of peers) {
      db.follows.push(localFollow(peer, subject, `in${peer.username}`))
      db.follows.push(localFollow(subject, peer, `out${peer.username}`))
      db.connections.push(localConnection(`con_${peer.username}`, viewer, peer))
    }
    db.blocks.push({
      id: 'blk_real', blocker_id: blocked.id, blocked_id: viewer.id,
      reason: 'PRIVATE block reason', created_at: STAMP,
    })
    db.profile_account_states.push({
      id: 'ast_real', profile_id: suspended.id, status: 'suspended',
      suspended_until: '2026-11-03T00:00:00.000Z', warning_count: 0,
    })
    db.account_deletion_jobs.push({
      id: 'del_real', user_id: deleting.user_id, profile_id: deleting.id,
      idempotency_key: null, policy_version: 'bulla-account-lifecycle-v1',
      state: 'queued', phase: 'content', attempts: 0,
      created_at: STAMP, updated_at: STAMP, next_attempt_at: STAMP,
      lease_expires_at: null, lease_token: null, error_code: null, completed_at: null,
    })
    db.users = db.users.filter(row => row.id !== orphan.user_id).map(row =>
      row.id === disabled.user_id ? { ...row, disabled_at: NOW } : row)
    useLocal(db, viewer.user_id)
    expect(await getGraphCounts(subject.id)).toEqual({
      counts: { follower_count: 1, following_count: 1, connection_count: null },
      error: null, unavailable: false,
    })
    for (const direction of ['followers', 'following'] as const) {
      const result = await getPublicGraphPage(subject.username, direction, { limit: 1 })
      expect(result.items.map(row => row.id)).toEqual([visible.id])
      expect(result).toMatchObject({ total: 1, nextCursor: null, error: null, unavailable: false })
    }
    const own = await getOwnGraphPage('connections', { limit: 1 })
    expect(own.items.map(row => [row.id, row.connectionId])).toEqual([[visible.id, 'con_visible']])
    expect(own).toMatchObject({ total: 1, nextCursor: null, error: null, unavailable: false })
    const controls = await getPageRelationships(peers.map(peer => item(peer.id)))
    expect(controls).toEqual({
      viewerId: viewer.id, relationships: {
        [visible.id]: { state: 'connected', connectionId: 'con_visible', isFollowing: false, isBlockingThem: false },
      }, error: null,
    })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('does not expose another private subject or any foreign connections even to an accepted contact', async () => {
    const viewer = localProfile('viewer')
    const subject = localProfile('subject', { visibility: 'private' })
    const peer = localProfile('peer')
    const db = snapshot(viewer, subject, peer)
    db.connections.push(localConnection('con_access', viewer, subject), localConnection('con_foreign', subject, peer))
    useLocal(db, viewer.user_id)
    expect(await getGraphCounts(subject.id)).toEqual({ counts: null, error: null, unavailable: true })
    expect(await getPublicGraphPage(subject.username, 'followers')).toEqual(unavailablePage())
    db.profiles[1] = { ...subject, visibility: 'public' }
    expect(await getGraphCounts(subject.id)).toEqual({
      counts: { follower_count: 0, following_count: 0, connection_count: null },
      error: null, unavailable: false,
    })
    expect(await getPublicGraphPage(subject.username, 'connections' as 'followers')).toEqual(unavailablePage())
    expect((await getOwnGraphPage('connections')).items.map(row => row.connectionId)).toEqual(['con_access'])
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('does not default a corrupt visible local connection handle to none', async () => {
    const viewer = localProfile('viewer')
    const peer = localProfile('peer')
    const db = snapshot(viewer, peer)
    db.connections.push(localConnection('not-a-real-id', viewer, peer))
    useLocal(db, viewer.user_id)
    const result = await getPageRelationships([item(peer.id)])
    expect(result.viewerId).toBe(viewer.id)
    expect(result.relationships).toEqual({})
    expect(result.error).toBe('Some page relationship states could not be read.')
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('keeps local counts/lists unavailable for a stale actor instead of reading anonymously', async () => {
    const subject = localProfile('subject')
    const viewer = localProfile('viewer')
    const db = snapshot(subject, viewer)
    useLocal(db, 'usr_missing')
    expect(await getGraphCounts(subject.id)).toEqual({ counts: null, error: null, unavailable: true })
    expect(await getPublicGraphPage(subject.username, 'followers')).toEqual(unavailablePage())
    expect(await getOwnGraphPage('connections')).toEqual(unavailablePage())
    expect(await getPageRelationships([item(subject.id)])).toEqual({ viewerId: null, relationships: {}, error: null })
    useLocal(db, null)
    expect(await getPublicGraphPage(subject.username, 'followers')).toMatchObject({
      total: 0, error: null, unavailable: false,
    })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('wraps local continuation in actual reader scope and reauthorizes after a new subject block', async () => {
    const viewer = localProfile('viewer')
    const subject = localProfile('subject')
    const alpha = localProfile('alpha')
    const beta = localProfile('beta')
    const db = snapshot(viewer, subject, alpha, beta)
    db.follows.push(localFollow(alpha, subject, 'alpha'), localFollow(beta, subject, 'beta', OFFSET_STAMP))
    useLocal(db, viewer.user_id)
    const first = await getPublicGraphPage(subject.username, 'followers', { limit: 1 })
    expect(first.items.map(row => row.id)).toEqual([beta.id])
    expect(decodeScopedGraphCursor(first.nextCursor, scope({
      provider: 'local', viewerId: viewer.id, subjectId: subject.id,
    }))).toEqual({
      cursor: { subjectId: subject.id, direction: 'followers', createdAt: STAMP, id: beta.id },
      error: null,
    })
    const second = await getPublicGraphPage(subject.username, 'followers', { cursor: first.nextCursor, limit: 1 })
    expect(second).toMatchObject({
      items: [{ id: alpha.id }], total: 2, nextCursor: null, error: null, unavailable: false,
    })
    db.blocks.push({
      id: 'blk_subject', blocker_id: subject.id, blocked_id: viewer.id,
      reason: null, created_at: STAMP,
    })
    expect(await getPublicGraphPage(subject.username, 'followers', { cursor: first.nextCursor })).toEqual(unavailablePage())
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('normalizes an omitted legacy subject headline to null (draft type/DTO defect)', async () => {
    const viewer = localProfile('legacy', { visibility: 'private' })
    delete viewer.headline
    useLocal(snapshot(viewer), viewer.user_id)
    expect(await getOwnGraphPage('followers')).toEqual({
      subject: {
        id: viewer.id, username: viewer.username, display_name: viewer.display_name,
        avatar_url: null, headline: null,
      },
      items: [], total: 0, nextCursor: null, error: null, unavailable: false,
    })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })

  it('returns honest local snapshot errors without querying the hosted provider', async () => {
    const viewer = localProfile('viewer')
    useLocal(snapshot(viewer), viewer.user_id)
    boundary.readStore.mockRejectedValue(new Error('PRIVATE snapshot failure'))
    expect(await getGraphCounts(viewer.id)).toEqual({ counts: null, error: COUNT_ERROR, unavailable: false })
    expect(await getOwnGraphPage('following')).toEqual(failedPage(null))
    expect(await getPageRelationships([item('prf_peer')])).toEqual({ viewerId: null, relationships: {}, error: STATE_ERROR })
    expect(boundary.createClient).not.toHaveBeenCalled()
  })
})

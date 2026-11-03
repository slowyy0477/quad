/**
 * PROPOSAL ONLY, 2026-11-02. Authored, NOT RUN/typechecked/linted.
 * Intended path: src/features/connections/graph-local.test.ts.
 * Fresh in-memory rows and a fake clock only. No session/store/provider runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProfile, Tables } from '@/lib/local/db'
import {
  getLocalScopedRelationships, localGraphCounts, localGraphPage,
  type LocalGraphSnapshot,
} from './graph-local'
import {
  decodeGraphCursor, encodeGraphCursor, GRAPH_CURSOR_ERROR, GRAPH_DIRECTION_ERROR,
  GRAPH_SCOPE_ERROR, type GraphCursor, type GraphDirection,
} from './graph-paging'

type Fixture = {
  -readonly [K in keyof LocalGraphSnapshot]: Array<LocalGraphSnapshot[K][number]>
}
type Connection = Tables['connections'][number]
type AccountState = Tables['profile_account_states'][number]
type DeletionJob = Tables['account_deletion_jobs'][number]

const NOW = '2026-11-02T07:00:00.000Z'
const STAMP = '2026-11-01T07:00:00.123456Z'

function profile(label: string, overrides: Partial<LocalProfile> = {}): LocalProfile {
  return {
    id: `prf_${label}`, user_id: `usr_${label}`, username: label,
    display_name: `Student ${label}`, bio: null, avatar_url: null,
    university_id: 'uni_home', department: null, programme: null, semester: null,
    website: null, github: null, visibility: 'public', searchable: true,
    created_at: STAMP, headline: null, ...overrides,
  }
}

function user(person: LocalProfile): Tables['users'][number] {
  return {
    id: person.user_id, email: `${person.username}@pure-fixture.invalid`,
    password_hash: 'pure-fixture-not-an-authentication-secret',
    created_at: STAMP, disabled_at: null,
  }
}

function fixture(...people: LocalProfile[]): Fixture {
  return {
    users: people.map(user), profiles: [...people], follows: [], connections: [],
    blocks: [], profile_account_states: [], account_deletion_jobs: [],
  }
}

function id(person: LocalProfile | string): string {
  return typeof person === 'string' ? person : person.id
}

function follow(
  rowId: string, from: LocalProfile | string, to: LocalProfile | string,
  at = STAMP,
): Tables['follows'][number] {
  return { id: rowId, follower_id: id(from), following_id: id(to), created_at: at }
}

function connection(
  rowId: string, from: LocalProfile | string, to: LocalProfile | string,
  status: Connection['status'] = 'accepted', at = STAMP,
): Connection {
  return {
    id: rowId, requester_id: id(from), addressee_id: id(to), status,
    message: 'PRIVATE fixture request message, never a graph DTO field',
    created_at: at, responded_at: status === 'pending' ? null : at,
  }
}

function block(
  from: LocalProfile, to: LocalProfile, rowId = 'blk_001', at = STAMP,
): Tables['blocks'][number] {
  return {
    id: rowId, blocker_id: from.id, blocked_id: to.id,
    reason: 'PRIVATE fixture block reason', created_at: at,
  }
}

function accountState(
  person: LocalProfile, status: AccountState['status'] = 'suspended',
  until: string | null = null,
): AccountState {
  return {
    id: `ast_${person.username}`, profile_id: person.id, status,
    suspended_until: until, warning_count: 0,
  }
}

function deletion(
  person: LocalProfile, state: DeletionJob['state'] = 'queued',
  overrides: Partial<DeletionJob> = {},
): DeletionJob {
  return {
    id: `del_${person.username}`, user_id: person.user_id, profile_id: person.id,
    idempotency_key: null, policy_version: 'bulla-account-lifecycle-v1',
    state, phase: state === 'completed' ? 'complete' : 'content', attempts: 0,
    created_at: STAMP, updated_at: STAMP, next_attempt_at: STAMP,
    lease_expires_at: null, lease_token: null, error_code: null,
    completed_at: state === 'completed' ? STAMP : null, ...overrides,
  }
}

function encoded(cursor: GraphCursor): string {
  const result = encodeGraphCursor(cursor)
  expect(result.error).toBeNull()
  if (result.cursor === null) throw new Error('Valid fixture cursor was refused.')
  return result.cursor
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) frozen(entry)
    Object.freeze(value)
  }
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('local graph authorization and projection', () => {
  it('permits an available owner of a private subject but exposes no other connections aggregate', () => {
    const subject = profile('subject', { visibility: 'private' })
    const alpha = profile('alpha')
    const beta = profile('beta')
    const viewer = profile('viewer')
    const db = fixture(subject, alpha, beta, viewer)
    db.follows.push(follow('fol_in', alpha, subject), follow('fol_out', subject, beta))
    db.connections.push(connection('con_real', alpha, subject))

    expect(localGraphCounts(db, subject, subject)).toEqual({
      follower_count: 1, following_count: 1, connection_count: 1,
    })
    expect(localGraphPage(db, subject, subject, 'connections')).toMatchObject({
      items: [{ id: alpha.id, connectionId: 'con_real' }],
      total: 1, nextCursor: null, error: null, unavailable: false,
    })
    expect(localGraphCounts(db, subject, viewer)).toBeNull()

    db.profiles[0] = { ...subject, visibility: 'public' }
    expect(localGraphCounts(db, subject, viewer)).toEqual({
      follower_count: 1, following_count: 1, connection_count: null,
    })
    for (const actor of [viewer, null]) {
      expect(localGraphPage(db, subject, actor, 'followers')).toMatchObject({
        items: [{ id: alpha.id }], total: 1, unavailable: false, error: null,
      })
      expect(localGraphPage(db, subject, actor, 'connections')).toEqual({
        items: [], nextCursor: null, total: null, error: null, unavailable: true,
      })
    }
  })

  it.each(['private', 'university', 'connections'] as const)(
    'refuses another %s subject even to a same-campus accepted contact', visibility => {
      const subject = profile('subject', { visibility })
      const viewer = profile('viewer')
      const peer = profile('peer')
      const db = fixture(subject, viewer, peer)
      db.connections.push(connection('con_access', viewer, subject))
      db.follows.push(follow('fol_in', peer, subject))
      expect(localGraphCounts(db, subject, viewer)).toBeNull()
      for (const direction of ['followers', 'following', 'connections'] as const) {
        expect(localGraphPage(db, subject, viewer, direction)).toMatchObject({
          items: [], total: null, error: null, unavailable: true,
        })
      }
    },
  )

  it('has no staff-looking profile flag override for private social reads', () => {
    const subject = profile('subject', { visibility: 'private' })
    const staff = Object.assign(profile('staff'), { role: 'admin', is_moderator: true })
    const db = fixture(subject, staff)
    expect(localGraphCounts(db, subject, staff)).toBeNull()
    expect(localGraphPage(db, subject, staff, 'followers').unavailable).toBe(true)
    expect(localGraphPage(db, subject, staff, 'connections').unavailable).toBe(true)
  })

  it('uses ordinary peer visibility, never a blanket social/private-peer override', () => {
    const subject = profile('subject')
    const publicPeer = profile('public')
    const campus = profile('campus', { visibility: 'university' })
    const foreign = profile('foreign', { visibility: 'university', university_id: 'uni_other' })
    const linked = profile('linked', { visibility: 'connections' })
    const unlinked = profile('unlinked', { visibility: 'connections' })
    const privatePeer = profile('private', { visibility: 'private' })
    const viewer = profile('viewer')
    const db = fixture(subject, publicPeer, campus, foreign, linked, unlinked, privatePeer, viewer)
    for (const peer of [publicPeer, campus, foreign, linked, unlinked, privatePeer]) {
      db.follows.push(follow(`fol_${peer.username}`, peer, subject))
    }
    db.connections.push(
      connection('con_linked', subject, linked),
      connection('con_private', subject, privatePeer),
    )
    expect(localGraphPage(db, subject, subject, 'followers').items.map(row => row.id).sort())
      .toEqual([campus.id, linked.id, publicPeer.id].sort())
    expect(localGraphCounts(db, subject, subject)?.connection_count).toBe(1)
    expect(localGraphPage(db, subject, viewer, 'followers').items.map(row => row.id).sort())
      .toEqual([campus.id, publicPeer.id].sort())
    expect(localGraphPage(db, subject, null, 'followers').items.map(row => row.id))
      .toEqual([publicPeer.id])
  })

  it('omits a private viewer self edge on somebody else’s public list in both directions', () => {
    const subject = profile('subject')
    const viewer = profile('viewer', { visibility: 'private' })
    const db = fixture(subject, viewer)
    db.follows.push(follow('fol_in', viewer, subject), follow('fol_out', subject, viewer))
    expect(localGraphCounts(db, subject, viewer)).toEqual({
      follower_count: 0, following_count: 0, connection_count: null,
    })
    for (const direction of ['followers', 'following'] as const) {
      expect(localGraphPage(db, subject, viewer, direction)).toMatchObject({
        items: [], total: 0, error: null, unavailable: false,
      })
    }
    expect(localGraphCounts(db, viewer, viewer)).toEqual({
      follower_count: 1, following_count: 1, connection_count: 0,
    })
  })

  it.each(['viewer-to-peer', 'peer-to-viewer', 'subject-to-peer', 'peer-to-subject'] as const)(
    'filters bilateral %s blocks before counting or paging, even with a corrupt block date/ID', relation => {
      const subject = profile('subject')
      const viewer = profile('viewer')
      const peer = profile('peer')
      const db = fixture(subject, viewer, peer)
      db.follows.push(follow('fol_in', peer, subject))
      const endpoints = {
        'viewer-to-peer': [viewer, peer], 'peer-to-viewer': [peer, viewer],
        'subject-to-peer': [subject, peer], 'peer-to-subject': [peer, subject],
      }[relation]
      db.blocks.push(block(endpoints[0]!, endpoints[1]!, 'malformed-id', 'malformed-time'))
      expect(localGraphCounts(db, subject, viewer)?.follower_count).toBe(0)
      expect(localGraphPage(db, subject, viewer, 'followers')).toMatchObject({
        items: [], total: 0, nextCursor: null, unavailable: false, error: null,
      })
    },
  )

  it.each([false, true])('refuses a viewer/subject block in either direction (reverse=%s)', reverse => {
    const subject = profile('subject')
    const viewer = profile('viewer')
    const db = fixture(subject, viewer)
    db.blocks.push(reverse ? block(subject, viewer) : block(viewer, subject))
    expect(localGraphCounts(db, subject, viewer)).toBeNull()
    expect(localGraphPage(db, subject, viewer, 'following').unavailable).toBe(true)
  })

  it('resolves subject/viewer ownership and visibility from stored rows, not stale supplied fields', () => {
    const subject = profile('subject')
    const viewer = profile('viewer')
    const db = fixture(subject, viewer)
    db.follows.push(follow('fol_in', viewer, subject))
    db.profiles[1] = { ...viewer, visibility: 'private' }
    expect(localGraphPage(db, subject, viewer, 'followers').items).toEqual([])
    db.profiles[0] = { ...subject, visibility: 'private' }
    expect(localGraphCounts(db, subject, viewer)).toBeNull()
    expect(localGraphCounts(db, { ...subject, user_id: viewer.user_id }, subject)).toBeNull()
    expect(localGraphCounts(db, subject, { ...subject, user_id: viewer.user_id })).toBeNull()
    expect(localGraphCounts(db, subject, subject)).toEqual({
      follower_count: 0, following_count: 0, connection_count: 0,
    })
  })

  it('distinguishes unavailable subjects from authorized empty graphs and ignores stale raw counters', () => {
    const subject = Object.assign(profile('subject'), {
      follower_count: 999, following_count: 888, connection_count: 777,
    })
    const db = fixture(subject)
    expect(localGraphCounts(db, subject, subject)).toEqual({
      follower_count: 0, following_count: 0, connection_count: 0,
    })
    expect(localGraphPage(db, subject, subject, 'followers')).toEqual({
      items: [], nextCursor: null, total: 0, error: null, unavailable: false,
    })
    expect(localGraphPage(db, profile('missing'), subject, 'followers')).toEqual({
      items: [], nextCursor: null, total: null, error: null, unavailable: true,
    })
  })

  it('returns freshly projected minimal people and real connection handles without private fields', () => {
    const subject = profile('subject')
    const peer = profile('peer', {
      bio: 'PRIVATE biography', website: 'PRIVATE website', github: 'PRIVATE link',
      avatar_url: null, headline: 'Public headline',
    })
    const db = fixture(subject, peer)
    db.connections.push(connection('con_real', subject, peer))
    const result = localGraphPage(db, subject, subject, 'connections')
    expect(result.items).toEqual([{
      id: peer.id, connectionId: 'con_real', created_at: STAMP,
      person: {
        id: peer.id, username: peer.username, display_name: peer.display_name,
        avatar_url: null, headline: 'Public headline',
      },
    }])
    expect(Object.keys(result.items[0]!.person).sort())
      .toEqual(['avatar_url', 'display_name', 'headline', 'id', 'username'])
    expect(result.items[0]!.person).not.toBe(peer)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
})

describe('strict local graph account availability', () => {
  const refusals: Array<[string, (db: Fixture, person: LocalProfile) => void]> = [
    ['missing backing user', (db, person) => {
      db.users = db.users.filter(row => row.id !== person.user_id)
    }],
    ['disabled backing user', (db, person) => {
      db.users = db.users.map(row => row.id === person.user_id ? { ...row, disabled_at: NOW } : row)
    }],
    ['ambiguous duplicate user identity', (db, person) => { db.users.push(user(person)) }],
    ['ambiguous duplicate profile identity', (db, person) => { db.profiles.push({ ...person }) }],
    ['open-ended suspension', (db, person) => { db.profile_account_states.push(accountState(person)) }],
    ['future suspension', (db, person) => {
      db.profile_account_states.push(accountState(person, 'suspended', '2026-11-03T00:00:00Z'))
    }],
    ['one-microsecond-future suspension', (db, person) => {
      db.profile_account_states.push(accountState(person, 'suspended', '2026-11-02T07:00:00.000001Z'))
    }],
    ['malformed suspension deadline', (db, person) => {
      db.profile_account_states.push(accountState(person, 'suspended', 'not-a-time'))
    }],
    ['unknown account state', (db, person) => {
      db.profile_account_states.push({
        ...accountState(person), status: 'unknown' as AccountState['status'],
      })
    }],
    ['profile-bound pending deletion without user ID', (db, person) => {
      db.account_deletion_jobs.push(deletion(person, 'queued', { user_id: null }))
    }],
    ['user-bound pending deletion without profile ID', (db, person) => {
      db.account_deletion_jobs.push(deletion(person, 'queued', { profile_id: null }))
    }],
  ]

  it.each(refusals)('refuses %s for subject/viewer and filters the same unavailable peer', (_name, refuse) => {
    for (const role of ['subject', 'viewer', 'peer'] as const) {
      const subject = profile('subject')
      const viewer = profile('viewer')
      const peer = profile('peer')
      const db = fixture(subject, viewer, peer)
      db.follows.push(follow('fol_in', peer, subject))
      refuse(db, { subject, viewer, peer }[role])
      const counts = localGraphCounts(db, subject, viewer)
      const page = localGraphPage(db, subject, viewer, 'followers')
      if (role === 'peer') {
        expect(counts?.follower_count).toBe(0)
        expect(page).toMatchObject({ items: [], total: 0, error: null, unavailable: false })
      } else {
        expect(counts).toBeNull()
        expect(page).toMatchObject({ items: [], total: null, error: null, unavailable: true })
      }
    }
  })

  it.each(['queued', 'processing', 'retry', 'blocked', 'failed'] as const)(
    'treats every unfinished deletion state %s as unavailable even after suspension expiry', state => {
      const subject = profile('subject')
      const db = fixture(subject)
      db.profile_account_states.push(accountState(subject, 'suspended', '2026-11-01T00:00:00Z'))
      db.account_deletion_jobs.push(deletion(subject, state))
      expect(localGraphCounts(db, subject, subject)).toBeNull()
      expect(localGraphPage(db, subject, subject, 'connections').unavailable).toBe(true)
    },
  )

  it.each([
    null,
    '2026-11-02T06:59:59.999999Z',
    '2026-11-02T07:00:00.000000Z',
    '2026-11-02 12:00:00.000000+05',
  ])('allows legacy active or genuinely expired/equal suspension %s without rewriting rows', until => {
    const subject = profile('subject')
    const peer = profile('peer')
    const db = fixture(subject, peer)
    if (until !== null) db.profile_account_states.push(accountState(peer, 'suspended', until))
    db.account_deletion_jobs.push(deletion(peer, 'completed'))
    db.follows.push(follow('fol_in', peer, subject))
    const before = structuredClone(db)
    expect(localGraphCounts(db, subject, subject)?.follower_count).toBe(1)
    expect(localGraphPage(db, subject, subject, 'followers').items.map(row => row.id))
      .toEqual([peer.id])
    expect(db).toEqual(before)
  })

  it('does not downgrade a disabled or orphan authenticated viewer to anonymous', () => {
    const subject = profile('subject')
    const viewer = profile('viewer')
    const db = fixture(subject, viewer)
    db.users = db.users.filter(row => row.id !== viewer.user_id)
    expect(localGraphPage(db, subject, viewer, 'followers').unavailable).toBe(true)
    expect(localGraphCounts(db, subject, viewer)).toBeNull()
    expect(localGraphPage(db, subject, null, 'followers')).toMatchObject({
      total: 0, unavailable: false, error: null,
    })
    expect(getLocalScopedRelationships(db, viewer, [subject.id])).toEqual({
      relationships: {}, error: null, unavailable: true,
    })
  })
})

describe('local graph distinct cohorts, limits and tuple continuation', () => {
  it('filters invalid/private/orphan/self rows and deduplicates valid peers before limit/lookahead', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const hidden = profile('hidden', { visibility: 'private' })
    const orphan = profile('orphan')
    const badTime = profile('badtime')
    const badId = profile('badid')
    const db = fixture(subject, alpha, beta, hidden, orphan, badTime, badId)
    db.users = db.users.filter(row => row.id !== orphan.user_id)
    db.follows.push(
      follow('fol_hidden', hidden, subject, '2026-11-01T09:00:00Z'),
      follow('fol_orphan', orphan, subject, '2026-11-01T08:00:00Z'),
      follow('fol_ghost', 'prf_ghost', subject),
      follow('fol_self', subject, subject),
      follow('fol_badtime', badTime, subject, '2026-02-30T00:00:00Z'),
      follow('not-an-id', badId, subject),
      follow('fol_alpha', alpha, subject),
      follow('fol_newalpha', alpha, subject, '2026-11-01 12:00:00.123457+05'),
      follow('fol_beta', beta, subject, '2026-11-01T07:00:00.123455Z'),
    )
    for (let index = 0; index < 30; index += 1) {
      db.follows.push(follow(`fol_copy${index}`, alpha, subject))
    }
    const first = localGraphPage(db, subject, subject, 'followers', { limit: 1 })
    expect(first).toMatchObject({
      items: [{ id: alpha.id, created_at: '2026-11-01T07:00:00.123457Z', connectionId: null }],
      total: 2, error: null, unavailable: false,
    })
    expect(first.nextCursor).not.toBeNull()
    const second = localGraphPage(db, subject, subject, 'followers', {
      limit: 1, cursor: first.nextCursor,
    })
    expect(second).toMatchObject({
      items: [{ id: beta.id }], total: 2, nextCursor: null, error: null, unavailable: false,
    })
    expect(localGraphPage(db, subject, subject, 'followers', { limit: 2 }).nextCursor).toBeNull()
    expect(localGraphCounts(db, subject, subject)?.follower_count).toBe(2)
  })

  it('pages more than 25 followers independently from a smaller asymmetric following graph', () => {
    const subject = profile('subject')
    const followers = Array.from({ length: 31 }, (_, index) => profile(`f${String(index).padStart(2, '0')}`))
    const following = Array.from({ length: 7 }, (_, index) => profile(`o${String(index).padStart(2, '0')}`))
    const db = fixture(subject, ...followers, ...following)
    followers.forEach((peer, index) => db.follows.push(follow(`fol_in${index}`, peer, subject)))
    following.forEach((peer, index) => db.follows.push(follow(`fol_out${index}`, subject, peer)))
    const first = localGraphPage(db, subject, subject, 'followers')
    const second = localGraphPage(db, subject, subject, 'followers', { cursor: first.nextCursor })
    expect(first.items).toHaveLength(25)
    expect(first.nextCursor).not.toBeNull()
    expect(second.items).toHaveLength(6)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(31)
    expect([first.total, second.total]).toEqual([31, 31])
    expect(localGraphPage(db, subject, subject, 'following')).toMatchObject({
      total: 7, nextCursor: null, error: null, unavailable: false,
    })
    expect(localGraphCounts(db, subject, subject)).toEqual({
      follower_count: 31, following_count: 7, connection_count: 0,
    })
  })

  it('clamps the local page maximum to 50 and uses only one eligible lookahead', () => {
    const subject = profile('subject')
    const peers = Array.from({ length: 51 }, (_, index) => profile(`p${String(index).padStart(2, '0')}`))
    const db = fixture(subject, ...peers)
    peers.forEach((peer, index) => db.follows.push(follow(`fol_${index}`, peer, subject)))
    const first = localGraphPage(db, subject, subject, 'followers', { limit: 999 })
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()
    const second = localGraphPage(db, subject, subject, 'followers', {
      limit: 999, cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(localGraphPage(db, subject, subject, 'followers', { limit: 0 }).items).toHaveLength(1)
  })

  it('orders exact adjacent microseconds before IDs and continues after boundary deletion/newer insertion', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const gamma = profile('gamma')
    const delta = profile('delta')
    const ahead = profile('ahead')
    const db = fixture(subject, alpha, beta, gamma, delta, ahead)
    db.follows.push(
      follow('fol_alpha', alpha, subject, '2026-11-01T07:00:00.123457Z'),
      follow('fol_beta', beta, subject, '2026-11-01T07:00:00.123456Z'),
      follow('fol_gamma', gamma, subject, '2026-11-01T07:00:00.123455Z'),
      follow('fol_delta', delta, subject, '2026-11-01T07:00:00.123454Z'),
    )
    const first = localGraphPage(db, subject, subject, 'followers', { limit: 2 })
    expect(first.items.map(row => row.id)).toEqual([alpha.id, beta.id])
    expect(decodeGraphCursor(first.nextCursor, subject.id, 'followers')).toEqual({
      cursor: { subjectId: subject.id, direction: 'followers', createdAt: STAMP, id: beta.id },
      error: null,
    })
    db.follows = db.follows.filter(row => row.id !== 'fol_beta')
    db.profiles = db.profiles.filter(row => row.id !== beta.id)
    db.follows.push(follow('fol_ahead', ahead, subject, '2026-11-01T07:00:00.123458Z'))
    const second = localGraphPage(db, subject, subject, 'followers', {
      limit: 2, cursor: first.nextCursor,
    })
    expect(second.items.map(row => row.id)).toEqual([gamma.id, delta.id])
    expect(second).toMatchObject({ total: 4, nextCursor: null, error: null, unavailable: false })
  })

  it('uses counterpart IDs, not follow-row IDs, at equal timestamps and after boundary hiding', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const gamma = profile('gamma')
    const db = fixture(subject, alpha, beta, gamma)
    db.follows.push(
      follow('fol_900', subject, alpha),
      follow('fol_800', subject, beta),
      follow('fol_700', subject, gamma),
    )
    const first = localGraphPage(db, subject, subject, 'following', { limit: 2 })
    expect(first.items.map(row => row.id)).toEqual([gamma.id, beta.id])
    db.profiles[2] = { ...beta, visibility: 'private' }
    const second = localGraphPage(db, subject, subject, 'following', {
      limit: 2, cursor: first.nextCursor,
    })
    expect(second.items.map(row => row.id)).toEqual([alpha.id])
    expect(second).toMatchObject({ total: 2, nextCursor: null, error: null, unavailable: false })
  })

  it('deduplicates accepted connections per peer, excludes requests, and keeps the canonical real ID', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const gamma = profile('gamma')
    const db = fixture(subject, alpha, beta, gamma)
    db.connections.push(
      connection('con_001', subject, alpha),
      connection('con_002', alpha, subject),
      connection('con_099', subject, alpha, 'pending', '2026-11-01T08:00:00Z'),
      connection('con_pending', beta, subject, 'pending'),
      connection('con_rejected', subject, gamma, 'rejected'),
      connection('con_self', subject, subject),
    )
    expect(localGraphCounts(db, subject, subject)?.connection_count).toBe(1)
    expect(localGraphPage(db, subject, subject, 'connections')).toMatchObject({
      items: [{ id: alpha.id, connectionId: 'con_002' }],
      total: 1, nextCursor: null, error: null, unavailable: false,
    })
    expect(getLocalScopedRelationships(db, subject, [alpha.id]).relationships[alpha.id])
      .toMatchObject({ state: 'connected', connectionId: 'con_002' })
  })

  it('uses real connection IDs at equal times and keeps continuation after deleting that row', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const gamma = profile('gamma')
    const delta = profile('delta')
    const db = fixture(subject, alpha, beta, gamma, delta)
    db.connections.push(
      connection('con_900', subject, alpha), connection('con_800', beta, subject),
      connection('con_700', subject, gamma), connection('con_600', delta, subject),
    )
    const first = localGraphPage(db, subject, subject, 'connections', { limit: 2 })
    expect(first.items.map(row => row.id)).toEqual([alpha.id, beta.id])
    expect(decodeGraphCursor(first.nextCursor, subject.id, 'connections')).toEqual({
      cursor: { subjectId: subject.id, direction: 'connections', createdAt: STAMP, id: 'con_800' },
      error: null,
    })
    db.connections = db.connections.filter(row => row.id !== 'con_800')
    const second = localGraphPage(db, subject, subject, 'connections', {
      limit: 2, cursor: first.nextCursor,
    })
    expect(second.items.map(row => row.connectionId)).toEqual(['con_700', 'con_600'])
    expect(second).toMatchObject({ total: 3, nextCursor: null, error: null, unavailable: false })
  })

  it('ignores identical legacy connection copies but rejects conflicting real-handle identities', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const beta = profile('beta')
    const gamma = profile('gamma')
    const db = fixture(subject, alpha, beta, gamma)
    const real = connection('con_real', subject, alpha)
    db.connections.push(
      real, { ...real },
      connection('con_conflict', subject, beta),
      connection('con_conflict', subject, gamma),
    )
    expect(localGraphPage(db, subject, subject, 'connections')).toMatchObject({
      items: [{ id: alpha.id, connectionId: 'con_real' }], total: 1, nextCursor: null,
    })
    const state = getLocalScopedRelationships(db, subject, [alpha.id, beta.id, gamma.id])
    expect(Object.keys(state.relationships)).toEqual([alpha.id])
    expect(state.relationships[alpha.id]?.connectionId).toBe('con_real')
    expect(state.error).not.toBeNull()
  })

  it('returns errors for malformed/foreign cursor scope instead of pretending a first/empty page', () => {
    const subject = profile('subject')
    const db = fixture(subject)
    const base: GraphCursor = {
      subjectId: subject.id, direction: 'followers', createdAt: STAMP, id: 'prf_boundary',
    }
    for (const cursor of ['', 'not a token', { ...base, createdAt: 'naive' }]) {
      expect(localGraphPage(db, subject, subject, 'followers', { cursor })).toEqual({
        items: [], nextCursor: null, total: null, error: GRAPH_CURSOR_ERROR, unavailable: false,
      })
    }
    for (const cursor of [
      encoded({ ...base, subjectId: 'prf_other' }),
      { ...base, direction: 'following' as GraphDirection },
    ]) {
      expect(localGraphPage(db, subject, subject, 'followers', { cursor })).toEqual({
        items: [], nextCursor: null, total: null, error: GRAPH_SCOPE_ERROR, unavailable: false,
      })
    }
    expect(localGraphPage(db, subject, subject, 'requests' as GraphDirection)).toEqual({
      items: [], nextCursor: null, total: null, error: GRAPH_DIRECTION_ERROR, unavailable: false,
    })
  })

  it('accepts an exact normalized decoded tuple even when the boundary row never exists', () => {
    const subject = profile('subject')
    const alpha = profile('alpha')
    const gamma = profile('gamma')
    const db = fixture(subject, alpha, gamma)
    db.follows.push(follow('fol_alpha', alpha, subject), follow('fol_gamma', gamma, subject))
    const result = localGraphPage(db, subject, subject, 'followers', {
      cursor: {
        subjectId: subject.id, direction: 'followers',
        createdAt: '2026-11-01 12:00:00.123456+05', id: 'prf_beta',
      },
    })
    expect(result).toMatchObject({
      items: [{ id: alpha.id }], total: 2, nextCursor: null, error: null, unavailable: false,
    })
  })
})

describe('bounded current-page local relationships', () => {
  it('returns only requested real incoming/outgoing/connected/rejected/follow states', () => {
    const viewer = profile('viewer')
    const incoming = profile('incoming')
    const outgoing = profile('outgoing')
    const connected = profile('connected')
    const rejected = profile('rejected')
    const none = profile('none')
    const outside = profile('outside')
    const db = fixture(viewer, incoming, outgoing, connected, rejected, none, outside)
    db.connections.push(
      connection('con_in', incoming, viewer, 'pending'),
      connection('con_out', viewer, outgoing, 'pending'),
      connection('con_real', connected, viewer),
      connection('con_no', rejected, viewer, 'rejected'),
      connection('con_outside', viewer, outside),
      connection('con_notmine', none, outside),
    )
    db.follows.push(follow('fol_in', viewer, incoming), follow('fol_none', viewer, none))
    const requested = [incoming.id, outgoing.id, connected.id, rejected.id, none.id]
    const result = getLocalScopedRelationships(db, viewer, requested)
    expect(result).toEqual({
      relationships: {
        [incoming.id]: { state: 'incoming', connectionId: 'con_in', isFollowing: true, isBlockingThem: false },
        [outgoing.id]: { state: 'outgoing', connectionId: 'con_out', isFollowing: false, isBlockingThem: false },
        [connected.id]: { state: 'connected', connectionId: 'con_real', isFollowing: false, isBlockingThem: false },
        [rejected.id]: { state: 'rejected', connectionId: 'con_no', isFollowing: false, isBlockingThem: false },
        [none.id]: { state: 'none', connectionId: null, isFollowing: true, isBlockingThem: false },
      },
      error: null, unavailable: false,
    })
    expect(result.relationships[outside.id]).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it('uses newest real pending/rejected state without inventing a connected relationship', () => {
    const viewer = profile('viewer')
    const peer = profile('peer')
    const db = fixture(viewer, peer)
    db.connections.push(
      connection('con_older', peer, viewer, 'rejected', '2026-11-01T07:00:00.123455Z'),
      connection('con_001', viewer, peer, 'pending'),
      connection('con_002', peer, viewer, 'pending'),
    )
    expect(getLocalScopedRelationships(db, viewer, [peer.id]).relationships[peer.id])
      .toEqual({ state: 'incoming', connectionId: 'con_002', isFollowing: false, isBlockingThem: false })
    expect(localGraphCounts(db, viewer, viewer)?.connection_count).toBe(0)
  })

  it('omits self/private/blocked/disabled/orphan/missing peers instead of returning ghost states', () => {
    const viewer = profile('viewer')
    const visible = profile('visible')
    const privatePeer = profile('private', { visibility: 'private' })
    const blocked = profile('blocked')
    const disabled = profile('disabled')
    const orphan = profile('orphan')
    const db = fixture(viewer, visible, privatePeer, blocked, disabled, orphan)
    db.blocks.push(block(blocked, viewer))
    db.users = db.users.filter(row => row.id !== orphan.user_id)
      .map(row => row.id === disabled.user_id ? { ...row, disabled_at: NOW } : row)
    for (const peer of [privatePeer, blocked, disabled, orphan]) {
      db.connections.push(connection(`con_${peer.username}`, viewer, peer))
      db.follows.push(follow(`fol_${peer.username}`, viewer, peer))
    }
    const result = getLocalScopedRelationships(db, viewer, [
      visible.id, visible.id, viewer.id, privatePeer.id, blocked.id, disabled.id, orphan.id, 'prf_missing',
    ])
    expect(result).toEqual({
      relationships: {
        [visible.id]: { state: 'none', connectionId: null, isFollowing: false, isBlockingThem: false },
      },
      error: null, unavailable: false,
    })
  })

  it('does not expose a conflicting connection handle owned by an unrelated pair', () => {
    const viewer = profile('viewer')
    const peer = profile('peer')
    const first = profile('first')
    const second = profile('second')
    const db = fixture(viewer, peer, first, second)
    db.connections.push(
      connection('con_collision', viewer, peer),
      connection('con_collision', first, second),
    )
    expect(localGraphPage(db, viewer, viewer, 'connections').items).toEqual([])
    const result = getLocalScopedRelationships(db, viewer, [peer.id])
    expect(result.relationships).toEqual({})
    expect(result.error).not.toBeNull()
    expect(result.unavailable).toBe(false)
  })

  it.each(['connection-id', 'connection-time', 'connection-status', 'follow-id', 'follow-time'] as const)(
    'reports corrupt visible-page %s state without catch-and-ignore or fabricated none', corrupt => {
      const viewer = profile('viewer')
      const peer = profile('peer')
      const db = fixture(viewer, peer)
      if (corrupt.startsWith('connection')) {
        const row = connection('con_real', viewer, peer)
        if (corrupt === 'connection-id') row.id = 'not-an-id'
        if (corrupt === 'connection-time') row.created_at = 'not-a-time'
        if (corrupt === 'connection-status') row.status = 'unknown' as Connection['status']
        db.connections.push(row)
      } else {
        const row = follow('fol_real', viewer, peer)
        if (corrupt === 'follow-id') row.id = 'not-an-id'
        if (corrupt === 'follow-time') row.created_at = 'not-a-time'
        db.follows.push(row)
      }
      const result = getLocalScopedRelationships(db, viewer, [peer.id])
      expect(result.relationships).toEqual({})
      expect(result.error).not.toBeNull()
      expect(result.unavailable).toBe(false)
      if (corrupt.startsWith('connection')) {
        expect(localGraphPage(db, viewer, viewer, 'connections').items).toEqual([])
      }
    },
  )

  it('does not leak hidden-peer corruption via a scoped-state error', () => {
    const viewer = profile('viewer')
    const hidden = profile('hidden', { visibility: 'private' })
    const db = fixture(viewer, hidden)
    db.connections.push(connection('not-an-id', viewer, hidden))
    expect(getLocalScopedRelationships(db, viewer, [hidden.id])).toEqual({
      relationships: {}, error: null, unavailable: false,
    })
  })

  it('bounds raw requested scope before deduplication and rejects malformed input explicitly', () => {
    const viewer = profile('viewer')
    const peer = profile('peer')
    const db = fixture(viewer, peer)
    const accepted = getLocalScopedRelationships(db, viewer, Array.from({ length: 50 }, () => peer.id))
    expect(Object.keys(accepted.relationships)).toEqual([peer.id])
    expect(accepted.error).toBeNull()
    for (const requested of [
      Array.from({ length: 51 }, () => peer.id), [peer.id, ''], ['prf_peer\n'],
      undefined as unknown as readonly string[], {} as unknown as readonly string[],
    ]) {
      const result = getLocalScopedRelationships(db, viewer, requested)
      expect(result.relationships).toEqual({})
      expect(result.error).not.toBeNull()
      expect(result.unavailable).toBe(false)
    }
    expect(getLocalScopedRelationships(db, viewer, [])).toEqual({
      relationships: {}, error: null, unavailable: false,
    })
    expect(getLocalScopedRelationships(db, null, [peer.id])).toEqual({
      relationships: {}, error: null, unavailable: true,
    })
  })

  it('keeps all reads snapshot-immutable, including dedup/sort/cursor and suspension handling', () => {
    const subject = profile('subject', { visibility: 'private' })
    const alpha = profile('alpha')
    const beta = profile('beta')
    const db = fixture(subject, alpha, beta)
    db.follows.push(follow('fol_alpha', alpha, subject), follow('fol_beta', beta, subject))
    db.connections.push(connection('con_alpha', subject, alpha), connection('con_beta', subject, beta))
    db.profile_account_states.push(accountState(alpha, 'suspended', '2026-11-01T00:00:00Z'))
    const before = structuredClone(db)
    frozen(db)
    const first = localGraphPage(db, subject, subject, 'connections', { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    expect(localGraphPage(db, subject, subject, 'connections', { cursor: first.nextCursor }).items)
      .toHaveLength(1)
    expect(localGraphCounts(db, subject, subject)).toEqual({
      follower_count: 2, following_count: 0, connection_count: 2,
    })
    expect(Object.keys(getLocalScopedRelationships(db, subject, [alpha.id, beta.id]).relationships))
      .toEqual([alpha.id, beta.id])
    expect(db).toEqual(before)
  })
})

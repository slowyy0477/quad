/**
 * PROPOSAL ONLY, 2026-11-02. NOT RUN/typechecked/linted.
 * Intended path: tests/db/connection-award-privacy.test.ts.
 *
 * Run only after main reviews/installs the forward migration in the repository.
 * ./harness applies the real cumulative repository migrations. No D-drive SQL
 * loader, fallback function, mock award, counter inflation or skipped assertions.
 * One real in-memory PostgreSQL session: every role-changing call is sequential.
 * Privileged statements arrange synthetic fixtures or inspect internal/catalog
 * maintenance; client authorization assertions use anon/authenticated roles.
 * Synthetic live sessions/factors do NOT establish hosted GoTrue/JWT acceptance.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

const CONNECTION_KEYS = ['first_connection', 'connections_25'] as const
const POLICY = 'profile_achievements_connection_award_privacy'
type ConnectionKey = typeof CONNECTION_KEYS[number]
type Award = {
  achievement_key: string
  awarded_at: string
  awarded_value: number | null
  is_pinned: boolean
}
type Offer = { id: string; requester: string; owner: string }
type OwnerClaims = {
  sub: string; role: 'authenticated'; session_id: string; aal: 'aal1'
  is_anonymous: false; amr: { method: 'password'; timestamp: number }[]
}
type Export = {
  subject_id: string
  sections: { achievements: { records: Award[]; next_cursor: string | null } }
}

let db: TestDb
let moderator: string
let admin: string

async function fresh(visibility: 'public' | 'private' = 'public', role?: 'admin' | 'moderator') {
  return db.createUser({ visibility, role })
}

async function read<T>(actor: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return actor === null ? db.asAnon<T>(sql, params) : db.asUser<T>(actor, sql, params)
}

async function awards(actor: string | null, owner: string): Promise<Award[]> {
  return read<Award>(actor, `select achievement_key, awarded_at::text,
    awarded_value, is_pinned from public.profile_achievements
    where profile_id = $1 order by achievement_key`, [owner])
}

async function assertStaff(actor: string) {
  const result = await db.asUser<{ assured: boolean; staff: boolean }>(actor,
    'select public.staff_session_assured() as assured, app.is_moderator() as staff')
  expect(result).toEqual([{ assured: true, staff: true }])
}

async function requestTo(owner: string, requester = ''): Promise<Offer> {
  const from = requester || await fresh()
  const result = await db.asUser<{ id: string; status: string }>(from,
    `insert into public.connections(requester_id, addressee_id, message)
     values ($1, $2, '0040 genuine synthetic request') returning id, status`, [from, owner])
  expect(result).toHaveLength(1)
  expect(result[0]!.status).toBe('pending')
  return { id: result[0]!.id, requester: from, owner }
}

async function accept(offer: Offer) {
  const result = await db.asUser<{ id: string; status: string }>(offer.owner,
    `update public.connections set status = 'accepted'
     where id = $1 returning id, status`, [offer.id])
  expect(result).toEqual([{ id: offer.id, status: 'accepted' }])
}

async function realConnection(owner: string) {
  const offer = await requestTo(owner)
  await accept(offer)
  return offer
}

async function realPost(owner: string) {
  const result = await db.asUser<{ id: string }>(owner,
    `insert into public.posts(author_id, body, visibility)
     values ($1, '0040 real non-connection activity', 'public') returning id`, [owner])
  expect(result).toHaveLength(1)
  return result[0]!.id
}

async function pin(owner: string, key: ConnectionKey, value: boolean) {
  return db.asUser<{ achievement_key: string; is_pinned: boolean }>(owner,
    `update public.profile_achievements set is_pinned = $3
     where profile_id = $1 and achievement_key = $2
     returning achievement_key, is_pinned`, [owner, key, value])
}

/** Internal counter maintenance only, never a substitute client SELECT. */
async function internalCounts(ids: string[]): Promise<Map<string, number>> {
  const result = await db.asService<{ id: string; connection_count: number }>(
    `select id, connection_count from public.profiles where id = any($1::uuid[])`, [ids])
  return new Map(result.map(row => [row.id, row.connection_count]))
}

async function passwordSession(owner: string): Promise<OwnerClaims> {
  // The existing harness's assured-staff fixture installs the minimal private
  // provider surfaces in beforeAll. This ordinary owner has no enrolled factor.
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id, user_id) values ($1, $2)', [id, owner])
  const result = await db.asService<{ timestamp: number }>(
    'select floor(extract(epoch from clock_timestamp()))::double precision as timestamp')
  return {
    sub: owner, role: 'authenticated', session_id: id, aal: 'aal1',
    is_anonymous: false, amr: [{ method: 'password', timestamp: result[0]!.timestamp }],
  }
}

async function asClaims<T>(claims: OwnerClaims, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', claims.sub])
  await db.raw.exec('set role authenticated')
  try { return (await db.raw.query<T>(sql, params)).rows }
  finally { await db.raw.exec('reset role') }
}

beforeAll(async () => {
  db = await createTestDb()
  moderator = await fresh('public', 'moderator')
  admin = await fresh('public', 'admin')
  // Genuine database assurance, not an editable role flag or a plain AAL2 claim.
  // asUser() arranges live own sessions and verified matching TOTP enrollment
  // ONCE in this synthetic DB, using the existing harness's staff fixture path.
  await assertStaff(moderator)
  await assertStaff(admin)
}, 120_000)

afterAll(async () => { await db?.close() })

describe.sequential('0040 additive automatic connection-award privacy', () => {
  it('adds exactly a restrictive client SELECT gate and keeps the original policies/guards', async () => {
    type Policy = {
      policyname: string; permissive: string; cmd: string; roles: string[]
      qual: string | null; with_check: string | null
    }
    const rows = await db.asService<Policy>(
      `select policyname, permissive, cmd, roles::text[] as roles, qual, with_check
       from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'profile_achievements'
       order by policyname`)
    const privacy = rows.filter(row => row.policyname === POLICY)
    expect(privacy).toHaveLength(1)
    expect(privacy[0]!).toMatchObject({ permissive: 'RESTRICTIVE', cmd: 'SELECT', with_check: null })
    expect([...privacy[0]!.roles].sort()).toEqual(['anon', 'authenticated'])
    expect(privacy[0]!.qual).toContain('auth.uid()')
    expect(privacy[0]!.qual).toContain('profile_id')
    for (const key of CONNECTION_KEYS) expect(privacy[0]!.qual).toContain(key)
    expect(privacy[0]!.qual).not.toMatch(/is_admin|is_moderator|can_view_profile/i)

    const original = rows.filter(row => row.policyname === 'profile_achievements_select')
    expect(original).toHaveLength(1)
    expect(original[0]!).toMatchObject({ permissive: 'PERMISSIVE', cmd: 'SELECT' })
    expect(original[0]!.qual).toContain('app.can_view_profile(profile_id)')
    expect(original[0]!.qual).toContain('auth.uid()')

    const ownPin = rows.filter(row => row.policyname === 'profile_achievements_pin_own')
    expect(ownPin).toHaveLength(1)
    expect(ownPin[0]!).toMatchObject({ permissive: 'PERMISSIVE', cmd: 'UPDATE' })
    expect(ownPin[0]!.qual).toContain('auth.uid()')
    expect(ownPin[0]!.with_check).toContain('auth.uid()')

    const lifecycle = rows.filter(row => row.policyname === 'account_lifecycle_access_guard')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]!).toMatchObject({ permissive: 'RESTRICTIVE', cmd: 'ALL' })
    expect(lifecycle[0]!.qual).toContain('app.account_lifecycle_access()')
    expect(lifecycle[0]!.with_check).toContain('app.account_lifecycle_access()')
  })

  it('preserves existing columns/client grants and trusted award/counter/pin/notification triggers', async () => {
    const columns = await db.asService<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'profile_achievements'
       order by ordinal_position`)
    expect(columns.map(row => row.column_name)).toEqual([
      'profile_id', 'achievement_key', 'awarded_at', 'awarded_value', 'is_pinned',
    ])
    for (const role of ['anon', 'authenticated']) {
      const acl = await db.asService<{
        can_select: boolean; can_insert: boolean; can_delete: boolean; can_pin: boolean
        can_change_value: boolean; can_change_key: boolean; can_award: boolean
      }>(`select
        has_table_privilege($1::name, 'public.profile_achievements', 'SELECT') as can_select,
        has_table_privilege($1::name, 'public.profile_achievements', 'INSERT') as can_insert,
        has_table_privilege($1::name, 'public.profile_achievements', 'DELETE') as can_delete,
        has_column_privilege($1::name, 'public.profile_achievements', 'is_pinned', 'UPDATE') as can_pin,
        has_column_privilege($1::name, 'public.profile_achievements', 'awarded_value', 'UPDATE') as can_change_value,
        has_column_privilege($1::name, 'public.profile_achievements', 'achievement_key', 'UPDATE') as can_change_key,
        has_function_privilege($1::name, 'app.award_achievement(uuid,text,integer)', 'EXECUTE') as can_award`,
      [role])
      expect(acl).toEqual([{
        can_select: true, can_insert: false, can_delete: false,
        can_pin: role === 'authenticated', can_change_value: false,
        can_change_key: false, can_award: false,
      }])
    }
    const triggers = await db.asService<{ name: string }>(
      `select tgname as name from pg_catalog.pg_trigger
       where not tgisinternal and tgrelid in (
         'public.profile_achievements'::regclass,
         'public.profiles'::regclass, 'public.connections'::regclass,
         'public.posts'::regclass)`)
    for (const name of [
      'profile_achievements_protect_columns', 'profile_achievements_notify',
      'profiles_evaluate_achievements', 'connections_sync_counts',
      'connections_before_write', 'posts_check_achievement', 'account_lifecycle_write_guard',
    ]) expect(triggers.map(row => row.name)).toContain(name)
    const definitions = await db.asAnon<{ key: string; criteria: string }>(
      `select key, criteria from public.achievement_definitions
       where key = any($1::text[]) order by key`, [CONNECTION_KEYS])
    expect(definitions).toEqual([
      { key: 'connections_25', criteria: 'Accepted 25 connections.' },
      { key: 'first_connection', criteria: 'Accepted 1 connection.' },
    ])
  })

  it('awards from a real pending-to-accepted connection and retains both parties’ internal counters', async () => {
    const owner = await fresh()
    const offer = await requestTo(owner)
    expect(await awards(owner, owner)).toEqual([])
    expect(await awards(offer.requester, offer.requester)).toEqual([])
    let counts = await internalCounts([owner, offer.requester])
    expect(counts.get(owner)).toBe(0)
    expect(counts.get(offer.requester)).toBe(0)

    await accept(offer)
    for (const actor of [owner, offer.requester]) {
      expect(await awards(actor, actor)).toEqual([{
        achievement_key: 'first_connection', awarded_at: expect.any(String),
        awarded_value: 1, is_pinned: false,
      }])
    }
    counts = await internalCounts([owner, offer.requester])
    expect(counts.get(owner)).toBe(1)
    expect(counts.get(offer.requester)).toBe(1)
  })

  it('reaches the real 25 threshold, hides both rows/existence/count from every foreign client, and preserves removal maintenance', async () => {
    const owner = await fresh()
    const student = await fresh()
    const offers: Offer[] = []
    let firstReceipt: Award | undefined
    for (let index = 1; index <= 25; index += 1) {
      offers.push(await realConnection(owner))
      if (index === 1) firstReceipt = (await awards(owner, owner))[0]
      if (index === 24) {
        expect((await awards(owner, owner)).map(row => row.achievement_key)).toEqual(['first_connection'])
        expect((await internalCounts([owner])).get(owner)).toBe(24)
      }
    }
    let held = await awards(owner, owner)
    expect(held.map(row => [row.achievement_key, row.awarded_value]))
      .toEqual([['connections_25', 25], ['first_connection', 1]])
    expect(held.find(row => row.achievement_key === 'first_connection')).toEqual(firstReceipt)
    expect((await internalCounts([owner])).get(owner)).toBe(25)

    // A genuine explicit public post about the owner's held threshold remains
    // allowed. It also genuinely awards first_post; no synthetic badge INSERT.
    const post = await db.asUser<{ id: string; achievement_key: string }>(owner,
      `insert into public.posts(author_id, type, body, visibility, achievement_key)
       values ($1, 'achievement', 'I chose to share this connection milestone.',
         'public', 'connections_25') returning id, achievement_key`, [owner])
    expect(post).toHaveLength(1)
    expect(post[0]!.achievement_key).toBe('connections_25')
    for (const actor of [null, student, moderator, admin]) {
      if (actor === moderator || actor === admin) await assertStaff(actor)
      expect(await read(actor, `select achievement_key, awarded_value
        from public.profile_achievements
        where profile_id = $1 and achievement_key = any($2::text[])`,
      [owner, CONNECTION_KEYS])).toEqual([])
      expect(await read(actor, `select achievement_key from public.profile_achievements
        where profile_id = $1 and achievement_key = any($2::text[])`,
      [owner, CONNECTION_KEYS])).toEqual([])
      expect(await read(actor, `select count(*)::int as n, max(awarded_value) as value
        from public.profile_achievements
        where profile_id = $1 and achievement_key = any($2::text[])`,
      [owner, CONNECTION_KEYS])).toEqual([{ n: 0, value: null }])
      expect(await read(actor, `select exists (
        select 1 from public.profile_achievements
        where profile_id = $1 and achievement_key = any($2::text[])) as has_award`,
      [owner, CONNECTION_KEYS])).toEqual([{ has_award: false }])
      expect((await awards(actor, owner)).map(row => [row.achievement_key, row.awarded_value]))
        .toEqual([['first_post', 1]])
      expect(await read(actor, `select achievement_key from public.posts where id = $1`,
        [post[0]!.id])).toEqual([{ achievement_key: 'connections_25' }])
    }

    held = await awards(owner, owner)
    const last = offers.at(-1)!
    expect(await db.asUser(owner, 'delete from public.connections where id = $1 returning id', [last.id]))
      .toEqual([{ id: last.id }])
    const counts = await internalCounts([owner, last.requester])
    expect(counts.get(owner)).toBe(24)
    expect(counts.get(last.requester)).toBe(0)
    // Historical crossing receipts remain unchanged, not erased/recomputed.
    expect(await awards(owner, owner)).toEqual(held)
  }, 120_000)

  it.each(['moderator', 'admin'] as const)(
    'refuses foreign connection awards to a genuinely assured %s while preserving original private non-connection badge reads', async role => {
      const owner = await fresh()
      await realConnection(owner)
      await realPost(owner)
      await db.asService(`update public.profiles set visibility = 'private' where id = $1`, [owner])
      const staff = role === 'admin' ? admin : moderator
      await assertStaff(staff)
      expect(await db.asUser(staff, 'select app.can_view_profile($1) as readable', [owner]))
        .toEqual([{ readable: true }])
      expect((await awards(staff, owner)).map(row => [row.achievement_key, row.awarded_value]))
        .toEqual([['first_post', 1]])
      expect((await awards(owner, owner)).map(row => row.achievement_key))
        .toEqual(['first_connection', 'first_post'])
      expect(await awards(null, owner)).toEqual([])
      expect(await awards(await fresh(), owner)).toEqual([])
    },
  )

  it('preserves actual owner pin/unpin and refuses foreign pin or award forgery', async () => {
    const owner = await fresh('private')
    await realConnection(owner)
    expect(await pin(owner, 'first_connection', true))
      .toEqual([{ achievement_key: 'first_connection', is_pinned: true }])
    for (const actor of [await fresh(), moderator, admin]) {
      if (actor === moderator || actor === admin) await assertStaff(actor)
      // Exact foreign-owner predicate with its real existing pinned row.
      expect(await db.asUser(actor, `update public.profile_achievements set is_pinned = false
        where profile_id = $1 and achievement_key = 'first_connection'
        returning achievement_key, is_pinned`, [owner])).toEqual([])
      expect((await awards(owner, owner))[0]!.is_pinned).toBe(true)
    }
    expect(await pin(owner, 'first_connection', false))
      .toEqual([{ achievement_key: 'first_connection', is_pinned: false }])
    await expectRejection(() => db.asUser(owner,
      `update public.profile_achievements set awarded_value = 999
       where profile_id = $1 and achievement_key = 'first_connection'`, [owner]),
    REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(owner,
      `insert into public.profile_achievements(profile_id, achievement_key)
       values ($1, 'connections_25')`, [owner]), REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(owner,
      'delete from public.profile_achievements where profile_id = $1', [owner]),
    REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(owner,
      `select app.award_achievement($1, 'connections_25', 25)`, [owner]),
    REJECTS.permissionDenied)
    expect((await awards(owner, owner)).map(row => [row.achievement_key, row.awarded_value]))
      .toEqual([['first_connection', 1]])
  })

  it('exports the genuine ordinary owner’s receipt/pin through the existing assured RPC, never a peer’s awards', async () => {
    const owner = await fresh('private')
    const offer = await realConnection(owner)
    await realPost(offer.requester)
    expect(await pin(owner, 'first_connection', true))
      .toEqual([{ achievement_key: 'first_connection', is_pinned: true }])
    const expected = await db.asUser<{ record: Award }>(owner,
      `select jsonb_build_object('achievement_key', achievement_key,
        'awarded_at', awarded_at, 'awarded_value', awarded_value, 'is_pinned', is_pinned) as record
       from public.profile_achievements where profile_id = $1 order by achievement_key`, [owner])
    const claims = await passwordSession(owner)
    const result = await asClaims<{ value: Export }>(claims,
      'select public.account_export($1, $2, $3) as value', ['achievements', null, 25])
    expect(result).toHaveLength(1)
    const value = result[0]!.value
    expect(value.subject_id).toBe(owner)
    expect(Object.keys(value.sections)).toEqual(['achievements'])
    expect(value.sections.achievements).toEqual({
      records: expected.map(row => row.record), next_cursor: null,
    })
    expect(value.sections.achievements.records).toHaveLength(1)
    expect(value.sections.achievements.records[0]).toMatchObject({
      achievement_key: 'first_connection', awarded_value: 1, is_pinned: true,
    })
    expect(Object.keys(value.sections.achievements.records[0]!).sort())
      .toEqual(['achievement_key', 'awarded_at', 'awarded_value', 'is_pinned'])
    expect((await awards(offer.requester, offer.requester)).map(row => row.achievement_key))
      .toContain('first_post')
    expect(JSON.stringify(value)).not.toContain('first_post')
    await expect(asClaims(claims, 'select app.account_export_page($1, $2, $3)',
      ['achievements', null, 25])).rejects.toMatchObject({ code: '42501' })
    await expect(db.asUser(owner, 'select public.account_export($1)', ['achievements']))
      .rejects.toMatchObject({ code: '42501', hint: 'provider_assurance_required' })
    await expect(db.asAnon('select public.account_export($1)', ['achievements']))
      .rejects.toMatchObject({ code: '42501' })
  })

  it.each([false, true])('keeps bilateral block guards and real sever/count maintenance (reverse=%s)', async reverse => {
    const owner = await fresh()
    const offer = await realConnection(owner)
    await realPost(owner)
    const before = await awards(owner, owner)
    const blocker = reverse ? owner : offer.requester
    const blocked = reverse ? offer.requester : owner
    expect(await db.asUser(blocker, `insert into public.blocks(blocker_id, blocked_id)
      values ($1, $2) returning blocker_id, blocked_id`, [blocker, blocked]))
      .toEqual([{ blocker_id: blocker, blocked_id: blocked }])
    expect(await awards(offer.requester, owner)).toEqual([])
    expect(await awards(owner, owner)).toEqual(before)
    expect((await awards(null, owner)).map(row => row.achievement_key)).toEqual(['first_post'])
    const counts = await internalCounts([owner, offer.requester])
    expect(counts.get(owner)).toBe(0)
    expect(counts.get(offer.requester)).toBe(0)
    expect(await db.asUser(owner, 'select id from public.connections where id = $1', [offer.id]))
      .toEqual([])
  })

  it.each(['profile deletion', 'Auth deletion', 'deactivation', 'pending deletion'] as const)(
    'does not let the new owner branch bypass existing %s lifecycle read/pin/export guards', async unavailable => {
      const owner = await fresh()
      await realConnection(owner)
      await realPost(owner)
      const claims = await passwordSession(owner)
      expect((await awards(owner, owner)).map(row => row.achievement_key))
        .toEqual(['first_connection', 'first_post'])
      switch (unavailable) {
        case 'profile deletion':
          await db.asService('update public.profiles set deleted_at = now() where id = $1', [owner])
          break
        case 'Auth deletion':
          await db.asService('update auth.users set deleted_at = now() where id = $1', [owner])
          break
        case 'deactivation':
          await db.asService(`update public.profiles set status = 'deactivated' where id = $1`, [owner])
          break
        case 'pending deletion':
          await db.asService(`insert into public.account_deletion_jobs(subject_id, request_key)
            values ($1, $2)`, [owner, randomUUID()])
          break
      }
      expect(await awards(owner, owner)).toEqual([])
      expect(await pin(owner, 'first_connection', true)).toEqual([])
      const stored = await db.asService<{ achievement_key: string; is_pinned: boolean }>(
        `select achievement_key, is_pinned from public.profile_achievements
         where profile_id = $1 order by achievement_key`, [owner])
      expect(stored).toEqual([
        { achievement_key: 'first_connection', is_pinned: false },
        { achievement_key: 'first_post', is_pinned: false },
      ])
      await expect(asClaims(claims, 'select public.account_export($1)', ['achievements']))
        .rejects.toMatchObject({ code: '42501', hint: 'account_unavailable' })
      // Only assert the original foreign profile guard where it actually
      // denies: Auth-only/pending soft state is NOT a new global badge policy.
      if (unavailable === 'profile deletion' || unavailable === 'deactivation') {
        expect(await awards(null, owner)).toEqual([])
        expect(await awards(await fresh(), owner)).toEqual([])
      }
    },
  )

  it('keeps missing/hard-deleted owner refusal and FK award cleanup without creating orphan access', async () => {
    const owner = await fresh()
    const offer = await realConnection(owner)
    await realPost(owner)
    const claims = await passwordSession(owner)
    expect(await awards(owner, owner)).toHaveLength(2)
    await db.asService('delete from auth.users where id = $1', [owner])
    for (const actor of [null, owner, await fresh(), moderator, admin]) {
      if (actor === moderator || actor === admin) await assertStaff(actor)
      expect(await awards(actor, owner)).toEqual([])
      expect(await awards(actor, randomUUID())).toEqual([])
    }
    expect(await db.asService('select profile_id from public.profile_achievements where profile_id = $1',
      [owner])).toEqual([])
    expect((await internalCounts([offer.requester])).get(offer.requester)).toBe(0)
    await expect(asClaims(claims, 'select public.account_export($1)', ['achievements']))
      .rejects.toMatchObject({ code: '42501', hint: 'account_unavailable' })
  })

  it('preserves an owner-authored first-connection post but rejects a foreign author claiming that badge', async () => {
    const owner = await fresh()
    await realConnection(owner)
    const student = await fresh()
    const post = await db.asUser<{ id: string; achievement_key: string }>(owner,
      `insert into public.posts(author_id, type, body, visibility, achievement_key)
       values ($1, 'achievement', 'I explicitly chose to share my badge.',
         'public', 'first_connection') returning id, achievement_key`, [owner])
    expect(post).toHaveLength(1)
    expect(post[0]!.achievement_key).toBe('first_connection')
    for (const actor of [null, student, moderator, admin]) {
      if (actor === moderator || actor === admin) await assertStaff(actor)
      expect(await read(actor, 'select achievement_key from public.posts where id = $1', [post[0]!.id]))
        .toEqual([{ achievement_key: 'first_connection' }])
      expect(await read(actor, `select achievement_key from public.profile_achievements
        where profile_id = $1 and achievement_key = 'first_connection'`, [owner])).toEqual([])
    }
    await expect(db.asUser(student,
      `insert into public.posts(author_id, type, body, visibility, achievement_key)
       values ($1, 'achievement', 'Not actually my award', 'public', 'first_connection')`, [student]))
      .rejects.toMatchObject({ code: '42501', hint: 'achievement_not_held' })
    expect(await db.asUser(student, `select id from public.posts
      where author_id = $1 and achievement_key = 'first_connection'`, [student])).toEqual([])
  })
})

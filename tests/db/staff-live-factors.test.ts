import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './harness'

/**
 * Real SQL/RLS in a synthetic in-memory platform fixture. This does not verify
 * GoTrue signatures/challenges, hosted permissions or PostgREST transport.
 * Raw claims never call the harness's already-verified staff convenience path.
 */
let db: TestDb
let minimalPlatform: { sessions: boolean; factors: boolean }
type FactorType = 'totp' | 'webauthn' | 'phone' | 'recovery_code'

async function asClaims<T = Record<string, unknown>>(
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1, $2, false)', [
    'request.jwt.claim.sub', typeof claims.sub === 'string' ? claims.sub : '',
  ])
  await db.raw.exec('set role authenticated')
  try { return (await db.raw.query<T>(sql, params)).rows }
  finally { await db.raw.exec('reset role') }
}

async function databaseNow(): Promise<number> {
  return (await db.asService<{ timestamp: number }>(
    'select floor(extract(epoch from clock_timestamp()))::double precision as timestamp',
  ))[0]!.timestamp
}

async function session(userId: string, method = 'totp'): Promise<Record<string, unknown>> {
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id,user_id) values ($1,$2)', [id, userId])
  const timestamp = await databaseNow()
  return {
    sub: userId, role: 'authenticated', session_id: id, aal: 'aal2',
    is_anonymous: false, amr: [{ method, timestamp }], iat: timestamp, exp: timestamp + 3600,
  }
}

async function factor(userId: string, factorType: FactorType = 'totp', status = 'verified'): Promise<string> {
  const id = randomUUID()
  await db.asService(
    `insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at)
     values ($1,$2,$3,$4,clock_timestamp(),clock_timestamp())`,
    [id, userId, factorType, status],
  )
  return id
}

async function operator({
  role = 'moderator', factorType = 'totp', enroll = true,
}: { role?: 'admin' | 'moderator'; factorType?: FactorType; enroll?: boolean } = {}) {
  const userId = await db.createUser({ role })
  const current = await session(userId)
  const factorId = enroll ? await factor(userId, factorType) : null
  return { userId, current, factorId }
}

async function verdict(claims: Record<string, unknown>): Promise<boolean> {
  return (await asClaims<{ allowed: boolean }>(
    claims, 'select public.staff_session_assured() as allowed',
  ))[0]!.allowed
}

async function enrollmentCount(userId: string): Promise<number> {
  return (await db.asService<{ n: number }>(
    'select count(*)::integer as n from auth.mfa_factors where user_id=$1', [userId],
  ))[0]!.n
}

beforeAll(async () => {
  db = await createTestDb()
  minimalPlatform = (await db.asService<{ sessions: boolean; factors: boolean }>(
    `select to_regclass('auth.sessions') is not null as sessions,
            to_regclass('auth.mfa_factors') is not null as factors`,
  ))[0]!
  // Match the provider's UUIDs, NOT NULL fields and enrollment enums. The extra
  // factor types exercise refusal; they are not new approved staff MFA methods.
  await db.raw.exec(`
    create table auth.sessions (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade
    );
    create type auth.factor_status as enum ('unverified', 'verified');
    create type auth.factor_type as enum ('totp', 'webauthn', 'phone', 'recovery_code');
    create table auth.mfa_factors (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade,
      status auth.factor_status not null,
      factor_type auth.factor_type not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      secret text
    );
    revoke all on auth.sessions, auth.mfa_factors
      from public, anon, authenticated, service_role;
  `)
}, 120_000)
afterAll(async () => { await db?.close() })

describe.sequential('0034 live verified factors strengthen existing staff capabilities', () => {
  it('applies without adding provider tables to the minimal bootstrap', () => {
    expect(minimalPlatform).toEqual({ sessions: false, factors: false })
  })

  it.each(['totp', 'mfa/totp', 'webauthn', 'mfa/webauthn'])(
    'accepts only current own verified enrollment matching fresh %s AMR', async method => {
      const fixture = await operator({
        role: method.startsWith('mfa/') ? 'admin' : 'moderator',
        factorType: method.includes('webauthn') ? 'webauthn' : 'totp',
      })
      const current = await session(fixture.userId, method)
      expect(await verdict(current)).toBe(true)
      expect((await asClaims<{ allowed: boolean }>(
        current, 'select app.is_moderator() as allowed',
      ))[0]!.allowed).toBe(true)
    },
  )

  it('refuses no-factor staff despite fresh AAL2 and editable enrollment metadata', async () => {
    const { userId, current } = await operator({ enroll: false })
    expect(await verdict({
      ...current, factors: [{ status: 'verified', factor_type: 'totp' }],
      user_metadata: { mfa_verified: true }, app_metadata: { factors: ['totp'] },
    })).toBe(false)
    expect(await enrollmentCount(userId)).toBe(0)
  })

  it('does not use another account’s verified authenticator', async () => {
    const { current } = await operator({ enroll: false })
    await factor(await db.createUser())
    expect(await verdict(current)).toBe(false)
  })

  it.each([
    ['webauthn', 'totp'], ['totp', 'webauthn'],
    ['phone', 'totp'], ['recovery_code', 'webauthn'],
  ] as const)('refuses a verified %s factor for %s AMR', async (factorType, method) => {
    const { userId } = await operator({ factorType })
    expect(await verdict(await session(userId, method))).toBe(false)
  })

  it('reads verification, factor type and ownership live after claim issuance', async () => {
    const { userId, current } = await operator({ enroll: false })
    const id = await factor(userId, 'totp', 'unverified')
    expect(await verdict(current)).toBe(false)
    await db.asService("update auth.mfa_factors set status='verified' where id=$1", [id])
    expect(await verdict(current)).toBe(true)
    await db.asService("update auth.mfa_factors set factor_type='webauthn' where id=$1", [id])
    expect(await verdict(current)).toBe(false)
    await db.asService("update auth.mfa_factors set factor_type='totp' where id=$1", [id])
    const other = await db.createUser()
    await db.asService('update auth.mfa_factors set user_id=$2 where id=$1', [id, other])
    expect(await verdict(current)).toBe(false)
  })

  it('revokes direct staff reads/decisions immediately after factor removal, without side effects', async () => {
    const { current, factorId, userId } = await operator()
    const reporter = await db.createUser()
    const target = await db.createUser()
    const report = (await db.asUser<{ id: string }>(reporter,
      `insert into public.reports(kind,user_id,reason)
       values ('profile',$1,'Harassment or bullying') returning id`, [target]))[0]!
    expect(await asClaims(current, 'select id from public.reports where id=$1', [report.id]))
      .toEqual([{ id: report.id }])
    await db.asService('delete from auth.mfa_factors where id=$1', [factorId])
    expect(await verdict(current)).toBe(false)
    expect(await asClaims(current, 'select id from public.reports where id=$1', [report.id])).toEqual([])
    await expect(asClaims(current, 'select public.moderate_report($1,$2,$3)',
      [report.id, 'dismiss_report', 'Synthetic reviewed conduct']))
      .rejects.toMatchObject({ code: '42501', hint: 'not_moderator' })
    expect((await db.asService<{ status: string; decisions: number }>(
      `select status, (select count(*)::integer from public.moderation_actions
         where report_id=$1) as decisions from public.reports where id=$1`, [report.id],
    ))[0]).toEqual({ status: 'open', decisions: 0 })
    expect(await enrollmentCount(userId)).toBe(0)
  })

  it('never replaces fresh MFA with token refresh, password or malformed AMR', async () => {
    const { current } = await operator()
    const timestamp = await databaseNow()
    for (const overrides of [
      { aal: 'aal1' }, { is_anonymous: true },
      { amr: [{ method: 'totp', timestamp: timestamp - 301 }] },
      { amr: [{ method: 'totp', timestamp: timestamp + 60 }] },
      { amr: [{ method: 'totp', timestamp: String(timestamp) }] },
      { amr: [{ method: 'totp', timestamp: timestamp + 0.5 }] },
      { amr: [{ method: 'totp', timestamp: null }] },
      { amr: [{ method: 'totp', timestamp: { value: timestamp } }] },
      { amr: [{ method: 'totp' }] }, { amr: ['totp'] },
      { amr: [null, false, timestamp] }, { amr: null }, { amr: [] },
      { amr: { method: 'totp', timestamp } },
      ...['password', 'recovery', 'token_refresh', 'mfa/phone', 'passkey'].map(method => ({
        iat: timestamp, amr: [{ method, timestamp }],
      })),
    ]) expect(await verdict({ ...current, ...overrides })).toBe(false)
  })

  it('keeps role, lifecycle, account restriction and real session ownership checks', async () => {
    const { current, userId } = await operator()
    const foreign = await session(await db.createUser())
    expect(await verdict({ ...current, session_id: foreign.session_id })).toBe(false)
    expect(await verdict({ ...current, session_id: 'malformed' })).toBe(false)
    expect(await verdict({ ...current, sub: 'malformed' })).toBe(false)
    await db.asService("update public.profiles set status='banned' where id=$1", [userId])
    expect(await verdict(current)).toBe(false)
    await db.asService("update public.profiles set status='active' where id=$1", [userId])
    expect(await verdict(current)).toBe(true)
    await db.asService("delete from public.user_roles where user_id=$1", [userId])
    expect(await verdict(current)).toBe(false)
  })

  it('does not resurrect a revoked session just because its verified factor remains', async () => {
    const { current, userId } = await operator()
    await db.asService('delete from auth.sessions where id=$1', [current.session_id])
    expect(await verdict(current)).toBe(false)
    expect(await enrollmentCount(userId)).toBe(1)
  })
})

describe.sequential('0034 unknown or malformed provider state fails closed', () => {
  it.each(['mfa_factors', 'sessions'])('refuses when auth.%s is missing', async table => {
    const { current } = await operator()
    await db.asService(`alter table auth.${table} rename to s34_hidden_${table}`)
    try { expect(await verdict(current)).toBe(false) }
    finally { await db.asService(`alter table auth.s34_hidden_${table} rename to ${table}`) }
    expect(await verdict(current)).toBe(true)
  })

  it.each([
    ['mfa_factors', 'id'], ['mfa_factors', 'user_id'],
    ['mfa_factors', 'status'], ['mfa_factors', 'factor_type'],
    ['sessions', 'id'], ['sessions', 'user_id'],
  ])('returns false, not a raw error, for missing auth.%s.%s', async (table, column) => {
    const { current } = await operator()
    await db.asService(`alter table auth.${table} rename column ${column} to s34_hidden_column`)
    try { expect(await verdict(current)).toBe(false) }
    finally { await db.asService(`alter table auth.${table} rename column s34_hidden_column to ${column}`) }
  })

  it('rejects a text-typed counterfeit factor table even with apparently verified rows', async () => {
    const { current, userId } = await operator()
    await db.asService('alter table auth.mfa_factors rename to s34_original_factors')
    try {
      await db.asService(`create table auth.mfa_factors (
        id uuid primary key, user_id uuid not null,
        status text not null, factor_type text not null
      )`)
      await db.asService(
        "insert into auth.mfa_factors values ($1,$2,'verified','totp')", [randomUUID(), userId],
      )
      expect(await verdict(current)).toBe(false)
    } finally {
      await db.asService('drop table if exists auth.mfa_factors')
      await db.asService('alter table auth.s34_original_factors rename to mfa_factors')
    }
  })

  it('rejects nullable enrollment fields rather than treating a malformed schema as assurance', async () => {
    const { current } = await operator()
    await db.asService('alter table auth.mfa_factors alter column status drop not null')
    try { expect(await verdict(current)).toBe(false) }
    finally { await db.asService('alter table auth.mfa_factors alter column status set not null') }
  })

  it('rejects a view masquerading as the live provider factor table', async () => {
    const { current } = await operator()
    await db.asService('alter table auth.mfa_factors rename to s34_original_factors')
    try {
      await db.asService('create view auth.mfa_factors as select * from auth.s34_original_factors')
      expect(await verdict(current)).toBe(false)
    } finally {
      await db.asService('drop view if exists auth.mfa_factors')
      await db.asService('alter table auth.s34_original_factors rename to mfa_factors')
    }
  })

  it('reduces an unreadable live-factor lookup to false instead of a provider exception', async () => {
    const { current } = await operator()
    const restoreOwner = (await db.asService<{ statement: string }>(
      `select format('alter function app.staff_session_assured() owner to %I',
         pg_get_userbyid(proowner)) as statement
       from pg_proc where oid='app.staff_session_assured()'::regprocedure`,
    ))[0]!.statement
    // Isolated, non-login fixture owner; no client role gains any privilege.
    await db.asService('create role s34_factor_reader nologin noinherit bypassrls')
    try {
      await db.raw.exec(`
        grant usage on schema auth, public, app to s34_factor_reader;
        grant create on schema app to s34_factor_reader;
        grant select on public.user_roles, auth.sessions, auth.mfa_factors to s34_factor_reader;
        grant execute on function auth.uid(), auth.jwt(),
          app.account_lifecycle_access(), app.is_account_restricted(uuid) to s34_factor_reader;
        alter function app.staff_session_assured() owner to s34_factor_reader;
      `)
      expect(await verdict(current)).toBe(true)
      await db.asService('revoke select on auth.mfa_factors from s34_factor_reader')
      expect(await verdict(current)).toBe(false)
    } finally {
      await db.asService(restoreOwner)
      await db.asService('drop owned by s34_factor_reader')
      await db.asService('drop role s34_factor_reader')
    }
  })
})

describe.sequential('0034 preserves grants and independent lifecycle reauthentication', () => {
  it('keeps the public RPC authenticated-only, its helper private and provider tables unreadable', async () => {
    const student = await db.createUser()
    await expect(db.asAnon('select public.staff_session_assured()')).rejects.toMatchObject({ code: '42501' })
    await expect(db.asUser(student, 'select app.staff_session_assured()')).rejects.toMatchObject({ code: '42501' })
    for (const sql of ['select * from auth.sessions', 'select * from auth.mfa_factors']) {
      await expect(db.asUser(student, sql)).rejects.toMatchObject({ code: '42501' })
    }
    const privileges = await db.asService<{ rpc: boolean; anon: boolean; worker: boolean; private: boolean; roles_write: boolean }>(
      `select has_function_privilege('authenticated','public.staff_session_assured()','execute') as rpc,
              has_function_privilege('anon','public.staff_session_assured()','execute') as anon,
              has_function_privilege('service_role','public.staff_session_assured()','execute') as worker,
              has_function_privilege('authenticated','app.staff_session_assured()','execute') as private,
              has_table_privilege('authenticated','public.user_roles','insert') as roles_write`,
    )
    expect(privileges[0]).toEqual({ rpc: true, anon: false, worker: false, private: false, roles_write: false })
  })

  it('leaves 0031 raw staff/no-factor export semantics untouched while refusing staff capabilities', async () => {
    const { userId, current } = await operator({ role: 'admin', enroll: false })
    expect(await enrollmentCount(userId)).toBe(0)
    expect(await verdict(current)).toBe(false)
    expect((await asClaims<{ value: { subject_id: string } }>(
      current, "select public.account_export('profile') as value",
    ))[0]!.value.subject_id).toBe(userId)
    await expect(asClaims({
      ...current, aal: 'aal1', amr: [{ method: 'password', timestamp: await databaseNow() }],
    }, "select public.account_export('profile')"))
      .rejects.toMatchObject({ code: '42501', hint: 'provider_assurance_required' })
    expect(await enrollmentCount(userId)).toBe(0)
  })

  it('enrolls the convenience staff fixture exactly once and never recreates a removed factor', async () => {
    const userId = await db.createUser({ role: 'moderator' })
    expect(await enrollmentCount(userId)).toBe(0)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await db.asUser<{ allowed: boolean }>(
        userId, 'select public.staff_session_assured() as allowed',
      ))[0]!.allowed).toBe(true)
      expect(await enrollmentCount(userId)).toBe(1)
    }
    await db.asService('delete from auth.mfa_factors where user_id=$1', [userId])
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await db.asUser<{ allowed: boolean }>(
        userId, 'select public.staff_session_assured() as allowed',
      ))[0]!.allowed).toBe(false)
      expect(await enrollmentCount(userId)).toBe(0)
    }
  })

  it('never re-verifies a downgraded fixture or recreates a deleted staff fixture session', async () => {
    const userId = await db.createUser({ role: 'admin' })
    await db.asUser(userId, 'select public.staff_session_assured()')
    await db.asService("update auth.mfa_factors set status='unverified' where user_id=$1", [userId])
    expect((await db.asUser<{ allowed: boolean }>(
      userId, 'select public.staff_session_assured() as allowed',
    ))[0]!.allowed).toBe(false)
    expect((await db.asService<{ status: string }>(
      'select status from auth.mfa_factors where user_id=$1', [userId],
    ))[0]!.status).toBe('unverified')
    await db.asService("update auth.mfa_factors set status='verified' where user_id=$1", [userId])
    await db.asService('delete from auth.sessions where user_id=$1', [userId])
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await db.asUser<{ allowed: boolean }>(
        userId, 'select public.staff_session_assured() as allowed',
      ))[0]!.allowed).toBe(false)
    }
    expect((await db.asService<{ n: number }>(
      'select count(*)::integer as n from auth.sessions where user_id=$1', [userId],
    ))[0]!.n).toBe(0)
    expect(await enrollmentCount(userId)).toBe(1)
  })
})

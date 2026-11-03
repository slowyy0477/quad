import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './harness'

/**
 * In-memory, synthetic platform fixtures only. JWT GUCs exercise the SQL
 * assurance contract; they do NOT prove signatures, GoTrue challenges,
 * PostgREST transport or deployed provider permissions.
 *
 * Install Auth surfaces AFTER createTestDb(): 0031 must compile with the
 * minimal shared bootstrap, and refuse unknown platform state at runtime.
 */
let db: TestDb

type Claims = Record<string, unknown> & {
  sub: string
  role: 'authenticated'
  session_id: string
  aal: string
  amr: unknown
  is_anonymous: boolean
}
type Export = {
  subject_id: string
  sections: Record<string, {
    records: Record<string, unknown>[]
    next_cursor: string | null
  }>
}
type Receipt = { id: string; state: string; phase: string }
type FactorType = 'totp' | 'webauthn' | 'phone' | 'recovery_code'
type Snapshot = {
  status: string
  searchable: boolean
  allow_messages_from: string
  allow_connection_requests: boolean
  sessions: number
  refresh_tokens: number
  jobs: number
  export_windows: number
}

const FACTOR_SECRET = 'S10-ASSURANCE-SYNTHETIC-FACTOR-SECRET'
const REFRESH_TOKEN = 'S10-ASSURANCE-SYNTHETIC-REFRESH-TOKEN'
const ASSURANCE_REFUSAL = { code: '42501', hint: 'provider_assurance_required' }

async function asClaims<T = Record<string, unknown>>(
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', [
    'request.jwt.claims', JSON.stringify(claims),
  ])
  await db.raw.query('select set_config($1, $2, false)', [
    'request.jwt.claim.sub', typeof claims.sub === 'string' ? claims.sub : '',
  ])
  // Never select a database role from caller-controlled claims.
  await db.raw.exec('set role authenticated')
  try {
    return (await db.raw.query<T>(sql, params)).rows
  } finally {
    await db.raw.exec('reset role')
  }
}

async function databaseNow(): Promise<number> {
  const rows = await db.asService<{ timestamp: number }>(
    'select floor(extract(epoch from clock_timestamp()))::double precision as timestamp',
  )
  return rows[0]!.timestamp
}

async function session(userId: string, method = 'password', aal = 'aal1'): Promise<Claims> {
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id, user_id) values ($1, $2)', [id, userId])
  await db.asService(
    'insert into auth.refresh_tokens(user_id, session_id, token) values ($1, $2, $3)',
    [userId, id, `${REFRESH_TOKEN}:${id}`],
  )
  const timestamp = await databaseNow()
  return {
    sub: userId, role: 'authenticated', session_id: id, aal,
    amr: [{ method, timestamp }], is_anonymous: false,
    iat: timestamp, exp: timestamp + 3600,
  }
}

async function factor(
  userId: string,
  status: 'unverified' | 'verified' = 'verified',
  factorType: FactorType = 'totp',
): Promise<string> {
  const id = randomUUID()
  await db.asService(
    `insert into auth.mfa_factors(id, user_id, status, factor_type, created_at, updated_at, secret)
     values ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), $5)`,
    [id, userId, status, factorType, FACTOR_SECRET],
  )
  return id
}

async function readExport(claims: Record<string, unknown>, section: string | null = 'profile'): Promise<Export> {
  const rows = await asClaims<{ value: Export }>(
    claims, 'select public.account_export($1) as value', [section],
  )
  return rows[0]!.value
}

async function request(claims: Record<string, unknown>): Promise<Receipt> {
  const rows = await asClaims<{ value: Receipt }>(
    claims, 'select public.account_request_deletion($1, $2, $3) as value',
    ['DELETE MY ACCOUNT', true, randomUUID()],
  )
  return rows[0]!.value
}

async function snapshot(userId: string): Promise<Snapshot> {
  const rows = await db.asService<Snapshot>(
    `select p.status, p.searchable, p.allow_messages_from, p.allow_connection_requests,
       (select count(*)::integer from auth.sessions where user_id = $1) as sessions,
       (select count(*)::integer from auth.refresh_tokens where user_id::text = $1::text) as refresh_tokens,
       (select count(*)::integer from public.account_deletion_jobs where subject_id = $1) as jobs,
       (select count(*)::integer from app.account_lifecycle_windows where subject_id = $1) as export_windows
     from public.profiles p where p.id = $1`,
    [userId],
  )
  return rows[0]!
}

beforeAll(async () => {
  db = await createTestDb()
  // Required field names/status enum follow the real provider contract:
  // https://supabase.com/docs/guides/auth/auth-mfa
  // https://github.com/supabase/auth/blob/master/migrations/20221003041349_add_mfa_schema.up.sql
  // Extra current factor types are fixture inputs, not newly approved AMR.
  await db.raw.exec(`
    create table if not exists auth.sessions (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade
    );
    create table if not exists auth.refresh_tokens (
      id bigint generated always as identity primary key,
      user_id text not null,
      session_id uuid references auth.sessions(id) on delete cascade,
      token text
    );
    do $fixture$
    begin
      create type auth.factor_status as enum ('unverified', 'verified');
    exception when duplicate_object then null;
    end;
    $fixture$;
    do $fixture$
    begin
      create type auth.factor_type as enum ('totp', 'webauthn', 'phone', 'recovery_code');
    exception when duplicate_object then null;
    end;
    $fixture$;
    create table if not exists auth.mfa_factors (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade,
      status auth.factor_status not null,
      factor_type auth.factor_type not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      secret text
    );
    revoke all on auth.sessions, auth.refresh_tokens, auth.mfa_factors
      from public, anon, authenticated, service_role;
  `)
}, 120_000)

afterAll(async () => { await db?.close() })

describe.sequential('0031 direct lifecycle assurance and live provider enrollment', () => {
  it('keeps reauthentication private and exposes no Auth factors or sessions to clients', async () => {
    const user = await db.createUser()
    const current = await session(user)
    await factor(user)
    for (const sql of [
      'select app.account_require_reauthentication()',
      'select * from auth.mfa_factors',
      'select * from auth.sessions',
      'select * from auth.refresh_tokens',
    ]) {
      await expect(asClaims(current, sql)).rejects.toMatchObject({ code: '42501' })
      await expect(db.asAnon(sql)).rejects.toMatchObject({ code: '42501' })
    }
    await expect(db.asAnon('select public.account_export()')).rejects.toMatchObject({ code: '42501' })
    const privileges = await db.asService<{ client: boolean; worker: boolean }>(
      `select has_function_privilege('authenticated', 'app.account_require_reauthentication()', 'execute') as client,
              has_function_privilege('service_role', 'app.account_require_reauthentication()', 'execute') as worker`,
    )
    expect(privileges[0]).toEqual({ client: false, worker: false })
  })

  it('allows a fresh password only when the live account has no verified enrolled factor', async () => {
    const user = await db.createUser()
    const current = await session(user)
    const exported = await readExport(current)
    expect(exported.subject_id).toBe(user)
    expect(exported.sections.profile!.records).toEqual([expect.objectContaining({ id: user })])
    expect((await snapshot(user)).sessions).toBe(1)
  })

  it('does not require another user’s factor or an unverified own enrollment', async () => {
    const user = await db.createUser()
    const other = await db.createUser({ visibility: 'private' })
    await factor(user, 'unverified')
    await factor(other)
    expect((await readExport(await session(user))).subject_id).toBe(user)
  })

  it.each<FactorType>(['totp', 'webauthn', 'phone', 'recovery_code'])(
    'rejects password-only export and deletion for a verified own %s factor without side effects',
    async factorType => {
      const user = await db.createUser()
      const current = await session(user)
      await factor(user, 'verified', factorType)
      const before = await snapshot(user)
      await expect(readExport(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      // Refused assurance cannot consume export budget, queue, restrict or revoke.
      expect(await snapshot(user)).toEqual(before)
    },
  )

  it('reads enrollment live after claims issuance rather than trusting factor metadata in a JWT', async () => {
    const user = await db.createUser()
    const id = await factor(user, 'unverified')
    const current = await session(user)
    current.user_metadata = { factors: [], mfa_enabled: false }
    current.app_metadata = { factors: [], mfa_enabled: false }
    current.factors = []
    expect((await readExport(current)).subject_id).toBe(user)
    await db.asService("update auth.mfa_factors set status = 'verified' where id = $1", [id])
    const before = await snapshot(user)
    await expect(readExport(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    expect(await snapshot(user)).toEqual(before)
  })

  it.each(['totp', 'mfa/totp', 'webauthn', 'mfa/webauthn'])(
    'accepts fresh approved %s AMR only with aal2 for enrolled non-staff',
    async method => {
      const user = await db.createUser()
      await factor(user)
      const current = await session(user, method, 'aal2')
      expect((await readExport(current)).subject_id).toBe(user)
      const accepted = await request(current)
      expect(accepted).toMatchObject({ state: 'queued', phase: 'media' })
      expect(await snapshot(user)).toMatchObject({
        status: 'deactivated', searchable: false, allow_messages_from: 'nobody',
        allow_connection_requests: false, sessions: 0, refresh_tokens: 0, jobs: 1,
      })
      await expect(readExport(current)).rejects.toMatchObject({
        code: '42501', hint: 'account_unavailable',
      })
    },
  )

  it.each(['admin', 'moderator'] as const)(
    'requires MFA for raw %s role even when 0033 denies actor capabilities and no factor is enrolled',
    async role => {
      const user = await db.createUser({ role })
      const current = await session(user)
      const stored = await db.asService<{ raw_role: boolean }>(
        `select exists (
           select 1 from public.user_roles where user_id = $1 and role = $2
         ) as raw_role`,
        [user, role],
      )
      expect(stored[0]).toEqual({ raw_role: true })
      const capability = await asClaims<{ admin: boolean; moderator: boolean }>(
        current,
        'select app.is_admin() as admin, app.is_moderator() as moderator',
      )
      expect(capability[0]).toEqual({ admin: false, moderator: false })
      await expect(readExport(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      expect((await readExport(await session(user, 'totp', 'aal2'))).subject_id).toBe(user)
    },
  )

  it('never exports enrollment identifiers, secrets, refresh tokens or Auth metadata', async () => {
    const user = await db.createUser()
    const id = await factor(user)
    await db.asService(
      'update auth.users set encrypted_password = $2, raw_user_meta_data = $3 where id = $1',
      [user, 'S10-ASSURANCE-SYNTHETIC-PASSWORD-HASH', { secret: 'S10-ASSURANCE-AUTH-METADATA' }],
    )
    const text = JSON.stringify(await readExport(await session(user, 'totp', 'aal2'), null))
    for (const marker of [id, FACTOR_SECRET, REFRESH_TOKEN, 'S10-ASSURANCE-SYNTHETIC-PASSWORD-HASH', 'S10-ASSURANCE-AUTH-METADATA']) {
      expect(text).not.toContain(marker)
    }
  })
})

describe.sequential('0031 refusal shapes and runtime platform failures', () => {
  it('rejects stale/future MFA, malformed AMR and AAL/metadata shortcuts without authorizing deletion', async () => {
    const user = await db.createUser()
    await factor(user)
    const current = await session(user)
    const before = await snapshot(user)
    const timestamp = await databaseNow()
    const variants: Record<string, unknown>[] = [
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: timestamp - 301 }], iat: timestamp },
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: timestamp + 120 }] },
      { aal: 'aal1', amr: [{ method: 'totp', timestamp }] },
      { aal: 'aal2', amr: [{ method: 'password', timestamp }] },
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: String(timestamp) }] },
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: timestamp + 0.5 }] },
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: null }] },
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: { value: timestamp } }] },
      { aal: 'aal2', amr: [{ method: 'totp' }] },
      { aal: 'aal2', amr: ['totp'] },
      { aal: 'aal2', amr: [null, false, timestamp] },
      { aal: 'aal2', amr: { method: 'totp', timestamp } },
      { aal: 'aal2', amr: null },
      { aal: 'aal2', amr: [] },
      { aal: 'aal2', amr: [{ method: 'token_refresh', timestamp }], iat: timestamp },
      { aal: 'aal2', amr: [{ method: 'password', timestamp }], user_metadata: { mfa_verified: true } },
    ]
    for (const overrides of variants) {
      const claims = { ...current, ...overrides }
      await expect(readExport(claims)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(claims)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    }
    expect(await snapshot(user)).toEqual(before)
  })

  it.each(['recovery', 'email', 'otp', 'magiclink', 'oauth', 'passkey', 'mfa/phone', 'mfa/recovery_code'])(
    'does not silently approve %s as strong lifecycle MFA',
    async method => {
      const user = await db.createUser()
      await factor(user)
      const current = await session(user, method, 'aal2')
      await expect(readExport(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    },
  )

  it('still requires a fresh password for an unenrolled non-staff account', async () => {
    const user = await db.createUser()
    const current = await session(user)
    const timestamp = await databaseNow()
    for (const amr of [
      [{ method: 'password', timestamp: timestamp - 1000 }],
      [{ method: 'password', timestamp: String(timestamp) }],
      [{ method: 'token_refresh', timestamp }],
    ]) {
      await expect(readExport({ ...current, amr, iat: timestamp })).rejects.toMatchObject(ASSURANCE_REFUSAL)
    }
  })

  it('rejects anonymous assurance and missing/malformed session claims', async () => {
    const user = await db.createUser()
    const current = await session(user, 'totp', 'aal2')
    for (const overrides of [
      { is_anonymous: true }, { session_id: undefined }, { session_id: null },
      { session_id: 'not-a-session' }, { session_id: '../synthetic-session' },
    ]) {
      await expect(readExport({ ...current, ...overrides })).rejects.toMatchObject(ASSURANCE_REFUSAL)
    }
  })

  it('binds the session to the exact subject and rejects revoked-session replay even with MFA', async () => {
    const user = await db.createUser()
    const other = await db.createUser()
    const otherSession = await session(other, 'totp', 'aal2')
    await expect(readExport({ ...otherSession, sub: user })).rejects.toMatchObject({
      code: '42501', hint: 'signed_out',
    })
    const current = await session(user, 'totp', 'aal2')
    await db.asService('delete from auth.sessions where id = $1', [current.session_id])
    await expect(readExport(current)).rejects.toMatchObject({ code: '42501', hint: 'signed_out' })
    await expect(request(current)).rejects.toMatchObject({ code: '42501', hint: 'signed_out' })
  })

  it('fails closed for password-only access when the factor table is absent, without requiring it for fresh MFA', async () => {
    const user = await db.createUser()
    const password = await session(user)
    const mfa = await session(user, 'totp', 'aal2')
    // These renames touch ONLY this file's in-memory fixture, never a provider.
    await db.asService('alter table auth.mfa_factors rename to s10_assurance_hidden_factors')
    try {
      await expect(readExport(password)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(password)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      expect((await readExport(mfa)).subject_id).toBe(user)
    } finally {
      await db.asService('alter table auth.s10_assurance_hidden_factors rename to mfa_factors')
    }
  })

  it('returns a fixed refusal instead of a raw missing-factor-column error', async () => {
    const user = await db.createUser()
    const current = await session(user)
    await db.asService('alter table auth.mfa_factors rename column status to s10_hidden_status')
    try {
      await expect(readExport(current)).rejects.toMatchObject({
        ...ASSURANCE_REFUSAL, message: 'Provider enrollment verification is unavailable',
      })
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    } finally {
      await db.asService('alter table auth.mfa_factors rename column s10_hidden_status to status')
    }
  })

  it('fails closed even with fresh MFA when the session table is absent', async () => {
    const user = await db.createUser()
    const current = await session(user, 'totp', 'aal2')
    await db.asService('alter table auth.sessions rename to s10_assurance_hidden_sessions')
    try {
      await expect(readExport(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    } finally {
      await db.asService('alter table auth.s10_assurance_hidden_sessions rename to sessions')
    }
  })

  it('returns a fixed refusal instead of a raw missing-session-column error', async () => {
    const user = await db.createUser()
    const current = await session(user, 'totp', 'aal2')
    await db.asService('alter table auth.sessions rename column user_id to s10_hidden_subject')
    try {
      await expect(readExport(current)).rejects.toMatchObject({
        ...ASSURANCE_REFUSAL, message: 'Provider session verification is unavailable',
      })
      await expect(request(current)).rejects.toMatchObject(ASSURANCE_REFUSAL)
    } finally {
      await db.asService('alter table auth.sessions rename column s10_hidden_subject to user_id')
    }
  })
})

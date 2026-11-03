import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, type TestDb } from './harness'

let db: TestDb
let staff: string
let otherAdmin: string
let student: string
let session: string
const now = () => Math.floor(Date.now() / 1000)

async function asClaims<T = Record<string, unknown>>(claims: Record<string, unknown>, sql: string, params: unknown[] = []) {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', String(claims.sub ?? '')])
  await db.raw.exec('set role authenticated')
  try { return (await db.raw.query<T>(sql, params)).rows }
  finally { await db.raw.exec('reset role') }
}

function claims(extra: Record<string, unknown> = {}) {
  return { sub: staff, role: 'authenticated', session_id: session, aal: 'aal2',
    is_anonymous: false, amr: [{ method: 'totp', timestamp: now() }], ...extra }
}

async function verdict(extra: Record<string, unknown> = {}) {
  return (await asClaims<{ allowed: boolean }>(claims(extra),
    'select public.staff_session_assured() as allowed'))[0].allowed
}

beforeAll(async () => {
  db = await createTestDb()
  await db.raw.exec(`create table if not exists auth.sessions (
    id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade
  );
  do $fixture$
  begin
    create type auth.factor_status as enum ('unverified', 'verified');
  exception when duplicate_object then null;
  end;
  $fixture$;
  do $fixture$
  begin
    create type auth.factor_type as enum ('totp', 'webauthn');
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
  revoke all on auth.sessions, auth.mfa_factors
    from public, anon, authenticated, service_role;`)
  staff = await db.createUser({ role: 'moderator' })
  otherAdmin = await db.createUser({ role: 'admin' })
  student = await db.createUser()
  session = randomUUID()
  await db.asService('insert into auth.sessions(id,user_id) values ($1,$2)', [session, staff])
  // This raw-claim scenario owns one explicit synthetic enrollment; do not use
  // asUser(staff), whose separate convenience fixture would add another session.
  await db.asService(
    `insert into auth.mfa_factors(id,user_id,status,factor_type,created_at,updated_at)
     values ($1,$2,'verified','totp',clock_timestamp(),clock_timestamp())`,
    [randomUUID(), staff],
  )
}, 120_000)
afterAll(async () => { await db?.close() })

describe('direct SQL staff session assurance, synthetic signed-claim contract', () => {
  it('requires fresh strong MFA and a role, not merely an AAL2 string or password login', async () => {
    expect(await verdict()).toBe(true)
    for (const extra of [
      { aal: 'aal1' }, { amr: [{ method: 'password', timestamp: now() }] },
      { amr: [{ method: 'recovery', timestamp: now() }] },
      { amr: [{ method: 'totp', timestamp: now() - 400 }] },
      { amr: [{ method: 'totp', timestamp: now() + 60 }] },
      { amr: null }, { is_anonymous: true }, { sub: student },
      { session_id: null }, { session_id: 'not-a-session' },
    ]) expect(await verdict(extra)).toBe(false)
  })

  it('ties capabilities to this actor while preserving target-administrator protection', async () => {
    const row = (await asClaims<{ own: boolean; other: boolean; moderator: boolean }>(claims(),
      'select app.is_admin($1) as own, app.is_admin($2) as other, app.is_moderator() as moderator',
      [staff, otherAdmin]))[0]
    expect(row).toEqual({ own: false, other: false, moderator: true })
    // The target-role guard is owner-only; test its actual rejection using a
    // genuine report, rather than granting clients EXECUTE on private helpers.
    const report = (await db.asUser<{ id: string }>(student,
      `insert into public.reports(kind,user_id,reason)
       values ('profile',$1,'Harassment or bullying') returning id`, [otherAdmin]))[0]
    await expect(asClaims(claims(),
      'select public.moderate_report($1,$2,$3)', [report.id, 'warn_user', 'Synthetic reviewed conduct']))
      .rejects.toMatchObject({ hint: 'admin_target_forbidden' })
  })

  it('refuses direct staff reads and decisions with an unassured login', async () => {
    const unassured = claims({ aal: 'aal1', amr: [{ method: 'password', timestamp: now() }] })
    expect(await asClaims(unassured, 'select * from public.reports')).toEqual([])
    await expect(asClaims(unassured, 'select public.moderate_report($1,$2,$3)',
      [randomUUID(), 'dismiss_report', 'Synthetic reviewed conduct']))
      .rejects.toMatchObject({ hint: 'not_moderator' })
  })

  it('rejects a session belonging to another account and a captured revoked session', async () => {
    const wrongSession = randomUUID()
    await db.asService('insert into auth.sessions(id,user_id) values ($1,$2)', [wrongSession, student])
    expect(await verdict({ session_id: wrongSession })).toBe(false)
    await db.asService('delete from auth.sessions where id=$1', [session])
    expect(await verdict()).toBe(false)
    expect((await asClaims<{ allowed: boolean }>(claims(), 'select app.is_moderator() as allowed'))[0].allowed).toBe(false)
  })

  it('keeps the new check authenticated-only and its private helper owner-only', async () => {
    await expect(db.asAnon('select public.staff_session_assured()')).rejects.toMatchObject({ code: '42501' })
    await expect(db.asUser(student, 'select app.staff_session_assured()')).rejects.toMatchObject({ code: '42501' })
  })
})

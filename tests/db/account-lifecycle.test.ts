import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, type TestDb } from './harness'

let db: TestDb
type Claims = { sub?: string; role: string; session_id?: string; aal?: string; amr?: { method: string; timestamp: number }[]; is_anonymous?: boolean }
type Receipt = { id: string; state: string; phase: string }
type Claim = { id: string; subject_id: string; phase: string; lease_token: string }

async function asClaims<T = Record<string, unknown>>(claims: Claims, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', claims.sub ?? ''])
  await db.raw.exec(`set role ${claims.role === 'service_role' ? 'service_role' : claims.role === 'anon' ? 'anon' : 'authenticated'}`)
  try { return (await db.raw.query<T>(sql, params)).rows } finally { await db.raw.exec('reset role') }
}

const service = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => asClaims<T>({ role: 'service_role' }, sql, params)

async function session(userId: string, methods = [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }], aal = 'aal1'): Promise<Claims> {
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id, user_id) values ($1, $2)', [id, userId])
  await db.asService('insert into auth.refresh_tokens(user_id, session_id, token) values ($1, $2, $3)', [userId, id, 'S10-synthetic-refresh-not-a-real-token'])
  return { sub: userId, role: 'authenticated', session_id: id, aal, amr: methods, is_anonymous: false }
}

async function request(claims: Claims): Promise<Receipt> {
  const rows = await asClaims<{ value: Receipt }>(claims,
    'select public.account_request_deletion($1, $2, $3) as value', ['DELETE MY ACCOUNT', true, randomUUID()])
  return rows[0]!.value
}
async function claim(receipt: Receipt): Promise<Claim> {
  return (await service<{ value: Claim }>('select public.account_deletion_claim($1) as value', [receipt.id]))[0]!.value
}
async function project(user: string, sharedWith?: string) {
  const rows = await asClaims<{ id: string; slug: string }>(await session(user),
    'insert into public.projects(title, description) values ($1, $2) returning id, slug',
    ['S10 synthetic collaboration', 'Only synthetic data in an in-memory fixture.'])
  if (sharedWith) await db.asService('insert into public.project_members(project_id, profile_id) values ($1, $2)', [rows[0]!.id, sharedWith])
  return rows[0]!
}

beforeAll(async () => {
  db = await createTestDb()
  // TEST-ONLY platform surfaces absent from the minimal existing bootstrap.
  // This does not exercise GoTrue, JWT signature checks or hosted Storage bytes.
  await db.raw.exec(`
    create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
    create table auth.refresh_tokens(
      id bigint generated always as identity primary key,
      user_id text not null, session_id uuid references auth.sessions(id) on delete cascade, token text
    );
    create type auth.factor_status as enum ('unverified', 'verified');
    create type auth.factor_type as enum ('totp', 'webauthn');
    create table auth.mfa_factors(
      id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
      status auth.factor_status not null, factor_type auth.factor_type not null,
      created_at timestamptz not null, updated_at timestamptz not null, secret text
    );
    revoke all on auth.sessions, auth.refresh_tokens, auth.mfa_factors
      from public, anon, authenticated, service_role;
  `)
}, 120_000)

afterAll(async () => { await db?.close() })

describe('S10 account migration and provider-signed reauthentication contract', () => {
  it('keeps private tables and worker RPCs inaccessible to user/anon clients', async () => {
    const user = await db.createUser()
    const current = await session(user)
    await expect(asClaims(current, 'select * from public.account_deletion_jobs')).rejects.toMatchObject({ code: '42501' })
    await expect(asClaims(current, 'select public.account_deletion_claim()')).rejects.toMatchObject({ code: '42501' })
    await expect(db.asAnon('select public.account_deletion_prepare_media($1, $2)', [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '42501' })
    await expect(asClaims(current, 'select app.account_export_page($1, $2, $3)', ['messages', null, 25])).rejects.toMatchObject({ code: '42501' })
  })

  it('does not accept session freshness, recovery, email OTP, old AMR or a revoked session as reauthentication', async () => {
    const user = await db.createUser()
    for (const method of ['recovery', 'otp', 'email']) {
      await expect(asClaims(await session(user, [{ method, timestamp: Math.floor(Date.now() / 1000) }]),
        'select public.account_export()')).rejects.toMatchObject({ code: '42501', hint: 'provider_assurance_required' })
    }
    const stale = await session(user, [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 1000 }])
    await expect(asClaims(stale, 'select public.account_export()')).rejects.toMatchObject({ hint: 'provider_assurance_required' })
    const revoked = await session(user)
    await db.asService('delete from auth.sessions where id = $1', [revoked.session_id])
    await expect(asClaims(revoked, 'select public.account_export()')).rejects.toMatchObject({ hint: 'signed_out' })
  })

  it('requires fresh aal2 MFA for staff, while permitting fresh strong provider assurance', async () => {
    const user = await db.createUser({ role: 'moderator' })
    await expect(asClaims(await session(user), 'select public.account_export()')).rejects.toMatchObject({ hint: 'provider_assurance_required' })
    const mfa = await session(user, [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }], 'aal2')
    const result = await asClaims<{ value: { subject_id: string } }>(mfa, 'select public.account_export($1) as value', ['profile'])
    expect(result[0]!.value.subject_id).toBe(user)
  })

  it('exports only own sent messages and whitelisted fields, even for a moderator', async () => {
    const owner = await db.createUser({ role: 'moderator' })
    const other = await db.createUser({ visibility: 'private' })
    const conversation = (await db.asService<{ id: string }>(
      `insert into public.conversations(type, title, created_by) values ('group', 'S10 private fixture', $1) returning id`, [owner]))[0]!.id
    await db.asService('insert into public.conversation_participants(conversation_id, profile_id) values ($1, $2), ($1, $3)', [conversation, owner, other])
    await db.asService(`insert into public.messages(conversation_id, sender_id, body) values ($1, $2, $4), ($1, $3, $5)`,
      [conversation, owner, other, 'S10-OWN-SENT-BODY', 'S10-OTHER-PRIVATE-BODY'])
    await db.asService('update auth.users set encrypted_password = $2, raw_user_meta_data = $3 where id = $1',
      [owner, 'S10-NEVER-EXPORT-HASH', { secret: 'S10-NEVER-EXPORT-IDENTITY-METADATA' }])
    const current = await session(owner, [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }], 'aal2')
    const value = (await asClaims<{ value: { sections: Record<string, { records: unknown[] }> } }>(current,
      'select public.account_export() as value'))[0]!.value
    const text = JSON.stringify(value)
    expect(text.includes('S10-OWN-SENT-BODY')).toBe(true)
    for (const marker of ['S10-OTHER-PRIVATE-BODY', 'S10-NEVER-EXPORT-HASH', 'S10-NEVER-EXPORT-IDENTITY-METADATA', 'S10-synthetic-refresh-not-a-real-token']) {
      expect(text.includes(marker)).toBe(false)
    }
    expect(value.sections.messages!.records).toHaveLength(1)
  })

  it('bounds export pages and refuses arbitrary sections/cursors/limits', async () => {
    const user = await db.createUser()
    await db.asService('insert into public.posts(author_id, body) select $1, $2 from generate_series(1, 4)', [user, 'S10 bounded own post'])
    const current = await session(user)
    type Export = { sections: { posts: { records: { id: string }[]; next_cursor: string | null } } }
    const first = (await asClaims<{ value: Export }>(current, 'select public.account_export($1, $2, $3) as value', ['posts', null, 2]))[0]!.value.sections.posts
    const next = (await asClaims<{ value: Export }>(current, 'select public.account_export($1, $2, $3) as value', ['posts', first.next_cursor, 2]))[0]!.value.sections.posts
    expect(first.records).toHaveLength(2)
    expect(next.records).toHaveLength(2)
    expect(new Set([...first.records, ...next.records].map(row => row.id)).size).toBe(4)
    expect(next.next_cursor).toBeNull()
    for (const params of [['auth.users', null, 2], ['posts', "' OR true --", 2], ['posts', null, 101], ['posts', null, 0]]) {
      await expect(asClaims(current, 'select public.account_export($1, $2, $3)', params)).rejects.toMatchObject({ code: '22023' })
    }
  })
})

describe('S10 durable deletion and ownership', () => {
  it('does not queue or revoke sessions without explicit confirmation and acknowledgement', async () => {
    const user = await db.createUser()
    const current = await session(user)
    for (const [confirmation, acknowledge] of [['delete', true], ['DELETE MY ACCOUNT', false]]) {
      await expect(asClaims(current, 'select public.account_request_deletion($1, $2, $3)', [confirmation, acknowledge, randomUUID()]))
        .rejects.toMatchObject({ hint: 'confirmation_required' })
    }
    expect((await db.asService<{ n: number }>('select count(*)::integer as n from auth.sessions where user_id = $1', [user]))[0]!.n).toBe(1)
    expect((await db.asService<{ n: number }>('select count(*)::integer as n from public.account_deletion_jobs where subject_id = $1', [user]))[0]!.n).toBe(0)
  })

  it('blocks shared and soft-deleted shared projects, including direct provider hard deletion', async () => {
    const owner = await db.createUser()
    const member = await db.createUser()
    const shared = await project(owner, member)
    await expect(request(await session(owner))).rejects.toMatchObject({ hint: 'ownership_transfer_required' })
    await db.asService('update public.projects set deleted_at = clock_timestamp() where id = $1', [shared.id])
    await expect(request(await session(owner))).rejects.toMatchObject({ hint: 'ownership_transfer_required' })
    await expect(db.asService('delete from auth.users where id = $1', [owner])).rejects.toMatchObject({ hint: 'ownership_transfer_required' })
    expect((await db.asService<{ owner_id: string }>('select owner_id from public.projects where id = $1', [shared.id]))[0]!.owner_id).toBe(owner)
  })

  it('permits deletion after the existing ownership transfer, preserving the shared project', async () => {
    const owner = await db.createUser()
    const member = await db.createUser()
    const shared = await project(owner, member)
    const current = await session(owner)
    await asClaims(current, 'select public.transfer_project_ownership($1, $2)', [shared.id, member])
    const accepted = await request(current)
    const lease = await claim(accepted)
    await service('select public.account_deletion_prepare_media($1, $2)', [lease.id, lease.lease_token])
    await service('select public.account_deletion_cleanup_content($1, $2)', [lease.id, lease.lease_token])
    expect((await db.asService<{ owner_id: string }>('select owner_id from public.projects where id = $1', [shared.id]))[0]!.owner_id).toBe(member)
    expect((await db.asService<{ n: number }>('select count(*)::integer as n from public.project_members where project_id = $1 and role = $2', [shared.id, 'owner']))[0]!.n).toBe(1)
  })

  it('atomically queues, disables and revokes all sessions; rejects old-JWT data/RPC replay through completion', async () => {
    const user = await db.createUser()
    const other = await db.createUser()
    const current = await session(user)
    await session(user)
    await db.asService('insert into public.posts(author_id, body) values ($1, $2)', [user, 'S10 removable private body'])
    const accepted = await request(current)
    expect(accepted).toMatchObject({ state: 'queued', phase: 'media' })
    expect((await db.asService<{ n: number }>('select count(*)::integer as n from auth.sessions where user_id = $1', [user]))[0]!.n).toBe(0)
    expect((await db.asService<{ n: number }>('select count(*)::integer as n from auth.refresh_tokens where user_id = $1', [user]))[0]!.n).toBe(0)
    expect(await asClaims(current, 'select id from public.posts')).toEqual([])
    await expect(asClaims(current, 'select public.total_unread_messages()')).rejects.toMatchObject({ hint: 'account_unavailable' })
    await expect(asClaims(current, 'select public.start_direct_conversation($1)', [other])).rejects.toMatchObject({ hint: 'account_unavailable' })
    const lease = await claim(accepted)
    await expect(service('select public.account_deletion_finish($1, $2)', [lease.id, lease.lease_token])).rejects.toMatchObject({ hint: 'provider_unavailable' })
    await service('select public.account_deletion_prepare_media($1, $2)', [lease.id, lease.lease_token])
    await service('select public.account_deletion_cleanup_content($1, $2)', [lease.id, lease.lease_token])
    // Synthetic stand-in for admin.deleteUser; NEVER run against a hosted account.
    await db.asService('delete from auth.users where id = $1', [user])
    const result = (await service<{ value: Receipt }>('select public.account_deletion_finish($1, $2) as value', [lease.id, lease.lease_token]))[0]!.value
    expect(result).toMatchObject({ id: accepted.id, state: 'completed', phase: 'complete' })
    expect(await asClaims(current, 'select id from public.profiles')).toEqual([])
    await expect(asClaims(current, 'select public.account_export()')).rejects.toMatchObject({ hint: 'account_unavailable' })
    const status = (await db.asAnon<{ value: Receipt }>('select public.account_deletion_status($1) as value', [accepted.id]))[0]!.value
    expect(Object.keys(status).sort()).toEqual(['id', 'phase', 'state'])
    const retained = (await db.asService<{ subject_id: string | null; request_key: string | null }>('select subject_id, request_key from public.account_deletion_jobs where id = $1', [accepted.id]))[0]!
    expect(retained.subject_id).toBeNull()
    expect(retained.request_key).toBeNull()
  })
})

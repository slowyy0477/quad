import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, type TestDb } from './harness'
import { EXPORT_SECTION_NAMES } from '@/features/account/policy'

/**
 * Prepared, unrun synthetic SQL regression. Main owns all execution.
 * createTestDb is a fresh in-memory platform shim, never a provider connection.
 * Auth surfaces below are installed after migrations, without bootstrap edits.
 * JWT GUCs test SQL predicates/grants, not token signatures, MFA challenges,
 * GoTrue deletion, Storage transport, deployed workers or hosted acceptance.
 */
let db: TestDb
type Claims = {
  role: 'authenticated' | 'anon' | 'service_role'
  sub?: string
  session_id?: string
  aal?: string
  amr?: { method: string; timestamp: number }[]
  is_anonymous?: boolean
}
type Export = {
  subject_id: string
  sections: Record<string, { records: Record<string, unknown>[]; next_cursor: string | null }>
}
type Receipt = { id: string; state: string; phase: string }
type Claim = { id: string; subject_id: string; lease_token: string; phase: string }
type Project = { id: string; slug: string }
type Invitation = {
  id: string; project_id: string; inviter_id: string; invitee_id: string
  message: string; proposed_role: string; status: string
  responded_at: string | null; created_at: string; updated_at: string
}
const SECTIONS = ['project_invites_sent', 'project_invites_received'] as const
const STATES = ['pending', 'accepted', 'declined', 'revoked'] as const
const PRIVATE_COLUMN = 'SYNTHETIC-UNKNOWN-INVITATION-PRIVATE-COLUMN'

async function asClaims<T = Record<string, unknown>>(
  claims: Claims,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', claims.sub ?? ''])
  const role = claims.role === 'service_role' ? 'service_role' : claims.role === 'anon' ? 'anon' : 'authenticated'
  await db.raw.exec(`set role ${role}`)
  try { return (await db.raw.query<T>(sql, params)).rows } finally { await db.raw.exec('reset role') }
}

const worker = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asClaims<T>({ role: 'service_role' }, sql, params)

async function session(userId: string, method = 'password', aal = 'aal1'): Promise<Claims> {
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id, user_id) values ($1, $2)', [id, userId])
  await db.asService('insert into auth.refresh_tokens(user_id, session_id, token) values ($1, $2, $3)',
    [userId, id, `SYNTHETIC-REFRESH-TOKEN:${id}`])
  const timestamp = (await db.asService<{ timestamp: number }>(
    'select floor(extract(epoch from clock_timestamp()))::double precision as timestamp',
  ))[0]!.timestamp
  return { sub: userId, role: 'authenticated', session_id: id, aal, amr: [{ method, timestamp }], is_anonymous: false }
}

async function factor(userId: string) {
  await db.asService(
    `insert into auth.mfa_factors(id, user_id, status, factor_type, created_at, updated_at, secret)
     values ($1, $2, 'verified', 'totp', clock_timestamp(), clock_timestamp(), $3)`,
    [randomUUID(), userId, 'SYNTHETIC-FACTOR-SECRET'],
  )
}

async function project(owner: string, sharedWith?: string): Promise<Project> {
  const rows = await asClaims<Project>(await session(owner),
    'insert into public.projects(title, description, visibility) values ($1, $2, $3) returning id, slug',
    [`Synthetic account invitation ${randomUUID()}`, 'PRIVATE-PROJECT-DESCRIPTION', 'private'])
  if (sharedWith) await db.asService(
    'insert into public.project_members(project_id, profile_id) values ($1, $2)', [rows[0]!.id, sharedWith],
  )
  return rows[0]!
}

async function invitation(
  target: Project,
  inviter: string,
  invitee: string,
  message: string,
  status: typeof STATES[number] = 'pending',
): Promise<Invitation> {
  // Superuser fixture setup only. Resolved history may predate current
  // membership/management; this does not replace the invitation-write tests.
  const rows = await db.asService<Invitation>(
    `insert into public.project_invites(
       id, project_id, inviter_id, invitee_id, message, proposed_role, status, responded_at,
       fixture_private_note, fixture_private_metadata
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       case when $7 = 'pending' then null else clock_timestamp() end, $8, $9
     ) returning id, project_id, inviter_id, invitee_id, message, proposed_role, status,
       to_jsonb(responded_at) #>> '{}' as responded_at,
       to_jsonb(created_at) #>> '{}' as created_at,
       to_jsonb(updated_at) #>> '{}' as updated_at`,
    [randomUUID(), target.id, inviter, invitee, message, `PRIVATE-PROPOSED-ROLE:${message}`, status,
      PRIVATE_COLUMN, { secret: 'SYNTHETIC-UNKNOWN-INVITATION-METADATA' }],
  )
  return rows[0]!
}

async function readExport(claims: Claims, section: string | null = null, after: string | null = null, limit = 25): Promise<Export> {
  return (await asClaims<{ value: Export }>(claims,
    'select public.account_export($1, $2, $3) as value', [section, after, limit]))[0]!.value
}

async function request(claims: Claims): Promise<Receipt> {
  return (await asClaims<{ value: Receipt }>(claims,
    'select public.account_request_deletion($1, $2, $3) as value',
    ['DELETE MY ACCOUNT', true, randomUUID()]))[0]!.value
}

async function claim(receipt: Receipt): Promise<Claim> {
  const value = (await worker<{ value: Claim | null }>(
    'select public.account_deletion_claim($1) as value', [receipt.id],
  ))[0]!.value
  if (!value) throw new Error('Synthetic worker did not obtain its exact receipt lease')
  return value
}

async function cleanup(lease: Claim) {
  await worker('select public.account_deletion_prepare_media($1, $2)', [lease.id, lease.lease_token])
  return (await worker<{ value: { ready: boolean; code?: string } }>(
    'select public.account_deletion_cleanup_content($1, $2) as value', [lease.id, lease.lease_token],
  ))[0]!.value
}

async function remainingInvites(): Promise<Invitation[]> {
  // Real service-role table grant/BYPASSRLS, not db.asService's owner privilege.
  // Fixed fixture query only; this intentionally is not a browser read claim.
  return worker<Invitation>(
    `select id, project_id, inviter_id, invitee_id, message, proposed_role, status,
       to_jsonb(responded_at) #>> '{}' as responded_at,
       to_jsonb(created_at) #>> '{}' as created_at,
       to_jsonb(updated_at) #>> '{}' as updated_at
     from public.project_invites order by id`,
  )
}

beforeAll(async () => {
  db = await createTestDb()
  await db.raw.exec(`
    create table if not exists auth.sessions(
      id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade
    );
    create table if not exists auth.refresh_tokens(
      id bigint generated always as identity primary key,
      user_id text not null, session_id uuid references auth.sessions(id) on delete cascade, token text
    );
    do $fixture$
    begin create type auth.factor_status as enum ('unverified', 'verified');
    exception when duplicate_object then null;
    end;
    $fixture$;
    do $fixture$
    begin create type auth.factor_type as enum ('totp', 'webauthn');
    exception when duplicate_object then null;
    end;
    $fixture$;
    create table if not exists auth.mfa_factors(
      id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
      status auth.factor_status not null, factor_type auth.factor_type not null,
      created_at timestamptz not null, updated_at timestamptz not null, secret text
    );
    revoke all on auth.sessions, auth.refresh_tokens, auth.mfa_factors
      from public, anon, authenticated, service_role;
    alter table public.project_invites add column fixture_private_note text;
    alter table public.project_invites add column fixture_private_metadata jsonb;
  `)
}, 120_000)

afterAll(async () => { await db?.close() })

describe('0038 bounded own invitation exports', () => {
  it('does not substitute staff/management access for authorship and excludes received notes/private project/unknown fields', async () => {
    const owner = await db.createUser({ role: 'moderator' })
    const other = await db.createUser()
    const third = await db.createUser()
    await factor(owner)
    const own = await project(owner)
    const managed = await project(owner)
    await db.asService(
      "insert into public.project_members(project_id, profile_id, role) values ($1, $2, 'maintainer')",
      [managed.id, third],
    )
    const privateOther = await project(other)
    const sent = await invitation(own, owner, other, 'SELF-AUTHORED-NOTE')
    const received = await invitation(privateOther, other, owner, 'OTHER-AUTHOR-PRIVATE-NOTE', 'declined')
    await invitation(managed, third, other, 'OTHER-MANAGER-PRIVATE-NOTE')
    await invitation(privateOther, other, third, 'UNRELATED-PRIVATE-NOTE')
    const exported = await readExport(await session(owner, 'totp', 'aal2'))
    expect(exported.subject_id).toBe(owner)
    expect(Object.keys(exported.sections).sort()).toEqual([...EXPORT_SECTION_NAMES].sort())
    expect(exported.sections.project_invites_sent!.records).toEqual([{
      id: sent.id, project_id: sent.project_id, message: sent.message, proposed_role: sent.proposed_role,
      status: sent.status, responded_at: sent.responded_at, created_at: sent.created_at, updated_at: sent.updated_at,
    }])
    expect(exported.sections.project_invites_received!.records).toEqual([{
      id: received.id, project_id: received.project_id, status: received.status,
      responded_at: received.responded_at, created_at: received.created_at, updated_at: received.updated_at,
    }])
    const invitationText = JSON.stringify({
      sent: exported.sections.project_invites_sent, received: exported.sections.project_invites_received,
    })
    for (const marker of [
      other, third, 'OTHER-AUTHOR-PRIVATE-NOTE', 'OTHER-MANAGER-PRIVATE-NOTE', 'UNRELATED-PRIVATE-NOTE',
      'PRIVATE-PROPOSED-ROLE:OTHER-AUTHOR-PRIVATE-NOTE', 'PRIVATE-PROJECT-DESCRIPTION',
      PRIVATE_COLUMN, 'SYNTHETIC-UNKNOWN-INVITATION-METADATA', 'SYNTHETIC-FACTOR-SECRET', 'SYNTHETIC-REFRESH-TOKEN',
    ]) expect(invitationText).not.toContain(marker)
  })

  it('preserves genuine own department_id and explicit null without exporting the directory or another profile', async () => {
    const owner = await db.createUser()
    const other = await db.createUser()
    const university = (await db.asService<{ id: string }>(
      'insert into public.universities(name, slug, status) values ($1, $2, $3) returning id',
      ['Synthetic export university', `export-${randomUUID()}`, 'approved'],
    ))[0]!.id
    const department = (await db.asService<{ id: string }>(
      'insert into public.departments(university_id, name, slug, created_by) values ($1, $2, $3, $4) returning id',
      [university, 'PRIVATE-DIRECTORY-ROW-NOT-EXPORTED', `export-${randomUUID()}`, other],
    ))[0]!.id
    await db.asService('update public.profiles set university_id = $2, department_id = $3 where id = $1', [owner, university, department])
    const current = await session(owner)
    const linked = await readExport(current, 'profile')
    expect(linked.sections.profile!.records[0]).toHaveProperty('department_id', department)
    expect(JSON.stringify(linked)).not.toContain('PRIVATE-DIRECTORY-ROW-NOT-EXPORTED')
    expect(JSON.stringify(linked)).not.toContain(other)
    await db.asService('update public.profiles set department_id = null where id = $1', [owner])
    expect((await readExport(current, 'profile')).sections.profile!.records[0]).toHaveProperty('department_id', null)
  })

  it.each(SECTIONS)('paginates %s stably by own invitation IDs with no overlap', async section => {
    const owner = await db.createUser()
    const other = await db.createUser()
    const rows: Invitation[] = []
    for (const status of STATES) {
      const actor = section === 'project_invites_sent' ? owner : other
      rows.push(await invitation(await project(actor), actor, actor === owner ? other : owner, 'PAGED-AUTHOR-NOTE', status))
    }
    const current = await session(owner)
    const first = (await readExport(current, section, null, 2)).sections[section]!
    const next = (await readExport(current, section, first.next_cursor, 2)).sections[section]!
    const expectedIds = rows.map(row => row.id).sort()
    expect(first.records.map(row => row.id)).toEqual(expectedIds.slice(0, 2))
    expect(first.next_cursor).toBe(expectedIds[1])
    expect(next.records.map(row => row.id)).toEqual(expectedIds.slice(2))
    expect(next.next_cursor).toBeNull()
    if (section === 'project_invites_received') expect(JSON.stringify([first, next])).not.toContain('PAGED-AUTHOR-NOTE')
  })

  it('keeps fresh password/enrolled-factor MFA, session revocation and raw caller gates for the new sections', async () => {
    const owner = await db.createUser()
    const current = await session(owner)
    expect((await readExport(current, 'project_invites_sent')).subject_id).toBe(owner)
    for (const method of ['recovery', 'email', 'otp']) await expect(
      readExport({ ...current, amr: [{ method, timestamp: current.amr![0].timestamp }] }, 'project_invites_received'),
    ).rejects.toMatchObject({ code: '42501', hint: 'provider_assurance_required' })
    await factor(owner)
    await expect(readExport(current, 'project_invites_sent')).rejects.toMatchObject({ code: '42501', hint: 'provider_assurance_required' })
    const strong = await session(owner, 'totp', 'aal2')
    expect((await readExport(strong, 'project_invites_received')).subject_id).toBe(owner)
    await db.asService('delete from auth.sessions where id = $1', [strong.session_id])
    await expect(readExport(strong, 'project_invites_received')).rejects.toMatchObject({ code: '42501', hint: 'signed_out' })
  })

  it('preserves private helper/audience grants and rejects unbounded or arbitrary section/cursor requests', async () => {
    const owner = await db.createUser()
    const current = await session(owner)
    for (const caller of [current, { role: 'anon' }, { role: 'service_role' }] as Claims[]) {
      await expect(asClaims(caller, 'select app.account_export_page($1, $2, $3)', ['project_invites_sent', null, 25]))
        .rejects.toMatchObject({ code: '42501' })
    }
    for (const caller of [{ role: 'anon' }, { role: 'service_role' }] as Claims[]) {
      await expect(asClaims(caller, 'select public.account_export($1)', ['project_invites_received']))
        .rejects.toMatchObject({ code: '42501' })
    }
    for (const params of [
      ['project_invites_sent', null, 101], ['project_invites_received', null, 0],
      ['project_invites_received', "' OR true --", 2], ['project_invites', null, 2], [null, randomUUID(), 2],
    ]) await expect(asClaims(current, 'select public.account_export($1, $2, $3)', params))
      .rejects.toMatchObject({ code: '22023', hint: 'invalid_request' })
    await expect(asClaims(current, 'select public.account_deletion_cleanup_content($1, $2)', [randomUUID(), randomUUID()]))
      .rejects.toMatchObject({ code: '42501' })
  })
})

describe('existing hosted invite cascades in account cleanup', () => {
  it('removes all inviter/invitee/project references and every status in the content phase before Auth deletion, preserving unrelated accounts/invites', async () => {
    const owner = await db.createUser()
    const other = await db.createUser()
    const third = await db.createUser()
    const owned = await project(owner)
    await invitation(owned, third, other, 'REMOVE-DELETED-PROJECT-NOTE')
    for (const status of STATES) {
      const surviving = await project(other)
      await invitation(surviving, owner, third, `REMOVE-SENT-${status}`, status)
      await invitation(surviving, other, owner, `REMOVE-RECEIVED-${status}`, status)
    }
    const unrelated = await invitation(await project(other), other, third, 'KEEP-UNRELATED-INVITATION')
    const beforeOther = await worker('select id, email from auth.users where id in ($1, $2) order by id', [other, third])
    const current = await session(owner)
    const receipt = await request(current)
    await expect(readExport(current, 'project_invites_sent')).rejects.toMatchObject({ code: '42501', hint: 'account_unavailable' })
    const lease = await claim(receipt)
    expect(await cleanup(lease)).toMatchObject({ ready: true })
    const rows = await remainingInvites()
    expect(rows.filter(row => row.inviter_id === owner || row.invitee_id === owner || row.project_id === owned.id)).toEqual([])
    expect(rows.find(row => row.id === unrelated.id)).toEqual(unrelated)
    // The content-phase profile cascade, not an Auth delete stand-in, removed
    // the invitations. Auth still exists at this exact observation point.
    expect(await worker('select id from auth.users where id = $1', [owner])).toEqual([{ id: owner }])
    expect(await worker('select id from public.profiles where id = $1', [owner])).toEqual([])
    expect(await worker('select id from public.projects where id = $1', [owned.id])).toEqual([])
    expect(await worker('select id, email from auth.users where id in ($1, $2) order by id', [other, third])).toEqual(beforeOther)
    const afterContent = await remainingInvites()
    expect(await cleanup(lease)).toMatchObject({ ready: true })
    expect(await remainingInvites()).toEqual(afterContent)
    // Explicit synthetic stand-in ONLY; never an SDK or hosted admin deletion.
    await db.asService('delete from auth.users where id = $1', [owner])
    expect((await worker<{ value: Receipt }>('select public.account_deletion_finish($1, $2) as value', [lease.id, lease.lease_token]))[0]!.value)
      .toEqual({ id: receipt.id, state: 'completed', phase: 'complete' })
    const status = (await db.asAnon<{ value: Receipt }>('select public.account_deletion_status($1) as value', [receipt.id]))[0]!.value
    expect(Object.keys(status).sort()).toEqual(['id', 'phase', 'state'])
    expect(JSON.stringify(status)).not.toContain(owner)
    expect(await remainingInvites()).toEqual(afterContent)
  })

  it('blocks shared ownership before revocation and preserves transferred shared projects and unrelated invitation rows', async () => {
    const owner = await db.createUser()
    const newOwner = await db.createUser()
    const recipient = await db.createUser()
    const otherRecipient = await db.createUser()
    const shared = await project(owner, newOwner)
    await invitation(shared, owner, recipient, 'REMOVE-OLD-INVITER-NOTE')
    const unrelated = await invitation(shared, newOwner, otherRecipient, 'KEEP-NEW-OWNER-INVITATION')
    const current = await session(owner)
    const before = await remainingInvites()
    await expect(request(current)).rejects.toMatchObject({ code: '42501', hint: 'ownership_transfer_required' })
    expect(await remainingInvites()).toEqual(before)
    // Real existing RPC, not a fixture owner-id/role UPDATE or widened grant.
    await asClaims(current, 'select public.transfer_project_ownership($1, $2)', [shared.id, newOwner])
    const lease = await claim(await request(current))
    expect(await cleanup(lease)).toMatchObject({ ready: true })
    expect(await worker('select id, owner_id from public.projects where id = $1', [shared.id]))
      .toEqual([{ id: shared.id, owner_id: newOwner }])
    expect(await worker('select profile_id, role from public.project_members where project_id = $1', [shared.id]))
      .toEqual([{ profile_id: newOwner, role: 'owner' }])
    const rows = await remainingInvites()
    expect(rows.filter(row => row.project_id === shared.id)).toEqual([unrelated])
  })

  it('refuses a late project membership without altering invitations or bypassing the deletion guard', async () => {
    const owner = await db.createUser()
    const other = await db.createUser()
    const shared = await project(owner)
    const row = await invitation(shared, owner, other, 'KEEP-WHILE-OWNERSHIP-BLOCKED')
    const receipt = await request(await session(owner))
    // Even provider-privileged writes must obey the real deletion fence.
    await expect(db.asService(
      'insert into public.project_members(project_id, profile_id) values ($1, $2)', [shared.id, other],
    )).rejects.toMatchObject({ code: '42501', hint: 'ownership_transfer_required' })
    expect(await worker('select profile_id from public.project_members where project_id = $1 and profile_id = $2',
      [shared.id, other])).toEqual([])
    expect((await remainingInvites()).find(invite => invite.id === row.id)).toEqual(row)
    expect(await worker('select id from public.profiles where id = $1', [owner])).toEqual([{ id: owner }])
    expect(await cleanup(await claim(receipt))).toMatchObject({ ready: true })
    expect((await remainingInvites()).some(invite => invite.id === row.id)).toBe(false)
    expect(await worker('select id from public.profiles where id = $1', [other])).toEqual([{ id: other }])
  })

  it('rechecks late provider ownership and keeps invitations/private content intact while blocked', async () => {
    const owner = await db.createUser()
    const other = await db.createUser()
    const owned = await project(owner)
    const row = await invitation(owned, owner, other, 'KEEP-WHILE-PROVIDER-OWNERSHIP-BLOCKED')
    const receipt = await request(await session(owner))
    // Provider-shaped external state: no application trigger is disabled and
    // no post-revocation human mutation is granted to manufacture a shared team.
    const bucket = `synthetic-lifecycle-${randomUUID()}`
    await db.asService('insert into storage.buckets(id, name, owner) values ($1, $1, $2)', [bucket, owner])
    const lease = await claim(receipt)
    expect((await worker<{ value: { ready: boolean; code: string } }>(
      'select public.account_deletion_prepare_media($1, $2) as value', [lease.id, lease.lease_token],
    ))[0]!.value).toMatchObject({ ready: false, code: 'shared_media_ownership' })
    expect((await remainingInvites()).find(invite => invite.id === row.id)).toEqual(row)
    expect(await worker('select id from public.profiles where id = $1', [owner])).toEqual([{ id: owner }])
    await expect(worker('select public.account_deletion_cleanup_content($1, $2)', [lease.id, lease.lease_token]))
      .rejects.toMatchObject({ code: '42501', hint: 'stale_cleanup_lease' })
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, type TestDb } from './harness'

let db: TestDb
type Claims = { role: string; sub?: string; session_id?: string; aal?: string; amr?: { method: string; timestamp: number }[] }
type Receipt = { id: string; state: string; phase: string }
type Claim = { id: string; lease_token: string }
type Image = { id: string; url: string }
type Media = { id: string; source_kind: string; source_id: string; bucket_id: string; object_path: string }

async function asClaims<T = Record<string, unknown>>(claims: Claims, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.raw.exec('reset role')
  await db.raw.query('select set_config($1,$2,false)', ['request.jwt.claims', JSON.stringify(claims)])
  await db.raw.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', claims.sub ?? ''])
  await db.raw.exec(`set role ${claims.role === 'service_role' ? 'service_role' : 'authenticated'}`)
  try { return (await db.raw.query<T>(sql, params)).rows } finally { await db.raw.exec('reset role') }
}

const service = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asClaims<T>({ role: 'service_role' }, sql, params)

async function session(userId: string): Promise<Claims> {
  const id = randomUUID()
  await db.asService('insert into auth.sessions(id,user_id) values ($1,$2)', [id, userId])
  await db.asService('insert into auth.refresh_tokens(user_id,session_id) values ($1,$2)', [userId, id])
  return { role: 'authenticated', sub: userId, session_id: id, aal: 'aal1',
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] }
}

async function request(userId: string): Promise<Receipt> {
  return (await asClaims<{ value: Receipt }>(await session(userId),
    'select public.account_request_deletion($1,true,$2) as value', ['DELETE MY ACCOUNT', randomUUID()]))[0].value
}

async function claim(receipt: Receipt): Promise<Claim> {
  return (await service<{ value: Claim }>('select public.account_deletion_claim($1) as value', [receipt.id]))[0].value
}

async function reserve(actor: string, kind = 'avatar', project: string | null = null) {
  return (await service<{ value: { id?: string; error?: string } }>(
    'select public.bulla_reserve_image($1,$2,$3) as value', [actor, kind, project]))[0].value
}

async function commit(id: string, actor: string): Promise<Image & { error?: string }> {
  return (await service<{ value: Image & { error?: string } }>(
    'select public.bulla_commit_image($1,$2,$3,900,120,80) as value', [id, actor, 'a'.repeat(64)]))[0].value
}

async function readyImage(actor: string, kind = 'avatar', project: string | null = null): Promise<Image> {
  const reservation = await reserve(actor, kind, project)
  expect(reservation.id).toBeDefined()
  const image = await commit(reservation.id!, actor)
  expect(image.error).toBeUndefined()
  // In-memory platform shim METADATA only, never hosted Storage bytes or API.
  await db.asService(`insert into storage.objects(bucket_id,name,metadata)
    values ('bulla-private-images',$1,'{"mimetype":"image/webp","size":900}')`, [`${image.id}.webp`])
  return image
}

async function prepare(lease: Claim) {
  return (await service<{ value: { ready: boolean } }>(
    'select public.account_deletion_prepare_media($1,$2) as value', [lease.id, lease.lease_token]))[0].value
}

async function batch(lease: Claim): Promise<Media[]> {
  return (await service<{ value: Media[] }>(
    'select public.account_deletion_media_batch($1,$2) as value', [lease.id, lease.lease_token]))[0].value
}

async function acknowledge(lease: Claim, mediaId: string) {
  await service('select public.account_deletion_mark_media_removed($1,$2,$3)', [lease.id, lease.lease_token, mediaId])
}

beforeAll(async () => {
  db = await createTestDb()
  // Test-only Auth surfaces; not signature/GoTrue/storage-network verification.
  await db.raw.exec(`
    create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
    create table auth.refresh_tokens(
      id bigint generated always as identity primary key,
      user_id text not null, session_id uuid references auth.sessions(id) on delete cascade
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

beforeEach(async () => {
  await db.asService(`update app.private_image_budgets set minute_hits=0 where subject='global'`)
})

afterAll(async () => { await db?.close() })

describe('0026/0027 private-image lifecycle interaction (isolated PGlite only)', () => {
  it('enrolls the later image table in restrictive account lifecycle guards', async () => {
    const policies = await db.asService(`select polpermissive from pg_catalog.pg_policy
      where polrelid='public.private_images'::regclass and polname='account_lifecycle_access_guard'`)
    expect(policies).toEqual([{ polpermissive: false }])
    expect(await db.asService(`select 1 from pg_catalog.pg_trigger
      where tgrelid='public.private_images'::regclass and tgname='account_lifecycle_write_guard'`)).toHaveLength(1)
  })

  it('retires server-owned images with NULL Storage owner and acknowledges only after API absence', async () => {
    const owner = await db.createUser()
    const image = await readyImage(owner)
    const receipt = await request(owner)
    expect(await db.asAnon('select id from public.private_images where id=$1', [image.id])).toHaveLength(0)
    expect(await reserve(owner)).toHaveProperty('error', 'upload_denied')
    const lease = await claim(receipt)
    expect(await prepare(lease)).toHaveProperty('ready', true)
    const media = await batch(lease)
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ source_kind: 'private_image', source_id: image.id,
      bucket_id: 'bulla-private-images', object_path: `${image.id}.webp` })
    expect(await db.asService('select state from public.private_images where id=$1', [image.id])).toEqual([{ state: 'retired' }])
    await expect(acknowledge(lease, media[0].id)).rejects.toMatchObject({ hint: 'media_cleanup_failed' })
    // Shim stand-in for successful Storage API metadata removal, not byte proof.
    await db.asService('delete from storage.objects where bucket_id=$1 and name=$2', ['bulla-private-images', `${image.id}.webp`])
    await acknowledge(lease, media[0].id)
    expect(await db.asService('select id from public.private_images where id=$1', [image.id])).toHaveLength(0)
    expect((await service<{ value: { ready: boolean } }>('select public.account_deletion_cleanup_content($1,$2) as value',
      [lease.id, lease.lease_token]))[0].value.ready).toBe(true)
    expect(await db.asService('select id from public.profiles where id=$1', [owner])).toHaveLength(0)
  })

  it('keeps the durable manifest valid when ordinary retired-image cleanup already forgot the row', async () => {
    const owner = await db.createUser()
    const image = await readyImage(owner)
    const lease = await claim(await request(owner))
    await prepare(lease)
    const original = (await batch(lease))[0]
    expect((await service<{ value: boolean }>('select public.bulla_retire_image($1,true) as value', [image.id]))[0].value).toBe(true)
    await db.asService('delete from storage.objects where bucket_id=$1 and name=$2', ['bulla-private-images', `${image.id}.webp`])
    expect((await service<{ value: boolean }>('select public.bulla_forget_image($1) as value', [image.id]))[0].value).toBe(true)
    expect(await batch(lease)).toEqual([original])
    await acknowledge(lease, original.id)
    expect(await db.asService('select state from public.account_deletion_media where id=$1', [original.id]))
      .toEqual([{ state: 'removed' }])
  })

  it('fences stale cleanup leases and refuses an object identity replaced after inventory', async () => {
    const owner = await db.createUser()
    const image = await readyImage(owner)
    const receipt = await request(owner)
    const stale = await claim(receipt)
    await prepare(stale)
    await db.asService(`update public.account_deletion_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [receipt.id])
    const fresh = await claim(receipt)
    expect(fresh.lease_token).not.toBe(stale.lease_token)
    await expect(batch(stale)).rejects.toMatchObject({ code: '42501', hint: 'stale_cleanup_lease' })
    await db.asService('delete from storage.objects where bucket_id=$1 and name=$2', ['bulla-private-images', `${image.id}.webp`])
    await db.asService(`insert into storage.objects(bucket_id,name) values ('bulla-private-images',$1)`, [`${image.id}.webp`])
    await expect(batch(fresh)).rejects.toMatchObject({ code: '42501', hint: 'media_ownership_review' })
  })

  it('blocks active pending uploads, then retires an expired reservation and refuses its late commit', async () => {
    const owner = await db.createUser()
    const pending = await reserve(owner)
    await expect(request(owner)).rejects.toMatchObject({ hint: 'shared_media_ownership' })
    await service('select public.bulla_retire_image($1,false)', [pending.id])
    await service('select public.bulla_forget_image($1)', [pending.id])
    const expired = (await db.asService<{ id: string }>(`insert into public.private_images
      (kind,owner_id,actor_id,profile_id,byte_count,expires_at)
      values ('avatar',$1,$1,$1,524288,clock_timestamp()-interval '31 seconds') returning id`, [owner]))[0].id
    const lease = await claim(await request(owner))
    await prepare(lease)
    expect(await commit(expired, owner)).toHaveProperty('error', 'upload_denied')
    expect(await db.asService('select state from public.private_images where id=$1', [expired])).toEqual([{ state: 'retired' }])
  })

  it('preserves a surviving project cover instead of cascading away a deleting maintainer', async () => {
    const owner = await db.createUser()
    const maintainer = await db.createUser()
    const project = (await db.asUser<{ id: string }>(owner,
      `insert into public.projects(title,description) values ('Synthetic shared cover','No owner data') returning id`))[0].id
    await db.asUser(owner, `insert into public.project_members(project_id,profile_id,role) values ($1,$2,'maintainer')`, [project, maintainer])
    const shared = await readyImage(maintainer, 'project-cover', project)
    await expect(request(maintainer)).rejects.toMatchObject({ hint: 'shared_media_ownership' })
    await expect(db.asService('delete from auth.users where id=$1', [maintainer])).rejects.toMatchObject({ hint: 'shared_media_ownership' })
    expect(await db.asUser(owner, 'select id from public.private_images where id=$1', [shared.id])).toHaveLength(1)
    const replacement = await readyImage(owner, 'project-cover', project)
    await db.asService('delete from storage.objects where bucket_id=$1 and name=$2', ['bulla-private-images', `${shared.id}.webp`])
    await service('select public.bulla_forget_image($1)', [shared.id])
    expect(await request(maintainer)).toHaveProperty('state', 'queued')
    expect(await db.asUser(owner, 'select id from public.private_images where id=$1', [replacement.id])).toHaveLength(1)
  })

  it('invalidates transferred-cover reads and requires replacement before deleting its original owner', async () => {
    const owner = await db.createUser()
    const nextOwner = await db.createUser()
    const project = (await db.asUser<{ id: string }>(owner,
      `insert into public.projects(title,description) values ('Synthetic transfer','No owner data') returning id`))[0].id
    await db.asUser(owner, 'insert into public.project_members(project_id,profile_id) values ($1,$2)', [project, nextOwner])
    const old = await readyImage(owner, 'project-cover', project)
    await db.asUser(owner, 'select public.transfer_project_ownership($1,$2)', [project, nextOwner])
    expect(await db.asUser(nextOwner, 'select id from public.private_images where id=$1', [old.id])).toHaveLength(0)
    await expect(request(owner)).rejects.toMatchObject({ hint: 'shared_media_ownership' })
    const replacement = await readyImage(nextOwner, 'project-cover', project)
    await db.asService('delete from storage.objects where bucket_id=$1 and name=$2', ['bulla-private-images', `${old.id}.webp`])
    await service('select public.bulla_forget_image($1)', [old.id])
    expect(await request(owner)).toHaveProperty('state', 'queued')
    expect(await db.asUser(nextOwner, 'select id from public.private_images where id=$1', [replacement.id])).toHaveLength(1)
  })
})

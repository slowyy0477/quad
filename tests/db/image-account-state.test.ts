import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let owner: string
let viewer: string
let maintainer: string
let member: string
let project: string
let reserved: string[] = []

type Reservation = { id?: string; ownerId?: string; actorId?: string; error?: string }
type Image = { id: string; url: string; error?: string }

beforeAll(async () => {
  db = await createTestDb()
  // Test-only provider surfaces in this fresh in-memory instance. Production
  // migration uses JSON lookup and never adds/changes Auth or local DB columns.
  await db.raw.exec(`alter table auth.users
    add column if not exists banned_until timestamptz,
    add column if not exists disabled_at timestamptz`)
}, 120_000)

beforeEach(async () => {
  reserved = []
  await db.asService(`update app.private_image_budgets set minute_hits=0 where subject='global'`)
  owner = await db.createUser()
  viewer = await db.createUser()
  maintainer = await db.createUser()
  member = await db.createUser()
  project = (await db.asUser<{ id: string }>(owner,
    `insert into public.projects(title,description,visibility)
     values ('Synthetic account-state cover','In-memory fixture only','private') returning id`))[0].id
  await db.asUser(owner, `insert into public.project_members(project_id,profile_id,role)
    values ($1,$2,'maintainer'),($1,$3,'member')`, [project, maintainer, member])
})

afterEach(async () => {
  // Only reservations produced by this test; ready images are deliberately
  // preserved by the real retirement RPC. No filesystem/provider/bucket sweep.
  for (const id of reserved) {
    await db.asService('select public.bulla_retire_image($1,false)', [id])
    await db.asService('select public.bulla_forget_image($1)', [id])
  }
})

afterAll(async () => { await db?.close() })

async function reserve(actor = owner, kind = 'avatar', target: string | null = null): Promise<Reservation> {
  const value = (await db.asService<{ value: Reservation }>(
    'select public.bulla_reserve_image($1,$2,$3) as value', [actor, kind, target]))[0].value
  if (value.id) reserved.push(value.id)
  return value
}

async function readyImage(kind = 'avatar', target: string | null = null): Promise<Image> {
  const reservation = await reserve(owner, kind, target)
  expect(reservation.id).toBeDefined()
  const value = (await db.asService<{ value: Image }>(
    'select public.bulla_commit_image($1,$2,$3,900,120,80) as value',
    [reservation.id, owner, 'a'.repeat(64)]))[0].value
  expect(value.error).toBeUndefined()
  // Synthetic Storage METADATA only, never a provider upload or actual bytes.
  await db.asService(`insert into storage.objects(bucket_id,name,metadata)
    values ('bulla-private-images',$1,'{"mimetype":"image/webp","size":900}')`, [`${value.id}.webp`])
  return value
}

async function suspended(profileId: string, expired: boolean) {
  await db.asService(`update public.profiles set status='suspended',
    suspended_until=now() + $2::interval where id=$1`, [profileId, expired ? '-1 hour' : '1 hour'])
}

async function visible(image: Image, actor: string | null = null) {
  const sql = 'select id from public.private_images where id=$1'
  const objectSql = 'select name from storage.objects where bucket_id=$1 and name=$2'
  const images = actor ? await db.asUser(actor, sql, [image.id]) : await db.asAnon(sql, [image.id])
  const objects = actor
    ? await db.asUser(actor, objectSql, ['bulla-private-images', `${image.id}.webp`])
    : await db.asAnon(objectSql, ['bulla-private-images', `${image.id}.webp`])
  return { images: images.length, objects: objects.length }
}

describe('0032 image account-state correction (isolated SQL, not hosted proof)', () => {
  it('permits an expired temporary owner suspension without clearing account state', async () => {
    const image = await readyImage()
    await suspended(owner, true)
    await db.asService(`update auth.users set banned_until=now()-interval '1 hour' where id=$1`, [owner])
    const before = await db.asService(`select p.status,p.suspended_until,u.banned_until,u.disabled_at
      from public.profiles p join auth.users u on u.id=p.id where p.id=$1`, [owner])
    expect(await visible(image)).toEqual({ images: 1, objects: 1 })
    expect(await visible(image, viewer)).toEqual({ images: 1, objects: 1 })
    expect(await reserve()).toMatchObject({ ownerId: owner, actorId: owner })
    expect(await db.asService(`select p.status,p.suspended_until,u.banned_until,u.disabled_at
      from public.profiles p join auth.users u on u.id=p.id where p.id=$1`, [owner])).toEqual(before)
  })

  it('permits an expired temporary viewer suspension without granting a private profile', async () => {
    const image = await readyImage()
    await suspended(viewer, true)
    expect(await visible(image, viewer)).toEqual({ images: 1, objects: 1 })
    await db.asService(`update public.profiles set visibility='private' where id=$1`, [owner])
    expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
    expect(await visible(image, owner)).toEqual({ images: 1, objects: 1 })
  })

  it('permits expired owner/maintainer suspensions but never promotes a member or outsider', async () => {
    const image = await readyImage('project-cover', project)
    await suspended(owner, true)
    await suspended(maintainer, true)
    await suspended(member, true)
    expect(await reserve(maintainer, 'project-cover', project)).toMatchObject({ ownerId: owner, actorId: maintainer })
    expect(await reserve(member, 'project-cover', project)).toMatchObject({ error: 'upload_denied' })
    expect(await reserve(viewer, 'project-cover', project)).toMatchObject({ error: 'upload_denied' })
    expect(await visible(image, maintainer)).toEqual({ images: 1, objects: 1 })
    expect(await visible(image, member)).toEqual({ images: 1, objects: 1 })
    expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
    expect(await visible(image)).toEqual({ images: 0, objects: 0 })
  })

  it.each(['owner', 'viewer'] as const)('refuses a still-current temporary %s suspension', async subject => {
    const image = await readyImage()
    await suspended(subject === 'owner' ? owner : viewer, false)
    expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
    if (subject === 'owner') {
      expect(await visible(image)).toEqual({ images: 0, objects: 0 })
      expect(await reserve()).toMatchObject({ error: 'upload_denied' })
    } else {
      expect(await reserve(viewer)).toMatchObject({ error: 'upload_denied' })
      expect(await visible(image)).toEqual({ images: 1, objects: 1 })
    }
  })

  it.each(['banned', 'deactivated'] as const)('never treats permanent %s state as an expired temporary suspension', async status => {
    const image = await readyImage()
    await db.asService(`update public.profiles set status=$2,suspended_until=now()-interval '1 hour' where id=$1`,
      [owner, status])
    expect(await visible(image)).toEqual({ images: 0, objects: 0 })
    expect(await visible(image, owner)).toEqual({ images: 0, objects: 0 })
    expect(await reserve()).toMatchObject({ error: 'upload_denied' })
  })

  it.each(['profile deletion', 'Auth deletion', 'provider disable', 'provider ban'] as const)(
    'preserves %s even with an expired temporary profile suspension', async state => {
      const image = await readyImage()
      await suspended(owner, true)
      if (state === 'profile deletion') {
        await db.asService('update public.profiles set deleted_at=now() where id=$1', [owner])
      } else if (state === 'Auth deletion') {
        await db.asService('update auth.users set deleted_at=now() where id=$1', [owner])
      } else if (state === 'provider disable') {
        await db.asService('update auth.users set disabled_at=now() where id=$1', [owner])
      } else {
        await db.asService(`update auth.users set banned_until='9999-12-31T23:59:59Z' where id=$1`, [owner])
      }
      expect(await visible(image)).toEqual({ images: 0, objects: 0 })
      expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
      expect(await reserve()).toMatchObject({ error: 'upload_denied' })
    },
  )

  it('refuses a permanently disabled viewer and queued deletion without deleting ready images', async () => {
    const image = await readyImage()
    await suspended(viewer, true)
    await db.asService('update auth.users set disabled_at=now() where id=$1', [viewer])
    expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
    await db.asService('insert into public.account_deletion_jobs(subject_id,request_key) values ($1,$2)',
      [owner, randomUUID()])
    expect(await visible(image)).toEqual({ images: 0, objects: 0 })
    expect(await reserve()).toMatchObject({ error: 'upload_denied' })
    expect(await db.asService('select state from public.private_images where id=$1', [image.id])).toEqual([{ state: 'ready' }])
    expect(await db.asService('select id from storage.objects where bucket_id=$1 and name=$2',
      ['bulla-private-images', `${image.id}.webp`])).toHaveLength(1)
  })

  it('retains block and current immutable-URL checks after suspension expiry', async () => {
    const image = await readyImage()
    await suspended(owner, true)
    await suspended(viewer, true)
    await db.asService('insert into public.blocks(blocker_id,blocked_id) values ($1,$2)', [owner, viewer])
    expect(await visible(image, viewer)).toEqual({ images: 0, objects: 0 })
    const replacement = await readyImage()
    expect(await visible(image)).toEqual({ images: 0, objects: 0 })
    expect(await visible(replacement)).toEqual({ images: 1, objects: 1 })
    await expectRejection(() => db.asUser(member, 'update public.profiles set avatar_url=$1 where id=$2',
      [replacement.url, member]), /different or inactive association/i)
  })

  it('keeps the internal account predicate private and hosted mutation readiness disabled', async () => {
    const capability = await db.asService('select public.bulla_image_upload_readiness() as value')
    expect(capability).toEqual([{ value: { version: 1, enabled: false, code: 'hosted_image_uploads_disabled' } }])
    for (const sql of [
      'select app.bulla_image_account_active($1)',
      'select public.bulla_image_upload_readiness()',
    ]) {
      const params = sql.includes('$1') ? [owner] : undefined
      await expectRejection(() => db.asUser(owner, sql, params), REJECTS.permissionDenied)
      await expectRejection(() => db.asAnon(sql, params), REJECTS.permissionDenied)
    }
    expect(await db.asService(`select app.bulla_image_account_active(null) as nil,
      app.bulla_image_account_active($1) as missing`, [randomUUID()])).toEqual([{ nil: false, missing: false }])
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let owner: string
let outsider: string
let maintainer: string
let member: string
let project: string

beforeAll(async () => {
  db = await createTestDb()
  // Deliberately hostile legacy policies: the new restrictive bucket guards
  // must still deny raw writes and unauthorized reads.
  await db.asService(`create policy fixture_open_storage on storage.objects for all to anon, authenticated using (true) with check (true)`)
  await db.asService(`insert into storage.buckets(id,name) values ('fixture-other', 'fixture-other')`)
}, 120_000)

beforeEach(async () => {
  await db.asService(`update app.private_image_budgets set minute_hits=0 where subject='global'`)
  const abandoned = await db.asService<{ id: string }>(`select id from public.private_images where state='pending'`)
  for (const row of abandoned) {
    await db.asService(`select public.bulla_retire_image($1,false)`, [row.id])
    await db.asService(`select public.bulla_forget_image($1)`, [row.id])
  }
  owner = await db.createUser()
  outsider = await db.createUser()
  maintainer = await db.createUser()
  member = await db.createUser()
  const rows = await db.asUser<{ id: string }>(owner,
    `insert into public.projects(title, description, category, visibility)
     values ('Synthetic image project', 'Synthetic fixture, not owner data.', 'web', 'private') returning id`)
  project = rows[0].id
  await db.asUser(owner, `insert into public.project_members(project_id,profile_id,role) values ($1,$2,'maintainer'),($1,$3,'member')`, [project, maintainer, member])
})

afterAll(async () => { await db?.close() })

async function reserve(actor = owner, kind = 'avatar', target: string | null = null) {
  const rows = await db.asService<{ value: Record<string, unknown> }>(
    'select public.bulla_reserve_image($1,$2,$3) as value', [actor, kind, target])
  return rows[0].value
}

async function commit(id: unknown, actor = owner) {
  const rows = await db.asService<{ value: Record<string, unknown> }>(
    'select public.bulla_commit_image($1,$2,$3,900,120,80) as value', [id, actor, 'a'.repeat(64)])
  return rows[0].value
}

async function readyAvatar() {
  const reservation = await reserve()
  const image = await commit(reservation.id)
  // Platform shim only: synthetic object METADATA for SQL/RLS assertions. No
  // actual Storage API, cloud, filesystem user content or auth traffic.
  await db.asService(`insert into storage.objects(bucket_id,name,metadata) values ('bulla-private-images',$1,'{"mimetype":"image/webp","size":900}')`, [`${image.id}.webp`])
  return image
}

describe('0027 immutable private image metadata and storage policies', () => {
  it('configures only a private WebP bucket with a fixed normalized-byte ceiling', async () => {
    const rows = await db.asService(`select public,file_size_limit,allowed_mime_types from storage.buckets where id='bulla-private-images'`)
    expect(rows).toEqual([{ public: false, file_size_limit: 2097152, allowed_mime_types: ['image/webp'] }])
  })

  it('denies all browser metadata writes and service-only RPCs', async () => {
    await expectRejection(() => db.asUser(owner,
      `insert into public.private_images(kind,owner_id,actor_id,profile_id,byte_count) values ('avatar',$1,$1,$1,900)`, [owner]), REJECTS.permissionDenied)
    await expectRejection(() => db.asAnon(`select public.bulla_reserve_image($1,'avatar',null)`, [owner]), REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(owner, `select public.bulla_reserve_image($1,'avatar',null)`, [outsider]), REJECTS.permissionDenied)
    for (const sql of [
      `select public.bulla_commit_image($1,$2,$3,900,120,80)`,
      `select public.bulla_retire_image($1,false)`,
      `select public.bulla_forget_image($1)`,
    ]) {
      const params = sql.includes('commit') ? [randomUUID(), owner, 'a'.repeat(64)] : [randomUUID()]
      await expectRejection(() => db.asUser(owner, sql, params), REJECTS.permissionDenied)
    }
  })

  it('has no service-role raw metadata DML grant (trusted RPCs own mutations)', async () => {
    const rows = await db.asService(`
      select has_table_privilege('service_role','public.private_images','INSERT') as ins,
             has_table_privilege('service_role','public.private_images','UPDATE') as upd,
             has_table_privilege('service_role','public.private_images','DELETE') as del,
             has_table_privilege('service_role','public.private_images','SELECT') as sel`)
    expect(rows).toEqual([{ ins: false, upd: false, del: false, sel: true }])
  })

  it('defeats permissive legacy Storage policies for insert/update/delete and moved-in raw objects', async () => {
    await expectRejection(() => db.asUser(owner, `insert into storage.objects(bucket_id,name) values ('bulla-private-images','raw.svg')`), REJECTS.rlsViolation)
    await expectRejection(() => db.asAnon(`insert into storage.objects(bucket_id,name) values ('bulla-private-images','raw.html')`), REJECTS.rlsViolation)
    const other = await db.asUser<{ id: string }>(owner,
      `insert into storage.objects(bucket_id,name) values ('fixture-other',$1) returning id`, [`${randomUUID()}.png`])
    await expectRejection(() => db.asUser(owner, `update storage.objects set bucket_id='bulla-private-images' where id=$1`, [other[0].id]), REJECTS.rlsViolation)
    const image = await readyAvatar()
    expect(await db.asUser(owner, `update storage.objects set name='forged.webp' where name=$1 returning id`, [`${image.id}.webp`])).toHaveLength(0)
    expect(await db.asUser(owner, `delete from storage.objects where name=$1 returning id`, [`${image.id}.webp`])).toHaveLength(0)
    expect(await db.asUser(owner, `select name from storage.objects where name=$1`, [`${image.id}.webp`])).toHaveLength(1)
  })

  it('never exposes pending, retired or unassociated raw objects', async () => {
    const pending = await reserve()
    await db.asService(`insert into storage.objects(bucket_id,name) values ('bulla-private-images',$1)`, [`${pending.id}.webp`])
    expect(await db.asAnon(`select id from public.private_images where id=$1`, [pending.id])).toHaveLength(0)
    expect(await db.asUser(owner, `select id from storage.objects where name=$1`, [`${pending.id}.webp`])).toHaveLength(0)
    await db.asService(`select public.bulla_retire_image($1,false)`, [pending.id])
    expect(await db.asUser(owner, `select id from public.private_images where id=$1`, [pending.id])).toHaveLength(0)
    await db.asService(`insert into storage.objects(bucket_id,name) values ('bulla-private-images','unassociated.webp')`)
    expect(await db.asAnon(`select id from storage.objects where name='unassociated.webp'`)).toHaveLength(0)
  })

  it('uses the current original profile visibility, not uploader access or a forged public URL', async () => {
    const image = await readyAvatar()
    expect(await db.asAnon(`select id from public.private_images where id=$1`, [image.id])).toHaveLength(1)
    await db.asUser(owner, `update public.profiles set visibility='private' where id=$1`, [owner])
    expect(await db.asAnon(`select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
    expect(await db.asUser(outsider, `select id from storage.objects where name=$1`, [`${image.id}.webp`])).toHaveLength(0)
    expect(await db.asUser(owner, `select id from storage.objects where name=$1`, [`${image.id}.webp`])).toHaveLength(1)
    await expectRejection(() => db.asUser(outsider, `update public.profiles set avatar_url=$1 where id=$2`, [image.url, outsider]), /different or inactive association/i)
  })

  it('allows owner/maintainer cover writes, never members/outsiders, and inherits private-project reads', async () => {
    expect(await reserve(member, 'project-cover', project)).toHaveProperty('error', 'upload_denied')
    expect(await reserve(outsider, 'project-cover', project)).toHaveProperty('error', 'upload_denied')
    const pending = await reserve(maintainer, 'project-cover', project)
    expect(pending.ownerId).toBe(owner)
    expect(pending.actorId).toBe(maintainer)
    const image = await commit(pending.id, maintainer)
    expect(image).toHaveProperty('kind', 'project-cover')
    const row = await db.asService(`select cover_url from public.projects where id=$1`, [project])
    expect(row[0].cover_url).toBe(image.url)
    for (const actor of [owner, maintainer, member]) {
      expect(await db.asUser(actor, `select id from public.private_images where id=$1`, [image.id])).toHaveLength(1)
    }
    expect(await db.asUser(outsider, `select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
    expect(await db.asAnon(`select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
  })

  it('refuses commit after manager demotion and prevents cross-project association forgery', async () => {
    const pending = await reserve(maintainer, 'project-cover', project)
    await db.asUser(owner, `update public.project_members set role='member' where project_id=$1 and profile_id=$2`, [project, maintainer])
    expect(await commit(pending.id, maintainer)).toHaveProperty('error', 'upload_denied')
    const legitimate = await reserve(owner, 'project-cover', project)
    const image = await commit(legitimate.id)
    const second = await db.asUser<{ id: string }>(owner,
      `insert into public.projects(title,description,category) values ('Other synthetic','No real data here.','web') returning id`)
    await expectRejection(() => db.asUser(owner, `update public.projects set cover_url=$1 where id=$2`, [image.url, second[0].id]), /different or inactive association/i)
  })

  it('makes immutable IDs, ownership, target and normalized metadata non-reassignable even to trusted code', async () => {
    const image = await readyAvatar()
    for (const [column, value] of [
      ['id', randomUUID()], ['owner_id', outsider], ['actor_id', outsider], ['profile_id', outsider],
    ]) {
      await expectRejection(() => db.asService(`update public.private_images set ${column}=$1 where id=$2`, [value, image.id]), /association is immutable/i)
    }
    await expectRejection(() => db.asService(`update public.private_images set state='retired',sha256=$1 where id=$2`, ['b'.repeat(64), image.id]), /metadata is immutable/i)
  })

  it('rejects null-association and missing-hash CHECK bypasses', async () => {
    await expectRejection(() => db.asService(`
      insert into public.private_images(kind,owner_id,actor_id,profile_id,byte_count) values ('avatar',$1,$1,null,900)`, [owner]), /private_images_target/i)
    await expectRejection(() => db.asService(`
      insert into public.private_images(kind,owner_id,actor_id,profile_id,state,byte_count,width,height,sha256)
      values ('avatar',$1,$1,$1,'ready',900,120,80,null)`, [owner]), /private_images_metadata/i)
  })

  it('invalidates replaced IDs, cannot retire ready images on an uncertain commit, and retains cleanup metadata', async () => {
    const first = await readyAvatar()
    expect((await db.asService<{ value: boolean }>(`select public.bulla_retire_image($1,false) as value`, [first.id]))[0].value).toBe(false)
    expect((await db.asService<{ value: boolean }>(`select public.bulla_forget_image($1) as value`, [first.id]))[0].value).toBe(false)
    const second = await reserve()
    await commit(second.id)
    expect(await db.asUser(owner, `select id from public.private_images where id=$1`, [first.id])).toHaveLength(0)
    expect(await db.asUser(owner, `select id from storage.objects where name=$1`, [`${first.id}.webp`])).toHaveLength(0)
    expect((await db.asService(`select state from public.private_images where id=$1`, [first.id]))[0].state).toBe('retired')
  })

  it('rechecks blocks and active/deleted target state instead of serving a stale grant', async () => {
    const image = await readyAvatar()
    await db.asUser(owner, `insert into public.blocks(blocker_id,blocked_id) values ($1,$2)`, [owner, outsider])
    expect(await db.asUser(outsider, `select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
    await db.asService(`update public.profiles set deleted_at=now() where id=$1`, [owner])
    expect(await db.asAnon(`select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
    expect(await db.asUser(owner, `select id from public.private_images where id=$1`, [image.id])).toHaveLength(0)
  })

  it('bounds pending reservations and cannot let a browser choose budgets or reset them', async () => {
    expect(await reserve()).toHaveProperty('id')
    expect(await reserve()).toHaveProperty('id')
    expect(await reserve()).toHaveProperty('error', 'upload_rate_limited')
    await expectRejection(() => db.asUser(owner, `select * from app.private_image_budgets`), REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(owner, `update app.private_image_budgets set day_hits=0`), REJECTS.permissionDenied)
  })

  it('persists failed-attempt spending and rejects the fixed ten-minute/day N+1 budgets', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pending = await reserve()
      expect(pending).toHaveProperty('id')
      await db.asService(`select public.bulla_retire_image($1,false)`, [pending.id])
      await db.asService(`select public.bulla_forget_image($1)`, [pending.id])
    }
    expect(await reserve()).toHaveProperty('error', 'upload_rate_limited')
    await db.asService(`update app.private_image_budgets set ten_minute_hits=0, day_hits=20 where subject=$1`, [owner])
    expect(await reserve()).toHaveProperty('error', 'upload_rate_limited')
  })

  it('charges fixed pending allocation and retained bytes to the actual project owner', async () => {
    // Synthetic metadata fixtures represent an already-full retained owner quota.
    for (let position = 0; position < 8; position += 1) {
      const rows = await db.asUser<{ id: string }>(owner,
        `insert into public.projects(title,description,category) values ($1,'Synthetic quota only','web') returning id`, [`Quota fixture ${position}`])
      await db.asService(`
        insert into public.private_images(kind,owner_id,actor_id,project_id,state,byte_count,width,height,sha256)
        values ('project-cover',$1,$1,$2,'ready',2097152,1600,900,$3)`, [owner, rows[0].id, 'a'.repeat(64)])
    }
    expect(await reserve(maintainer, 'project-cover', project)).toHaveProperty('error', 'image_quota_exceeded')
  })

  it('leaves unrelated Storage buckets alone and refuses unsafe object names', async () => {
    for (const name of ['../private.webp', 'avatar.svg', `${randomUUID()}.webp?raw=1`, `folder/${randomUUID()}.webp`]) {
      expect((await db.asAnon<{ value: boolean }>(`select app.bulla_can_read_image_path($1) as value`, [name]))[0].value).toBe(false)
    }
    const rows = await db.asUser(owner, `insert into storage.objects(bucket_id,name) values ('fixture-other',$1) returning id`, [`${randomUUID()}.png`])
    expect(rows).toHaveLength(1)
  })
})

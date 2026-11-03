import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createTestDb, type TestDb } from './harness'

let db: TestDb
let sequence = 0

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db?.close() })

async function rawSignup(metadata: Record<string, unknown> = {}) {
  sequence += 1
  const rows = await db.asService<{ id: string }>(
    `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
     values ($1, now(), $2::jsonb) returning id`,
    [`private-signup-${sequence}@example.test`, JSON.stringify(metadata)],
  )
  return rows[0]!.id
}

describe('0030 genuine signup publication consent', () => {
  it('makes email-style signup private and unfinished before onboarding', async () => {
    const id = await rawSignup({ full_name: 'Private Signup Fixture' })
    const rows = await db.asUser<{ visibility: string; onboarding_completed: boolean }>(
      id, 'select visibility, onboarding_completed from public.profiles where id = $1', [id],
    )
    expect(rows).toEqual([{ visibility: 'private', onboarding_completed: false }])
    expect(await db.asAnon('select id from public.profiles where id = $1', [id])).toEqual([])
    const other = await db.createUser({ username: 'signup_observer' })
    expect(await db.asUser(other, 'select id from public.profiles where id = $1', [id])).toEqual([])
  })

  it('does not treat OAuth or client metadata as permission to publish', async () => {
    const id = await rawSignup({
      name: 'Provider Signup Fixture', picture: null,
      visibility: 'public', onboarding_completed: true, role: 'admin',
    })
    const rows = await db.asUser<{ visibility: string; onboarding_completed: boolean }>(
      id, 'select visibility, onboarding_completed from public.profiles where id = $1', [id],
    )
    expect(rows).toEqual([{ visibility: 'private', onboarding_completed: false }])
    expect(await db.asService('select role from public.user_roles where user_id = $1', [id])).toEqual([])
    expect(await db.asAnon('select id from public.profiles where id = $1', [id])).toEqual([])
  })

  it('publishes only after an actual owner-scoped choice, not an ID-substituted update', async () => {
    const id = await rawSignup()
    const other = await db.createUser({ username: 'consent_observer' })
    expect(await db.asUser(other,
      `update public.profiles set visibility = 'public' where id = $1 returning id`, [id],
    )).toEqual([])
    await db.asUser(id,
      `update public.profiles set visibility = 'public', onboarding_completed = true
       where id = $1`, [id],
    )
    expect(await db.asAnon<{ id: string }>('select id from public.profiles where id = $1', [id])).toEqual([{ id }])
  })

  it('also defaults a legitimately repaired profile to private when visibility is omitted', async () => {
    const id = await rawSignup()
    await db.asService('delete from public.profiles where id = $1', [id])
    await db.asUser(id,
      `insert into public.profiles (id, username, display_name)
       values ($1, 'repaired_private', 'Repaired Fixture')`, [id],
    )
    const rows = await db.asUser<{ visibility: string }>(
      id, 'select visibility from public.profiles where id = $1', [id],
    )
    expect(rows).toEqual([{ visibility: 'private' }])
    expect(await db.asAnon('select id from public.profiles where id = $1', [id])).toEqual([])
  })

  it('preserves every existing audience and profile value when the forward change is applied again', async () => {
    const ids: string[] = []
    for (const visibility of ['public', 'university', 'connections', 'private'] as const) {
      ids.push(await db.createUser({ username: `existing_${visibility}`, visibility }))
    }
    const before = await db.asService(
      'select id, visibility, display_name, onboarding_completed, created_at from public.profiles where id = any($1::uuid[]) order by id',
      [ids],
    )
    const sql = await readFile(path.join(import.meta.dirname, '../../supabase/migrations/0030_private_profile_defaults.sql'), 'utf8')
    await db.raw.exec(sql)
    expect(await db.asService(
      'select id, visibility, display_name, onboarding_completed, created_at from public.profiles where id = any($1::uuid[]) order by id',
      [ids],
    )).toEqual(before)
  })
})

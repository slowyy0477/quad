import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'quad_local_session' && auth.token
      ? { value: auth.token } : undefined,
  }),
}))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => false }))
vi.mock('@/lib/supabase/server', async () => {
  const { getLocalUser } = await import('@/lib/local/session')
  return {
    getUser: getLocalUser,
    createClient: () => { throw new Error('An unconfigured feed action reached Supabase.') },
  }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { readStore, resetLocalCache, type LocalPost } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { setPostLikeAction, setPostSaveAction } from '@/features/feed/actions'
import { getSavedPosts } from '@/features/feed/queries'

let fixture: TempWorkspace | undefined
let fixtureFile: string
let aliceToken: string
let bobToken: string
const timestamp = '2026-10-20T00:00:00.000Z'

function post(id: string, visibility: 'public' | 'private'): LocalPost {
  return {
    id, author_id: 'prf_bob', body: 'Isolated feed action fixture',
    visibility, project_id: null, goal_id: null, moderation_status: 'active',
    like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null,
  }
}

beforeEach(async () => {
  fixture = await createTempWorkspace('feed-actions')
  fixtureFile = path.join(fixture.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', fixtureFile)
  vi.stubEnv('LOCAL_DATA_FILE', fixtureFile)
  vi.stubEnv('LOCAL_DATA_DIR', fixture.directory)
  aliceToken = randomBytes(32).toString('base64url')
  bobToken = randomBytes(32).toString('base64url')
  const people = ['alice', 'bob']
  await fs.writeFile(fixtureFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: people.map(name => ({
      id: `usr_${name}`, email: `${name}@synthetic.example.test`,
      password_hash: '', created_at: timestamp,
    })),
    profiles: people.map(name => ({
      id: `prf_${name}`, user_id: `usr_${name}`, username: name,
      display_name: name, bio: null, avatar_url: null, university_id: null,
      department: null, programme: null, semester: null, website: null,
      github: null, visibility: 'public', searchable: true,
      onboarding_completed: true, created_at: timestamp,
    })),
    sessions: people.map((name, index) => ({
      id: `ses_${name}`, user_id: `usr_${name}`,
      token_hash: createHash('sha256').update(index ? bobToken : aliceToken).digest('hex'),
      created_at: timestamp, expires_at: '2099-01-01T00:00:00.000Z',
    })),
    posts: [post('pst_public', 'public'), post('pst_private', 'private')],
  }), { mode: 0o600 })
  resetLocalCache()
  auth.token = aliceToken
})

afterEach(async () => {
  auth.token = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('feed actions without cloud credentials', () => {
  it('persists idempotent likes and private saves for the verified session profile', async () => {
    for (let index = 0; index < 2; index++) {
      expect(await setPostLikeAction({ postId: 'pst_public', active: true })).toEqual({ ok: true, active: true })
      expect(await setPostSaveAction({ postId: 'pst_public', active: true })).toEqual({ ok: true, active: true })
    }
    const persisted = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
    expect(persisted.post_likes).toHaveLength(1)
    expect(persisted.post_likes[0]).toMatchObject({ post_id: 'pst_public', profile_id: 'prf_alice' })
    expect(persisted.post_saves).toHaveLength(1)
    expect(persisted.post_saves[0]).toMatchObject({ post_id: 'pst_public', profile_id: 'prf_alice' })
    expect((await getSavedPosts()).posts?.map(row => row.id)).toEqual(['pst_public'])
    auth.token = bobToken
    expect((await getSavedPosts()).posts).toEqual([])
    auth.token = aliceToken
    for (let index = 0; index < 2; index++) {
      expect(await setPostLikeAction({ postId: 'pst_public', active: false })).toEqual({ ok: true, active: false })
      expect(await setPostSaveAction({ postId: 'pst_public', active: false })).toEqual({ ok: true, active: false })
    }
    expect((await readStore()).post_likes).toEqual([])
    expect((await readStore()).post_saves).toEqual([])
  })

  it('refuses signed-out and unrecognized cookies without writing an interaction', async () => {
    for (const token of [undefined, randomBytes(32).toString('base64url')]) {
      auth.token = token
      expect(await setPostLikeAction({ postId: 'pst_public', active: true })).toEqual({
        ok: false, message: 'Sign in to like posts.',
      })
      expect(await setPostSaveAction({ postId: 'pst_public', active: true })).toEqual({
        ok: false, message: 'Sign in to save posts.',
      })
    }
    expect((await readStore()).post_likes).toEqual([])
    expect((await readStore()).post_saves).toEqual([])
  })

  it('refuses inaccessible posts, including removal requests, without altering either owner', async () => {
    const before = await fs.readFile(fixtureFile, 'utf8')
    for (const active of [true, false]) {
      expect(await setPostLikeAction({ postId: 'pst_private', active })).toEqual({
        ok: false, message: 'You are not allowed to like that post.',
      })
      expect(await setPostSaveAction({ postId: 'pst_private', active })).toEqual({
        ok: false, message: 'You are not allowed to save that post.',
      })
    }
    expect(await fs.readFile(fixtureFile, 'utf8')).toBe(before)
  })

  it('refuses malformed IDs before any interaction write', async () => {
    for (const postId of ['not an id', '../pst_public', '']) {
      expect(await setPostLikeAction({ postId, active: true })).toEqual({
        ok: false, message: 'That post could not be identified.',
      })
      expect(await setPostSaveAction({ postId, active: true })).toEqual({
        ok: false, message: 'That post could not be identified.',
      })
    }
    expect((await readStore()).post_likes).toEqual([])
    expect((await readStore()).post_saves).toEqual([])
  })

  it('preserves the missing-database refusal outside local mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    expect(await setPostLikeAction({ postId: 'pst_public', active: true })).toEqual({
      ok: false, message: 'Liking is unavailable: this deployment has no database.',
    })
    expect(await setPostSaveAction({ postId: 'pst_public', active: true })).toEqual({
      ok: false, message: 'Saving is unavailable: this deployment has no database.',
    })
    expect((await readStore()).post_likes).toEqual([])
    expect((await readStore()).post_saves).toEqual([])
  })
})

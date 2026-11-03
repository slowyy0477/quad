import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'
import type { LocalComment, LocalMessage, LocalPost, LocalProject, Tables } from '@/lib/local/db'
import type { DeletionReceipt, LifecycleResult } from '@/features/account/types'
import type { PrivateImageRecord } from '@/features/uploads/types'

vi.mock('server-only', () => ({}))
const request = vi.hoisted(() => ({
  context: undefined as AsyncLocalStorage<Map<string, string>> | undefined,
  jar: new Map<string, string>(),
  failCookieDelete: false,
}))
vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar = request.context?.getStore() ?? request.jar
    return {
      get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
      set: (name: string, value: string) => { jar.set(name, value) },
      delete: (name: string) => {
        if (request.failCookieDelete) throw new Error('Synthetic response-cookie failure')
        jar.delete(name)
      },
    }
  },
  headers: async () => new Headers(),
}))
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: async () => {} }))
vi.mock('@/features/account/hosted', () => ({
  exportHostedAccount: () => { throw new Error('Local fixtures must never contact hosted Auth') },
  getHostedAccountBlockers: () => { throw new Error('Local fixtures must never contact hosted data') },
  getHostedDeletionReceipt: () => { throw new Error('Local fixtures must never contact hosted data') },
  requestHostedAccountDeletion: () => { throw new Error('Local fixtures must never delete a hosted user') },
}))

const contexts = new AsyncLocalStorage<Map<string, string>>()
request.context = contexts
const COOKIE = 'quad_local_session'
let fixture: TempWorkspace
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let lifecycle: typeof import('@/lib/local/account-lifecycle')
let provider: typeof import('@/features/account/provider')
let media: typeof import('@/features/account/local-media')
let owner: { userId: string; profileId: string; password: string }
let other: typeof owner
let otherJar: Map<string, string>

function accepted(result: LifecycleResult<DeletionReceipt>): DeletionReceipt {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Synthetic deletion refused: ${result.code}`)
  return result.value
}

function deletionInput() {
  return { password: owner.password, confirmation: 'DELETE MY ACCOUNT', acknowledge: true, idempotencyKey: randomUUID() }
}

function post(authorId: string, body: string, id: string = randomUUID()): LocalPost {
  return {
    id, author_id: authorId, body, visibility: 'private', project_id: null, goal_id: null,
    moderation_status: 'active', like_count: 0, comment_count: 0,
    created_at: new Date().toISOString(), deleted_at: null,
  }
}

function comment(authorId: string, postId: string, body: string, parentId: string | null = null): LocalComment {
  return {
    id: randomUUID(), author_id: authorId, post_id: postId, body, parent_id: parentId,
    created_at: new Date().toISOString(), deleted_at: null,
  }
}

function message(authorId: string, conversationId: string, body: string): LocalMessage {
  return { id: randomUUID(), author_id: authorId, conversation_id: conversationId, body, created_at: new Date().toISOString() }
}

async function ownProject(shared = false): Promise<LocalProject> {
  const row: LocalProject = {
    id: randomUUID(), owner_id: owner.profileId, slug: 's10-synthetic-project',
    title: 'S10 synthetic project', purpose: 'Synthetic fixture', description: null,
    category: 'web', status: 'active', visibility: 'private', is_seeking_members: true,
    team_size_target: null, member_count: shared ? 2 : 1, created_at: new Date().toISOString(), deleted_at: null,
  }
  // Protected setup writes use a genuine synthetic cookie, already committed
  // by startSession. No NODE_ENV/test bypass or caller-selected actor is used.
  await db.mutate(store => {
    store.projects.push(row)
    store.project_members.push({ id: randomUUID(), project_id: row.id, profile_id: owner.profileId, role: 'owner', created_at: row.created_at })
    if (shared) store.project_members.push({ id: randomUUID(), project_id: row.id, profile_id: other.profileId, role: 'member', created_at: row.created_at })
  })
  return row
}

async function indexedImages(specs: { ownerId: string; actorId?: string; projectId?: string }[]) {
  const root = path.join(fixture.directory, 'private-images')
  const objects = path.join(root, 'objects')
  await fs.mkdir(objects, { recursive: true })
  const records: PrivateImageRecord[] = specs.map(spec => {
    const bytes = Buffer.from('S10 synthetic normalized-image stand-in')
    return {
      id: randomUUID(), ownerId: spec.ownerId, actorId: spec.actorId ?? spec.ownerId,
      kind: spec.projectId ? 'project-cover' : 'avatar', profileId: spec.projectId ? null : spec.ownerId,
      projectId: spec.projectId ?? null, state: 'ready', width: 1, height: 1, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }
  })
  for (const row of records) await fs.writeFile(path.join(objects, `${row.id}.webp`), 'S10 synthetic normalized-image stand-in', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({ version: 1, records, budgets: [] }), { flag: 'wx', mode: 0o600 })
  return { root, objects, records }
}

beforeEach(async () => {
  vi.resetModules()
  request.jar.clear()
  request.failCookieDelete = false
  fixture = await createTempWorkspace('account-lifecycle',
    process.platform === 'win32' ? 'D:\\All tasks + Automations\\Bulla-Recovery\\account-lifecycle-fixtures' : undefined)
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'local.json'))
  vi.stubEnv('BULLA_LOCAL_MEDIA_ROOT', path.join(fixture.directory, 'private-images'))
  vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'false')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
  db = await import('@/lib/local/db')
  session = await import('@/lib/local/session')
  lifecycle = await import('@/lib/local/account-lifecycle')
  provider = await import('@/features/account/provider')
  media = await import('@/features/account/local-media')
  const create = async (name: string) => {
    const password = randomBytes(24).toString('base64url')
    const account = await session.createAccount({ email: `${name}@s10.example.test`, password, displayName: `Synthetic ${name}` })
    return { userId: account!.user.id, profileId: account!.profile.id, password }
  }
  owner = await create('owner')
  other = await create('neighbor')
  otherJar = new Map()
  await contexts.run(otherJar, () => session.startSession(other.userId))
  await session.startSession(owner.userId)
})

afterEach(async () => {
  request.jar.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  db?.resetLocalCache()
  await fixture?.cleanup()
})

describe('S10 local identity-bound bounded export', () => {
  it('exports only own sent messages and explicit fields, even for a moderator', async () => {
    const conversationId = randomUUID()
    await db.mutate(store => {
      store.user_roles.push({ id: randomUUID(), user_id: owner.userId, role: 'moderator', created_at: new Date().toISOString() })
      store.messages.push(message(owner.profileId, conversationId, 'S10-OWN-SENT'))
      store.posts.push(Object.assign(post(owner.profileId, 'S10-OWN-POST'), {
        password_hash: 'S10-UNKNOWN-SECRET-COLUMN', metadata: { body: 'S10-UNKNOWN-METADATA' },
      }))
      store.notifications.push({
        id: randomUUID(), recipient_id: owner.profileId, actor_id: other.profileId, type: 'message',
        body: 'S10-OTHER-PRIVATE-PREVIEW', is_read: false, created_at: new Date().toISOString(),
        post_id: null, comment_id: null, project_id: null, idea_id: null, event_id: null, opportunity_id: null, conversation_id: conversationId,
      })
    })
    await contexts.run(otherJar, () => db.mutate(store => {
      store.messages.push(message(other.profileId, conversationId, 'S10-OTHER-PRIVATE-MESSAGE'))
      store.posts.push(post(other.profileId, 'S10-OTHER-PRIVATE-POST'))
      store.daily_logs.push({
        id: randomUUID(), profile_id: other.profileId, log_date: '2026-10-31', hours_studied: null, mood: null,
        productivity: null, summary: 'S10-OTHER-PRIVATE-LEARNING', wins: null, blockers: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
    }))
    const exported = await lifecycle.exportLocalAccount(owner.userId, owner.password)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const text = JSON.stringify(exported.value)
    expect(text).toContain('S10-OWN-SENT')
    expect(text).toContain('S10-OWN-POST')
    for (const secret of [
      owner.password, other.password, request.jar.get(COOKIE)!, otherJar.get(COOKIE)!,
      'S10-UNKNOWN-SECRET-COLUMN', 'S10-UNKNOWN-METADATA', 'S10-OTHER-PRIVATE-PREVIEW',
      'S10-OTHER-PRIVATE-MESSAGE', 'S10-OTHER-PRIVATE-POST', 'S10-OTHER-PRIVATE-LEARNING',
      (await db.readStore()).users[0].password_hash,
    ]) expect(text).not.toContain(secret)
    expect(exported.value.sections.messages?.records).toHaveLength(1)
    expect(exported.value.sections.notifications?.records[0]).not.toHaveProperty('body')
    expect(exported.value.subject).toEqual({ user_id: owner.userId, profile_id: owner.profileId, email: 'owner@s10.example.test' })
  })

  it('uses stable, bounded own-row pages with no overlap and verification on every page', async () => {
    await db.mutate(store => {
      for (const id of ['s10_post_a', 's10_post_b', 's10_post_c', 's10_post_d']) store.posts.push(post(owner.profileId, 'Synthetic own page', id))
    })
    const first = await lifecycle.exportLocalAccount(owner.userId, owner.password, { section: 'posts', limit: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.complete_for_selected_sections).toBe(false)
    expect(first.value.sections.posts?.records.map(row => row.id)).toEqual(['s10_post_a', 's10_post_b'])
    const cursor = first.value.sections.posts!.next_cursor!
    expect(await lifecycle.exportLocalAccount(owner.userId, 'wrong synthetic password', { section: 'posts', after: cursor, limit: 2 }))
      .toEqual({ ok: false, code: 'invalid_password', retryAfterSeconds: undefined })
    const next = await lifecycle.exportLocalAccount(owner.userId, owner.password, { section: 'posts', after: cursor, limit: 2 })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.sections.posts?.records.map(row => row.id)).toEqual(['s10_post_c', 's10_post_d'])
    expect(next.value.sections.posts?.next_cursor).toBeNull()
    expect(next.value.complete_for_selected_sections).toBe(true)
  })

  it('rejects forged identity, unknown sections, invalid cursors and unbounded limits', async () => {
    expect(await lifecycle.exportLocalAccount(other.userId, other.password)).toMatchObject({ ok: false, code: 'identity_mismatch' })
    for (const options of [
      { limit: 101 }, { limit: 0 }, { after: 's10_cursor' }, { section: 'posts', after: "' OR true --" }, { section: 'users' },
    ]) {
      expect(await lifecycle.exportLocalAccount(owner.userId, owner.password, options as Parameters<typeof lifecycle.exportLocalAccount>[2]))
        .toEqual({ ok: false, code: 'invalid_request' })
    }
  })

  it('refuses oversized content without exposing the field or changing stored data', async () => {
    await db.mutate(store => { store.posts.push(post(owner.profileId, 'S10-private-marker'.repeat(1500))) })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await lifecycle.exportLocalAccount(owner.userId, owner.password, { section: 'posts', limit: 1 }))
      .toEqual({ ok: false, code: 'export_too_large' })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('shares the current-password attempt budget and never returns credentials in errors', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect(await lifecycle.exportLocalAccount(owner.userId, 'wrong synthetic password')).toMatchObject({ ok: false, code: 'invalid_password' })
    }
    const limited = await lifecycle.exportLocalAccount(owner.userId, owner.password)
    expect(limited).toMatchObject({ ok: false, code: 'throttled', retryAfterSeconds: expect.any(Number) })
    expect(JSON.stringify(limited)).not.toContain(owner.password)
  })
})

describe('S10 local durable deletion and ownership safeguards', () => {
  it('requires exact confirmation, acknowledgement and current credentials before queuing or revoking', async () => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    for (const input of [
      { ...deletionInput(), confirmation: 'delete' }, { ...deletionInput(), acknowledge: false },
      { ...deletionInput(), idempotencyKey: 'forged' },
    ]) expect(await lifecycle.requestLocalAccountDeletion(owner.userId, input)).toEqual({ ok: false, code: 'confirmation_required' })
    expect(await lifecycle.requestLocalAccountDeletion(owner.userId, { ...deletionInput(), password: other.password }))
      .toMatchObject({ ok: false, code: 'invalid_password' })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it.each([false, true])('blocks shared projects, including soft-deleted=%s, without mutating the account', async (deleted) => {
    const project = await ownProject(true)
    if (deleted) await db.mutate(store => { store.projects[0].deleted_at = new Date().toISOString() })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const blockers = await lifecycle.getLocalAccountBlockers(owner.userId)
    expect(blockers).toMatchObject({ ok: true, value: { projects: [{ id: project.id, deleted }] } })
    expect(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
      .toEqual({ ok: false, code: 'ownership_transfer_required' })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('blocks inconsistent owner roles and the last active administrator', async () => {
    await ownProject()
    await db.mutate(store => { store.project_members = [] })
    expect(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput())).toEqual({ ok: false, code: 'owner_role_inconsistent' })
    await db.mutate(store => {
      store.projects = []
      store.user_roles.push({ id: randomUUID(), user_id: owner.userId, role: 'admin', created_at: new Date().toISOString() })
    })
    expect(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput())).toEqual({ ok: false, code: 'last_administrator' })
    await db.mutate(store => { store.user_roles.push({ id: randomUUID(), user_id: other.userId, role: 'admin', created_at: new Date().toISOString() }) })
    expect(accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput())).state).toBe('queued')
  })

  it('atomically queues, disables and revokes all devices; cleanup rejects old-token replay after reload', async () => {
    const firstToken = request.jar.get(COOKIE)!
    request.jar.clear()
    await session.startSession(owner.userId)
    const secondToken = request.jar.get(COOKIE)!
    const ownPost = post(owner.profileId, 'S10-remove-own-content')
    await db.mutate(store => { store.posts.push(ownPost) })
    await contexts.run(otherJar, () => db.mutate(store => { store.posts.push(post(other.profileId, 'S10-neighbor-content-remains')) }))
    const neighborBefore = (await db.readStore()).users.find(row => row.id === other.userId)
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    expect(job).toMatchObject({ state: 'queued', phase: 'media' })
    db.resetLocalCache()
    expect(await session.getLocalUserFromToken(firstToken)).toBeNull()
    expect(await session.getLocalUserFromToken(secondToken)).toBeNull()
    expect(await session.checkCredentials('owner@s10.example.test', owner.password)).toBeNull()
    expect((await db.readStore()).posts.some(row => row.id === ownPost.id)).toBe(true)
    request.jar.clear()
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ id: job.id, state: 'completed', phase: 'complete' })
    db.resetLocalCache()
    const after = await db.readStore()
    expect(after.users.find(row => row.id === owner.userId)).toBeUndefined()
    expect(after.profiles.find(row => row.id === owner.profileId)).toBeUndefined()
    expect(after.sessions.some(row => row.user_id === owner.userId)).toBe(false)
    expect(after.posts.map(row => row.body)).toEqual(['S10-neighbor-content-remains'])
    expect(after.users.find(row => row.id === other.userId)).toEqual(neighborBefore)
    expect((await session.getLocalUserFromToken(otherJar.get(COOKIE)))?.id).toBe(other.userId)
    expect(await lifecycle.exportLocalAccount(owner.userId, owner.password)).toMatchObject({ ok: false, code: 'signed_out' })
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    expect(after.account_deletion_jobs[0]).toMatchObject({ user_id: null, profile_id: null, idempotency_key: null, error_code: null })
  })

  it('preserves others’ independent content while nulling only removed references after session revocation', async () => {
    const project = await ownProject()
    const otherPost = post(other.profileId, 'S10-KEEP-POST')
    otherPost.project_id = project.id
    const ownComment = comment(owner.profileId, otherPost.id, 'S10-REMOVE-COMMENT')
    const otherComment = comment(other.profileId, otherPost.id, 'S10-KEEP-COMMENT', ownComment.id)
    const conversationId = randomUUID()
    const ownMessage = message(owner.profileId, conversationId, 'S10-REMOVE-MESSAGE')
    const otherMessage = Object.assign(message(other.profileId, conversationId, 'S10-KEEP-MESSAGE'), { reply_to_id: ownMessage.id })
    await db.mutate(store => {
      store.comments.push(ownComment)
      store.messages.push(ownMessage)
      store.goals.push({
        id: 's10_own_goal', profile_id: owner.profileId, semester_id: null, course_id: null,
        title: 'Synthetic goal', description: null, category: 'study', status: 'active', target_value: 1,
        current_value: 0, unit: null, progress_percent: 0, visibility: 'private', target_date: null,
        completed_at: null, milestone_count: 0, completed_milestone_count: 0, created_at: new Date().toISOString(),
      })
      store.conversations.push({
        id: conversationId, type: 'direct', title: null, last_message_at: ownMessage.created_at,
        last_message_preview: ownMessage.body, created_at: ownMessage.created_at,
      })
    })
    otherPost.goal_id = 's10_own_goal'
    await contexts.run(otherJar, () => db.mutate(store => {
      store.posts.push(otherPost)
      store.comments.push(otherComment)
      store.messages.push(otherMessage)
      store.ideas.push({
        id: 's10_other_idea', author_id: other.profileId, title: 'S10-KEEP-IDEA', description: 'S10-KEEP-DESCRIPTION',
        category: 'web', status: 'converted', visibility: 'private', upvote_count: 0, interest_count: 0,
        converted_project_id: project.id, created_at: new Date().toISOString(), deleted_at: null,
      })
      store.university_requests.push({
        id: 's10_other_request', submitted_by: other.profileId, name: 'S10-KEEP-UNIVERSITY',
        short_name: null, city: null, country: null, website: null, status: 'approved', reason: 'S10-KEEP-REVIEW',
        reviewed_by: owner.profileId, reviewed_at: new Date().toISOString(), created_at: new Date().toISOString(),
      })
    }))
    const before = await db.readStore()
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    request.jar.clear()
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    const after = await db.readStore()
    expect(after.posts[0]).toEqual({ ...before.posts[0], project_id: null, goal_id: null, comment_count: 1 })
    expect(after.comments).toEqual([{ ...otherComment, parent_id: null }])
    expect(after.messages).toEqual([{ ...otherMessage, reply_to_id: null }])
    expect(after.ideas[0]).toEqual({ ...before.ideas[0], converted_project_id: null })
    expect(after.university_requests[0]).toEqual({ ...before.university_requests[0], reviewed_by: null })
    expect(after.conversations[0].last_message_preview).toBeNull()
    expect(after.mutation_limit_windows).toEqual(before.mutation_limit_windows)
  })

  it('leaves the account, all sessions and content intact when the request commit fails', async () => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('S10-synthetic-commit-failure'))
    await expect(lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput())).rejects.toThrow('S10-synthetic-commit-failure')
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect((await session.getLocalUser())?.id).toBe(owner.userId)
  })

  it('accepts at most one simultaneous deletion request without reusing a revoked session', async () => {
    const firstJar = new Map(request.jar)
    request.jar.clear()
    await session.startSession(owner.userId)
    const secondJar = new Map(request.jar)
    const input = deletionInput()
    const results = await Promise.all([
      contexts.run(firstJar, () => lifecycle.requestLocalAccountDeletion(owner.userId, input)),
      contexts.run(secondJar, () => lifecycle.requestLocalAccountDeletion(owner.userId, input)),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ code: 'signed_out' })
    expect((await db.readStore()).account_deletion_jobs).toHaveLength(1)
  })

  it('returns accepted durable cleanup even if clearing the response cookie fails', async () => {
    const token = request.jar.get(COOKIE)!
    request.failCookieDelete = true
    expect(accepted(await provider.deleteOwnAccount(deletionInput())).state).toBe('completed')
    expect(await session.getLocalUserFromToken(token)).toBeNull()
    expect(request.jar.get(COOKIE)).toBe(token)
  })
})

describe('S10 local job retries, privacy-safe evidence and retention', () => {
  it('removes only exact account-owned indexed images, preserving neighbors and unindexed files', async () => {
    const images = await indexedImages([{ ownerId: owner.profileId }, { ownerId: other.profileId }])
    const unindexed = path.join(images.objects, `${randomUUID()}.webp`)
    await fs.writeFile(unindexed, 'S10 unindexed bytes must not be adopted', { flag: 'wx' })
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    await expect(fs.stat(path.join(images.objects, `${images.records[0].id}.webp`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(images.objects, `${images.records[1].id}.webp`), 'utf8')).toContain('S10 synthetic')
    expect(await fs.readFile(unindexed, 'utf8')).toContain('must not be adopted')
    const index = JSON.parse(await fs.readFile(path.join(images.root, 'index.json'), 'utf8'))
    expect(index.records.map((row: PrivateImageRecord) => row.id)).toEqual([images.records[1].id])
    expect((await db.readStore()).account_deletion_media).toEqual([])
  })

  it('blocks images uploaded for another owner before any account restriction or byte removal', async () => {
    const images = await indexedImages([{ ownerId: other.profileId, actorId: owner.profileId }])
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput())).toEqual({ ok: false, code: 'shared_media_ownership' })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(await fs.readFile(path.join(images.objects, `${images.records[0].id}.webp`), 'utf8')).toContain('S10 synthetic')
  })

  it('retries a failed exact-image unlink from the durable manifest without losing the account job', async () => {
    const images = await indexedImages([{ ownerId: owner.profileId }])
    const target = path.join(images.objects, `${images.records[0].id}.webp`)
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    const realUnlink = fs.unlink
    let rejected = false
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === target && !rejected) { rejected = true; throw new Error('S10-private-unlink-failure') }
      return realUnlink(file)
    })
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'retry' })
    const snapshot = await db.readStore()
    expect(snapshot.account_deletion_media).toMatchObject([{ image_id: images.records[0].id, state: 'pending' }])
    expect(snapshot.users.some(row => row.id === owner.userId)).toBe(true)
    expect(JSON.stringify(snapshot.account_deletion_jobs)).not.toContain('S10-private-unlink-failure')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(snapshot.account_deletion_jobs[0].next_attempt_at) + 1)
    db.resetLocalCache()
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists a privacy-safe retry, honors its delay, resumes after restart and does not duplicate cleanup', async () => {
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    vi.spyOn(media, 'cleanupLocalAccountImages').mockRejectedValueOnce(new Error('S10-PRIVATE-EXCEPTION-BODY'))
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'retry' })
    db.resetLocalCache()
    const retried = (await db.readStore()).account_deletion_jobs[0]
    expect(retried).toMatchObject({ attempts: 1, error_code: 'cleanup_failed', lease_token: null })
    expect(JSON.stringify(retried)).not.toContain('S10-PRIVATE-EXCEPTION-BODY')
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'retry' })
    expect((await db.readStore()).account_deletion_jobs[0].attempts).toBe(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(retried.next_attempt_at) + 1)
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    expect((await db.readStore()).account_deletion_jobs).toHaveLength(1)
  })

  it('fences an unexpired claim and recovers a crashed lease without resurrecting sessions', async () => {
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    const deadline = Date.now() + 60_000
    await db.mutate(store => {
      Object.assign(store.account_deletion_jobs[0], {
        state: 'processing', attempts: 1, lease_token: randomUUID(), lease_expires_at: new Date(deadline).toISOString(),
      })
    })
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'processing' })
    expect((await db.readStore()).account_deletion_jobs[0].attempts).toBe(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(deadline + 1)
    db.resetLocalCache()
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    expect((await db.readStore()).sessions.some(row => row.user_id === owner.userId)).toBe(false)
  })

  it('stops after its failure budget and needs an explicit operator retry', async () => {
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    await db.mutate(store => { store.account_deletion_jobs[0].attempts = 4 })
    vi.spyOn(media, 'cleanupLocalAccountImages').mockRejectedValueOnce(new Error('Synthetic fifth failure'))
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'failed' })
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'failed' })
    expect(await lifecycle.retryLocalAccountDeletionJob(job.id)).toBe(true)
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    expect(await lifecycle.retryLocalAccountDeletionJob(job.id)).toBe(false)
  })

  it('rechecks newly shared ownership before cleanup and never overrides it on operator retry', async () => {
    const project = await ownProject()
    const images = await indexedImages([{ ownerId: owner.profileId, projectId: project.id }])
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    await contexts.run(otherJar, () => db.mutate(store => {
      store.project_members.push({ id: randomUUID(), project_id: project.id, profile_id: other.profileId, role: 'member', created_at: new Date().toISOString() })
    }))
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'blocked' })
    expect((await db.readStore()).projects[0]).toEqual(project)
    expect(await fs.readFile(path.join(images.objects, `${images.records[0].id}.webp`), 'utf8')).toContain('S10 synthetic')
    expect(await lifecycle.retryLocalAccountDeletionJob(job.id)).toBe(true)
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'blocked' })
    expect((await db.readStore()).users.find(row => row.id === owner.userId)?.disabled_at).toBeTruthy()
  })

  it('retains only bounded content-free moderation outcomes and expires completed receipts', async () => {
    const timestamp = new Date().toISOString()
    await db.mutate(store => {
      store.reports.push({
        id: 's10_own_report', reporter_id: owner.profileId, reported_profile_id: other.profileId,
        reason: 'S10-PRIVATE-REPORT-REASON', detail: 'S10-PRIVATE-REPORT-BODY', status: 'actioned', created_at: timestamp,
        post_id: null, comment_id: null, project_id: null, idea_id: null, message_id: null,
      })
      store.moderation_actions.push({
        id: 's10_own_action', actor_id: other.profileId, report_id: 's10_own_report', action: 'warn_user',
        reason: 'S10-PRIVATE-STAFF-NOTE', target_profile_id: owner.profileId, target_id: null, created_at: timestamp,
      })
    })
    const job = accepted(await lifecycle.requestLocalAccountDeletion(owner.userId, deletionInput()))
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toMatchObject({ state: 'completed' })
    const snapshot: Tables = await db.readStore()
    expect(snapshot.reports).toEqual([])
    expect(snapshot.moderation_actions).toEqual([])
    expect(snapshot.account_retained_moderation).toHaveLength(2)
    for (const row of snapshot.account_retained_moderation) {
      expect(Object.keys(row).sort()).toEqual(['category', 'deletion_job_id', 'expires_at', 'id', 'occurred_on', 'outcome'])
      expect(row.occurred_on).toBe(timestamp.slice(0, 10))
      expect(Date.parse(row.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 86_400_000)
    }
    const text = JSON.stringify(snapshot.account_retained_moderation)
    for (const secret of [owner.userId, owner.profileId, other.profileId, 'S10-PRIVATE', 's10_own_report', 's10_own_action']) {
      expect(text).not.toContain(secret)
    }
    expect(Object.keys((await lifecycle.getLocalDeletionReceipt(job.id))!).sort()).toEqual(['id', 'phase', 'state'])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    expect(await lifecycle.getLocalDeletionReceipt(job.id)).toBeNull()
    // A worker/operator invocation prunes expired sidecars even for an old job.
    expect(await lifecycle.runLocalAccountDeletionJob(job.id)).toBeNull()
    expect((await db.readStore()).account_retained_moderation).toEqual([])
    expect((await db.readStore()).account_deletion_jobs).toEqual([])
  })
})

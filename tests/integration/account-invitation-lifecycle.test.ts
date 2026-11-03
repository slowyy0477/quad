import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'
import type { LocalProject, Tables } from '@/lib/local/db'
import type { LocalProjectInvite } from '@/lib/local/domain-tables'
import type { DeletionReceipt, LifecycleResult } from '@/features/account/types'

/**
 * Authoring-only handoff: main runs this file later.
 * Every datastore/media path is a new synthetic fixture. Protected arrangement
 * writes use real createAccount/startSession cookies, never a TEST bypass.
 * Persisted invitation history is arranged here; this is not invitation-create
 * UI acceptance, a real owner deletion, or hosted/provider evidence.
 */
vi.mock('server-only', () => ({}))
const request = vi.hoisted(() => ({
  context: undefined as AsyncLocalStorage<Map<string, string>> | undefined,
  jar: new Map<string, string>(),
}))
vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar = request.context?.getStore() ?? request.jar
    return {
      get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
      set: (name: string, value: string) => { jar.set(name, value) },
      delete: (name: string) => { jar.delete(name) },
    }
  },
  headers: async () => new Headers(),
}))
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: async () => {} }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => (await import('@/lib/local/session')).getLocalUser(),
  createClient: () => { throw new Error('Synthetic local lifecycle must not construct a provider client') },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`Unexpected fixture redirect: ${url}`) } }))

const contexts = new AsyncLocalStorage<Map<string, string>>()
request.context = contexts
const COOKIE = 'quad_local_session'
const SECTIONS = ['project_invites_sent', 'project_invites_received'] as const
const STATES = ['pending', 'accepted', 'declined', 'revoked'] as const
type Account = { userId: string; profileId: string; password: string; jar: Map<string, string> }
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let lifecycle: typeof import('@/lib/local/account-lifecycle')
let media: typeof import('@/features/account/local-media')
let projects: typeof import('@/features/projects/actions')
let owner: Account
let neighbor: Account
let third: Account

function as<T>(account: Account, work: () => T): T {
  return contexts.run(account.jar, work)
}

async function createAccount(name: string): Promise<Account> {
  const password = randomBytes(24).toString('base64url')
  const created = await session.createAccount({
    email: `${name}@account-invitation.example.test`, password, displayName: `Synthetic ${name}`,
  })
  if (!created) throw new Error('Synthetic fixture account was not created')
  const account = { userId: created.user.id, profileId: created.profile.id, password, jar: new Map<string, string>() }
  await as(account, () => session.startSession(account.userId))
  return account
}

async function project(
  actor: Account,
  label: string,
  members: { account: Account; role: 'member' | 'maintainer' }[] = [],
): Promise<LocalProject> {
  const row: LocalProject = {
    id: randomUUID(), owner_id: actor.profileId, slug: `invite-fixture-${label}`,
    title: `Synthetic invitation ${label}`, purpose: 'Synthetic fixture only',
    description: `PRIVATE-PROJECT-DESCRIPTION-${label}`, category: 'web', status: 'planning',
    visibility: 'private', is_seeking_members: false, team_size_target: null,
    member_count: 1 + members.length, created_at: new Date().toISOString(), deleted_at: null,
  }
  await as(actor, () => db.mutate(store => {
    store.projects.push(row)
    store.project_members.push({
      id: randomUUID(), project_id: row.id, profile_id: actor.profileId,
      role: 'owner', created_at: row.created_at,
    })
    for (const member of members) store.project_members.push({
      id: randomUUID(), project_id: row.id, profile_id: member.account.profileId,
      role: member.role, created_at: row.created_at,
    })
  }))
  return row
}

async function invitation(
  actor: Account,
  recipient: Account,
  target: LocalProject,
  options: { id?: string; message?: string; proposedRole?: string; status?: LocalProjectInvite['status'] } = {},
): Promise<LocalProjectInvite> {
  const timestamp = new Date().toISOString()
  const status = options.status ?? 'pending'
  const row: LocalProjectInvite = {
    id: options.id ?? randomUUID(), project_id: target.id,
    inviter_id: actor.profileId, invitee_id: recipient.profileId,
    message: options.message ?? 'SYNTHETIC-INVITATION-NOTE',
    proposed_role: options.proposedRole ?? 'Synthetic proposed role',
    status, responded_at: status === 'pending' ? null : timestamp,
    created_at: timestamp, updated_at: timestamp,
  }
  // History may predate current membership/management. No invitation outcome or
  // membership is mocked; these are isolated persisted-row fixtures for export.
  await as(actor, () => db.mutate(store => { store.project_invites.push(row) }))
  return row
}

function accepted(result: LifecycleResult<DeletionReceipt>): DeletionReceipt {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Synthetic request refused: ${result.code}`)
  return result.value
}

function queue() {
  return as(owner, () => lifecycle.requestLocalAccountDeletion(owner.userId, {
    password: owner.password, confirmation: 'DELETE MY ACCOUNT', acknowledge: true, idempotencyKey: randomUUID(),
  }))
}

function independentAccounts(store: Tables) {
  return {
    users: store.users.filter(row => row.id !== owner.userId),
    profiles: store.profiles.filter(row => row.id !== owner.profileId),
    sessions: store.sessions.filter(row => row.user_id !== owner.userId),
  }
}

beforeEach(async () => {
  vi.resetModules()
  request.jar.clear()
  fixture = await createTempWorkspace('account-invitation-lifecycle',
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
  media = await import('@/features/account/local-media')
  projects = await import('@/features/projects/actions')
  owner = await createAccount('owner')
  neighbor = await createAccount('neighbor')
  third = await createAccount('third')
})

afterEach(async () => {
  request.jar.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  db?.resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('own invitation export and department projection', () => {
  it('exports only self-authored notes and a note-free recipient DTO, never another manager’s private rows', async () => {
    const own = await project(owner, 'own')
    const managed = await project(owner, 'managed', [{ account: third, role: 'maintainer' }])
    const privateOther = await project(neighbor, 'other')
    const sent = await invitation(owner, neighbor, own, { message: 'SELF-AUTHORED-NOTE', proposedRole: 'SELF-AUTHORED-ROLE' })
    const received = await invitation(neighbor, owner, privateOther, { message: 'OTHER-AUTHOR-PRIVATE-NOTE', proposedRole: 'OTHER-AUTHOR-PRIVATE-ROLE' })
    await invitation(third, neighbor, managed, { message: 'OTHER-MANAGER-PRIVATE-NOTE' })
    await invitation(neighbor, third, privateOther, { message: 'UNRELATED-PRIVATE-NOTE' })
    await as(owner, () => db.mutate(store => {
      Object.assign(store.project_invites.find(row => row.id === sent.id)!, {
        password_hash: 'UNKNOWN-INVITATION-SECRET', staff_note: 'UNKNOWN-STAFF-NOTE',
        metadata: { private: 'UNKNOWN-INVITATION-METADATA' },
      })
    }))
    const result = await as(owner, () => lifecycle.exportLocalAccount(owner.userId, owner.password))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sections.project_invites_sent?.records).toEqual([{
      id: sent.id, project_id: own.id, message: sent.message, proposed_role: sent.proposed_role,
      status: 'pending', responded_at: null, created_at: sent.created_at, updated_at: sent.updated_at,
    }])
    expect(result.value.sections.project_invites_received?.records).toEqual([{
      id: received.id, project_id: privateOther.id, status: 'pending', responded_at: null,
      created_at: received.created_at, updated_at: received.updated_at,
    }])
    const text = JSON.stringify(result.value)
    for (const marker of [
      'OTHER-AUTHOR-PRIVATE-NOTE', 'OTHER-AUTHOR-PRIVATE-ROLE', 'OTHER-MANAGER-PRIVATE-NOTE',
      'UNRELATED-PRIVATE-NOTE', privateOther.description!, neighbor.profileId, third.profileId,
      'UNKNOWN-INVITATION-SECRET', 'UNKNOWN-STAFF-NOTE', 'UNKNOWN-INVITATION-METADATA',
      owner.password, neighbor.password, owner.jar.get(COOKIE)!, neighbor.jar.get(COOKIE)!,
    ]) expect(text).not.toContain(marker)
    expect(result.value.continuation.reauthenticate_each_page).toBe(true)
  })

  it('keeps a genuine own department_id, an explicit clear, and legacy text without joining directory/private rows', async () => {
    const departmentId = randomUUID()
    const universityId = randomUUID()
    await as(owner, () => db.mutate(store => {
      const profile = store.profiles.find(row => row.id === owner.profileId)!
      profile.university_id = universityId
      profile.department_id = departmentId
      profile.department = 'Own legacy department text'
      store.universities.push({
        id: universityId, name: 'Synthetic export university', short_name: null, city: null, country: null,
        student_count: 1, project_count: 0, created_at: new Date().toISOString(),
      })
      store.departments.push({
        id: departmentId, university_id: universityId, name: 'DO-NOT-EXPORT-DIRECTORY',
        slug: 'synthetic-department', is_verified: false, created_by: neighbor.profileId,
        created_at: new Date().toISOString(),
      })
    }))
    const read = () => as(owner, () => lifecycle.exportLocalAccount(owner.userId, owner.password, { section: 'profile' }))
    const linked = await read()
    expect(linked.ok).toBe(true)
    if (!linked.ok) return
    expect(linked.value.sections.profile?.records[0]).toMatchObject({ department_id: departmentId, department: 'Own legacy department text' })
    expect(JSON.stringify(linked.value)).not.toContain('DO-NOT-EXPORT-DIRECTORY')
    await as(owner, () => db.mutate(store => { store.profiles.find(row => row.id === owner.profileId)!.department_id = null }))
    const cleared = await read()
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.sections.profile?.records[0]).toHaveProperty('department_id', null)
    await as(owner, () => db.mutate(store => { delete store.profiles.find(row => row.id === owner.profileId)!.department_id }))
    const legacy = await read()
    expect(legacy.ok).toBe(true)
    if (legacy.ok) {
      expect(legacy.value.sections.profile?.records[0]).not.toHaveProperty('department_id')
      expect(legacy.value.sections.profile?.records[0]).toHaveProperty('department', 'Own legacy department text')
    }
  })

  it.each(SECTIONS)('bounds stable %s pages and reauthenticates continuation', async section => {
    for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
      const actor = section === 'project_invites_sent' ? owner : neighbor
      const recipient = actor === owner ? neighbor : owner
      const target = await project(actor, `page-${suffix}`)
      await invitation(actor, recipient, target, {
        id: `pin_page_${suffix}`, message: 'PAGED-AUTHOR-NOTE', status: STATES[index],
      })
    }
    const first = await as(owner, () => lifecycle.exportLocalAccount(owner.userId, owner.password, { section, limit: 2 }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.sections[section]?.records.map(row => row.id)).toEqual(['pin_page_a', 'pin_page_b'])
    const cursor = first.value.sections[section]!.next_cursor!
    expect(cursor).toBe('pin_page_b')
    const before = (await db.readStore()).project_invites
    expect(await as(owner, () => lifecycle.exportLocalAccount(owner.userId, 'wrong synthetic password', { section, after: cursor, limit: 2 })))
      .toMatchObject({ ok: false, code: 'invalid_password' })
    expect((await db.readStore()).project_invites).toEqual(before)
    const next = await as(owner, () => lifecycle.exportLocalAccount(owner.userId, owner.password, { section, after: cursor, limit: 2 }))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.sections[section]?.records.map(row => row.id)).toEqual(['pin_page_c', 'pin_page_d'])
    expect(next.value.sections[section]?.next_cursor).toBeNull()
    expect(next.value.complete_for_selected_sections).toBe(true)
    if (section === 'project_invites_received') expect(JSON.stringify([first.value, next.value])).not.toContain('PAGED-AUTHOR-NOTE')
  })

  it('refuses mismatched accounts and missing real session cookies for both invitation sections', async () => {
    for (const section of SECTIONS) {
      expect(await as(neighbor, () => lifecycle.exportLocalAccount(owner.userId, owner.password, { section })))
        .toMatchObject({ ok: false, code: 'identity_mismatch' })
      expect(await as(owner, () => lifecycle.exportLocalAccount(neighbor.userId, neighbor.password, { section })))
        .toMatchObject({ ok: false, code: 'identity_mismatch' })
    }
    owner.jar.clear()
    for (const section of SECTIONS) expect(await as(owner, () => lifecycle.exportLocalAccount(owner.userId, owner.password, { section })))
      .toMatchObject({ ok: false, code: 'signed_out' })
  })
})

describe('invitation deletion parity under the locked mandatory budget', () => {
  it('removes every status by inviter/invitee/deleted project without charging revoked-session cleanup or destroying independent accounts', async () => {
    for (const status of STATES) {
      const surviving = await project(neighbor, `surviving-${status}`, [{ account: owner, role: 'maintainer' }])
      await invitation(owner, third, surviving, { status, message: `REMOVE-SENT-${status}` })
      await invitation(neighbor, owner, surviving, { status, message: `REMOVE-RECEIVED-${status}` })
    }
    const sole = await project(owner, 'sole', [{ account: third, role: 'maintainer' }])
    await invitation(third, neighbor, sole, { message: 'REMOVE-PROJECT-DEPENDENT-NOTE' })
    await as(owner, () => db.mutate(store => {
      // The former manager left before deletion. A pending invitation alone is
      // not membership and must not turn this sole-owned project into a blocker.
      store.project_members = store.project_members.filter(row => row.project_id !== sole.id || row.profile_id === owner.profileId)
      store.projects.find(row => row.id === sole.id)!.member_count = 1
    }))
    const unrelatedProject = await project(neighbor, 'unrelated')
    const unrelated = await invitation(neighbor, third, unrelatedProject, { message: 'KEEP-UNRELATED-INVITATION' })
    const before = await db.readStore()
    const blockers = await as(owner, () => lifecycle.getLocalAccountBlockers(owner.userId))
    expect(blockers).toMatchObject({ ok: true, value: { projects: [], inconsistentOwnerRole: false } })
    const oldToken = owner.jar.get(COOKIE)!
    const receipt = accepted(await queue())
    expect(receipt).toMatchObject({ state: 'queued', phase: 'media' })
    db.resetLocalCache()
    expect(await session.getLocalUserFromToken(oldToken)).toBeNull()
    expect((await db.readStore()).project_invites).toEqual(before.project_invites)
    owner.jar.clear()
    // No caller cookie exists here: deletes and exact existing derived counters
    // must pass without a worker-wide bypass or a new association exemption.
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'completed', phase: 'complete' })
    db.resetLocalCache()
    const after = await db.readStore()
    expect(after.project_invites).toEqual([unrelated])
    expect(after.projects.some(row => row.id === sole.id)).toBe(false)
    expect(after.projects.filter(row => row.id !== unrelatedProject.id).every(row => row.member_count === 1)).toBe(true)
    expect(independentAccounts(after)).toEqual(independentAccounts(before))
    expect(after.mutation_limit_windows).toEqual(before.mutation_limit_windows)
    expect(after.users.some(row => row.id === owner.userId)).toBe(false)
    expect(after.profiles.some(row => row.id === owner.profileId)).toBe(false)
    expect((await session.getLocalUserFromToken(neighbor.jar.get(COOKIE)))?.id).toBe(neighbor.userId)
    expect(JSON.stringify(after.account_retained_moderation)).not.toMatch(/REMOVE-|INVITATION|NOTE/)
    expect(await lifecycle.getLocalDeletionReceipt(receipt.id)).toEqual({ id: receipt.id, state: 'completed', phase: 'complete' })
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'completed' })
    expect(await db.readStore()).toEqual(after)
  })

  it('keeps the shared-project blocker and preserves the transferred project and its unrelated invitations', async () => {
    const bystander = await createAccount('bystander')
    const shared = await project(owner, 'shared', [{ account: neighbor, role: 'member' }])
    await invitation(owner, third, shared, { message: 'REMOVE-OLD-INVITER-NOTE' })
    const before = await db.readStore()
    expect(await queue()).toEqual({ ok: false, code: 'ownership_transfer_required' })
    expect(await db.readStore()).toEqual(before)
    const form = new FormData()
    form.set('projectId', shared.id)
    form.set('slug', shared.slug)
    form.set('profileId', neighbor.profileId)
    // Exercise the real existing local action with its real verified cookie,
    // not an owner-id/role write fixture or a mocked action return value.
    expect(await as(owner, () => projects.transferOwnershipAction({ status: 'idle' }, form))).toMatchObject({ status: 'success' })
    const surviving = await invitation(neighbor, bystander, shared, { message: 'KEEP-NEW-OWNER-INVITATION' })
    const receipt = accepted(await queue())
    owner.jar.clear()
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'completed' })
    const after = await db.readStore()
    expect(after.projects.find(row => row.id === shared.id)).toMatchObject({ owner_id: neighbor.profileId, member_count: 1 })
    expect(after.project_members.filter(row => row.project_id === shared.id)).toMatchObject([{ profile_id: neighbor.profileId, role: 'owner' }])
    expect(after.project_invites).toEqual([surviving])
    expect((await session.getLocalUserFromToken(bystander.jar.get(COOKIE)))?.id).toBe(bystander.userId)
  })

  it('leaves invitation rows on a durable media retry, then removes them exactly once after restart', async () => {
    const target = await project(owner, 'retry')
    const row = await invitation(owner, neighbor, target, { message: 'REMOVE-AFTER-RETRY-NOTE' })
    const receipt = accepted(await queue())
    owner.jar.clear()
    vi.spyOn(media, 'cleanupLocalAccountImages').mockRejectedValueOnce(new Error('PRIVATE-SYNTHETIC-RETRY-ERROR'))
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'retry' })
    db.resetLocalCache()
    const retry = (await db.readStore()).account_deletion_jobs.find(job => job.id === receipt.id)!
    expect(retry).toMatchObject({ attempts: 1, error_code: 'cleanup_failed', lease_token: null })
    expect((await db.readStore()).project_invites).toEqual([row])
    expect(JSON.stringify(retry)).not.toContain('PRIVATE-SYNTHETIC-RETRY-ERROR')
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'retry' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(retry.next_attempt_at) + 1)
    db.resetLocalCache()
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'completed' })
    const completed = await db.readStore()
    expect(completed.project_invites).toEqual([])
    expect(completed.account_deletion_jobs).toHaveLength(1)
    expect(completed.account_deletion_jobs[0]).toMatchObject({ user_id: null, profile_id: null, idempotency_key: null })
    expect(await lifecycle.runLocalAccountDeletionJob(receipt.id)).toMatchObject({ state: 'completed' })
    expect(await db.readStore()).toEqual(completed)
  })
})

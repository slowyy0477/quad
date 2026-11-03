import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

vi.mock('server-only', () => ({}))
const request = vi.hoisted(() => ({ cookies: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => request.cookies.has(name) ? { value: request.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => { request.cookies.set(name, value) },
    delete: (name: string) => { request.cookies.delete(name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (destination: string): never => { throw new Error(`S07_REDIRECT:${destination}`) },
}))
// Keep the real local authentication and moderator checks; never seed live/demo data.
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: async () => {} }))

type Account = NonNullable<Awaited<ReturnType<typeof import('@/lib/local/session').createAccount>>>
const COOKIE = 'quad_local_session'
const START = Date.parse('2026-10-31T00:00:00.000Z')
const DAY = 86_400_000
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let auth: typeof import('@/lib/local/session')
let actions: typeof import('@/features/moderation/actions')
let login: typeof import('@/features/auth/local-actions')
let password: string
let target: Account
let reporter: Account
let moderator: Account

function form(values: Record<string, string>): FormData {
  const result = new FormData()
  for (const [key, value] of Object.entries(values)) result.set(key, value)
  return result
}

async function device(account: Account): Promise<string> {
  request.cookies.clear()
  await auth.startSession(account.user.id)
  return request.cookies.get(COOKIE)!
}

async function fileReport(): Promise<string> {
  await device(reporter)
  const result = await actions.submitReportAction({ status: 'idle' }, form({
    kind: 'profile', targetId: target.profile.id, reason: 'Harassment or bullying',
  }))
  expect(result.status).toBe('success')
  return (await db.readStore()).reports.find(row => row.reported_profile_id === target.profile.id)!.id
}

function decision(reportId: string): FormData {
  return form({ reportId, action: 'suspend_user', reason: 'Reviewed the reported conduct.', days: '1' })
}

async function suspend(reportId: string): Promise<void> {
  await device(moderator)
  expect((await actions.decideReportAction({ status: 'idle' }, decision(reportId))).status).toBe('success')
}

function loginForm(): FormData {
  return form({ email: target.user.email, password, next: '/feed' })
}

async function expectLoginBlocked(): Promise<void> {
  request.cookies.clear()
  expect((await auth.checkCredentials(target.user.email, password))?.id ?? null).toBeNull()
  expect((await login.localSignInAction(loginForm())).message).toBe('That email or password is incorrect.')
  await expect(auth.startSession(target.user.id)).rejects.toThrow('Account is unavailable')
  expect(request.cookies.has(COOKIE)).toBe(false)
  expect((await db.readStore()).sessions.filter(row => row.user_id === target.user.id)).toHaveLength(0)
}

beforeEach(async () => {
  fixture = undefined
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  request.cookies.clear()
  fixture = await createTempWorkspace('s07-suspension')
  const directory = fixture.directory
  const dataFile = path.join(directory, 'data', 'local.json')
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_DIR', directory)
  vi.stubEnv('LOCAL_DATA_FILE', dataFile)
  vi.stubEnv('LOCAL_DATA_PATH', dataFile)
  vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'false')
  db = await import('@/lib/local/db')
  auth = await import('@/lib/local/session')
  actions = await import('@/features/moderation/actions')
  login = await import('@/features/auth/local-actions')
  password = randomBytes(24).toString('base64url')
  target = (await auth.createAccount({ email: 's07-target@example.test', password, displayName: 'Reported Student' }))!
  reporter = (await auth.createAccount({ email: 's07-reporter@example.test', password, displayName: 'Reporting Student' }))!
  moderator = (await auth.createAccount({ email: 's07-moderator@example.test', password, displayName: 'Moderator Student' }))!
  await db.mutate(store => {
    store.user_roles.push({ id: 'rol_s07', user_id: moderator.user.id, role: 'moderator', created_at: db.now() })
    // This scenario reports an intentionally published profile. New accounts
    // correctly remain private until consent; do not change the signup default
    // or report eligibility to accommodate a legacy synthetic fixture.
    store.profiles.find(row => row.id === target.profile.id)!.visibility = 'public'
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  request.cookies.clear()
  db?.resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('S07 local timed moderation suspension', () => {
  it.each([undefined, null])('expires without changing permanent disabled_at (%s), but never revives revoked sessions', async (disabledAt) => {
    if (disabledAt === null) await db.mutate(store => { store.users.find(row => row.id === target.user.id)!.disabled_at = null })
    const oldTokens = [await device(target), await device(target)]
    const reportId = await fileReport()
    const reporterToken = request.cookies.get(COOKIE)!
    await suspend(reportId)
    const moderatorToken = request.cookies.get(COOKIE)!
    const store = await db.readStore()
    expect(store.users.find(row => row.id === target.user.id)?.disabled_at).toBe(disabledAt)
    expect(store.profile_account_states.find(row => row.profile_id === target.profile.id)).toMatchObject({
      status: 'suspended', suspended_until: new Date(START + DAY).toISOString(), warning_count: 0,
    })
    expect(store.sessions.filter(row => row.user_id === target.user.id)).toHaveLength(0)
    expect(store.reports.find(row => row.id === reportId)?.status).toBe('actioned')
    expect(store.moderation_actions).toHaveLength(1)
    expect(store.moderation_actions[0]).toMatchObject({
      actor_id: moderator.profile.id, action: 'suspend_user', target_profile_id: target.profile.id, report_id: reportId,
    })
    expect((await auth.getLocalUserFromToken(reporterToken))?.id).toBe(reporter.user.id)
    expect((await auth.getLocalUserFromToken(moderatorToken))?.id).toBe(moderator.user.id)
    for (const token of oldTokens) expect(await auth.getLocalUserFromToken(token)).toBeNull()
    await expectLoginBlocked()

    vi.setSystemTime(START + DAY - 1)
    await expectLoginBlocked()
    vi.setSystemTime(START + DAY)
    db.resetLocalCache()
    expect((await auth.checkCredentials(target.user.email, password))?.id).toBe(target.user.id)
    await expect(login.localSignInAction(loginForm())).rejects.toThrow('S07_REDIRECT:/feed')
    const freshToken = request.cookies.get(COOKIE)!
    expect(oldTokens.includes(freshToken)).toBe(false)
    expect((await auth.getLocalUser())?.id).toBe(target.user.id)
    expect((await db.readStore()).sessions.filter(row => row.user_id === target.user.id)).toHaveLength(1)
    for (const token of oldTokens) expect(await auth.getLocalUserFromToken(token)).toBeNull()

    vi.setSystemTime(START + DAY + 1)
    db.resetLocalCache()
    expect((await auth.getLocalUserFromToken(freshToken))?.id).toBe(target.user.id)
    for (const token of oldTokens) expect(await auth.getLocalUserFromToken(token)).toBeNull()
    expect((await db.readStore()).users.find(row => row.id === target.user.id)?.disabled_at).toBe(disabledAt)
  })

  it('denies resolution of an outstanding token while its account is temporarily suspended', async () => {
    const token = await device(target)
    await db.mutate(store => {
      store.profile_account_states.push({
        id: 'sta_s07', profile_id: target.profile.id, status: 'suspended',
        suspended_until: new Date(START + DAY).toISOString(), warning_count: 0,
      })
    })
    expect(await auth.getLocalUser()).toBeNull()
    expect(await auth.getLocalUserFromToken(token)).toBeNull()
    expect((await db.readStore()).sessions.filter(row => row.user_id === target.user.id)).toHaveLength(1)
  })

  it.each([null, 'invalid-deadline'])('fails closed for a suspension with no usable expiry (%s)', async (deadline) => {
    await db.mutate(store => {
      store.profile_account_states.push({
        id: 'sta_s07', profile_id: target.profile.id, status: 'suspended',
        suspended_until: deadline, warning_count: 0,
      })
    })
    await expectLoginBlocked()
    vi.setSystemTime(START + 366 * DAY)
    await expectLoginBlocked()
  })

  it('preserves an existing permanent disable when a moderator also records a timed suspension', async () => {
    const oldToken = await device(target)
    const reportId = await fileReport()
    const disabledAt = new Date(START - DAY).toISOString()
    await db.mutate(store => { store.users.find(row => row.id === target.user.id)!.disabled_at = disabledAt })
    await suspend(reportId)
    expect((await db.readStore()).users.find(row => row.id === target.user.id)?.disabled_at).toBe(disabledAt)
    vi.setSystemTime(START + DAY + 1)
    await expectLoginBlocked()
    expect(await auth.getLocalUserFromToken(oldToken)).toBeNull()
    expect((await db.readStore()).users.find(row => row.id === target.user.id)?.disabled_at).toBe(disabledAt)
  })

  it('keeps a permanent disable applied during suspension blocked after the temporary deadline', async () => {
    await suspend(await fileReport())
    vi.setSystemTime(START + 1)
    const disabledAt = db.now()
    await db.mutate(store => { store.users.find(row => row.id === target.user.id)!.disabled_at = disabledAt })
    vi.setSystemTime(START + DAY)
    await expectLoginBlocked()
    expect((await db.readStore()).users.find(row => row.id === target.user.id)?.disabled_at).toBe(disabledAt)
  })

  it('rechecks suspension inside the session transaction after an earlier credential check succeeded', async () => {
    const checkedUserId = (await auth.checkCredentials(target.user.email, password))?.id
    expect(checkedUserId).toBe(target.user.id)
    await suspend(await fileReport())
    request.cookies.clear()
    await expect(auth.startSession(checkedUserId!)).rejects.toThrow('Account is unavailable')
    expect(request.cookies.has(COOKIE)).toBe(false)
    expect((await db.readStore()).sessions.filter(row => row.user_id === target.user.id)).toHaveLength(0)
  })

  it('does not let a non-moderator suspend an account or revoke its sessions', async () => {
    const oldToken = await device(target)
    const reportId = await fileReport()
    expect((await actions.decideReportAction({ status: 'idle' }, decision(reportId))).status).toBe('error')
    const store = await db.readStore()
    expect(store.profile_account_states).toHaveLength(0)
    expect(store.moderation_actions).toHaveLength(0)
    expect(store.reports.find(row => row.id === reportId)?.status).toBe('open')
    expect((await auth.getLocalUserFromToken(oldToken))?.id).toBe(target.user.id)
  })

  it('does not expose suspension or revocation when committing the moderator decision fails', async () => {
    const oldToken = await device(target)
    const reportId = await fileReport()
    await device(moderator)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('S07 fixture commit failed'))
    await expect(actions.decideReportAction({ status: 'idle' }, decision(reportId))).rejects.toThrow('S07 fixture commit failed')
    const store = await db.readStore()
    expect(store.profile_account_states).toHaveLength(0)
    expect(store.moderation_actions).toHaveLength(0)
    expect(store.reports.find(row => row.id === reportId)?.status).toBe('open')
    expect(store.users.find(row => row.id === target.user.id)?.disabled_at).toBeUndefined()
    expect((await auth.getLocalUserFromToken(oldToken))?.id).toBe(target.user.id)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

vi.mock('server-only', () => ({}))
const initialization = vi.hoisted(() => ({
  ensureSeeded: vi.fn(async () => { throw new Error('Auth requests must not initialize demo data') }),
}))
const request = vi.hoisted(() => ({
  context: undefined as AsyncLocalStorage<Map<string, string>> | undefined,
  jar: new Map<string, string>(),
  failDelete: false,
}))
vi.mock('next/headers', () => ({
  cookies: async () => {
    const jar = request.context?.getStore() ?? request.jar
    return {
      get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
      set: (name: string, value: string) => { jar.set(name, value) },
      delete: (name: string) => {
        if (request.failDelete) throw new Error('Fixture cookie deletion failed')
        jar.delete(name)
      },
    }
  },
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) },
}))
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: initialization.ensureSeeded }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => { throw new Error('Local password tests must never contact a provider') },
}))

const contexts = new AsyncLocalStorage<Map<string, string>>()
request.context = contexts
const COOKIE = 'quad_local_session'
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let passwords: typeof import('@/lib/local/password')
let actions: typeof import('@/features/auth/password-actions')
let ownerId: string
let neighborId: string
let oldPassword: string
let newPassword: string

function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

beforeEach(async () => {
  vi.resetModules()
  initialization.ensureSeeded.mockClear()
  request.jar.clear()
  request.failDelete = false
  fixture = await createTempWorkspace('password-recovery')
  vi.spyOn(process, 'cwd').mockReturnValue(fixture.directory)
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'local.json'))
  vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'false')
  db = await import('@/lib/local/db')
  session = await import('@/lib/local/session')
  passwords = await import('@/lib/local/password')
  actions = await import('@/features/auth/password-actions')
  oldPassword = randomBytes(24).toString('base64url')
  newPassword = randomBytes(24).toString('base64url')
  const owner = await session.createAccount({ email: 'owner@example.test', password: oldPassword, displayName: 'Owner' })
  const neighbor = await session.createAccount({ email: 'neighbor@example.test', password: newPassword, displayName: 'Neighbor' })
  ownerId = owner!.user.id
  neighborId = neighbor!.user.id
  await session.startSession(ownerId)
})

afterEach(async () => {
  request.jar.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  db?.resetLocalCache()
  const owned = fixture
  fixture = undefined
  await owned?.cleanup()
})

describe('local auth without request-time demo initialization', () => {
  it('signs in an existing account without seeding or changing account/profile rows', async () => {
    const before = await db.readStore()
    const localActions = await import('@/features/auth/local-actions')
    await expect(localActions.localSignInAction(form({
      email: 'owner@example.test', password: oldPassword,
    }))).rejects.toThrow('TEST_REDIRECT:/feed')
    expect(initialization.ensureSeeded).not.toHaveBeenCalled()
    const after = await db.readStore()
    expect(after.users).toEqual(before.users)
    expect(after.profiles).toEqual(before.profiles)
    expect(after.posts).toEqual(before.posts)
    expect((await session.getLocalUser())?.id).toBe(ownerId)
  })

  it('creates only the requested private account in an empty fixture, never demo content', async () => {
    request.jar.clear()
    await db.mutate((store) => {
      store.users = []
      store.profiles = []
      store.sessions = []
    })
    const localActions = await import('@/features/auth/local-actions')
    await expect(localActions.localSignUpAction(form({
      email: 'new-private@example.test',
      password: newPassword,
      displayName: 'New private account',
      acceptTerms: 'on',
    }))).rejects.toThrow('TEST_REDIRECT:/onboarding')
    expect(initialization.ensureSeeded).not.toHaveBeenCalled()
    const after = await db.readStore()
    expect(after.users).toHaveLength(1)
    expect(after.users[0].email).toBe('new-private@example.test')
    expect(after.profiles).toHaveLength(1)
    expect(after.profiles[0]).toMatchObject({
      visibility: 'private', onboarding_completed: false,
    })
    expect(after.posts).toHaveLength(0)
    expect(after.messages).toHaveLength(0)
    expect(after.projects).toHaveLength(0)
    expect(after.universities).toHaveLength(0)
    expect((await session.getLocalUser())?.id).toBe(after.users[0].id)
  })
})

describe('local current-password change and durable session revocation', () => {
  it('replaces only the owner hash, invalidates the old password, and revokes every old device after reload', async () => {
    const firstToken = request.jar.get(COOKIE)!
    request.jar.clear()
    await session.startSession(ownerId)
    const secondToken = request.jar.get(COOKIE)!
    const neighborJar = new Map<string, string>()
    await contexts.run(neighborJar, () => session.startSession(neighborId))
    const before = await db.readStore()
    expect(await passwords.changeLocalPassword({
      expectedUserId: ownerId, currentPassword: oldPassword, newPassword,
    })).toEqual({ ok: true, cookieCleared: true })

    db.resetLocalCache()
    expect(await session.checkCredentials('owner@example.test', oldPassword)).toBeNull()
    expect((await session.checkCredentials('owner@example.test', newPassword))?.id).toBe(ownerId)
    expect(await session.getLocalUserFromToken(firstToken)).toBeNull()
    expect(await session.getLocalUserFromToken(secondToken)).toBeNull()
    expect((await session.getLocalUserFromToken(neighborJar.get(COOKIE)))?.id).toBe(neighborId)
    expect(request.jar.has(COOKIE)).toBe(false)
    const after = await db.readStore()
    expect(after.profiles).toEqual(before.profiles)
    expect(after.user_roles).toEqual(before.user_roles)
    expect(after.users.find((row) => row.id === neighborId)).toEqual(before.users.find((row) => row.id === neighborId))
  })

  it('allows a shorter pre-policy current password to be upgraded without changing the account ID', async () => {
    const legacy = randomBytes(4).toString('hex')
    await db.mutate((store) => { store.users.find((row) => row.id === ownerId)!.password_hash = session.hashPassword(legacy) })
    await expect(actions.changePasswordAction({ status: 'idle' }, form({
      currentPassword: legacy, password: newPassword, confirm: newPassword,
    }))).rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(await session.checkCredentials('owner@example.test', legacy)).toBeNull()
    expect((await session.checkCredentials('owner@example.test', newPassword))?.id).toBe(ownerId)
  })

  it('requires the current password and never echoes any password, token, or hash in form state', async () => {
    const wrong = randomBytes(24).toString('base64url')
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const state = await actions.changePasswordAction({ status: 'idle' }, form({
      currentPassword: wrong, password: newPassword, confirm: newPassword, userId: neighborId,
    }))
    expect(state).toMatchObject({ status: 'error', fieldErrors: { currentPassword: expect.any(String) } })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    for (const value of [wrong, newPassword, request.jar.get(COOKIE)!, 'password_hash']) {
      expect(JSON.stringify(state)).not.toContain(value)
    }
    expect(await actions.changePasswordAction({ status: 'idle' }, form({
      password: newPassword, confirm: newPassword,
    }))).toMatchObject({ status: 'error', fieldErrors: { currentPassword: expect.any(String) } })
  })

  it('rejects weak, mismatched, and unchanged passwords before changing any credential', async () => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    for (const [password, confirm] of [
      ['too short', 'too short'],
      ['x'.repeat(20), 'x'.repeat(20)],
      [newPassword, oldPassword],
      [oldPassword, oldPassword],
    ]) {
      expect((await actions.changePasswordAction({ status: 'idle' }, form({
        currentPassword: oldPassword, password, confirm,
      }))).status).toBe('error')
    }
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('enforces the new policy and unchanged-password rejection on direct helper calls too', async () => {
    expect(await passwords.changeLocalPassword({
      expectedUserId: ownerId, currentPassword: oldPassword, newPassword: 'short',
    })).toEqual({ ok: false, reason: 'invalid_new_password' })
    expect(await passwords.changeLocalPassword({
      expectedUserId: ownerId, currentPassword: oldPassword, newPassword: oldPassword,
    })).toEqual({ ok: false, reason: 'same_password' })
    expect((await db.readStore()).sessions).toHaveLength(1)
  })

  it('leaves both the old hash and all sessions intact when the atomic commit fails', async () => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const token = request.jar.get(COOKIE)!
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Fixture commit failed'))
    expect(await actions.changePasswordAction({ status: 'idle' }, form({
      currentPassword: oldPassword, password: newPassword, confirm: newPassword,
    }))).toMatchObject({ status: 'error', message: expect.stringContaining('could not be changed') })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect((await session.getLocalUserFromToken(token))?.id).toBe(ownerId)
    expect((await session.checkCredentials('owner@example.test', oldPassword))?.id).toBe(ownerId)
  })

  it('keeps durable revocation effective even if clearing the response cookie fails', async () => {
    const token = request.jar.get(COOKIE)!
    request.failDelete = true
    expect(await passwords.changeLocalPassword({
      expectedUserId: ownerId, currentPassword: oldPassword, newPassword,
    })).toEqual({ ok: true, cookieCleared: false })
    db.resetLocalCache()
    expect(await session.getLocalUserFromToken(token)).toBeNull()
    expect(await session.checkCredentials('owner@example.test', oldPassword)).toBeNull()
  })

  it('allows only one simultaneous change across two signed-in devices and rejects the losing session', async () => {
    const firstJar = new Map(request.jar)
    const secondJar = new Map<string, string>()
    await contexts.run(secondJar, () => session.startSession(ownerId))
    const otherPassword = randomBytes(24).toString('base64url')
    const results = await Promise.all([
      contexts.run(firstJar, () => passwords.changeLocalPassword({
        expectedUserId: ownerId, currentPassword: oldPassword, newPassword,
      })),
      contexts.run(secondJar, () => passwords.changeLocalPassword({
        expectedUserId: ownerId, currentPassword: oldPassword, newPassword: otherPassword,
      })),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'signed_out' }])
    expect((await db.readStore()).sessions.filter((row) => row.user_id === ownerId)).toHaveLength(0)
    const accepted = await Promise.all([newPassword, otherPassword].map((candidate) => session.checkCredentials('owner@example.test', candidate)))
    expect(accepted.filter(Boolean)).toHaveLength(1)
  })

  it('rejects session issuance from a password check that raced with a completed password change', async () => {
    const checked = (await session.checkCredentials('owner@example.test', oldPassword))!
    await passwords.changeLocalPassword({ expectedUserId: ownerId, currentPassword: oldPassword, newPassword })
    await expect(session.startSession(checked.id, { expectedPasswordHash: checked.password_hash }))
      .rejects.toBeInstanceOf(session.LocalCredentialsChangedError)
    expect((await db.readStore()).sessions).toHaveLength(0)
    const { localSignInAction } = await import('@/features/auth/local-actions')
    vi.spyOn(session, 'checkCredentials').mockResolvedValueOnce(checked)
    expect(await localSignInAction(form({ email: 'owner@example.test', password: oldPassword })))
      .toMatchObject({ status: 'error', message: 'That email or password is incorrect.' })
    expect((await db.readStore()).sessions).toHaveLength(0)
    expect(request.jar.has(COOKIE)).toBe(false)
  })
})

describe('reusable identity-bound local password reauthentication', () => {
  it('returns only identity, not a transferable grant or credential record', async () => {
    const result = await passwords.reauthenticateLocalPassword({ expectedUserId: ownerId, currentPassword: oldPassword })
    expect(result).toEqual({ ok: true, value: { userId: ownerId, profileId: expect.any(String) } })
    expect(JSON.stringify(result)).not.toContain(oldPassword)
    expect(JSON.stringify(result)).not.toContain(request.jar.get(COOKIE)!)
    expect(JSON.stringify(result)).not.toContain('password_hash')
  })

  it('refuses a mismatched expected identity even with the neighbor password and a valid owner cookie', async () => {
    const callback = vi.fn()
    expect(await passwords.reauthenticateLocalPassword({
      expectedUserId: neighborId, currentPassword: newPassword,
    })).toEqual({ ok: false, reason: 'identity_mismatch' })
    expect(await passwords.withLocalPasswordReauthentication({
      expectedUserId: neighborId, currentPassword: newPassword,
    }, callback)).toEqual({ ok: false, reason: 'identity_mismatch' })
    expect(callback).not.toHaveBeenCalled()
  })

  it.each(['absent', 'forged', 'expired', 'disabled', 'suspended'] as const)('denies a %s session without executing lifecycle work', async (kind) => {
    if (kind === 'absent') request.jar.clear()
    if (kind === 'forged') request.jar.set(COOKIE, randomBytes(32).toString('base64url'))
    if (kind === 'expired') await db.mutate((store) => { store.sessions[0].expires_at = new Date(Date.now() - 1).toISOString() })
    if (kind === 'disabled') await db.mutate((store) => { store.users.find((row) => row.id === ownerId)!.disabled_at = new Date().toISOString() })
    if (kind === 'suspended') await db.mutate((store) => {
      store.profile_account_states.push({
        id: 'sta_fixture', profile_id: store.profiles.find((row) => row.user_id === ownerId)!.id,
        status: 'suspended', suspended_until: null, warning_count: 0,
      })
    })
    const callback = vi.fn()
    expect(await passwords.withLocalPasswordReauthentication({
      expectedUserId: ownerId, currentPassword: oldPassword,
    }, callback)).toEqual({ ok: false, reason: 'signed_out' })
    expect(callback).not.toHaveBeenCalled()
  })

  it('checks the latest locked session/password again before lifecycle writes', async () => {
    await session.endSession()
    const callback = vi.fn()
    expect(await passwords.withLocalPasswordReauthentication({
      expectedUserId: ownerId, currentPassword: oldPassword,
    }, callback)).toEqual({ ok: false, reason: 'signed_out' })
    expect(callback).not.toHaveBeenCalled()
  })

  it('bounds reauthentication guesses with the same account/source budget used for login', async () => {
    const wrong = randomBytes(24).toString('base64url')
    for (let index = 0; index < 5; index += 1) {
      expect(await passwords.reauthenticateLocalPassword({
        expectedUserId: ownerId, currentPassword: wrong,
      })).toEqual({ ok: false, reason: 'invalid_password' })
    }
    expect(await passwords.reauthenticateLocalPassword({
      expectedUserId: ownerId, currentPassword: oldPassword,
    })).toMatchObject({ ok: false, reason: 'throttled', retryAfterSeconds: expect.any(Number) })
  })
})

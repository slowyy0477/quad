import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

vi.mock('server-only', () => ({}))
const request = vi.hoisted(() => ({
  values: new Map<string, string>(),
  options: new Map<string, Record<string, unknown>>(),
  headers: new Headers(),
  failCookieWrite: false,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => request.values.has(name) ? { value: request.values.get(name)! } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (request.failCookieWrite) throw new Error('Cookie write unavailable')
      request.values.set(name, value)
      request.options.set(name, options)
    },
    delete: (name: string) => { request.values.delete(name) },
  }),
  headers: async () => request.headers,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) },
}))
// Auth tests never seed or read real student/demo credentials.
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: async () => {} }))

const COOKIE = 'quad_local_session'
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let auth: typeof import('@/lib/local/session')
let password: string
let userId: string

beforeEach(async () => {
  fixture = undefined
  vi.resetModules()
  request.values.clear()
  request.options.clear()
  request.headers = new Headers()
  request.failCookieWrite = false
  fixture = await createTempWorkspace('auth', process.env.AUTH_TEST_ROOT)
  const fixtureDirectory = fixture.directory
  const dataFile = path.join(fixtureDirectory, 'data', 'local.json')
  vi.spyOn(process, 'cwd').mockReturnValue(fixtureDirectory)
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_DIR', fixtureDirectory)
  vi.stubEnv('LOCAL_DATA_FILE', dataFile)
  vi.stubEnv('LOCAL_DATA_PATH', dataFile)
  vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'false')
  db = await import('@/lib/local/db')
  auth = await import('@/lib/local/session')
  password = randomBytes(24).toString('base64url')
  userId = 'usr_security_fixture'
  await db.mutate((store) => {
    store.users.push({ id: userId, email: 'fixture@example.test', password_hash: auth.hashPassword(password), created_at: new Date().toISOString() })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  db?.resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('local authentication security', () => {
  it('creates new profiles with onboarding still required', async () => {
    const account = await auth.createAccount({ email: 'onboarding@example.test', password, displayName: 'New Student' })
    expect(account?.profile.onboarding_completed).toBe(false)
    expect(account?.profile.onboarding_step).toBe(0)
  })

  it('continues accepting legacy salted scrypt hashes with shorter existing passwords', async () => {
    const legacy = randomBytes(4).toString('hex')
    await db.mutate((store) => { store.users[0].password_hash = auth.hashPassword(legacy) })
    expect((await auth.checkCredentials(' FIXTURE@EXAMPLE.TEST ', legacy))?.id).toBe(userId)
    expect(await auth.checkCredentials('fixture@example.test', password) === null).toBe(true)
  })
  it('allows exactly one winner for concurrent signups of the same normalized email', async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => auth.createAccount({
      email: index % 2 ? ' SAME@EXAMPLE.TEST ' : 'same@example.test', password, displayName: 'Same Student',
    })))
    expect(attempts.filter(Boolean)).toHaveLength(1)
    expect((await db.readStore()).users).toHaveLength(2)
    expect((await db.readStore()).profiles).toHaveLength(1)
  })
  it('rejects forged, malformed, tampered and unknown bearer tokens', async () => {
    await auth.startSession(userId)
    const valid = request.values.get(COOKIE)!
    for (const raw of [undefined, '', `${userId}.${randomBytes(32).toString('hex')}`, 'x'.repeat(100_000), randomBytes(32).toString('base64url'), `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`]) {
      expect(await auth.getLocalUserFromToken(raw)).toBeNull()
    }
  })
  it('does not serialize credential material into session users or action errors', async () => {
    await auth.startSession(userId)
    const user = await auth.getLocalUser()
    expect(Object.keys(user!).sort()).toEqual(['email', 'id', 'profile'])
    const { localSignInAction, localSignUpAction } = await import('@/features/auth/local-actions')
    const form = new FormData()
    form.set('email', 'invalid')
    form.set('password', password)
    form.set('displayName', 'Student')
    for (const state of [await localSignInAction(form), await localSignUpAction(form)]) {
      expect(JSON.stringify(state).includes(password)).toBe(false)
      expect(JSON.stringify(state).includes('password_hash')).toBe(false)
      expect(Object.keys(state.values ?? {}).includes('password')).toBe(false)
    }
  })
  it('sets Secure cookies in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await auth.startSession(userId)
    expect(request.options.get(COOKIE)?.secure).toBe(true)
  })
  it('does not issue a cookie or retain a session after a database commit fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Fixture write failed'))
    await expect(auth.startSession(userId)).rejects.toThrow('Fixture write failed')
    expect(request.values.has(COOKIE)).toBe(false)
    expect((await db.readStore()).sessions).toHaveLength(0)
  })
  it('does not claim logout success when durable revocation fails', async () => {
    await auth.startSession(userId)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Fixture write failed'))
    await expect(auth.endSession()).rejects.toThrow('Fixture write failed')
    expect(request.values.has(COOKIE)).toBe(true)
    expect((await db.readStore()).sessions).toHaveLength(1)
  })
  it('fails closed when the isolated database is corrupt', async () => {
    await auth.startSession(userId)
    await fs.writeFile(db.localStorePath(), '{broken-json', 'utf8')
    await expect(auth.getLocalUser()).rejects.toThrow()
  })
  it('revokes only the current device on logout', async () => {
    await auth.startSession(userId)
    const otherDevice = request.values.get(COOKIE)!
    request.values.clear()
    await auth.startSession(userId)
    await auth.endSession()
    expect((await auth.getLocalUserFromToken(otherDevice))?.id).toBe(userId)
  })
  it('counts invalid login forms against the abuse budget', async () => {
    const { localSignInAction } = await import('@/features/auth/local-actions')
    const form = new FormData()
    form.set('email', 'invalid')
    for (let index = 0; index < 5; index += 1) await localSignInAction(form)
    expect((await localSignInAction(form)).message).toContain('Too many attempts')
  })

  it('rejects malformed password records with extra fields instead of accepting a valid prefix', async () => {
    const stored = (await db.readStore()).users[0].password_hash
    expect(auth.verifyPassword(password, `${stored}$ignored`)).toBe(false)
  })
  it.each(['A', '____________________', 'abcdefghijklmnopqrs_ trailing'])('allocates a schema-valid username for display name %s', async (displayName) => {
    const created = await auth.createAccount({ email: 'a@example.test', password, displayName })
    const { usernameSchema } = await import('@/features/auth/schemas')
    expect(usernameSchema.safeParse(created!.profile.username).success).toBe(true)
  })
  it('prunes expired sessions when creating a fresh session', async () => {
    await auth.startSession(userId)
    await db.mutate((store) => { store.sessions[0].expires_at = new Date(Date.now() - 1).toISOString() })
    request.values.clear()
    await auth.startSession(userId)
    expect((await db.readStore()).sessions).toHaveLength(1)
  })
  it('keeps at most five active device sessions per account', async () => {
    const captured: string[] = []
    for (let index = 0; index < 6; index += 1) {
      request.values.clear()
      await auth.startSession(userId)
      captured.push(request.values.get(COOKIE)!)
    }
    expect((await db.readStore()).sessions).toHaveLength(5)
    expect(await auth.getLocalUserFromToken(captured[0])).toBeNull()
    expect((await auth.getLocalUserFromToken(captured[5]))?.id).toBe(userId)
  })

  it.each(['/foo\\bar', '/%5cevil.example', '/%2f%2fevil.example', '/%252f%252fevil.example', '/good%0d%0aLocation:evil', '/path/..//evil.example'])('rejects unsafe local login redirect %s', async (destination) => {
    const { localSignInAction } = await import('@/features/auth/local-actions')
    const form = new FormData()
    form.set('email', 'fixture@example.test')
    form.set('password', password)
    form.set('next', destination)
    await expect(localSignInAction(form)).rejects.toThrow('TEST_REDIRECT:/feed')
  })

  it('throttles repeated login attempts before password verification', async () => {
    const { localSignInAction } = await import('@/features/auth/local-actions')
    const form = new FormData()
    form.set('email', 'fixture@example.test')
    form.set('password', randomBytes(24).toString('base64url'))
    for (let index = 0; index < 5; index += 1) {
      expect((await localSignInAction(form)).message).toBe('That email or password is incorrect.')
    }
    const blocked = await localSignInAction(form)
    expect(blocked.message).toContain('Too many attempts')
    expect((await db.readStore()).sessions).toHaveLength(0)
  })
  it('throttles repeated signup attempts even when account creation is rejected', async () => {
    const { localSignUpAction } = await import('@/features/auth/local-actions')
    const form = new FormData()
    form.set('email', 'fixture@example.test')
    form.set('password', password)
    form.set('displayName', 'Existing Student')
    form.set('acceptTerms', 'on')
    for (let index = 0; index < 3; index += 1) await localSignUpAction(form)
    const blocked = await localSignUpAction(form)
    expect(blocked.message).toContain('Too many attempts')
    expect((await db.readStore()).users).toHaveLength(1)
  })

  it('resolves opaque tokens without a Next cookie context for proxy authorization', async () => {
    expect(typeof auth.getLocalUserFromToken).toBe('function')
    await auth.startSession(userId)
    const captured = request.values.get(COOKIE)!
    request.values.clear()
    expect((await auth.getLocalUserFromToken(captured))?.id).toBe(userId)
    await db.mutate((store) => { store.sessions[0].expires_at = new Date(Date.now() - 1).toISOString() })
    expect(await auth.getLocalUserFromToken(captured)).toBeNull()
  })

  it('rejects short, whitespace-only, repeated-character and common new passwords', async () => {
    const { passwordSchema } = await import('@/features/auth/schemas')
    for (const candidate of [randomBytes(9).toString('hex').slice(0, 14), ' '.repeat(20), 'x'.repeat(20), '123456789012345', 'passwordpassword']) {
      expect(passwordSchema.safeParse(candidate).success).toBe(false)
    }
    expect(passwordSchema.safeParse(password).success).toBe(true)
  })

  it('enforces the signup password policy even when createAccount is called directly', async () => {
    const invalid = 'x'.repeat(8)
    await expect(auth.createAccount({ email: 'policy@example.test', password: invalid, displayName: 'Policy Student' })).rejects.toThrow('Invalid account details')
    expect((await db.readStore()).users).toHaveLength(1)
  })

  it('treats pre-existing mixed-case emails as taken during concurrent signup', async () => {
    await db.mutate((store) => { store.users[0].email = 'Fixture@Example.Test' })
    const attempts = await Promise.all(Array.from({ length: 4 }, () => auth.createAccount({
      email: ' FIXTURE@example.test ', password, displayName: 'Duplicate',
    })))
    expect(attempts.every((entry) => entry === null)).toBe(true)
    expect((await db.readStore()).users).toHaveLength(1)
  })

  it('allocates unique usernames inside concurrent signup transactions', async () => {
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => auth.createAccount({
      email: `parallel-${index}@example.test`, password, displayName: 'Same Student',
    })))
    expect(created.every(Boolean)).toBe(true)
    const usernames = created.map((entry) => entry!.profile.username.toLowerCase())
    expect(new Set(usernames).size).toBe(8)
    const store = await db.readStore()
    expect(store.profiles).toHaveLength(8)
  })

  it('removes a newly persisted session if setting its browser cookie fails', async () => {
    request.failCookieWrite = true
    await expect(auth.startSession(userId)).rejects.toThrow('Cookie write unavailable')
    expect((await db.readStore()).sessions).toHaveLength(0)
  })

  it('denies existing sessions after an account is disabled', async () => {
    await auth.startSession(userId)
    await db.mutate((store) => { store.users[0].disabled_at = new Date().toISOString() })
    expect(await auth.getLocalUser()).toBeNull()
  })
  it('denies password authentication for disabled accounts', async () => {
    await db.mutate((store) => { store.users[0].disabled_at = new Date().toISOString() })
    expect((await auth.checkCredentials('fixture@example.test', password)) === null).toBe(true)
  })
  it.each(['disabled', 'missing'])('will not create a session for a %s account', async (kind) => {
    await db.mutate((store) => {
      if (kind === 'missing') store.users = []
      else store.users[0].disabled_at = new Date().toISOString()
    })
    await expect(auth.startSession(userId)).rejects.toThrow('Account is unavailable')
    expect((await db.readStore()).sessions).toHaveLength(0)
    expect(request.values.has(COOKIE)).toBe(false)
  })

  it('rotates and revokes the previous browser session on fresh login', async () => {
    await auth.startSession(userId)
    const previous = request.values.get(COOKIE)!
    await auth.startSession(userId)
    expect((await db.readStore()).sessions).toHaveLength(1)
    request.values.set(COOKIE, previous)
    expect(await auth.getLocalUser()).toBeNull()
  })

  it('revokes the server session on logout even if the cookie is replayed', async () => {
    await auth.startSession(userId)
    const captured = request.values.get(COOKIE)!
    await auth.endSession()
    expect((await db.readStore()).sessions).toHaveLength(0)
    expect(request.values.has(COOKIE)).toBe(false)
    request.values.set(COOKIE, captured)
    expect(await auth.getLocalUser()).toBeNull()
    db.resetLocalCache()
    expect(await auth.getLocalUser()).toBeNull()
  })

  it.each(['expired', 'invalid', 'future-created'])('rejects a %s session using server-side time', async (kind) => {
    await auth.startSession(userId)
    await db.mutate((store) => {
      const session = store.sessions[0]
      if (kind === 'expired') session.expires_at = new Date(Date.now() - 1).toISOString()
      if (kind === 'invalid') session.expires_at = 'not-a-date'
      if (kind === 'future-created') session.created_at = new Date(Date.now() + 60_000).toISOString()
    })
    expect(await auth.getLocalUser()).toBeNull()
  })

  it('issues random opaque sessions persisted only as a token digest', async () => {
    await auth.startSession(userId)
    const first = request.values.get(COOKIE)!
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.includes(userId)).toBe(false)
    const store = await db.readStore()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]).toMatchObject({ user_id: userId, token_hash: createHash('sha256').update(first).digest('hex') })
    expect(Object.keys(store.sessions[0]).sort()).toEqual(['created_at', 'expires_at', 'id', 'token_hash', 'user_id'])
    expect(JSON.stringify(store.sessions).includes(first)).toBe(false)
    expect((await auth.getLocalUser())?.id).toBe(userId)
    await auth.startSession(userId)
    expect(request.values.get(COOKIE) === first).toBe(false)
    expect(request.options.get(COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 2_592_000 })
  })
})

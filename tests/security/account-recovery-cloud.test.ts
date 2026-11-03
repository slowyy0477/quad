import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))
const cloud = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  getClaims: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  verifyOtp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}))
const configuration = vi.hoisted(() => ({
  local: false,
  configured: true,
  capabilities: vi.fn(),
}))
const request = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => request.jar.has(name) ? { value: request.jar.get(name) } : undefined,
    set: (name: string, value: string) => { request.jar.set(name, value) },
    delete: (name: string) => { request.jar.delete(name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) },
}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => configuration.local }))
vi.mock('@/lib/env', () => ({
  isSupabaseConfigured: () => configuration.configured,
  isDataConfigured: () => configuration.local || configuration.configured,
  siteUrl: () => 'https://bulla.example.test',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: cloud.createClient }))
vi.mock('@/features/auth/providers', () => ({ getAuthCapabilities: configuration.capabilities }))

const OWNER = '11111111-1111-4111-8111-111111111111'
const RECOVERY_OWNER = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const TOKEN = 'a1'.repeat(32)
const COOKIE = 'bulla_password_recovery'
const currentPassword = 'existing account phrase'
const newPassword = 'brand new private phrase'
let passwordActions: typeof import('@/features/auth/password-actions')
let authActions: typeof import('@/features/auth/actions')
let usedTokens: Set<string>

function form(overrides: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({
    currentPassword, password: newPassword, confirm: newPassword, ...overrides,
  })) data.set(key, value)
  return data
}

function freshClaims(overrides: Record<string, unknown> = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    sub: RECOVERY_OWNER, role: 'authenticated', session_id: SESSION,
    iat: timestamp, exp: timestamp + 3600,
    amr: [{ method: 'otp', timestamp }], ...overrides,
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  request.jar.clear()
  configuration.local = false
  configuration.configured = true
  configuration.capabilities.mockResolvedValue({
    status: 'configured', password: true, google: true, emailRecovery: true, recoveryUnavailableReason: null,
  })
  cloud.createClient.mockResolvedValue({
    auth: {
      getUser: cloud.getUser, getClaims: cloud.getClaims,
      signInWithPassword: cloud.signInWithPassword, updateUser: cloud.updateUser,
      signOut: cloud.signOut, verifyOtp: cloud.verifyOtp,
      resetPasswordForEmail: cloud.resetPasswordForEmail,
      signInWithOAuth: cloud.signInWithOAuth, exchangeCodeForSession: cloud.exchangeCodeForSession,
    },
  })
  cloud.getUser.mockImplementation(async (token?: string) => ({
    data: { user: { id: token ? RECOVERY_OWNER : OWNER, email: 'owner@example.test' } }, error: null,
  }))
  cloud.getClaims.mockResolvedValue({ data: { claims: freshClaims() }, error: null })
  cloud.signInWithPassword.mockResolvedValue({
    data: { user: { id: OWNER }, session: { access_token: 'fixture-password-session' } }, error: null,
  })
  cloud.updateUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null })
  cloud.signOut.mockResolvedValue({ error: null })
  cloud.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
  cloud.signInWithOAuth.mockResolvedValue({ data: { url: 'https://provider.example.test/oauth' }, error: null })
  cloud.exchangeCodeForSession.mockResolvedValue({ data: { redirectType: null }, error: null })
  usedTokens = new Set()
  cloud.verifyOtp.mockImplementation(async (input: { type: string; token_hash: string }) => {
    if (input.type !== 'recovery' || input.token_hash !== TOKEN || usedTokens.has(input.token_hash)) {
      return { data: { user: null, session: null }, error: { code: 'otp_expired' } }
    }
    // A provider-owned atomic one-time-token contract, not an application map.
    usedTokens.add(input.token_hash)
    return {
      data: {
        user: { id: RECOVERY_OWNER },
        session: { user: { id: RECOVERY_OWNER }, access_token: 'fixture-recovery-session' },
      },
      error: null,
    }
  })
  passwordActions = await import('@/features/auth/password-actions')
  authActions = await import('@/features/auth/actions')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  request.jar.clear()
})

describe('cloud password change with explicit account binding', () => {
  it('reauthenticates the verified account, enforces current_password, and globally revokes sessions', async () => {
    await expect(passwordActions.changePasswordAction({ status: 'idle' }, form({
      email: 'victim@example.test', userId: RECOVERY_OWNER,
    }))).rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(cloud.signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.test', password: currentPassword })
    expect(cloud.updateUser).toHaveBeenCalledWith({ password: newPassword, current_password: currentPassword })
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'global' })
  })

  it('requires the current password without applying the new minimum to legacy credentials', async () => {
    await expect(passwordActions.changePasswordAction({ status: 'idle' }, form({
      currentPassword: 'legacy8',
    }))).rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(cloud.signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.test', password: 'legacy8' })
    const missing = form()
    missing.delete('currentPassword')
    expect(await passwordActions.changePasswordAction({ status: 'idle' }, missing))
      .toMatchObject({ status: 'error', fieldErrors: { currentPassword: expect.any(String) } })
  })

  it('rejects an incorrect current password and never forwards credential material', async () => {
    cloud.signInWithPassword.mockResolvedValue({ data: {}, error: { code: 'invalid_credentials' } })
    const result = await passwordActions.changePasswordAction({ status: 'idle' }, form())
    expect(result).toMatchObject({ status: 'error', fieldErrors: { currentPassword: expect.any(String) } })
    expect(cloud.updateUser).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(currentPassword)
    expect(JSON.stringify(result)).not.toContain(newPassword)
  })

  it('rejects reauthentication to a different account instead of mutating it', async () => {
    cloud.signInWithPassword.mockResolvedValue({
      data: { user: { id: RECOVERY_OWNER }, session: {} }, error: null,
    })
    expect(await passwordActions.changePasswordAction({ status: 'idle' }, form()))
      .toMatchObject({ status: 'error', message: expect.stringContaining('did not match') })
    expect(cloud.updateUser).not.toHaveBeenCalled()
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('is truthful about partial success when password replacement succeeded but revocation failed', async () => {
    cloud.signOut.mockResolvedValueOnce({ error: { code: 'unexpected_failure' } })
    expect(await passwordActions.changePasswordAction({ status: 'idle' }, form()))
      .toMatchObject({ status: 'changed_unrevoked', message: expect.stringContaining('password changed') })
    cloud.signOut.mockResolvedValue({ error: null })
    await expect(passwordActions.revokePasswordSessionsAction())
      .rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(cloud.updateUser).toHaveBeenCalledTimes(1)
    expect(cloud.signOut).toHaveBeenLastCalledWith({ scope: 'global' })
  })

  it('rejects weak, unchanged, mismatched and bcrypt-truncating UTF-8 new passwords server-side', async () => {
    for (const [password, confirm] of [
      ['short', 'short'],
      [currentPassword, currentPassword],
      [newPassword, 'different phrase'],
      ['🔐🌴🦒🎉🚲🌊🍀🍎🔑🚀🌟🦉🧩🎸🛶🦊🐢🐳🌵', '🔐🌴🦒🎉🚲🌊🍀🍎🔑🚀🌟🦉🧩🎸🛶🦊🐢🐳🌵'],
    ]) {
      expect((await passwordActions.changePasswordAction({ status: 'idle' }, form({ password, confirm }))).status).toBe('error')
    }
    expect(cloud.updateUser).not.toHaveBeenCalled()
    expect(cloud.signInWithPassword).not.toHaveBeenCalled()
  })
})

describe('actual one-time cloud recovery authority', () => {
  it('redeems type: recovery, verifies the newly issued user/claims, and signs out every device', async () => {
    request.jar.set(COOKIE, TOKEN)
    await expect(passwordActions.recoverPasswordAction({ status: 'idle' }, form({
      userId: OWNER, recovery: 'true', email: 'victim@example.test',
    }))).rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(cloud.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: TOKEN })
    expect(cloud.getUser).toHaveBeenCalledWith('fixture-recovery-session')
    expect(cloud.getClaims).toHaveBeenCalledWith('fixture-recovery-session')
    expect(cloud.updateUser).toHaveBeenCalledWith({ password: newPassword })
    expect(cloud.signInWithPassword).not.toHaveBeenCalled()
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'global' })
    expect(request.jar.get(COOKIE)).toBe('')
  })

  it('accepts the real PKCE-prefixed email TokenHash without stripping or trusting its prefix', async () => {
    const prefixed = `pkce_${TOKEN}`
    const { GET } = await import('@/app/auth/recovery/route')
    const response = await GET(new NextRequest(`https://bulla.example.test/auth/recovery?token_hash=${prefixed}&type=recovery`))
    expect(response.headers.get('location')).toBe('https://bulla.example.test/settings/password?recovery=1')
    expect(response.cookies.get(COOKIE)?.value).toBe(prefixed)
    expect(cloud.verifyOtp).not.toHaveBeenCalled()
    request.jar.set(COOKIE, prefixed)
    cloud.verifyOtp.mockResolvedValueOnce({
      data: { user: { id: RECOVERY_OWNER }, session: { user: { id: RECOVERY_OWNER }, access_token: 'fixture-recovery-session' } },
      error: null,
    })
    await expect(passwordActions.recoverPasswordAction({ status: 'idle' }, form()))
      .rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    expect(cloud.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: prefixed })
  })

  it('does not treat a normal signed-in session, URL flag or posted token as recovery authority', async () => {
    const state = await passwordActions.recoverPasswordAction({ status: 'idle' }, form({
      token_hash: TOKEN, recovery: 'true', next: '/settings/password',
    }))
    expect(state).toMatchObject({ status: 'error', recoveryInvalid: true })
    expect(cloud.verifyOtp).not.toHaveBeenCalled()
    expect(cloud.updateUser).not.toHaveBeenCalled()
  })

  it('rejects expired/invalid provider tokens without changing any password', async () => {
    request.jar.set(COOKIE, 'b2'.repeat(32))
    const state = await passwordActions.recoverPasswordAction({ status: 'idle' }, form())
    expect(state).toMatchObject({ status: 'error', recoveryInvalid: true, message: expect.stringContaining('expired') })
    expect(cloud.updateUser).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).not.toContain('b2'.repeat(32))
  })

  it('rejects a copied-token replay after success using provider one-time verification', async () => {
    request.jar.set(COOKIE, TOKEN)
    await expect(passwordActions.recoverPasswordAction({ status: 'idle' }, form()))
      .rejects.toThrow('TEST_REDIRECT:/settings/password?changed=1')
    request.jar.set(COOKIE, TOKEN)
    expect(await passwordActions.recoverPasswordAction({ status: 'idle' }, form()))
      .toMatchObject({ status: 'error', recoveryInvalid: true })
    expect(cloud.updateUser).toHaveBeenCalledTimes(1)
    expect(cloud.verifyOtp).toHaveBeenCalledTimes(2)
  })

  it('allows only the provider token-redemption winner to perform a simultaneous recovery update', async () => {
    request.jar.set(COOKIE, TOKEN)
    const results = await Promise.allSettled([
      passwordActions.recoverPasswordAction({ status: 'idle' }, form()),
      passwordActions.recoverPasswordAction({ status: 'idle' }, form({
        password: 'another fresh private phrase', confirm: 'another fresh private phrase',
      })),
    ])
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(cloud.updateUser).toHaveBeenCalledTimes(1)
  })

  it('does not consume the link on a weak or mismatched password validation error', async () => {
    request.jar.set(COOKIE, TOKEN)
    expect(await passwordActions.recoverPasswordAction({ status: 'idle' }, form({ password: 'short', confirm: 'short' })))
      .toMatchObject({ status: 'error', fieldErrors: { password: expect.any(String) } })
    expect(cloud.verifyOtp).not.toHaveBeenCalled()
    expect(request.jar.get(COOKIE)).toBe(TOKEN)
  })

  it.each([
    ['stale session', { iat: 1 }],
    ['expired token', { exp: 1 }],
    ['future session', { iat: Math.floor(Date.now() / 1000) + 120 }],
    ['wrong account', { sub: OWNER }],
    ['missing session ID', { session_id: null }],
    ['ordinary password AMR', { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] }],
    ['untimestamped AMR', { amr: ['otp'] }],
  ])('rejects %s after token redemption rather than trusting cookie/session metadata', async (_name, overrides) => {
    request.jar.set(COOKIE, TOKEN)
    cloud.getClaims.mockResolvedValue({ data: { claims: freshClaims(overrides) }, error: null })
    expect(await passwordActions.recoverPasswordAction({ status: 'idle' }, form()))
      .toMatchObject({ status: 'error', recoveryInvalid: true, message: expect.stringContaining('fresh recovery session') })
    expect(cloud.updateUser).not.toHaveBeenCalled()
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('rejects invalid signed claims and a provider user mismatch', async () => {
    request.jar.set(COOKIE, TOKEN)
    cloud.getClaims.mockResolvedValueOnce({ data: null, error: { code: 'bad_jwt' } })
    expect((await passwordActions.recoverPasswordAction({ status: 'idle' }, form())).recoveryInvalid).toBe(true)
    expect(cloud.updateUser).not.toHaveBeenCalled()
  })

  it('invalidates the recovery context when the provider rejects the password after consuming the link', async () => {
    request.jar.set(COOKIE, TOKEN)
    cloud.updateUser.mockResolvedValueOnce({ error: { code: 'weak_password' } })
    expect(await passwordActions.recoverPasswordAction({ status: 'idle' }, form()))
      .toMatchObject({ status: 'error', recoveryInvalid: true, message: expect.stringContaining('link has been used') })
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(request.jar.get(COOKIE)).toBe('')
  })
})

describe('recovery/provider availability and safe existing redirects', () => {
  it('never fakes local email recovery even when cloud credentials are present', async () => {
    configuration.local = true
    configuration.capabilities.mockResolvedValue({
      status: 'local', google: false, emailRecovery: false, recoveryUnavailableReason: 'Local accounts have no email recovery.',
    })
    expect(await authActions.requestPasswordResetAction({ status: 'idle' }, form({ email: 'owner@example.test' })))
      .toMatchObject({ status: 'error', message: expect.stringContaining('no email recovery') })
    expect(cloud.createClient).not.toHaveBeenCalled()
    expect(cloud.resetPasswordForEmail).not.toHaveBeenCalled()
    await expect(authActions.signInWithGoogleAction(form())).rejects.toThrow('TEST_REDIRECT:/auth/provider-unavailable')
    expect(cloud.signInWithOAuth).not.toHaveBeenCalled()
  })

  it('does not report reset-email success after a provider/SMTP failure', async () => {
    cloud.resetPasswordForEmail.mockResolvedValue({ error: { code: 'unexpected_failure' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await authActions.requestPasswordResetAction({ status: 'idle' }, form({ email: 'owner@example.test' })))
      .toMatchObject({ status: 'error', message: expect.stringContaining('No email delivery is confirmed') })
  })

  it('keeps missing-account recovery neutral and uses the dedicated recovery callback', async () => {
    cloud.resetPasswordForEmail.mockResolvedValue({ error: { code: 'user_not_found' } })
    await expect(authActions.requestPasswordResetAction({ status: 'idle' }, form({ email: 'absent@example.test' })))
      .rejects.toThrow('TEST_REDIRECT:/reset-password/sent')
    expect(cloud.resetPasswordForEmail).toHaveBeenCalledWith('absent@example.test', {
      redirectTo: 'https://bulla.example.test/auth/recovery',
    })
  })

  it('preserves safe OAuth destinations and rejects encoded open redirects', async () => {
    await expect(authActions.signInWithGoogleAction(form({ next: '/projects?view=mine' })))
      .rejects.toThrow('TEST_REDIRECT:https://provider.example.test/oauth')
    expect(cloud.signInWithOAuth).toHaveBeenLastCalledWith(expect.objectContaining({
      options: { redirectTo: 'https://bulla.example.test/auth/callback?next=%2Fprojects%3Fview%3Dmine' },
    }))
    await expect(authActions.signInWithGoogleAction(form({ next: '/%252f%252fevil.example' })))
      .rejects.toThrow('TEST_REDIRECT:https://provider.example.test/oauth')
    expect(cloud.signInWithOAuth).toHaveBeenLastCalledWith(expect.objectContaining({
      options: { redirectTo: 'https://bulla.example.test/auth/callback?next=%2Ffeed' },
    }))
  })

  it('stages but never redeems a recovery link on GET, removes secrets from the URL, and forbids non-recovery types', async () => {
    const { GET } = await import('@/app/auth/recovery/route')
    const response = await GET(new NextRequest(`https://bulla.example.test/auth/recovery?token_hash=${TOKEN}&next=https://evil.example`))
    expect(response.headers.get('location')).toBe('https://bulla.example.test/settings/password?recovery=1')
    expect(response.headers.get('location')).not.toContain(TOKEN)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = response.cookies.get(COOKIE)!
    expect(cookie).toMatchObject({ value: TOKEN, httpOnly: true, sameSite: 'lax', path: '/settings/password', maxAge: 600 })
    expect(cloud.verifyOtp).not.toHaveBeenCalled()
    const wrongType = await GET(new NextRequest(`https://bulla.example.test/auth/recovery?token_hash=${TOKEN}&type=signup`))
    expect(wrongType.headers.get('location')).toBe('https://bulla.example.test/reset-password?error=recovery_link')
    expect(wrongType.cookies.get(COOKIE)?.maxAge).toBe(0)
  })

  it('keeps signup/login callback redirects safe and never turns a recovery suffix into reset authority', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    let response = await GET(new NextRequest('https://bulla.example.test/auth/callback?code=fixture&next=/onboarding'))
    expect(response.headers.get('location')).toBe('https://bulla.example.test/onboarding')
    response = await GET(new NextRequest('https://bulla.example.test/auth/callback?code=fixture&next=/%2f%2fevil.example'))
    expect(response.headers.get('location')).toBe('https://bulla.example.test/feed')
    cloud.exchangeCodeForSession.mockResolvedValueOnce({ data: { redirectType: 'recovery' }, error: null })
    response = await GET(new NextRequest('https://bulla.example.test/auth/callback?code=fixture&next=/settings/password'))
    expect(response.headers.get('location')).toBe('https://bulla.example.test/reset-password?error=legacy_link')
    expect(cloud.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(cloud.updateUser).not.toHaveBeenCalled()
  })
})

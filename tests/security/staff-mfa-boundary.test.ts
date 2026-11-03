import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  local: false, configured: true, publicLocal: false,
  getStaffAssurance: vi.fn(), createClient: vi.fn(), createServerClient: vi.fn(),
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(), listFactors: vi.fn(),
  select: vi.fn(), eq: vi.fn(), from: vi.fn(), rpc: vi.fn(),
  enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(),
}))
vi.mock('@/features/auth/staff-assurance', () => ({ getStaffAssurance: mocks.getStaffAssurance }))
vi.mock('@/lib/mode', () => ({
  isLocalMode: () => mocks.local,
  assertNotDeployedInLocalMode: () => {
    if (mocks.publicLocal) throw new Error('Synthetic public-local refusal')
  },
}))
vi.mock('@/lib/env', () => ({
  isSupabaseConfigured: () => mocks.configured,
  publicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://mfa-fixture.supabase.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key-only',
  }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }))

const USER = '11111111-1111-4111-8111-111111111111'
const SESSION = '33333333-3333-4333-8333-333333333333'
const FACTOR = '55555555-5555-4555-8555-555555555555'
const NOW = Date.parse('2026-10-31T12:00:00Z') / 1_000
const TOKEN = 'synthetic-access-token-never-a-real-jwt'
let mfa: typeof import('@/features/auth/staff-mfa')

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER, role: 'authenticated', aud: 'authenticated',
    iss: 'https://mfa-fixture.supabase.invalid/auth/v1',
    session_id: SESSION, iat: NOW - 10, exp: NOW + 600, aal: 'aal2',
    amr: [{ method: 'totp', timestamp: NOW - 5 }], ...overrides,
  }
}
function factors(type = 'totp', status = 'verified') {
  mocks.listFactors.mockResolvedValue({
    data: { all: [{ id: FACTOR, factor_type: type, status, friendly_name: 'Fixture authenticator' }] },
    error: null,
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1_000)
  mocks.local = false
  mocks.configured = true
  mocks.publicLocal = false
  mocks.getStaffAssurance.mockResolvedValue({ state: 'verified', userId: USER })
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: TOKEN, user: { id: 'forged-cookie-user', user_metadata: { role: 'admin' } } } },
    error: null,
  })
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER, is_anonymous: false } }, error: null })
  mocks.getClaims.mockResolvedValue({ data: { claims: claims() }, error: null })
  factors()
  const builder = { select: mocks.select, eq: mocks.eq }
  mocks.select.mockReturnValue(builder)
  mocks.eq.mockResolvedValue({ data: [{ role: 'admin' }], error: null })
  mocks.from.mockReturnValue(builder)
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.createClient.mockResolvedValue({
    auth: {
      getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims,
      mfa: { listFactors: mocks.listFactors, enroll: mocks.enroll, challenge: mocks.challenge, verify: mocks.verify },
    },
    from: mocks.from, rpc: mocks.rpc,
  })
  mfa = await import('@/features/auth/staff-mfa')
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('fresh fail-closed cloud staff assurance boundary', () => {
  it('binds verified subject, owner role and current factors; projects no credentials', async () => {
    expect(await mfa.requireStaffAssurance()).toEqual({
      userId: USER, role: 'admin', verifiedAt: NOW - 5, validUntil: NOW + 295,
    })
    expect(mocks.getUser).toHaveBeenCalledWith(TOKEN)
    expect(mocks.getClaims).toHaveBeenCalledWith(TOKEN)
    expect(mocks.from).toHaveBeenCalledWith('user_roles')
    expect(mocks.select).toHaveBeenCalledWith('role')
    expect(mocks.eq).toHaveBeenCalledWith('user_id', USER)
    expect(mocks.rpc).toHaveBeenCalledWith('staff_session_assured')
    expect(mocks.createServerClient).not.toHaveBeenCalled()
  })

  it('cannot elevate a moderator using cookie or editable metadata claims', async () => {
    mocks.eq.mockResolvedValue({ data: [{ role: 'moderator' }], error: null })
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER, user_metadata: { role: 'admin' } } }, error: null })
    expect(await mfa.requireStaffAssurance()).toMatchObject({ userId: USER, role: 'moderator' })
    mocks.eq.mockResolvedValue({ data: [], error: null })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'not_staff' })
  })

  it.each(['signed_out', 'not_staff', 'unavailable', 'local_unsupported'] as const)(
    'refuses the existing hook state %s without opening a cloud client', async state => {
      mocks.getStaffAssurance.mockResolvedValue({ state, userId: USER })
      await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ name: 'StaffAssuranceError', reason: state })
      expect(mocks.createClient).not.toHaveBeenCalled()
      expect(mocks.rpc).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['wrong_subject', { sub: '22222222-2222-4222-8222-222222222222' }],
    ['wrong_issuer', { iss: 'https://other-project.invalid/auth/v1' }],
    ['wrong_audience', { aud: 'anon' }],
    ['service_role', { role: 'service_role' }],
    ['anonymous', { is_anonymous: true }],
    ['missing_session', { session_id: undefined }],
    ['nil_session', { session_id: '00000000-0000-0000-0000-000000000000' }],
    ['malformed_session', { session_id: 'posted-session' }],
    ['expired_token', { exp: NOW }],
    ['future_token', { iat: NOW + 31 }],
    ['not_yet_valid', { nbf: NOW + 1 }],
    ['invalid_expiry', { exp: 'later' }],
  ])('rejects verified claims with %s', async (_label, overrides) => {
    mocks.getClaims.mockResolvedValue({ data: { claims: claims(overrides as Record<string, unknown>) }, error: null })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'unavailable' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each(['user', 'claims', 'role', 'factors'] as const)('fails closed when %s verification fails', async part => {
    if (part === 'user') mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: 'session_not_found' } })
    if (part === 'claims') mocks.getClaims.mockResolvedValue({ data: null, error: { code: 'bad_jwt' } })
    if (part === 'role') mocks.eq.mockResolvedValue({ data: null, error: { code: '42501' } })
    if (part === 'factors') mocks.listFactors.mockResolvedValue({ data: null, error: { code: 'provider_unavailable' } })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ name: 'StaffAssuranceError' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each(['totp', 'mfa/totp', 'webauthn', 'mfa/webauthn'])('accepts a fresh provider-owned %s method', async method => {
    factors(method.includes('webauthn') ? 'webauthn' : 'totp')
    mocks.getClaims.mockResolvedValue({ data: { claims: claims({ amr: [{ method, timestamp: NOW }] }) }, error: null })
    expect(await mfa.requireStaffAssurance()).toMatchObject({ verifiedAt: NOW, validUntil: NOW + 300 })
  })

  it.each([-300, 30])('matches the 300-second age and 30-second future-skew boundary (%s)', async offset => {
    mocks.getClaims.mockResolvedValue({ data: { claims: claims({ amr: [{ method: 'totp', timestamp: NOW + offset }] }) }, error: null })
    expect(await mfa.requireStaffAssurance()).toMatchObject({ verifiedAt: NOW + offset })
  })

  it.each([
    [{ method: 'totp', timestamp: NOW - 301 }],
    [{ method: 'totp', timestamp: NOW + 31 }],
    [{ method: 'totp', timestamp: String(NOW) }],
    [{ method: 'totp', timestamp: Number.NaN }],
    [{ method: 'totp', timestamp: Number.POSITIVE_INFINITY }],
    [{ method: 'totp', timestamp: NOW + 0.5 }],
    [{ method: 'password', timestamp: NOW }],
    [{ method: 'mfa/phone', timestamp: NOW }],
    'totp',
  ])('rejects missing, stale, unaccepted or untimed AMR proof (%j)', async entry => {
    mocks.getClaims.mockResolvedValue({ data: { claims: claims({ iat: NOW, amr: [entry] }) }, error: null })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('does not turn a refreshed JWT into fresh MFA or trust a removed factor', async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: claims({ iat: NOW, amr: [{ method: 'totp', timestamp: NOW - 600 }] }) }, error: null })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
    mocks.getClaims.mockResolvedValue({ data: { claims: claims() }, error: null })
    factors('totp', 'unverified')
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
    factors('phone', 'verified')
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
  })

  it.each([false, null, 1, 'true', [], {}])('requires strict true from the live session RPC (%j)', async data => {
    mocks.rpc.mockResolvedValue({ data, error: null })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
  })

  it('fails closed on missing 0033 or an RPC outage without exposing raw errors', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'synthetic-sensitive-provider-detail' } })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'unavailable' })
    mocks.rpc.mockRejectedValue(new Error('synthetic-sensitive-provider-detail'))
    await expect(mfa.requireStaffAssurance()).rejects.not.toThrow('synthetic-sensitive-provider-detail')
  })

  it('rechecks every call and refuses when MFA expires while the RPC is in flight', async () => {
    await mfa.requireStaffAssurance()
    mocks.rpc.mockImplementationOnce(async () => {
      vi.setSystemTime((NOW + 301) * 1_000)
      return { data: true, error: null }
    })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'mfa_required' })
    expect(mocks.createClient).toHaveBeenCalledTimes(2)
    expect(mocks.getStaffAssurance).toHaveBeenCalledTimes(2)
  })
})

describe('staff settings read-only projections and private-local truthfulness', () => {
  it('does not create a factor/challenge on GET and cannot unlock backup enrollment without live assurance', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    expect(await mfa.getStaffMfaSettings()).toEqual({
      state: 'cloud', assured: false, assuranceUnavailable: true, canEnroll: false,
      hasOtherFactors: false,
      factors: [{ id: FACTOR, name: 'Fixture authenticator', status: 'verified' }],
    })
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.challenge).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('permits first enrollment without claiming AAL2 for an unfinished factor', async () => {
    factors('totp', 'unverified')
    mocks.getClaims.mockResolvedValue({ data: { claims: claims({ aal: 'aal1', amr: [] }) }, error: null })
    expect(await mfa.getStaffMfaSettings()).toMatchObject({ state: 'cloud', canEnroll: true, assured: false })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('reports local MFA unavailable and never presents it as a cloud assurance grant', async () => {
    mocks.local = true
    mocks.getStaffAssurance.mockResolvedValue({ state: 'local_unsupported', userId: 'usr_fixture' })
    expect(await mfa.getStaffMfaSettings()).toEqual({ state: 'local_unsupported' })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'local_unsupported' })
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('refuses prohibited public-local serving before reading even the staff hook', async () => {
    mocks.local = true
    mocks.publicLocal = true
    expect(await mfa.getStaffMfaSettings()).toEqual({ state: 'unavailable' })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'unavailable' })
    expect(mocks.getStaffAssurance).not.toHaveBeenCalled()
  })

  it('does not open a cloud client when the provider is unconfigured', async () => {
    mocks.configured = false
    expect(await mfa.getStaffMfaSettings()).toEqual({ state: 'unavailable' })
    await expect(mfa.requireStaffAssurance()).rejects.toMatchObject({ reason: 'unavailable' })
    expect(mocks.createClient).not.toHaveBeenCalled()
  })
})

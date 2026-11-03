import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({
  local: false, configured: true,
  createClient: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  select: vi.fn(), eq: vi.fn(), getLocalUser: vi.fn(), readStore: vi.fn(),
}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => state.local }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => state.configured }))
vi.mock('@/lib/supabase/server', () => ({ createClient: state.createClient }))
vi.mock('@/lib/local/session', () => ({ getLocalUser: state.getLocalUser }))
vi.mock('@/lib/local/db', () => ({ readStore: state.readStore }))

const USER = '11111111-1111-4111-8111-111111111111'
let assurance: typeof import('@/features/auth/staff-assurance')['getStaffAssurance']

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  state.local = false
  state.configured = true
  const builder = { select: state.select, eq: state.eq }
  state.select.mockReturnValue(builder)
  state.eq.mockResolvedValue({ data: [{ role: 'admin' }], error: null })
  state.createClient.mockResolvedValue({
    auth: { getUser: state.getUser, getClaims: state.getClaims },
    from: vi.fn().mockReturnValue(builder),
  })
  state.getUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
  state.getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } }, error: null })
  assurance = (await import('@/features/auth/staff-assurance')).getStaffAssurance
})
afterEach(() => { vi.restoreAllMocks() })

describe('reusable staff assurance hook without gating ordinary user routes', () => {
  it('requires a verified aal2 claim for an owner-scoped staff role', async () => {
    expect(await assurance()).toEqual({ state: 'verified', userId: USER })
    expect(state.eq).toHaveBeenCalledWith('user_id', USER)
    state.getClaims.mockResolvedValueOnce({ data: { claims: { sub: USER, aal: 'aal1' } }, error: null })
    expect(await assurance()).toEqual({ state: 'mfa_required', userId: USER })
  })

  it('does not trust an editable role in user_metadata or require MFA for a regular user', async () => {
    state.getUser.mockResolvedValueOnce({ data: { user: { id: USER, user_metadata: { role: 'admin' } } }, error: null })
    state.eq.mockResolvedValueOnce({ data: [], error: null })
    expect(await assurance()).toEqual({ state: 'not_staff', userId: USER })
    expect(state.getClaims).not.toHaveBeenCalled()
  })

  it.each(['role_error', 'claims_error', 'wrong_subject', 'network'] as const)('fails closed on %s', async (kind) => {
    if (kind === 'role_error') state.eq.mockResolvedValueOnce({ data: null, error: { code: '42501' } })
    if (kind === 'claims_error') state.getClaims.mockResolvedValueOnce({ data: null, error: { code: 'bad_jwt' } })
    if (kind === 'wrong_subject') state.getClaims.mockResolvedValueOnce({ data: { claims: { sub: 'other', aal: 'aal2' } }, error: null })
    if (kind === 'network') state.createClient.mockRejectedValueOnce(new Error('Fixture outage'))
    expect(await assurance()).toEqual({ state: 'unavailable' })
  })

  it('cannot grant assurance to an anonymous session or unconfigured provider', async () => {
    state.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    expect(await assurance()).toEqual({ state: 'signed_out' })
    state.configured = false
    expect(await assurance()).toEqual({ state: 'unavailable' })
  })

  it('reports local staff MFA as unsupported rather than verified', async () => {
    state.local = true
    state.getLocalUser.mockResolvedValue({ id: 'usr_fixture' })
    state.readStore.mockResolvedValue({ user_roles: [{ user_id: 'usr_fixture', role: 'admin' }] })
    expect(await assurance()).toEqual({ state: 'local_unsupported', userId: 'usr_fixture' })
    expect(state.createClient).not.toHaveBeenCalled()
  })
})

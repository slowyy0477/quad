import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('server-only', () => ({}))
const configuration = vi.hoisted(() => ({ local: false, configured: true }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => configuration.local }))
vi.mock('@/lib/env', () => ({
  isSupabaseConfigured: () => configuration.configured,
  publicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://provider.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key',
  }),
}))
vi.mock('@/features/auth/actions', () => ({ signInWithGoogleAction: vi.fn() }))
let getCapabilities: typeof import('@/features/auth/providers')['getAuthCapabilities']

beforeEach(async () => {
  vi.resetModules()
  configuration.local = false
  configuration.configured = true
  vi.stubEnv('BULLA_RECOVERY_EMAIL_TEMPLATE', 'token_hash')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ external: { google: true, email: true } }),
  }))
  getCapabilities = (await import('@/features/auth/providers')).getAuthCapabilities
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('actual auth provider availability', () => {
  it('does not contact or enable cloud providers in local mode, even with configured credentials', async () => {
    configuration.local = true
    expect(await getCapabilities()).toMatchObject({
      status: 'local', password: true, google: false, emailRecovery: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not equate missing credentials with working providers', async () => {
    configuration.configured = false
    expect(await getCapabilities()).toMatchObject({
      status: 'unconfigured', password: false, google: false, emailRecovery: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads real public provider settings without caching a user session', async () => {
    expect(await getCapabilities()).toEqual({
      status: 'configured', password: true, google: true, emailRecovery: true, recoveryUnavailableReason: null,
    })
    expect(fetch).toHaveBeenCalledWith('https://provider.example.test/auth/v1/settings', expect.objectContaining({
      headers: { apikey: 'synthetic-public-anon-key' }, cache: 'no-store', signal: expect.any(AbortSignal),
    }))
  })

  it('requires an explicit configured one-time recovery template, not just an anon key', async () => {
    vi.stubEnv('BULLA_RECOVERY_EMAIL_TEMPLATE', '')
    expect(await getCapabilities()).toMatchObject({
      google: true, emailRecovery: false, recoveryUnavailableReason: expect.stringContaining('template has not been configured'),
    })
  })

  it('keeps disabled Google/email providers unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ external: { google: false, email: false } }),
    } as Response)
    expect(await getCapabilities()).toMatchObject({
      status: 'configured', password: false, google: false, emailRecovery: false,
      recoveryUnavailableReason: expect.stringContaining('disabled'),
    })
  })

  it.each(['error', 'http', 'malformed'] as const)('fails closed when provider settings return %s', async (kind) => {
    if (kind === 'error') vi.mocked(fetch).mockRejectedValueOnce(new Error('Fixture network failure'))
    if (kind === 'http') vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response)
    if (kind === 'malformed') vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
    expect(await getCapabilities()).toMatchObject({
      status: 'unreachable', google: false, emailRecovery: false,
    })
  })

  it('renders no Google button when the actual provider is disabled', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ external: { google: false, email: true } }),
    } as Response)
    const { GoogleSignInButton } = await import('@/features/auth/components/google-sign-in-button')
    const element = await GoogleSignInButton({ next: '/onboarding' })
    expect(element.type).toBe('p')
    expect(element.props.children).toContain('not enabled')
  })

  it('renders a real Google form only when public provider settings enable it', async () => {
    const { GoogleSignInButton } = await import('@/features/auth/components/google-sign-in-button')
    expect((await GoogleSignInButton({ next: '/feed' })).type).toBe('form')
  })
})

describe('local Supabase password/confirmation/TOTP/recovery configuration', () => {
  it('records 15-character minimum, confirmations, reauthentication and TOTP without a paid tool', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const config = readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8')
    expect(config).toMatch(/^minimum_password_length = 15$/m)
    const email = config.split('[auth.email]')[1].split('\n[')[0]
    expect(email).toMatch(/^enable_confirmations = true$/m)
    expect(email).toMatch(/^secure_password_change = true$/m)
    const totp = config.split('[auth.mfa.totp]')[1].split('\n[')[0]
    expect(totp).toMatch(/^enroll_enabled = true$/m)
    expect(totp).toMatch(/^verify_enabled = true$/m)
    const template = config.split('[auth.email.template.recovery]')[1].split('\n[')[0]
    const templatePath = template.match(/^content_path = "([^"]+)"$/m)![1]
    expect(existsSync(path.resolve(root, templatePath))).toBe(true)
    const html = readFileSync(path.resolve(root, templatePath), 'utf8')
    expect(html).toContain('/auth/recovery?token_hash={{ .TokenHash }}')
    expect(html).toContain('type=recovery')
    expect(html).not.toContain('{{ .ConfirmationURL }}')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('data configuration without provider confusion', () => {
  it('enables local screens without pretending Supabase is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
    vi.resetModules()
    const env = await import('./env')
    expect(env.isDataConfigured()).toBe(true)
    expect(env.isSupabaseConfigured()).toBe(false)
    expect(env.publicEnv).toThrow('Supabase is not configured')
  })

  it('does not enable an unconfigured hosted deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
    vi.resetModules()
    const env = await import('./env')
    expect(env.isDataConfigured()).toBe(false)
  })
})

async function configuredEnvironment({
  origin = '', mode = 'supabase', production = true, configured = true,
}: { origin?: string; mode?: string; production?: boolean; configured?: boolean } = {}) {
  vi.stubEnv('NODE_ENV', production ? 'production' : 'development')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', mode)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', configured ? 'https://fixture.supabase.co' : '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', configured ? 'synthetic-public-key-for-config-test' : '')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin)
  vi.resetModules()
  return import('./env')
}

describe('canonical deployment origin without unsafe production fallback', () => {
  it('requires explicit production cloud origin even when an automatic host URL exists', async () => {
    vi.stubEnv('VERCEL_URL', 'fixture-host.example.test')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'other-fixture.example.test')
    const env = await configuredEnvironment()
    expect(env.isSupabaseConfigured()).toBe(true)
    expect(env.siteUrl).toThrow('NEXT_PUBLIC_SITE_URL is required')
  })

  it('accepts the explicit production HTTPS origin', async () => {
    const env = await configuredEnvironment({ origin: 'https://bulla.example.test' })
    expect(env.siteUrl()).toBe('https://bulla.example.test')
  })

  it('rejects HTTP for configured production cloud flows', async () => {
    const env = await configuredEnvironment({ origin: 'http://bulla.example.test' })
    expect(env.siteUrl).toThrow('requires HTTPS')
  })

  it.each([
    'https://user:private-fixture@bulla.example.test',
    'https://bulla.example.test/path',
    'https://bulla.example.test?query=private-fixture',
    'https://bulla.example.test#private-fixture',
    'ftp://bulla.example.test',
    'not-a-url-private-fixture',
  ])('rejects non-origin configuration without exposing its value (%s)', async origin => {
    const env = await configuredEnvironment({ origin })
    expect(env.siteUrl).toThrow('canonical origin')
    try { env.siteUrl() } catch (error) {
      expect((error as Error).message).not.toContain('private-fixture')
    }
  })

  it('keeps HTTP origin available for development', async () => {
    const env = await configuredEnvironment({ origin: 'http://127.0.0.1:3301', production: false })
    expect(env.siteUrl()).toBe('http://127.0.0.1:3301')
  })

  it('preserves explicitly private local production previews', async () => {
    const env = await configuredEnvironment({ origin: 'http://127.0.0.1:3000', mode: 'local', configured: false })
    expect(env.siteUrl()).toBe('http://127.0.0.1:3000')
  })

  it('lets unconfigured setup render without claiming a usable cloud origin', async () => {
    const env = await configuredEnvironment({ configured: false })
    expect(env.isSupabaseConfigured()).toBe(false)
    expect(env.siteUrl()).toBe('http://localhost:3000')
  })
})

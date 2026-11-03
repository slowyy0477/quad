import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
// The installed 16.4.3 API retains this legacy export despite the Proxy docs.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from 'next/experimental/testing/server'

const provider = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getUser: vi.fn(),
}))
vi.mock('@supabase/ssr', () => ({ createServerClient: provider.createServerClient }))
import { config, proxy } from '../../src/proxy'

const ORIGIN = 'https://bulla.example.test'
const PRIVATE_CANARY = 'synthetic-diagnostic-secret-never-render'
const PATHS = [
  '/status', '/status/', '/status?probe=1',
  '/setup', '/setup/', '/setup?_rsc=synthetic',
  '/status.rsc', '/setup.rsc',
  '/status.segments/_full.segment.rsc', '/setup.segments/_tree.segment.rsc',
]
const TRANSPORTS: { name: string; headers: Record<string, string> }[] = [
  { name: 'HTML or stripped Flight headers', headers: {} },
  { name: 'Flight', headers: { RSC: '1' } },
  { name: 'prefetch', headers: { RSC: '1', 'Next-Router-Prefetch': '1' } },
  { name: 'segment prefetch', headers: { RSC: '1', 'Next-Router-Segment-Prefetch': '/_tree' } },
]

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic-provider.example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', PRIVATE_CANARY)
  provider.getUser.mockResolvedValue({ data: { user: null }, error: null })
  provider.createServerClient.mockReturnValue({ auth: { getUser: provider.getUser } })
})

afterEach(() => vi.unstubAllEnvs())

function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest(`${ORIGIN}${path}`, { method, headers })
}

async function denied(incoming: NextRequest) {
  const response = await proxy(incoming)
  expect(response.status).toBe(404)
  expect(response.headers.get('x-middleware-next')).toBeNull()
  expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('content-security-policy')).toMatch(/'nonce-[A-Za-z0-9+/]{24}'/)
  expect(response.headers.get('set-cookie')).toBeNull()
  const body = await response.text()
  if (incoming.method === 'HEAD') expect(body).toBe('')
  else {
    expect(body).toContain('<h1>There is nothing at this address</h1>')
    expect(body).toContain('href="/"')
    expect(body).toContain('href="/help"')
    expect(body).not.toMatch(/build status|tracked features|hosted environment variables|SUPABASE_SERVICE_ROLE_KEY|href="\/(?:status|setup)"/i)
    expect(body).not.toContain(PRIVATE_CANARY)
  }
  expect(provider.createServerClient).not.toHaveBeenCalled()
  expect(provider.getUser).not.toHaveBeenCalled()
}

describe('diagnostic requests are denied before rendering or provider access', () => {
  it.each(TRANSPORTS.flatMap(transport => PATHS.map(path => ({ ...transport, path }))))(
    'returns a hard 404 for $name $path',
    async ({ path, headers }) => {
      expect(doesProxyMatch({ config, nextConfig: {}, url: `${ORIGIN}${path}`, headers })).toBe(true)
      await denied(request(path, headers))
    },
  )

  it.each(['test', 'unknown', undefined])('also fails closed for NODE_ENV %s', async environment => {
    vi.stubEnv('NODE_ENV', environment)
    await denied(request('/status'))
    await denied(request('/setup', { RSC: '1' }))
  })

  it.each(['HEAD', 'POST', 'OPTIONS'])('refuses %s without reaching any action', async method => {
    await denied(request('/status', { origin: 'https://attacker.example.test' }, method))
    await denied(request('/setup', { 'Next-Action': 'synthetic-action' }, method))
  })

  it('does not disclose missing configuration on an unconfigured diagnostic URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined)
    await denied(request('/setup'))
  })

  it('does not derive diagnostic access from a cookie or claimed staff header', async () => {
    await denied(request('/status', {
      cookie: 'claimed-admin=1', 'x-user-role': 'admin', authorization: 'Bearer synthetic-token',
    }))
  })

  it('retains fresh CSP nonces on refused requests', async () => {
    const first = await proxy(request('/status'))
    const second = await proxy(request('/status'))
    expect(first.headers.get('content-security-policy')).not.toBe(second.headers.get('content-security-policy'))
  })

  it.each(PATHS)('retains explicit development access to %s', async path => {
    vi.stubEnv('NODE_ENV', 'development')
    const response = await proxy(request(path))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['/', '/help', '/status-board', '/setup-guide'])('does not block unrelated public path %s', async path => {
    const response = await proxy(request(path))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })
})

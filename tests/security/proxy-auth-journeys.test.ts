import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { CookieMethodsServer, CookieOptions } from '@supabase/ssr'

const provider = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getUser: vi.fn(),
}))
vi.mock('@supabase/ssr', () => ({ createServerClient: provider.createServerClient }))
import { proxy } from '../../src/proxy'

const SITE_ORIGIN = 'https://bulla.example.test'
const PROVIDER_URL = 'https://synthetic-provider.example.test'
const PUBLIC_KEY = 'synthetic-public-key-for-proxy-tests'
const RECOVERY_COOKIE = 'bulla_password_recovery'
const RECOVERY_TOKEN = `pkce_${'a1'.repeat(32)}`
const STAGED_COOKIE = `${RECOVERY_COOKIE}=${RECOVERY_TOKEN}`
const AUTH_COOKIE = 'sb-synthetic-auth-token'
const AUTH_CACHE_HEADERS = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Expires: '0',
  Pragma: 'no-cache',
}
type CookieUpdate = { name: string; value: string; options: CookieOptions }
type CookieSnapshot = Awaited<ReturnType<CookieMethodsServer['getAll']>>
let cookieMethods: CookieMethodsServer | undefined

beforeEach(() => {
  vi.resetAllMocks()
  cookieMethods = undefined
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROVIDER_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', PUBLIC_KEY)
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', SITE_ORIGIN)
  vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', undefined)
  vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', undefined)
  vi.stubEnv('BULLA_REQUIRE_HTTPS', undefined)
  vi.stubEnv('QUAD_REQUIRE_HTTPS', undefined)
  vi.stubEnv('__NEXT_NO_MIDDLEWARE_URL_NORMALIZE', undefined)
  provider.createServerClient.mockImplementation((
    _url: string, _key: string, options: { cookies: CookieMethodsServer },
  ) => {
    cookieMethods = options.cookies
    return { auth: { getUser: provider.getUser } }
  })
  provider.getUser.mockResolvedValue({ data: { user: null }, error: null })
})

afterEach(() => {
  cookieMethods = undefined
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function request(path: string, init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {}, servingOrigin = SITE_ORIGIN) {
  // No browser jar, owner environment file, network client or shared fixture.
  const headers = new Headers({ host: new URL(servingOrigin).host, cookie: '' })
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  return new NextRequest(`${servingOrigin}${path}`, { ...init, headers })
}

function privatePolicy(response: NextResponse) {
  expect(response).toBeInstanceOf(NextResponse)
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('content-security-policy')).toMatch(/'nonce-[A-Za-z0-9+/]{24}'/)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
}

function passesThrough(response: NextResponse) {
  privatePolicy(response)
  expect(response.status).toBe(200)
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('location')).toBeNull()
}

function loginRedirect(response: NextResponse, incoming: NextRequest) {
  privatePolicy(response)
  expect(response.status).toBe(307)
  expect(response.headers.get('x-middleware-next')).toBeNull()
  const target = new URL(response.headers.get('location')!)
  expect(target.origin).toBe(incoming.nextUrl.origin)
  // NextURL preserves trailing-slash formatting when cloning a URL.
  expect(target.pathname.replace(/\/$/, '')).toBe('/login')
  expect([...target.searchParams.keys()]).toEqual(['next'])
  expect(target.searchParams.get('next')).toBe(`${incoming.nextUrl.pathname}${incoming.nextUrl.search}`)
}

function ssrCookies() {
  if (!cookieMethods?.setAll) throw new Error('The mocked SSR client did not receive its cookie bridge.')
  return { getAll: cookieMethods.getAll, setAll: cookieMethods.setAll }
}

describe('signed-out password entry is not settings authorization', () => {
  it.each(['GET', 'HEAD'])('admits the exact staged recovery entry on %s without consuming its token', async method => {
    const incoming = request('/settings/password?recovery=1', {
      method, headers: { cookie: STAGED_COOKIE },
    })
    const response = await proxy(incoming)
    passesThrough(response)
    expect(incoming.cookies.get(RECOVERY_COOKIE)?.value).toBe(RECOVERY_TOKEN)
    expect(await ssrCookies().getAll()).toEqual([{ name: RECOVERY_COOKIE, value: RECOVERY_TOKEN }])
    expect(response.cookies.getAll()).toEqual([])
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
    expect(provider.createServerClient).toHaveBeenCalledWith(PROVIDER_URL, PUBLIC_KEY, {
      cookies: { getAll: expect.any(Function), setAll: expect.any(Function) },
    })
  })

  it.each([false, true])('admits same-origin recovery POST with Next-Action header %s', async actionHeader => {
    const headers = new Headers({
      origin: SITE_ORIGIN, cookie: STAGED_COOKIE,
      'content-type': 'application/x-www-form-urlencoded',
    })
    if (actionHeader) headers.set('next-action', 'synthetic-recovery-action')
    const incoming = request('/settings/password?recovery=1', {
      method: 'POST', headers, body: '$ACTION_ID_fixture=&password=synthetic',
    })
    passesThrough(await proxy(incoming))
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
    expect(incoming.cookies.get(RECOVERY_COOKIE)?.value).toBe(RECOVERY_TOKEN)
  })

  it.each(['GET', 'HEAD'])('admits only read-only changed receipts on %s after sign-out', async method => {
    passesThrough(await proxy(request('/settings/password?changed=1', { method })))
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([undefined, 'not-a-provider-token', RECOVERY_TOKEN].flatMap(
    token => ['GET', 'HEAD', 'POST'].map(method => ({ token, method })),
  ))(
    'delegates $method recovery without deriving identity from cookie $token',
    async ({ token, method }) => {
      const headers = { origin: SITE_ORIGIN, cookie: token ? `${RECOVERY_COOKIE}=${token}` : '' }
      passesThrough(await proxy(request('/settings/password?recovery=1', { method, headers })))
      const settings = request('/settings/password', { method, headers })
      loginRedirect(await proxy(settings), settings)
      expect(provider.getUser).toHaveBeenCalledTimes(2)
    },
  )

  it('retains the scalar entry when Next appends its RSC query parameter', async () => {
    passesThrough(await proxy(request('/settings/password?recovery=1&_rsc=synthetic', {
      headers: { cookie: STAGED_COOKIE },
    })))
  })

  it.each([
    '/settings', '/settings/password', '/settings/security?recovery=1',
    '/settings/account?changed=1', '/settings/password/?recovery=1',
    '/settings/password/child?recovery=1', '/settings/password-reset?recovery=1',
    '/settings/Password?recovery=1', '/feed?recovery=1',
    '/messages?changed=1', '/admin?recovery=1', '/me?changed=1',
  ].flatMap(path => ['GET', 'HEAD', 'POST'].map(method => ({ path, method }))))(
    'keeps private/noncanonical $path private on $method even with a staged token',
    async ({ path, method }) => {
      const incoming = request(path, { method, headers: { origin: SITE_ORIGIN, cookie: STAGED_COOKIE } })
      loginRedirect(await proxy(incoming), incoming)
      expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it.each([
    'recovery', 'recovery=0', 'recovery=true', 'recovery=01', 'Recovery=1',
    'recovery=1&recovery=1', 'recovery=1&recovery=0', 'recovery=0&recovery=1',
    'changed', 'changed=0', 'changed=true', 'changed=01',
    'changed=1&changed=1', 'changed=1&changed=0', 'changed=0&changed=1',
    'recovery=1&changed=1', 'changed=1&recovery=1',
    'recovery=1&changed=0', 'changed=1&recovery=0', 'recovery=1&changed', 'changed=1&recovery',
  ].flatMap(query => ['GET', 'HEAD', 'POST'].map(method => ({ query, method }))))(
    'does not admit ambiguous/noncanonical flags $query on $method',
    async ({ query, method }) => {
      const incoming = request(`/settings/password?${query}`, {
        method, headers: { origin: SITE_ORIGIN, cookie: STAGED_COOKIE },
      })
      loginRedirect(await proxy(incoming), incoming)
    },
  )

  it.each([
    ...['OPTIONS', 'PUT', 'PATCH', 'DELETE'].map(method => ({ flag: 'recovery', method })),
    ...['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ flag: 'changed', method })),
  ])('does not admit signed-out $method for the $flag entry', async ({ flag, method }) => {
    const incoming = request(`/settings/password?${flag}=1`, {
      method, headers: { origin: SITE_ORIGIN, cookie: STAGED_COOKIE, 'next-action': 'synthetic-action' },
    })
    loginRedirect(await proxy(incoming), incoming)
  })

  it.each([
    { path: '/settings/password', method: 'GET' },
    { path: '/settings/password', method: 'HEAD' },
    { path: '/settings/password', method: 'POST' },
    { path: '/settings/password?changed=1', method: 'POST' },
  ])('retains normal provider-user authorization for $method $path', async ({ path, method }) => {
    provider.getUser.mockResolvedValueOnce({ data: { user: { id: 'synthetic-verified-user' } }, error: null })
    passesThrough(await proxy(request(path, { method, headers: { origin: SITE_ORIGIN } })))
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('recovery POST keeps origin/CSRF enforcement', () => {
  it.each([
    undefined, '', 'null', 'https://attacker.example.test',
    'http://bulla.example.test', `${SITE_ORIGIN}/`, 'https://bulla.example.test.attacker.test',
  ])('refuses missing/invalid/nonmatching Origin %s before SSR or actions', async origin => {
    const headers = new Headers({ cookie: STAGED_COOKIE, 'next-action': 'synthetic-action' })
    if (origin !== undefined) headers.set('origin', origin)
    const response = await proxy(request('/settings/password?recovery=1', { method: 'POST', headers }))
    privatePolicy(response)
    expect(response.status).toBe(403)
    expect(response.headers.get('x-middleware-next')).toBeNull()
    expect(provider.createServerClient).not.toHaveBeenCalled()
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('does not trust forwarded authority, Referer or an action header to allow a recovery write', async () => {
    const response = await proxy(request('/settings/password?recovery=1', {
      method: 'POST',
      headers: {
        cookie: STAGED_COOKIE, origin: 'https://attacker.example.test',
        'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'https',
        referer: `${SITE_ORIGIN}/settings/password?recovery=1`, 'next-action': 'synthetic-action',
      },
    }))
    expect(response.status).toBe(403)
    expect(provider.createServerClient).not.toHaveBeenCalled()
  })

  it.each(['/settings/password?changed=1', '/settings/password', '/feed'])(
    'retains cross-origin write refusal for %s',
    async path => {
      const response = await proxy(request(path, {
        method: 'POST', headers: { origin: 'https://attacker.example.test', cookie: STAGED_COOKIE },
      }))
      expect(response.status).toBe(403)
      expect(response.headers.get('x-middleware-next')).toBeNull()
      expect(provider.getUser).not.toHaveBeenCalled()
    },
  )
})

const COOKIE_EXPIRY = new Date('2030-01-02T03:04:05.000Z')
const FINAL_COOKIE_OPTIONS: CookieOptions = {
  path: '/', domain: 'bulla.example.test', secure: true, httpOnly: true,
  sameSite: 'lax', expires: COOKIE_EXPIRY, priority: 'high',
}
const FIRST_BATCH: CookieUpdate[] = [
  {
    name: `${AUTH_COOKIE}.0`, value: 'first-access-chunk',
    options: { ...FINAL_COOKIE_OPTIONS, sameSite: 'strict', priority: 'low' },
  },
  {
    name: `${AUTH_COOKIE}.old`, value: '',
    options: { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 0, expires: new Date(0) },
  },
]
const SECOND_BATCH: CookieUpdate[] = [
  {
    name: `${AUTH_COOKIE}.1`, value: 'fresh-second-chunk',
    options: { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 900 },
  },
  { name: `${AUTH_COOKIE}.0`, value: 'latest-access-chunk', options: FINAL_COOKIE_OPTIONS },
]

function refreshingUser(user: { id: string } | null) {
  const snapshots: CookieSnapshot[] = []
  provider.getUser.mockImplementation(async () => {
    const bridge = ssrCookies()
    snapshots.push(await bridge.getAll())
    for (const batch of [FIRST_BATCH, SECOND_BATCH, []]) {
      await bridge.setAll(batch, AUTH_CACHE_HEADERS)
      snapshots.push(await bridge.getAll())
    }
    return { data: { user }, error: null }
  })
  return snapshots
}

function refreshedCookies(response: NextResponse) {
  expect(response.cookies.getAll().map(cookie => cookie.name).sort()).toEqual([
    `${AUTH_COOKIE}.0`, `${AUTH_COOKIE}.1`, `${AUTH_COOKIE}.old`,
  ].sort())
  expect(response.cookies.get(`${AUTH_COOKIE}.0`)).toEqual({
    name: `${AUTH_COOKIE}.0`, value: 'latest-access-chunk', ...FINAL_COOKIE_OPTIONS,
  })
  expect(response.cookies.get(`${AUTH_COOKIE}.1`)).toMatchObject({
    name: `${AUTH_COOKIE}.1`, value: 'fresh-second-chunk',
    path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 900, expires: expect.any(Date),
  })
  expect(response.cookies.get(`${AUTH_COOKIE}.old`)).toEqual({
    name: `${AUTH_COOKIE}.old`, value: '',
    path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 0, expires: new Date(0),
  })
  const serialized = response.headers.get('set-cookie')!
  expect(serialized).toContain(`${AUTH_COOKIE}.0=latest-access-chunk`)
  expect(serialized).toContain(`${AUTH_COOKIE}.1=fresh-second-chunk`)
  expect(serialized).toContain(`${AUTH_COOKIE}.old=`)
  expect(serialized).toContain('Max-Age=0')
  expect(serialized).toContain('HttpOnly')
  expect(serialized).toContain('Secure')
}

describe('SSR refreshed cookies survive response replacement', () => {
  it('cumulatively forwards cookies and existing request headers with the same fresh nonce', async () => {
    const snapshots = refreshingUser(null)
    const incoming = request('/settings/password?recovery=1', {
      headers: {
        cookie: `${STAGED_COOKIE}; untouched=keep; ${AUTH_COOKIE}.0=stale; ${AUTH_COOKIE}.old=obsolete`,
        'x-nonce': 'untrusted-client-nonce', 'x-test-context': 'synthetic-request',
      },
    })
    const response = await proxy(incoming)
    passesThrough(response)
    refreshedCookies(response)
    const nonce = response.headers.get('x-middleware-request-x-nonce')
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/)
    expect(nonce).not.toBe('untrusted-client-nonce')
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
    expect(response.headers.get('x-middleware-request-content-security-policy'))
      .toBe(response.headers.get('content-security-policy'))
    expect(response.headers.get('x-middleware-request-x-test-context')).toBe('synthetic-request')
    expect(response.headers.get('x-test-context')).toBeNull()
    expect(response.headers.get('x-middleware-request-cookie')).toBe(incoming.headers.get('cookie'))
    expect(response.headers.get('x-middleware-override-headers')?.split(','))
      .toEqual(expect.arrayContaining(['cookie', 'x-test-context', 'x-nonce', 'content-security-policy']))
    expect(snapshots[0]).toEqual(expect.arrayContaining([
      { name: 'untouched', value: 'keep' }, { name: `${AUTH_COOKIE}.0`, value: 'stale' },
    ]))
    expect(snapshots[1]).toEqual(expect.arrayContaining([
      { name: `${AUTH_COOKIE}.0`, value: 'first-access-chunk' }, { name: `${AUTH_COOKIE}.old`, value: '' },
    ]))
    expect(snapshots[2]).toEqual(expect.arrayContaining([
      { name: RECOVERY_COOKIE, value: RECOVERY_TOKEN }, { name: 'untouched', value: 'keep' },
      { name: `${AUTH_COOKIE}.0`, value: 'latest-access-chunk' },
      { name: `${AUTH_COOKIE}.1`, value: 'fresh-second-chunk' }, { name: `${AUTH_COOKIE}.old`, value: '' },
    ]))
    expect(snapshots[3]).toEqual(snapshots[2])
    expect(incoming.cookies.get('untouched')?.value).toBe('keep')
  })

  it.each([
    { path: '/settings/security?tab=sessions', user: null, target: '/login' },
    { path: '/login?next=/admin', user: { id: 'synthetic-verified-user' }, target: '/feed' },
    { path: '/signup?next=/me', user: { id: 'synthetic-verified-user' }, target: '/feed' },
  ])('keeps all batches/options on the $path redirect to $target', async ({ path, user, target }) => {
    refreshingUser(user)
    const incoming = request(path, { headers: { cookie: 'untouched=keep' } })
    const response = await proxy(incoming)
    privatePolicy(response)
    refreshedCookies(response)
    expect(response.headers.get('x-middleware-next')).toBeNull()
    if (target === '/login') loginRedirect(response, incoming)
    else {
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe(`${SITE_ORIGIN}/feed`)
    }
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('canonical HTTPS origin is required only for configured production cloud serving', () => {
  it.each([
    undefined, '', 'not-an-origin', 'http://bulla.example.test', `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}/auth`, `${SITE_ORIGIN}?query=1`, `${SITE_ORIGIN}#fragment`,
    'https://user:password@bulla.example.test', 'https://bulla.example.test:443',
    ` ${SITE_ORIGIN}`, 'HTTPS://bulla.example.test',
  ].flatMap(configuredOrigin => ['GET', 'HEAD', 'POST'].map(method => ({ configuredOrigin, method }))))(
    'fails closed for production origin $configuredOrigin on $method',
    async ({ configuredOrigin, method }) => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', configuredOrigin)
      const response = await proxy(request('/settings/password?recovery=1', {
        method, headers: { origin: SITE_ORIGIN, cookie: STAGED_COOKIE },
      }))
      privatePolicy(response)
      expect(response.status).toBe(503)
      expect(response.headers.get('x-middleware-next')).toBeNull()
      expect(provider.createServerClient).not.toHaveBeenCalled()
      expect(provider.getUser).not.toHaveBeenCalled()
    },
  )

  it('also gates a configured cloud client when the data-mode selector is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', undefined)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    expect((await proxy(request('/'))).status).toBe(503)
    expect(provider.createServerClient).not.toHaveBeenCalled()
  })

  it('accepts the canonical external origin over an internal HTTP replica transport', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    passesThrough(await proxy(request('/settings/password?recovery=1', {
      method: 'POST', headers: { origin: SITE_ORIGIN, cookie: STAGED_COOKIE },
    }, 'http://internal-replica:3000')))
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })

  it('does not substitute internal/forwarded authority for the production canonical Origin', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const response = await proxy(request('/settings/password?recovery=1', {
      method: 'POST',
      headers: {
        origin: 'http://internal-replica:3000', cookie: STAGED_COOKIE,
        'x-forwarded-host': 'internal-replica:3000', 'x-forwarded-proto': 'http',
      },
    }, 'http://internal-replica:3000'))
    expect(response.status).toBe(403)
    expect(provider.getUser).not.toHaveBeenCalled()
  })

  it('retains the explicit private local-production preview with no site origin, even with cloud keys present', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '1')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    const response = await proxy(request('/settings', {}, 'http://127.0.0.1:3301'))
    passesThrough(response)
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'")
    expect(response.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests')
    expect(provider.createServerClient).not.toHaveBeenCalled()
  })

  it('still refuses a production local adapter without its explicit private-preview override', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    expect((await proxy(request('/', {}, 'http://127.0.0.1:3301'))).status).toBe(503)
    expect(provider.createServerClient).not.toHaveBeenCalled()
  })

  it.each([
    { providerUrl: undefined, publicKey: PUBLIC_KEY },
    { providerUrl: PROVIDER_URL, publicKey: undefined },
    { providerUrl: undefined, publicKey: undefined },
  ])('does not apply the cloud-serving gate to unconfigured setup $providerUrl/$publicKey', async ({ providerUrl, publicKey }) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', providerUrl)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', publicKey)
    passesThrough(await proxy(request('/setup', {}, 'http://127.0.0.1:3301')))
    expect(provider.createServerClient).not.toHaveBeenCalled()
  })

  it('retains development cloud recovery and real loopback Origin matching without a canonical site setting', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
    const incoming = request('/settings/password?recovery=1', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3301', cookie: STAGED_COOKIE },
    }, 'http://127.0.0.1:3301')
    expect(incoming.nextUrl.hostname).toBe('localhost')
    passesThrough(await proxy(incoming))
    expect(provider.getUser).toHaveBeenCalledExactlyOnceWith()
  })
})

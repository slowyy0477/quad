import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../src/proxy'

afterEach(() => vi.unstubAllEnvs())

function localMode(production = false) {
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('NODE_ENV', production ? 'production' : 'development')
  vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', undefined)
  vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', undefined)
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)
}

describe('request proxy security wiring', () => {
  it('forwards a fresh nonce to rendering and sends the same policy to the browser', async () => {
    localMode()
    const request = () => new NextRequest('http://127.0.0.1:3301/')
    const first = await proxy(request())
    const second = await proxy(request())
    const nonce = first.headers.get('x-middleware-request-x-nonce')
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/)
    expect(second.headers.get('x-middleware-request-x-nonce')).not.toBe(nonce)
    const csp = first.headers.get('content-security-policy')
    expect(csp).toContain(`'nonce-${nonce}'`)
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
    expect(first.headers.get('cache-control')).toContain('private, no-store')
  })

  it('refuses cross-origin writes before they reach a local action', async () => {
    localMode()
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/feed', {
      method: 'POST',
      headers: { origin: 'https://unrelated.example.test' },
    }))
    expect(response.status).toBe(403)
    expect(response.headers.get('x-middleware-next')).toBeNull()
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('accepts a real same-origin loopback POST despite NextURL hostname normalization', async () => {
    localMode()
    const request = new NextRequest('http://127.0.0.1:3301/signup', {
      method: 'POST',
      headers: { host: '127.0.0.1:3301', origin: 'http://127.0.0.1:3301' },
    })
    expect(request.nextUrl.hostname).toBe('localhost')
    expect((await proxy(request)).headers.get('x-middleware-next')).toBe('1')
  })

  it('does not authorize an attacker by trusting a forged forwarded host', async () => {
    localMode()
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/signup', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3301',
        origin: 'https://unrelated.example.test',
        'x-forwarded-host': 'unrelated.example.test',
      },
    }))
    expect(response.status).toBe(403)
  })

  it('rejects malformed authority even if its parsed host would match the origin', async () => {
    localMode()
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/signup', {
      method: 'POST',
      headers: { host: 'attacker@127.0.0.1:3301', origin: 'http://127.0.0.1:3301' },
    }))
    expect(response.status).toBe(403)
  })

  it('uses the configured public origin behind a production reverse proxy', async () => {
    localMode(true)
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '1')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://bulla.example.test')
    const response = await proxy(new NextRequest('http://internal-replica:3000/signup', {
      method: 'POST',
      headers: { host: 'internal-replica:3000', origin: 'https://bulla.example.test' },
    }))
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([undefined, '0', 'true', 'yes'])(
    'fails closed for a production local adapter with override %s',
    async (override) => {
      localMode(true)
      vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', override)
      const response = await proxy(new NextRequest('http://127.0.0.1:3301/'))
      expect(response.status).toBe(503)
      expect(response.headers.get('x-middleware-next')).toBeNull()
    },
  )

  it('retains the explicit private-review override without weakening script policy', async () => {
    localMode(true)
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '1')
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/'))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    const scripts = response.headers.get('content-security-policy')
      ?.split(';').find(part => part.trim().startsWith('script-src'))
    expect(scripts).toContain("'nonce-")
    expect(scripts).not.toContain("'unsafe-inline'")
    expect(scripts).not.toContain("'unsafe-eval'")
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const provider = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: provider.getUser } }),
}))
import { proxy } from '../../src/proxy'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic-provider.example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key')
  provider.getUser.mockResolvedValue({ data: { user: null }, error: null })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('status-only deletion receipt routing after session revocation', () => {
  it('allows only the exact receipt path through, with private headers', async () => {
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/settings/account/deletion?receipt=opaque'))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('cache-control')).toContain('private, no-store')
  })

  it.each(['/settings', '/settings/account', '/settings/password', '/settings/account/deletion/other'])(
    'keeps %s behind the signed-in redirect',
    async pathname => {
      const response = await proxy(new NextRequest(`http://127.0.0.1:3301${pathname}`))
      expect(response.status).toBe(307)
      expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
      expect(response.headers.get('x-middleware-next')).toBeNull()
    },
  )

  it('does not exempt cross-origin writes on the receipt path', async () => {
    const response = await proxy(new NextRequest('http://127.0.0.1:3301/settings/account/deletion', {
      method: 'POST', headers: { origin: 'https://unrelated.example.test' },
    }))
    expect(response.status).toBe(403)
    expect(provider.getUser).not.toHaveBeenCalled()
  })
})

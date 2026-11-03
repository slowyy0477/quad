import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
let security: typeof import('@/lib/local/auth-security')
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'false')
  security = await import('@/lib/local/auth-security')
})

afterEach(() => { vi.unstubAllEnvs() })

describe('local authentication policy', () => {
  it('bounds login input without enforcing the new signup minimum', async () => {
    const { signInSchema } = await import('@/features/auth/schemas')
    expect(signInSchema.safeParse({ email: 'legacy@example.test', password: 'x'.repeat(8) }).success).toBe(true)
    expect(signInSchema.safeParse({ email: 'legacy@example.test', password: 'x'.repeat(1025) }).success).toBe(false)
  })

  it('counts Unicode code points rather than UTF-16 units for the new password minimum', async () => {
    const { passwordSchema } = await import('@/features/auth/schemas')
    expect(passwordSchema.safeParse('🔐🌴🦒🎉🚲🌊🍀🍎').success).toBe(false)
  })

  it('uses one shared source budget unless a gateway is explicitly trusted', () => {
    expect(typeof security.authAttemptSource).toBe('function')
    const first = new Headers({ 'x-forwarded-for': '198.51.100.1' })
    const second = new Headers({ 'x-forwarded-for': '198.51.100.2' })
    expect(security.authAttemptSource(first)).toBe('shared-untrusted')
    expect(security.authAttemptSource(second)).toBe('shared-untrusted')
    vi.stubEnv('LOCAL_AUTH_TRUST_PROXY', 'true')
    expect(security.authAttemptSource(first)).toBe('198.51.100.1')
    expect(security.authAttemptSource(new Headers({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2' }))).toBe('shared-untrusted')
  })

  it('does not permit account budget bypass by changing client identity or email case', () => {
    for (let index = 0; index < 5; index += 1) {
      expect(security.consumeAuthAttempt('login', index % 2 ? ' STUDENT@EXAMPLE.TEST ' : 'student@example.test', `source-${index}`, 1_000_000).allowed).toBe(true)
    }
    expect(security.consumeAuthAttempt('login', 'student@example.test', 'fresh-source', 1_000_001)).toMatchObject({ allowed: false, retryAfterSeconds: 900 })
    expect(security.consumeAuthAttempt('login', 'student@example.test', 'fresh-source', 1_900_000).allowed).toBe(true)
  })

  it('limits rotating account identities under one untrusted source budget', () => {
    for (let index = 0; index < 60; index += 1) expect(security.consumeAuthAttempt('login', `student-${index}@example.test`, undefined, 1_000_000).allowed).toBe(true)
    expect(security.consumeAuthAttempt('login', 'fresh@example.test', undefined, 1_000_000).allowed).toBe(false)
  })

  it('fails closed at bucket capacity instead of evicting live rate limits', () => {
    let allowed = 0
    for (let index = 0; index < 5_001; index += 1) if (security.consumeAuthAttempt('login', `student-${index}@example.test`, `source-${index}`, 1_000_000).allowed) allowed += 1
    expect(allowed).toBe(5_000)
    expect(security.consumeAuthAttempt('login', 'new@example.test', 'new-source', 1_900_000).allowed).toBe(true)
  })

  it.each(['/feed', '/projects?search=hello%20world#recent', '/students/محمد', '/feed?next=%2Fprojects'])('preserves safe local redirect %s verbatim', (destination) => {
    expect(security.safeLocalRedirect(destination)).toBe(destination)
  })

  it.each(['https://evil.example', '//evil.example', 'javascript:alert(1)', '/%zz', '/bad\u0000path', '/bad\u007fpath', '/%0aevil.example', '/%255cevil.example'])('rejects unsafe redirect %s', (destination) => {
    expect(security.safeLocalRedirect(destination)).toBe('/feed')
  })
})

import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../../next.config'

describe('request-bound content security policy', () => {
  it('authorizes only nonced scripts in production instead of unsafe inline script', () => {
    const csp = contentSecurityPolicy('test-nonce', { production: true, local: true })
    const scripts = csp.split(';').find((part) => part.trim().startsWith('script-src')) || ''
    expect(scripts).toContain("'nonce-test-nonce'")
    expect(scripts).not.toContain("'unsafe-inline'")
    expect(scripts).not.toContain("'unsafe-eval'")
  })
})

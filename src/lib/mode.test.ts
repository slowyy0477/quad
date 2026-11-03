import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertNotDeployedInLocalMode } from './mode'

afterEach(() => vi.unstubAllEnvs())

describe('production data-mode safety', () => {
  it('refuses a local production deployment by default', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', undefined)
    vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', undefined)
    expect(assertNotDeployedInLocalMode).toThrow('Refusing')
  })

  it.each(['0', 'false', 'true', 'yes'])('does not treat %s as an explicit private-demo override', value => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', value)
    vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', '1')
    expect(assertNotDeployedInLocalMode).toThrow('Refusing')
  })

  it('accepts only the explicit private-demo value', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '1')
    expect(assertNotDeployedInLocalMode).not.toThrow()
  })

  it('keeps an explicit legacy private-demo setting compatible', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', undefined)
    vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', '1')
    expect(assertNotDeployedInLocalMode).not.toThrow()
  })

  it('does not restrict the hosted data mode', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
    expect(assertNotDeployedInLocalMode).not.toThrow()
  })
})

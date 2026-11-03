import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS, type RateLimitBucket } from '../../src/lib/rate-limit/budgets'

const mocks = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  rpc: vi.fn(),
  client: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: mocks.configured }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }))
const { checkRateLimit } = await import('../../src/lib/rate-limit')

beforeEach(() => {
  mocks.configured.mockReturnValue(true)
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.client.mockResolvedValue({ rpc: mocks.rpc })
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('non-consuming fixed-budget wrapper compatibility', () => {
  it.each(Object.keys(RATE_LIMITS) as RateLimitBucket[])('echoes fixed %s policy, with no identity or caller override', async bucket => {
    const policy = RATE_LIMITS[bucket]
    expect(await checkRateLimit(bucket)).toEqual({ allowed: true })
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('check_rate_limit', {
      p_bucket: bucket, p_limit: policy.limit, p_window_seconds: policy.windowSeconds,
    })
  })

  it('refuses an unknown runtime bucket even if TypeScript was bypassed', async () => {
    expect(await checkRateLimit('attacker:bucket' as RateLimitBucket)).toMatchObject({ allowed: false })
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('continues to defer unconfigured/local writes to the selected adapter', async () => {
    mocks.configured.mockReturnValue(false)
    expect(await checkRateLimit('bug:file')).toEqual({ allowed: true })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('fails closed on false/null data and uses minute copy for messages', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    expect(await checkRateLimit('message:write')).toMatchObject({ allowed: false, message: expect.stringContaining('minute') })
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect(await checkRateLimit('bug:file')).toMatchObject({ allowed: false, message: expect.stringContaining('hour') })
  })

  it('fails closed on RPC errors without logging raw request/private material', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'private-fixture-do-not-log' } })
    expect(await checkRateLimit('bug:file')).toMatchObject({ allowed: false })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-fixture-do-not-log')
  })

  it('fails closed if client creation or transport throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.client.mockRejectedValueOnce(new Error('private-client-fixture'))
    expect(await checkRateLimit('bug:file')).toMatchObject({ allowed: false })
    mocks.rpc.mockRejectedValueOnce(new Error('private-transport-fixture'))
    expect(await checkRateLimit('bug:file')).toMatchObject({ allowed: false })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-client-fixture')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-transport-fixture')
  })
})

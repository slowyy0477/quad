import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.mock('server-only', () => ({}))
const provider = vi.hoisted(() => ({ export: vi.fn(), deletion: vi.fn(), receipt: vi.fn() }))
vi.mock('@/features/account/provider', () => ({
  exportOwnAccount: provider.export,
  deleteOwnAccount: provider.deletion,
  getAccountDeletionReceipt: provider.receipt,
}))

import { POST as exportPost } from '@/app/api/account/export/route'
import { POST as deletionPost } from '@/app/api/account/deletion/route'
import { POST as receiptPost } from '@/app/api/account/deletion/status/route'
import { accountRequestOriginAllowed } from '@/features/account/http'

function request(body: unknown = { password: 'synthetic password' }, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3999/api/account/export', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3999', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function assertPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(response.headers.get('vary')).toBe('Cookie, Authorization')
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
}

const invalidOrigins: Record<string, string>[] = [
  { origin: 'https://cross-site.example' }, { origin: '' }, { origin: 'null' },
  { 'sec-fetch-site': 'cross-site' }, { host: 'attacker.example' },
]

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test') })
afterEach(() => { vi.unstubAllEnvs() })

describe('S10 sensitive HTTP boundaries', () => {
  it('downloads bounded own export JSON with private headers and attachment disposition', async () => {
    provider.export.mockResolvedValue({ ok: true, value: { schema_version: 1, sections: { messages: { records: [], next_cursor: null } } } })
    const response = await exportPost(request({ password: 'synthetic password', section: 'messages', limit: 2 }))
    expect(response.status).toBe(200)
    assertPrivate(response)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="bulla-account-\d{4}-\d{2}-\d{2}\.json"$/)
    expect(provider.export).toHaveBeenCalledWith({ password: 'synthetic password', totpCode: '', section: 'messages', limit: 2 })
  })

  it.each(invalidOrigins)('rejects invalid browser origin %j before any account work', async headers => {
    const response = await exportPost(request(undefined, headers))
    expect(response.status).toBe(403)
    assertPrivate(response)
    expect(provider.export).not.toHaveBeenCalled()
  })

  it('uses the configured production origin and ignores forwarded-host spoofing', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://bulla.example')
    expect(accountRequestOriginAllowed(request(undefined, { origin: 'https://bulla.example', 'x-forwarded-host': 'attacker.example' }))).toBe(true)
    expect(accountRequestOriginAllowed(request())).toBe(false)
  })

  it('rejects wrong content type, excessive declared/streamed bytes and malformed JSON before provider calls', async () => {
    expect((await exportPost(request(undefined, { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await exportPost(request(undefined, { 'content-length': '13000' }))).status).toBe(413)
    expect((await exportPost(request({ password: 'x'.repeat(13_000) }))).status).toBe(413)
    const malformed = new Request('http://127.0.0.1:3999/api/account/export', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3999', 'content-type': 'application/json' }, body: '{not json',
    })
    expect((await exportPost(malformed)).status).toBe(400)
    expect(provider.export).not.toHaveBeenCalled()
  })

  it('rejects posted identities, arbitrary export sections/cursors and unbounded limits', async () => {
    for (const body of [
      { password: 'synthetic password', userId: 'forged' }, { section: 'sessions' },
      { limit: 101 }, { limit: 0 }, { after: 'cursor_without_section' }, { section: 'posts', after: "' OR true --" },
    ]) expect((await exportPost(request(body))).status).toBe(400)
    expect(provider.export).not.toHaveBeenCalled()
  })

  it('maps sensitive failures to safe status/copy and Retry-After without leaking credentials or raw errors', async () => {
    provider.export.mockResolvedValue({ ok: false, code: 'throttled', retryAfterSeconds: 60 })
    const limited = await exportPost(request())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    assertPrivate(limited)
    provider.export.mockRejectedValue(new Error('S10-PRIVATE-TOKEN-OR-PASSWORD'))
    const failed = await exportPost(request())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('S10-PRIVATE-TOKEN-OR-PASSWORD')
  })

  it('requires exact confirmation and acknowledgement and distinguishes accepted from completed deletion', async () => {
    const body = { password: 'synthetic password', confirmation: 'DELETE MY ACCOUNT', acknowledge: true, idempotencyKey: randomUUID() }
    expect((await deletionPost(request({ ...body, acknowledge: false }))).status).toBe(400)
    expect((await deletionPost(request({ ...body, confirmation: 'delete' }))).status).toBe(400)
    expect(provider.deletion).not.toHaveBeenCalled()
    for (const [state, phase, status] of [['queued', 'media', 202], ['completed', 'complete', 200]] as const) {
      provider.deletion.mockResolvedValue({ ok: true, value: { id: randomUUID(), state, phase } })
      const response = await deletionPost(request(body))
      expect(response.status).toBe(status)
      assertPrivate(response)
      expect(await response.json()).toMatchObject({ ok: true, value: { state, phase } })
    }
  })

  it('allows status-only lookup with a random receipt, without credentials or account IDs', async () => {
    const id = randomUUID()
    provider.receipt.mockResolvedValue({ ok: true, value: { id, state: 'retry', phase: 'auth' } })
    const response = await receiptPost(request({ receipt: id }))
    expect(response.status).toBe(200)
    assertPrivate(response)
    expect(provider.receipt).toHaveBeenCalledWith(id)
    expect(Object.keys((await response.json()).value).sort()).toEqual(['id', 'phase', 'state'])
    expect((await receiptPost(request({ receipt: id, userId: randomUUID() }))).status).toBe(400)
    expect((await receiptPost(request({ receipt: 'not-a-receipt' }))).status).toBe(400)
  })
})

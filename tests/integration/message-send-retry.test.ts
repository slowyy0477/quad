import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111' as string | null,
  error: null as { code: string; message: string; hint?: string } | null,
  existing: null as { id: string; conversation_id: string; body: string } | null,
  lookupError: null as { code: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  filters: [] as [string, unknown][],
  lookups: 0,
  revalidate: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: fixture.revalidate }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => true }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => fixture.userId ? { id: fixture.userId } : null,
  createClient: fixture.createClient,
}))

import { sendMessageAction } from '@/features/messages/actions'

const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const NONCE = '33333333-3333-4333-8333-333333333333'
function form(body = 'synthetic retry body', nonce = NONCE) {
  const result = new FormData()
  result.set('conversationId', CONVERSATION)
  result.set('body', body)
  result.set('clientNonce', nonce)
  return result
}

beforeEach(() => {
  fixture.userId = '11111111-1111-4111-8111-111111111111'
  fixture.error = null
  fixture.existing = null
  fixture.lookupError = null
  fixture.inserts = []
  fixture.filters = []
  fixture.lookups = 0
  fixture.revalidate.mockClear()
  fixture.createClient.mockReset()
  fixture.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: fixture.userId ? { id: fixture.userId } : null }, error: null }) },
    from(table: string) {
      if (table === 'profiles') {
        const profileQuery = {
          select: () => profileQuery, eq: () => profileQuery,
          maybeSingle: async () => ({ data: { status: 'active', suspended_until: null }, error: null }),
        }
        return profileQuery
      }
      if (table !== 'messages') throw new Error(`Unexpected synthetic query: ${table}`)
      const messages = {
        insert: async (row: Record<string, unknown>) => {
          fixture.inserts.push(row)
          return { error: fixture.error }
        },
        select: () => { fixture.lookups += 1; return messages },
        eq: (column: string, value: unknown) => { fixture.filters.push([column, value]); return messages },
        maybeSingle: async () => ({ data: fixture.existing, error: fixture.lookupError }),
      }
      return messages
    },
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('hosted send adapter nonce handling (mocked transport, not hosted acceptance)', () => {
  it('sends the verified sender and nonce, ignoring a forged form sender', async () => {
    const input = form('  synthetic trimmed body  ')
    input.set('sender_id', '44444444-4444-4444-8444-444444444444')
    expect(await sendMessageAction({ status: 'idle' }, input)).toEqual({ status: 'success', message: 'Sent.' })
    expect(fixture.inserts).toEqual([{
      conversation_id: CONVERSATION, sender_id: fixture.userId,
      body: 'synthetic trimmed body', client_nonce: NONCE,
    }])
    expect(fixture.lookups).toBe(0)
  })

  it('acknowledges an exact already-accepted send with an owner-scoped lookup', async () => {
    fixture.error = { code: '23505', message: 'synthetic unique conflict' }
    fixture.existing = { id: 'accepted-id', conversation_id: CONVERSATION, body: 'synthetic retry body' }
    expect(await sendMessageAction({ status: 'idle' }, form())).toEqual({ status: 'success', message: 'Sent.' })
    expect(fixture.filters).toEqual([['sender_id', fixture.userId], ['client_nonce', NONCE]])
    expect(fixture.revalidate).toHaveBeenCalledWith('/messages')
  })

  it.each([
    { conversation_id: '44444444-4444-4444-8444-444444444444', body: 'synthetic retry body' },
    { conversation_id: CONVERSATION, body: 'another previously accepted body' },
  ])('never treats a reused nonce for another accepted send as success: %j', async (existing) => {
    fixture.error = { code: '23505', message: 'synthetic unique conflict' }
    fixture.existing = { id: 'accepted-id', ...existing }
    const result = await sendMessageAction({ status: 'idle' }, form())
    expect(result.status).toBe('error')
    expect(result.message).toContain('identifier was already used')
    expect(fixture.revalidate).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('another previously accepted body')
  })

  it('does not claim success when the accepted-send lookup fails', async () => {
    fixture.error = { code: '23505', message: 'synthetic unique conflict' }
    fixture.lookupError = { code: '08006', message: 'synthetic unavailable transport' }
    expect((await sendMessageAction({ status: 'idle' }, form())).status).toBe('error')
    expect(fixture.revalidate).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'not_participant', 'messaging_not_permitted'])(
    'keeps a %s refusal authoritative even when a nonce was previously accepted',
    async (hint) => {
      fixture.error = { code: '42501', message: 'synthetic private database detail', hint }
      fixture.existing = { id: 'accepted-id', conversation_id: CONVERSATION, body: 'synthetic retry body' }
      const result = await sendMessageAction({ status: 'idle' }, form())
      expect(result.status).toBe('error')
      expect(fixture.lookups).toBe(0)
      expect(JSON.stringify(result)).not.toContain('private database detail')
    },
  )

  it('rejects a malformed nonce before reaching the database client', async () => {
    expect((await sendMessageAction({ status: 'idle' }, form('synthetic body', 'invalid'))).status).toBe('error')
    expect(fixture.createClient).not.toHaveBeenCalled()
    expect(fixture.inserts).toEqual([])
  })

  it('refuses a signed-out caller without inserting a message', async () => {
    fixture.userId = null
    expect((await sendMessageAction({ status: 'idle' }, form())).status).toBe('error')
    expect(fixture.inserts).toEqual([])
  })
})

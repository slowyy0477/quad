import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyTargetIndex } from './plan'
import type { NotificationRow } from './queries'

const provider = vi.hoisted(() => ({
  createClient: vi.fn(),
  replies: {} as Record<string, { data?: unknown; count?: unknown; error: unknown }>,
  operations: [] as unknown[][],
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: provider.createClient, getUser: vi.fn(),
}))
vi.mock('@/lib/local/db', () => ({
  readStore: () => { throw new Error('An ordinary hosted read must not open local data.') },
}))

import { getNotifications, getTargetIndex, getUnreadNotificationCount } from './queries'

function activity(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'ntf_fixture', type: 'follow', body: null, is_read: false,
    created_at: '2026-11-02T00:00:00.000Z',
    post_id: null, comment_id: null, project_id: null, idea_id: null,
    event_id: null, opportunity_id: null, conversation_id: null, actor: null,
    ...overrides,
  }
}

function ordinaryClient() {
  return {
    from(table: string) {
      provider.operations.push(['from', table])
      let head = false
      const query = {
        select(columns: string, options?: { head?: boolean; count?: string }) {
          provider.operations.push(['select', table, columns, options])
          head = options?.head === true
          return query
        },
        eq(column: string, value: unknown) {
          provider.operations.push(['eq', table, column, value]); return query
        },
        order(column: string, value: unknown) {
          provider.operations.push(['order', table, column, value]); return query
        },
        limit(value: number) {
          provider.operations.push(['limit', table, value]); return query
        },
        in(column: string, values: string[]) {
          provider.operations.push(['in', table, column, values]); return query
        },
        is(column: string, value: unknown) {
          provider.operations.push(['is', table, column, value]); return query
        },
        or(value: string) { provider.operations.push(['or', table, value]); return query },
        returns() { return Promise.resolve(provider.replies[table]) },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(provider.replies[head ? 'count' : table]).then(resolve, reject)
        },
      }
      return query
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  provider.operations = []
  provider.replies = {
    count: { count: 0, error: null },
    notifications: { data: [], error: null },
    posts: { data: [], error: null },
    projects: { data: [], error: null },
  }
  provider.createClient.mockResolvedValue(ordinaryClient())
})

describe('ordinary-provider notification outcomes — not hosted/RLS acceptance', () => {
  it.each([0, 1, 105])('retains the exact genuine unread count %i, not the preview length', async count => {
    provider.replies.count = { count, error: null }
    expect(await getUnreadNotificationCount()).toBe(count)
    expect(provider.operations).toContainEqual([
      'select', 'notifications', 'id', { count: 'exact', head: true },
    ])
    expect(provider.operations).not.toContainEqual(['limit', 'notifications', 5])
  })

  it.each([null, undefined, -1, 0.5, Infinity, NaN, '0'])(
    'does not turn a missing/malformed count %s into zero', async count => {
      provider.replies.count = { count, error: null }
      expect(await getUnreadNotificationCount()).toBeNull()
    },
  )

  it('returns unknown on both reported and thrown count failures without private provider detail', async () => {
    provider.replies.count = { count: 3, error: { code: '42501', message: 'PRIVATE_PROVIDER_DETAIL' } }
    expect(await getUnreadNotificationCount()).toBeNull()
    provider.createClient.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'))
    expect(await getUnreadNotificationCount()).toBeNull()
  })

  it('distinguishes a real empty list from null/malformed/reported responses', async () => {
    expect(await getNotifications()).toEqual({ notifications: [], nextCursor: null, error: null })
    for (const data of [null, undefined, {}, [null], [activity({ created_at: 'not a date' })]]) {
      provider.replies.notifications = { data, error: null }
      expect(await getNotifications()).toEqual({
        notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.',
      })
    }
    provider.replies.notifications = { data: [], error: { message: 'PRIVATE_PROVIDER_DETAIL' } }
    expect(await getNotifications()).toEqual({
      notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.',
    })
  })

  it('rejects a whole malformed list rather than returning a partially accurate preview', async () => {
    provider.replies.notifications = { data: [activity(), { ...activity(), is_read: 'false' }], error: null }
    expect((await getNotifications({ limit: 5 })).notifications).toBeNull()
  })

  it('copies minimal rows/actors and strips private message bodies before presentation', async () => {
    const row = activity({
      type: 'message', body: 'PRIVATE_MESSAGE_BODY', conversation_id: 'conversation_fixture',
      actor: { id: 'person_fixture', username: 'alice', display_name: 'Alice', avatar_url: null },
    })
    provider.replies.notifications = { data: [{
      ...row, recipient_id: 'PRIVATE_RECIPIENT_ID', private_note: 'PRIVATE_ROW_DETAIL',
      actor: { ...row.actor, email: 'PRIVATE_ACTOR_EMAIL' },
    }], error: null }
    const result = await getNotifications({ limit: 5 })
    expect(result).toEqual({ notifications: [{ ...row, body: null }], nextCursor: null, error: null })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/)
  })

  it('bounds the list and refuses an oversized provider answer', async () => {
    provider.replies.notifications = { data: Array.from({ length: 6 }, () => activity()), error: null }
    expect((await getNotifications({ limit: 5 })).error).not.toBeNull()
    await getNotifications({ limit: 10_000 })
    expect(provider.operations).toContainEqual(['limit', 'notifications', 50])
  })

  it('keeps a successful empty target lookup distinct from a failed one', async () => {
    const rows = [activity({ post_id: 'post_fixture' })]
    expect(await getTargetIndex(rows)).toEqual({ index: emptyTargetIndex(), error: null })
    provider.replies.posts = { data: null, error: null }
    const failed = await getTargetIndex(rows)
    expect(failed.index).toEqual(emptyTargetIndex())
    expect(failed.error).toContain('could not be resolved')
  })

  it('does not claim targets vanished or retain partial destinations after one reported failure', async () => {
    const rows = [activity({ post_id: 'post_fixture', project_id: 'project_fixture' })]
    provider.replies.posts = { data: [{ id: 'post_fixture' }], error: null }
    provider.replies.projects = { data: [], error: { message: 'PRIVATE_TARGET_DETAIL' } }
    const result = await getTargetIndex(rows)
    expect(result.index).toEqual(emptyTargetIndex())
    expect(result.error).toContain('could not be resolved')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TARGET_DETAIL')
  })

  it.each([
    [{ id: 'unasked_private_target' }],
    [{ id: 'post_fixture' }, { id: 'post_fixture' }],
    [{ id: ['post_fixture'] }],
    null,
  ])('refuses null, duplicate or unasked target rows instead of inventing links', async data => {
    provider.replies.posts = { data, error: null }
    const result = await getTargetIndex([activity({ post_id: 'post_fixture' })])
    expect(result.index).toEqual(emptyTargetIndex())
    expect(result.error).not.toBeNull()
  })

  it('returns a truthful error for a thrown target lookup without a service-role fallback', async () => {
    provider.createClient.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'))
    const result = await getTargetIndex([activity({ post_id: 'post_fixture' })])
    expect(result.index).toEqual(emptyTargetIndex())
    expect(result.error).not.toContain('PRIVATE_PROVIDER_DETAIL')
  })
})

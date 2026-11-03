import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkReadOutcome } from './types'

// These are source-level action tests, not local-store integration or hosted
// authorization proof. Every environment, auth, storage and cache boundary is
// replaced; the real action's local mutation callback still runs on our fixture.
const boundary = vi.hoisted(() => ({
  isLocalMode: vi.fn(),
  isSupabaseConfigured: vi.fn(),
  getUser: vi.fn(),
  createClient: vi.fn(),
  mutate: vi.fn(),
  select: vi.fn(),
  revalidatePath: vi.fn(),
  unstableRethrow: vi.fn(),
  operations: [] as unknown[][],
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/mode', () => ({ isLocalMode: boundary.isLocalMode }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: boundary.isSupabaseConfigured }))
vi.mock('@/lib/local/db', () => ({ mutate: boundary.mutate }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: boundary.getUser,
  createClient: boundary.createClient,
}))
vi.mock('next/cache', () => ({ revalidatePath: boundary.revalidatePath }))
vi.mock('next/navigation', () => ({ unstable_rethrow: boundary.unstableRethrow }))

import { markOneReadAction, markOneReadFormAction } from './actions'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
// Local recipient profiles deliberately differ from auth user IDs.
const PROFILE_ID = 'prf_reader'
const OTHER_PROFILE_ID = 'prf_peer'
const LOCAL_ID = 'ntf_ownunread'
const OTHER_LOCAL_ID = 'ntf_peerunread'
const HOSTED_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_HOSTED_ID = '44444444-4444-4444-8444-444444444444'
const PRIVATE_DIAGNOSTIC = 'SYNTHETIC_PRIVATE_NOTIFICATION_DIAGNOSTIC'
const REFUSED = 'That notification could not be updated.'
const FAILED = 'That could not be marked as read. Please try again.'
const UNCONFIRMED = 'The read status could not be confirmed. Please try again.'

type FixtureNotification = {
  id: string
  recipient_id: string
  actor_id: string | null
  type: string
  body: string | null
  is_read: boolean
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
}
type FixtureStore = {
  profiles: { id: string; user_id: string }[]
  notifications: FixtureNotification[]
}

function notification(id: string, recipientId: string, isRead = false): FixtureNotification {
  return {
    id, recipient_id: recipientId, actor_id: OTHER_PROFILE_ID,
    type: 'content_hidden', body: 'Synthetic moderation note.', is_read: isRead,
    created_at: '2026-11-02T00:00:00.000Z',
    post_id: 'post_fixture', comment_id: null, project_id: null, idea_id: null,
    event_id: null, opportunity_id: null, conversation_id: null,
  }
}

function fixtureStore(): FixtureStore {
  return {
    profiles: [
      { id: PROFILE_ID, user_id: USER_ID },
      { id: OTHER_PROFILE_ID, user_id: OTHER_USER_ID },
    ],
    notifications: [
      notification(LOCAL_ID, PROFILE_ID),
      notification('ntf_ownread', PROFILE_ID, true),
      notification('ntf_ownother', PROFILE_ID),
      notification(OTHER_LOCAL_ID, OTHER_PROFILE_ID),
      notification('ntf_peerread', OTHER_PROFILE_ID, true),
    ],
  }
}

function copyStore(store: FixtureStore): FixtureStore {
  return {
    profiles: store.profiles.map(profile => ({ ...profile })),
    notifications: store.notifications.map(row => ({ ...row })),
  }
}

function form(...ids: (string | File)[]): FormData {
  const data = new FormData()
  for (const id of ids) data.append('id', id)
  return data
}

const forgedPrevious = Object.freeze({
  ok: true as const,
  marked: 9876,
  id: OTHER_LOCAL_ID,
  user: Object.freeze({ id: OTHER_USER_ID }),
  profile: Object.freeze({ id: OTHER_PROFILE_ID }),
  recipient_id: OTHER_PROFILE_ID,
})

function forgedForm(id: string, recipientId = OTHER_PROFILE_ID): FormData {
  const data = form(id)
  data.set('user_id', OTHER_USER_ID)
  data.set('recipient_id', recipientId)
  data.set('is_read', 'true')
  data.set('marked', '9876')
  return data
}

// Record the requested update and return exactly the configured response.
// This deliberately does not implement PostgREST, row mutation or RLS.
function ordinaryClient() {
  return {
    from(table: string) {
      boundary.operations.push(['from', table])
      const query = {
        update(values: Record<string, unknown>) {
          boundary.operations.push(['update', values])
          return query
        },
        eq(column: string, value: unknown) {
          boundary.operations.push(['eq', column, value])
          return query
        },
        select(columns: string) {
          boundary.operations.push(['select', columns])
          return boundary.select()
        },
      }
      return query
    },
  }
}

function expectScopedUpdate(id = HOSTED_ID) {
  expect(boundary.operations).toEqual([
    ['from', 'notifications'],
    ['update', { is_read: true }],
    ['eq', 'recipient_id', USER_ID],
    ['eq', 'id', id],
    ['eq', 'is_read', false],
    ['select', 'id'],
  ])
  expect(boundary.getUser).toHaveBeenCalledTimes(1)
  expect(boundary.createClient).toHaveBeenCalledTimes(1)
  expect(boundary.mutate).not.toHaveBeenCalled()
}

function expectRefreshes(requests = 1) {
  expect(boundary.revalidatePath.mock.calls).toEqual(
    Array.from({ length: requests }, () => [
      ['/notifications'],
      ['/', 'layout'],
    ]).flat(),
  )
}

function expectNoWriteOrRefresh() {
  expect(boundary.mutate).not.toHaveBeenCalled()
  expect(boundary.createClient).not.toHaveBeenCalled()
  expect(boundary.select).not.toHaveBeenCalled()
  expect(boundary.operations).toEqual([])
  expect(boundary.revalidatePath).not.toHaveBeenCalled()
}

function expectSanitizedFailure(outcome: MarkReadOutcome, error: unknown) {
  expect(outcome).toEqual({ ok: false, message: FAILED })
  expect(boundary.unstableRethrow).toHaveBeenCalledExactlyOnceWith(error)
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markOne] request failed')
  expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls }))
    .not.toContain(PRIVATE_DIAGNOSTIC)
  expect(boundary.revalidatePath).not.toHaveBeenCalled()
}

let store: FixtureStore
beforeEach(() => {
  vi.resetAllMocks()
  boundary.operations = []
  boundary.isLocalMode.mockReturnValue(true)
  boundary.isSupabaseConfigured.mockReturnValue(true)
  boundary.getUser.mockResolvedValue({ id: USER_ID })
  store = fixtureStore()
  boundary.mutate.mockImplementation(async (callback: (db: FixtureStore) => number) => callback(store))
  boundary.createClient.mockResolvedValue(ordinaryClient())
  boundary.select.mockResolvedValue({ data: [], error: null })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { vi.restoreAllMocks() })

describe('markOneReadFormAction — local callback contract, not store integration', () => {
  it('changes only the requested own unread flag and returns one, ignoring forged prior state/identity', async () => {
    boundary.isSupabaseConfigured.mockReturnValue(false)
    const expected = copyStore(store)
    expected.notifications[0].is_read = true

    expect(await markOneReadFormAction(forgedPrevious, forgedForm(LOCAL_ID)))
      .toEqual({ ok: true, marked: 1 })
    expect(store).toEqual(expected)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.isSupabaseConfigured).not.toHaveBeenCalled()
    expect(boundary.createClient).not.toHaveBeenCalled()
    expectRefreshes()
  })

  it('does not reuse an earlier failure as the current result', async () => {
    const previous: MarkReadOutcome = { ok: false, message: PRIVATE_DIAGNOSTIC }
    expect(await markOneReadFormAction(previous, form(LOCAL_ID))).toEqual({ ok: true, marked: 1 })
    expect(store.notifications[0].is_read).toBe(true)
    expectRefreshes()
  })

  it.each([
    { label: 'already-read own', id: 'ntf_ownread' },
    { label: 'missing', id: 'ntf_missing' },
    { label: 'foreign unread', id: OTHER_LOCAL_ID },
    { label: 'foreign already-read', id: 'ntf_peerread' },
  ])('returns an honest zero for a valid $label ID without any row mutation, then reconciles stale surfaces', async ({ id }) => {
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(id)))
      .toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(before)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.createClient).not.toHaveBeenCalled()
    expectRefreshes()
  })

  it('does not borrow another profile when the authenticated user has no local profile', async () => {
    store.profiles = store.profiles.filter(profile => profile.id !== PROFILE_ID)
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(LOCAL_ID)))
      .toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(before)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expectRefreshes()
  })

  it('returns one then zero for the same valid request and refreshes both times', async () => {
    const first = await markOneReadFormAction(null, form(LOCAL_ID))
    expect(first).toEqual({ ok: true, marked: 1 })
    const afterFirst = copyStore(store)
    expect(await markOneReadFormAction(first, form(LOCAL_ID))).toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(afterFirst)
    expect(boundary.mutate).toHaveBeenCalledTimes(2)
    expectRefreshes(2)
  })

  it.each([
    { label: 'rejected', fail: (error: Error) => boundary.mutate.mockRejectedValue(error) },
    { label: 'synchronously thrown', fail: (error: Error) => boundary.mutate.mockImplementation(() => { throw error }) },
  ])('sanitizes a $label store-boundary failure before the fixture callback runs', async ({ fail }) => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    const before = copyStore(store)
    fail(error)
    expectSanitizedFailure(await markOneReadFormAction(null, form(LOCAL_ID)), error)
    expect(store).toEqual(before)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.createClient).not.toHaveBeenCalled()
  })
})

const malformedForms: {
  label: string
  make: (id: string, otherId: string) => FormData
}[] = [
  { label: 'missing ID', make: () => form() },
  { label: 'empty ID', make: () => form('') },
  { label: 'whitespace ID', make: () => form('   ') },
  { label: 'file ID', make: () => form(new File(['fixture'], 'id.txt')) },
  { label: 'repeated identical IDs', make: id => form(id, id) },
  { label: 'repeated different IDs', make: (id, otherId) => form(id, otherId) },
  { label: 'mixed string/file IDs', make: id => form(id, new File(['fixture'], 'id.txt')) },
]

describe.each([
  {
    label: 'local', local: true, id: LOCAL_ID, otherId: OTHER_LOCAL_ID,
    invalidIds: [
      { label: 'hosted UUID', id: HOSTED_ID },
      { label: 'uppercase local suffix', id: 'ntf_ABC' },
      { label: 'punctuation in local suffix', id: 'ntf_bad-id' },
      { label: 'empty local suffix', id: 'ntf_' },
      { label: 'oversized local suffix', id: `ntf_${'a'.repeat(65)}` },
    ],
  },
  {
    label: 'ordinary-provider', local: false, id: HOSTED_ID, otherId: OTHER_HOSTED_ID,
    invalidIds: [
      { label: 'opaque local ID', id: LOCAL_ID },
      { label: 'non-UUID', id: 'not-a-uuid' },
      { label: 'UUID with leading space', id: ` ${HOSTED_ID}` },
      { label: 'UUID with trailing space', id: `${HOSTED_ID} ` },
      { label: 'UUID with appended path', id: `${HOSTED_ID}/anything` },
    ],
  },
])('$label form and auth guards', ({ local, id, otherId, invalidIds }) => {
  beforeEach(() => { boundary.isLocalMode.mockReturnValue(local) })

  it.each(malformedForms)('refuses $label before auth or mutation', async ({ make }) => {
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, make(id, otherId)))
      .toEqual({ ok: false, message: REFUSED })
    expect(store).toEqual(before)
    expect(boundary.getUser).not.toHaveBeenCalled()
    expectNoWriteOrRefresh()
  })

  it.each(invalidIds)('refuses $label before auth or mutation', async ({ id: invalidId }) => {
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, form(invalidId)))
      .toEqual({ ok: false, message: REFUSED })
    expect(store).toEqual(before)
    expect(boundary.getUser).not.toHaveBeenCalled()
    expectNoWriteOrRefresh()
  })

  it('requires current auth even when prior state and form fields forge a user/recipient', async () => {
    boundary.getUser.mockResolvedValue(null)
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(id)))
      .toEqual({ ok: false, message: 'Sign in again to mark this as read.' })
    expect(store).toEqual(before)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expectNoWriteOrRefresh()
  })

  it('sanitizes a thrown auth lookup without trusting the previous outcome', async () => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    boundary.getUser.mockRejectedValue(error)
    expectSanitizedFailure(await markOneReadFormAction(forgedPrevious, form(id)), error)
    expectNoWriteOrRefresh()
  })
})

describe('markOneReadFormAction — ordinary-provider request/response contract, not hosted/RLS proof', () => {
  beforeEach(() => { boundary.isLocalMode.mockReturnValue(false) })

  it('reports missing database configuration without auth, a client, mutation or refresh', async () => {
    boundary.isSupabaseConfigured.mockReturnValue(false)
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(HOSTED_ID, OTHER_USER_ID)))
      .toEqual({
        ok: false,
        message: 'This deployment has no database connection, so nothing can be saved.',
      })
    expect(boundary.getUser).not.toHaveBeenCalled()
    expectNoWriteOrRefresh()
  })

  // Array-valued responses are wrapped in objects so Vitest does not spread
  // them into the callback's arguments.
  it.each([
    { label: 'a valid empty selected array', data: [], marked: 0 },
    { label: 'one selected requested ID', data: [{ id: HOSTED_ID }], marked: 1 },
  ])('returns the supplied provider row count for $label and reconciles surfaces', async ({ data, marked }) => {
    boundary.select.mockResolvedValue({ data, error: null })
    const before = copyStore(store)
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(HOSTED_ID, OTHER_USER_ID)))
      .toEqual({ ok: true, marked })
    expectScopedUpdate()
    expect(store).toEqual(before)
    expectRefreshes()
  })

  it('keeps the authenticated recipient predicate for a foreign requested ID despite forged identity', async () => {
    expect(await markOneReadFormAction(forgedPrevious, forgedForm(OTHER_HOSTED_ID, OTHER_USER_ID)))
      .toEqual({ ok: true, marked: 0 })
    expectScopedUpdate(OTHER_HOSTED_ID)
    expectRefreshes()
  })

  it.each([
    { label: 'null data', data: null },
    { label: 'omitted data', data: undefined },
    { label: 'non-array object', data: { id: HOSTED_ID } },
    { label: 'non-array string', data: HOSTED_ID },
    { label: 'null row', data: [null] },
    { label: 'undefined row', data: [undefined] },
    { label: 'scalar row', data: [HOSTED_ID] },
    { label: 'row without an ID', data: [{}] },
    { label: 'null ID', data: [{ id: null }] },
    { label: 'numeric ID', data: [{ id: 3 }] },
    { label: 'array ID', data: [{ id: [HOSTED_ID] }] },
    { label: 'foreign/unasked returned ID', data: [{ id: OTHER_HOSTED_ID }] },
    { label: 'duplicate requested rows', data: [{ id: HOSTED_ID }, { id: HOSTED_ID }] },
    { label: 'requested plus foreign rows', data: [{ id: HOSTED_ID }, { id: OTHER_HOSTED_ID }] },
  ])('rejects $label as unconfirmed, never an invented zero or one', async ({ data }) => {
    boundary.select.mockResolvedValue({ data, error: null })
    expect(await markOneReadFormAction(forgedPrevious, form(HOSTED_ID)))
      .toEqual({ ok: false, message: UNCONFIRMED })
    expectScopedUpdate()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'null response envelope', reply: null },
    { label: 'omitted response envelope', reply: undefined },
  ])('rejects a $label without claiming success or exposing the thrown diagnostic', async ({ reply }) => {
    boundary.select.mockResolvedValue(reply)
    const outcome = await markOneReadFormAction(null, form(HOSTED_ID))
    expect(outcome).toEqual({ ok: false, message: FAILED })
    expectScopedUpdate()
    expect(boundary.unstableRethrow).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markOne] request failed')
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })

  it('sanitizes reported provider errors even when data looks like a one-row success', async () => {
    boundary.select.mockResolvedValue({
      data: [{ id: HOSTED_ID }],
      error: {
        code: PRIVATE_DIAGNOSTIC, message: PRIVATE_DIAGNOSTIC,
        details: PRIVATE_DIAGNOSTIC, hint: PRIVATE_DIAGNOSTIC,
      },
    })
    const outcome = await markOneReadFormAction(null, form(HOSTED_ID))
    expect(outcome).toEqual({ ok: false, message: FAILED })
    expectScopedUpdate()
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markOne] provider write failed')
    expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls }))
      .not.toContain(PRIVATE_DIAGNOSTIC)
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'omitted error', error: undefined },
    { label: 'false error', error: false },
    { label: 'zero error', error: 0 },
    { label: 'empty-string error', error: '' },
  ])('does not treat a malformed $label field as confirmed zero changes', async ({ error }) => {
    boundary.select.mockResolvedValue({ data: [], error })
    expect(await markOneReadFormAction(null, form(HOSTED_ID)))
      .toEqual({ ok: false, message: UNCONFIRMED })
    expectScopedUpdate()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'client creation', fail: (error: Error) => boundary.createClient.mockRejectedValue(error) },
    { label: 'selected write response', fail: (error: Error) => boundary.select.mockRejectedValue(error) },
  ])('sanitizes a thrown provider failure at $label', async ({ fail }) => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    fail(error)
    expectSanitizedFailure(await markOneReadFormAction(null, form(HOSTED_ID)), error)
    expect(boundary.mutate).not.toHaveBeenCalled()
  })
})

describe('legacy markOneReadAction — void compatibility with the same core behavior', () => {
  it('returns undefined while applying only the accepted own local read', async () => {
    const expected = copyStore(store)
    expected.notifications[0].is_read = true
    expect(await markOneReadAction(forgedForm(LOCAL_ID))).toBeUndefined()
    expect(store).toEqual(expected)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expectRefreshes()
  })

  it('retains valid-zero reconciliation through the shared core without returning an outcome', async () => {
    const before = copyStore(store)
    expect(await markOneReadAction(form(OTHER_LOCAL_ID))).toBeUndefined()
    expect(store).toEqual(before)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expectRefreshes()
  })

  it('uses the same explicit provider update and still returns undefined', async () => {
    boundary.isLocalMode.mockReturnValue(false)
    boundary.select.mockResolvedValue({ data: [{ id: HOSTED_ID }], error: null })
    expect(await markOneReadAction(forgedForm(HOSTED_ID, OTHER_USER_ID))).toBeUndefined()
    expectScopedUpdate()
    expectRefreshes()
  })

  it('delegates repeated-ID refusal instead of marking any or all rows', async () => {
    const before = copyStore(store)
    expect(await markOneReadAction(form(LOCAL_ID, OTHER_LOCAL_ID))).toBeUndefined()
    expect(store).toEqual(before)
    expect(boundary.getUser).not.toHaveBeenCalled()
    expectNoWriteOrRefresh()
  })

  it('preserves a core rejection rather than converting the void entry point into form state', async () => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    boundary.mutate.mockRejectedValue(error)
    await expect(markOneReadAction(form(LOCAL_ID))).rejects.toBe(error)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })
})

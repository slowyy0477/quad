import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalNotification } from '@/lib/local/db'
import type { MarkReadOutcome } from './types'

// Auth, storage, provider and cache boundaries are replaced. The real local
// mutation callback runs on an in-memory fixture; this is not datastore,
// PostgREST/RLS, hosted receipt completeness or browser acceptance.
type FixtureStore = {
  profiles: { id: string; user_id: string }[]
  notifications: LocalNotification[]
}

const boundary = vi.hoisted(() => ({
  isLocalMode: vi.fn<() => boolean>(),
  isSupabaseConfigured: vi.fn<() => boolean>(),
  getUser: vi.fn<() => Promise<{ id: string } | null>>(),
  createClient: vi.fn(),
  mutate: vi.fn<(callback: (db: FixtureStore) => number) => Promise<number>>(),
  select: vi.fn<() => Promise<unknown>>(),
  revalidatePath: vi.fn<(path: string, type?: 'page' | 'layout') => void>(),
  unstableRethrow: vi.fn<(error: unknown) => void>(),
  operations: new Array<unknown[]>(),
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

import { markAllReadAction, markAllReadFormAction } from './actions'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
// Deliberately not auth IDs: local recipients must use the resolved own profile.
const PROFILE_ID = 'prf_bulkreader'
const OTHER_PROFILE_ID = 'prf_bulkpeer'
const HOSTED_ID = '3abcdef0-1234-4234-8234-123456789abc'
const OTHER_HOSTED_ID = '4abcdef0-1234-4234-8234-123456789abc'
const PRIVATE_DIAGNOSTIC = 'SYNTHETIC_PRIVATE_BULK_NOTIFICATION_DIAGNOSTIC'
const FAILED = 'Those could not be marked as read. Please try again.'
const UNCONFIRMED = 'The read status could not be confirmed. Please try again.'

const forgedPrevious: {
  ok: true
  marked: number
  recipient_id: string
  user: { id: string }
} = {
  ok: true,
  marked: 9876,
  recipient_id: OTHER_PROFILE_ID,
  user: { id: OTHER_USER_ID },
}

function forgedForm(): FormData {
  const form = new FormData()
  form.set('id', 'ntf_peerunread')
  form.set('recipient_id', OTHER_PROFILE_ID)
  form.append('recipient_id', OTHER_USER_ID)
  form.set('user_id', OTHER_USER_ID)
  form.set('marked', '9876')
  form.set('is_read', 'false')
  return form
}

function notification(id: string, recipientId: string, isRead = false): LocalNotification {
  return {
    id,
    recipient_id: recipientId,
    actor_id: recipientId === OTHER_PROFILE_ID ? PROFILE_ID : OTHER_PROFILE_ID,
    type: 'content_hidden',
    body: 'Synthetic notification note; preserve its contents.',
    is_read: isRead,
    created_at: '2026-11-02T00:00:00.000Z',
    post_id: 'post_bulkfixture',
    comment_id: null,
    project_id: null,
    idea_id: null,
    event_id: null,
    opportunity_id: null,
    conversation_id: null,
  }
}

function fixtureStore(): FixtureStore {
  return {
    profiles: [
      { id: PROFILE_ID, user_id: USER_ID },
      { id: OTHER_PROFILE_ID, user_id: OTHER_USER_ID },
    ],
    notifications: [
      notification('ntf_ownunread', PROFILE_ID),
      notification('ntf_ownread', PROFILE_ID, true),
      notification('ntf_ownother', PROFILE_ID),
      notification('ntf_peerunread', OTHER_PROFILE_ID),
      notification('ntf_peerread', OTHER_PROFILE_ID, true),
      notification('ntf_authidtrap', USER_ID),
    ],
  }
}

function copyStore(db: FixtureStore): FixtureStore {
  return {
    profiles: db.profiles.map(profile => ({ ...profile })),
    notifications: db.notifications.map(row => ({ ...row })),
  }
}

// Record the update/projection, not a simulated policy or arbitrary-pair helper.
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

function expectScopedUpdate() {
  expect(boundary.operations).toEqual([
    ['from', 'notifications'],
    ['update', { is_read: true }],
    ['eq', 'recipient_id', USER_ID],
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

function expectSanitizedRequestFailure(outcome: MarkReadOutcome, error: unknown) {
  expect(outcome).toEqual({ ok: false, message: UNCONFIRMED })
  expect(boundary.unstableRethrow).toHaveBeenCalledExactlyOnceWith(error)
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markAll] request failed')
  expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls }))
    .not.toContain(PRIVATE_DIAGNOSTIC)
}

let store: FixtureStore

beforeEach(() => {
  vi.resetAllMocks()
  boundary.operations = []
  boundary.isLocalMode.mockReturnValue(true)
  boundary.isSupabaseConfigured.mockReturnValue(true)
  boundary.getUser.mockResolvedValue({ id: USER_ID })
  store = fixtureStore()
  boundary.mutate.mockImplementation(async callback => callback(store))
  boundary.createClient.mockResolvedValue(ordinaryClient())
  boundary.select.mockResolvedValue({ data: [], error: null })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => { vi.restoreAllMocks() })

describe('bulk read — local own-only callback contract', () => {
  it('changes only own unread flags, preserves every other field/row, and does not use the auth ID as a local recipient', async () => {
    boundary.isSupabaseConfigured.mockReturnValue(false)
    const expected = copyStore(store)
    expected.notifications[0].is_read = true
    expected.notifications[2].is_read = true

    expect(await markAllReadAction()).toEqual({ ok: true, marked: 2 })
    expect(store).toEqual(expected)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.isSupabaseConfigured).not.toHaveBeenCalled()
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expectRefreshes()
  })

  it.each([
    {
      label: 'only already-read own and foreign rows',
      arrange(db: FixtureStore) {
        for (const row of db.notifications) {
          if (row.recipient_id === PROFILE_ID) row.is_read = true
        }
      },
    },
    {
      label: 'only foreign rows',
      arrange(db: FixtureStore) {
        db.notifications = db.notifications.filter(row => row.recipient_id !== PROFILE_ID)
      },
    },
    {
      label: 'an empty notification table',
      arrange(db: FixtureStore) { db.notifications = [] },
    },
    {
      label: 'no profile for the authenticated user',
      arrange(db: FixtureStore) {
        db.profiles = db.profiles.filter(profile => profile.id !== PROFILE_ID)
      },
    },
  ])('returns legitimate zero for $label without row changes and refreshes stale surfaces', async ({ arrange }) => {
    arrange(store)
    const before = copyStore(store)
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(before)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.createClient).not.toHaveBeenCalled()
    expectRefreshes()
  })

  it('returns two then zero on a repeated request and refreshes on both calls', async () => {
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 2 })
    const afterFirst = copyStore(store)
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(afterFirst)
    expect(boundary.mutate).toHaveBeenCalledTimes(2)
    expectRefreshes(2)
  })

  it('ignores forged progressive prior state/form identity instead of narrowing or widening the bulk request', async () => {
    const expected = copyStore(store)
    expected.notifications[0].is_read = true
    expected.notifications[2].is_read = true
    expect(await markAllReadFormAction(forgedPrevious, forgedForm()))
      .toEqual({ ok: true, marked: 2 })
    expect(store).toEqual(expected)
    expectRefreshes()
  })

  it('uses the new request result rather than a previous failed message/count', async () => {
    const previous: MarkReadOutcome = { ok: false, message: PRIVATE_DIAGNOSTIC }
    const outcome = await markAllReadFormAction(previous, forgedForm())
    expect(outcome).toEqual({ ok: true, marked: 2 })
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_DIAGNOSTIC)
    expectRefreshes()
  })

  it.each([
    { label: 'negative', marked: -1 },
    { label: 'fractional', marked: 0.5 },
    { label: 'NaN', marked: Number.NaN },
    { label: 'infinite', marked: Number.POSITIVE_INFINITY },
    { label: 'unsafe integer', marked: Number.MAX_SAFE_INTEGER + 1 },
  ])('does not serialize a $label local boundary count as success', async ({ marked }) => {
    boundary.mutate.mockResolvedValue(marked)
    const before = copyStore(store)
    expect(await markAllReadAction()).toEqual({ ok: false, message: UNCONFIRMED })
    expect(store).toEqual(before)
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'rejected',
      fail(error: Error) { boundary.mutate.mockRejectedValue(error) },
    },
    {
      label: 'synchronously thrown',
      fail(error: Error) { boundary.mutate.mockImplementation(() => { throw error }) },
    },
  ])('sanitizes a $label local storage failure without modifying the fixture', async ({ fail }) => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    fail(error)
    const before = copyStore(store)
    expectSanitizedRequestFailure(await markAllReadAction(), error)
    expect(store).toEqual(before)
    expect(boundary.mutate).toHaveBeenCalledTimes(1)
    expect(boundary.createClient).not.toHaveBeenCalled()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })

  it('reports uncertain confirmation, not zero or rollback, if refresh fails after the local write', async () => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    boundary.revalidatePath.mockImplementationOnce(() => { throw error })
    expectSanitizedRequestFailure(await markAllReadAction(), error)
    expect(store.notifications.filter(row => row.recipient_id === PROFILE_ID)
      .every(row => row.is_read)).toBe(true)
    const afterWrite = copyStore(store)

    boundary.revalidatePath.mockClear()
    expect(await markAllReadAction()).toEqual({ ok: true, marked: 0 })
    expect(store).toEqual(afterWrite)
    expectRefreshes()
  })
})

describe.each([
  { label: 'local', local: true },
  { label: 'ordinary provider', local: false },
])('bulk read — $label auth refusal', ({ local }) => {
  beforeEach(() => { boundary.isLocalMode.mockReturnValue(local) })

  it('requires current auth despite forged form/prior state and does no write/refresh when signed out', async () => {
    boundary.getUser.mockResolvedValue(null)
    const before = copyStore(store)
    expect(await markAllReadFormAction(forgedPrevious, forgedForm()))
      .toEqual({ ok: false, message: 'Sign in again to mark these as read.' })
    expect(store).toEqual(before)
    expect(boundary.getUser).toHaveBeenCalledTimes(1)
    expectNoWriteOrRefresh()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('sanitizes an auth rejection before any mutation', async () => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    boundary.getUser.mockRejectedValue(error)
    expectSanitizedRequestFailure(await markAllReadFormAction(null, new FormData()), error)
    expectNoWriteOrRefresh()
  })
})

describe('bulk read — ordinary-provider request/receipt contract, not hosted authorization proof', () => {
  beforeEach(() => { boundary.isLocalMode.mockReturnValue(false) })

  it('refuses an unconfigured deployment before auth, provider creation, mutation or refresh', async () => {
    boundary.isSupabaseConfigured.mockReturnValue(false)
    expect(await markAllReadAction()).toEqual({
      ok: false,
      message: 'This deployment has no database connection, so nothing can be saved.',
    })
    expect(boundary.getUser).not.toHaveBeenCalled()
    expectNoWriteOrRefresh()
    expect(console.error).not.toHaveBeenCalled()
  })

  // Wrap array-valued receipts in objects; Vitest must not spread them into
  // unrelated callback arguments.
  it.each([
    { label: 'empty legitimate receipt', data: [], marked: 0 },
    { label: 'one UUID', data: [{ id: HOSTED_ID }], marked: 1 },
    { label: 'two distinct UUIDs', data: [{ id: OTHER_HOSTED_ID }, { id: HOSTED_ID }], marked: 2 },
  ])('counts only $label, uses the authenticated recipient and refreshes even at zero', async ({ data, marked }) => {
    boundary.select.mockResolvedValue({ data, error: null, count: null, status: 200, statusText: 'OK' })
    const before = copyStore(store)
    expect(await markAllReadFormAction(forgedPrevious, forgedForm()))
      .toEqual({ ok: true, marked })
    expectScopedUpdate()
    expect(store).toEqual(before)
    expectRefreshes()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'null data', data: null },
    { label: 'undefined data', data: undefined },
    { label: 'non-array object', data: { id: HOSTED_ID } },
    { label: 'array-like object', data: { 0: { id: HOSTED_ID }, length: 1 } },
    { label: 'string data', data: HOSTED_ID },
    { label: 'numeric data', data: 1 },
    { label: 'null row', data: [null] },
    { label: 'undefined row', data: [undefined] },
    { label: 'sparse row array', data: new Array<unknown>(1) },
    { label: 'scalar UUID row', data: [HOSTED_ID] },
    { label: 'array row', data: [[HOSTED_ID]] },
    { label: 'row missing ID', data: [{}] },
    { label: 'inherited ID field', data: [Object.create({ id: HOSTED_ID })] },
    { label: 'null ID', data: [{ id: null }] },
    { label: 'undefined ID', data: [{ id: undefined }] },
    { label: 'numeric ID', data: [{ id: 1 }] },
    { label: 'array ID', data: [{ id: [HOSTED_ID] }] },
    { label: 'empty ID', data: [{ id: '' }] },
    { label: 'whitespace ID', data: [{ id: '   ' }] },
    { label: 'non-UUID ID', data: [{ id: 'not-a-uuid' }] },
    { label: 'local ID in hosted receipt', data: [{ id: 'ntf_ownunread' }] },
    { label: 'UUID with surrounding whitespace', data: [{ id: ` ${HOSTED_ID} ` }] },
    { label: 'UUID with appended path', data: [{ id: `${HOSTED_ID}/notification` }] },
    { label: 'duplicate UUIDs', data: [{ id: HOSTED_ID }, { id: HOSTED_ID }] },
    { label: 'case-varied duplicate UUIDs', data: [{ id: HOSTED_ID }, { id: HOSTED_ID.toUpperCase() }] },
    { label: 'one valid and one malformed row', data: [{ id: HOSTED_ID }, { id: '' }] },
    { label: 'unrequested recipient projection', data: [{ id: HOSTED_ID, recipient_id: USER_ID }] },
    { label: 'unrequested symbol field', data: [{ id: HOSTED_ID, [Symbol('extra')]: true }] },
    { label: 'unrequested actor/body projection', data: [{ id: HOSTED_ID, actor_id: OTHER_USER_ID, body: PRIVATE_DIAGNOSTIC }] },
  ])('rejects $label as unconfirmed, not an invented zero or inflated count', async ({ data }) => {
    boundary.select.mockResolvedValue({ data, error: null })
    const outcome = await markAllReadAction()
    expect(outcome).toEqual({ ok: false, message: UNCONFIRMED })
    expectScopedUpdate()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_DIAGNOSTIC)
  })

  it.each([
    { label: 'null envelope', reply: null },
    { label: 'undefined envelope', reply: undefined },
    { label: 'array envelope', reply: [] },
    { label: 'string envelope', reply: PRIVATE_DIAGNOSTIC },
    { label: 'empty envelope', reply: {} },
    { label: 'missing error field', reply: { data: [] } },
    { label: 'undefined error field', reply: { data: [], error: undefined } },
    { label: 'false error field', reply: { data: [], error: false } },
    { label: 'zero error field', reply: { data: [], error: 0 } },
    { label: 'empty-string error field', reply: { data: [], error: '' } },
    { label: 'missing data field', reply: { error: null } },
    { label: 'inherited success error field', reply: Object.create({ error: null, data: [] }) },
    { label: 'inherited data field', reply: Object.setPrototypeOf({ error: null }, { data: [] }) },
  ])('rejects a $label before claiming a confirmed receipt or refreshing', async ({ reply }) => {
    boundary.select.mockResolvedValue(reply)
    const outcome = await markAllReadAction()
    expect(outcome).toEqual({ ok: false, message: UNCONFIRMED })
    expectScopedUpdate()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_DIAGNOSTIC)
  })

  it('refuses provider errors even with plausible receipt rows, logging only a fixed marker', async () => {
    boundary.select.mockResolvedValue({
      data: [{ id: HOSTED_ID }],
      error: {
        code: PRIVATE_DIAGNOSTIC,
        message: PRIVATE_DIAGNOSTIC,
        details: PRIVATE_DIAGNOSTIC,
        hint: PRIVATE_DIAGNOSTIC,
      },
    })
    const outcome = await markAllReadAction()
    expect(outcome).toEqual({ ok: false, message: FAILED })
    expectScopedUpdate()
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markAll] provider write failed')
    expect(JSON.stringify({ outcome, logs: vi.mocked(console.error).mock.calls }))
      .not.toContain(PRIVATE_DIAGNOSTIC)
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })

  it('does not inspect raw provider error diagnostics to decide or log failure', async () => {
    boundary.select.mockResolvedValue({
      data: [],
      error: {
        get code() { throw new Error(PRIVATE_DIAGNOSTIC) },
        get message() { throw new Error(PRIVATE_DIAGNOSTIC) },
      },
    })
    expect(await markAllReadAction()).toEqual({ ok: false, message: FAILED })
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[notifications:markAll] provider write failed')
    expect(boundary.unstableRethrow).not.toHaveBeenCalled()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'client creation rejection',
      fail(error: Error) { boundary.createClient.mockRejectedValue(error) },
    },
    {
      label: 'synchronous query construction throw',
      fail(error: Error) {
        boundary.createClient.mockResolvedValue({ from() { throw error } })
      },
    },
    {
      label: 'selected write response rejection',
      fail(error: Error) { boundary.select.mockRejectedValue(error) },
    },
    {
      label: 'synchronous select throw',
      fail(error: Error) { boundary.select.mockImplementation(() => { throw error }) },
    },
  ])('sanitizes a $label without exposing diagnostics or refreshing', async ({ fail }) => {
    const error = new Error(PRIVATE_DIAGNOSTIC)
    fail(error)
    expectSanitizedRequestFailure(await markAllReadAction(), error)
    expect(boundary.mutate).not.toHaveBeenCalled()
    expect(boundary.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('bulk read — Next control-flow forwarding at both compatible entry points', () => {
  it.each([
    {
      label: 'no-argument action during local auth',
      invoke: () => markAllReadAction(),
      fail(error: unknown) { boundary.getUser.mockRejectedValue(error) },
    },
    {
      label: 'progressive form during local mutation',
      invoke: () => markAllReadFormAction(forgedPrevious, forgedForm()),
      fail(error: unknown) { boundary.mutate.mockRejectedValue(error) },
    },
    {
      label: 'no-argument action during provider select',
      invoke: () => markAllReadAction(),
      fail(error: unknown) {
        boundary.isLocalMode.mockReturnValue(false)
        boundary.select.mockRejectedValue(error)
      },
    },
    {
      label: 'progressive form during revalidation',
      invoke: () => markAllReadFormAction(null, new FormData()),
      fail(error: unknown) { boundary.revalidatePath.mockImplementationOnce(() => { throw error }) },
    },
  ])('passes $label control flow to unstable_rethrow before sanitized handling', async ({ invoke, fail }) => {
    // A sentinel verifies forwarding, not Next's own error classification.
    const controlFlow = new Error('Synthetic Next control-flow sentinel')
    boundary.unstableRethrow.mockImplementation(error => {
      if (error === controlFlow) throw error
    })
    fail(controlFlow)
    await expect(invoke()).rejects.toBe(controlFlow)
    expect(boundary.unstableRethrow).toHaveBeenCalledExactlyOnceWith(controlFlow)
    expect(console.error).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Destructive-provider code is exercised ONLY through the fake Admin below.
 * No credentials, datastore, HTTP server, real Storage or Auth user is used.
 * Keep the real receipt parser/path validators; forbid all other client paths.
 */
const guards = vi.hoisted(() => ({
  admin: vi.fn(),
  sdk: vi.fn((): never => { throw new Error('S10 worker test forbids SDK construction') }),
  server: vi.fn((): never => { throw new Error('S10 worker test forbids request clients') }),
  env: vi.fn((): never => { throw new Error('S10 worker test forbids provider credentials') }),
  request: vi.fn((): never => { throw new Error('S10 worker test forbids request headers') }),
  auth: vi.fn((): never => { throw new Error('S10 worker test forbids credential flows') }),
  fetch: vi.fn(async (): Promise<never> => { throw new Error('S10 worker test forbids network') }),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: guards.admin }))
vi.mock('@/lib/supabase/server', () => ({ createClient: guards.server }))
vi.mock('@supabase/supabase-js', () => ({ createClient: guards.sdk }))
vi.mock('@/lib/env', () => ({ publicEnv: guards.env, serviceRoleKey: guards.env }))
vi.mock('next/headers', () => ({ headers: guards.request }))
vi.mock('@/lib/local/auth-security', () => ({
  authAttemptSource: guards.auth, consumeAuthAttempt: guards.auth,
}))

import {
  resumeHostedAccountDeletion, runHostedAccountCleanup,
  type HostedCleanupReport,
} from '@/features/account/cleanup-worker'
import { PRIVATE_IMAGE_BUCKET } from '@/features/uploads/contracts'

const JOB = '11111111-1111-4111-8111-111111111111'
const SUBJECT = 'abcdefab-2222-4222-8222-222222222222'
const LEASE = '33333333-3333-4333-8333-333333333333'
const IMAGE = 'abcdefab-4444-4444-8444-444444444444'
const PRIVATE_MANIFEST = '55555555-5555-4555-8555-555555555555'
const STORAGE_MANIFEST = '66666666-6666-4666-8666-666666666666'
const OTHER = '77777777-7777-4777-8777-777777777777'
const STORAGE_BUCKET = 'message-attachments'
const IMAGE_PATH = `${IMAGE}.webp`
const STORAGE_PATH = `${SUBJECT}/attachments/s10-fixture.txt`
const RAW_ERROR = 'S10-MOCK-PRIVATE-PROVIDER-ERROR'
const CLAIM = { id: JOB, subject_id: SUBJECT, phase: 'media', lease_token: LEASE }
const FENCE = { p_job: JOB, p_lease: LEASE }

type Media = {
  id: string
  source_kind: 'private_image' | 'owned_storage'
  source_id: string | null
  bucket_id: string
  object_path: string
}
type ProviderError = { message?: string; code?: string; hint?: string; status?: number }
type Reply = { data: unknown; error: ProviderError | null }
type Event = [name: string, args: unknown]
type Plan = {
  claims?: unknown[]
  batches?: unknown[]
  prepare?: unknown
  content?: unknown
  finish?: unknown
  status?: unknown
  resume?: unknown
  rpcErrors?: Record<string, ProviderError>
  rpcThrows?: string[]
  storageError?: ProviderError
  storageThrows?: boolean
  authError?: ProviderError
}

function privateMedia(overrides: Partial<Media> = {}): Media {
  return {
    id: PRIVATE_MANIFEST, source_kind: 'private_image', source_id: IMAGE,
    bucket_id: PRIVATE_IMAGE_BUCKET, object_path: IMAGE_PATH, ...overrides,
  }
}

function ownedMedia(overrides: Partial<Media> = {}): Media {
  return {
    id: STORAGE_MANIFEST, source_kind: 'owned_storage', source_id: null,
    bucket_id: STORAGE_BUCKET, object_path: STORAGE_PATH, ...overrides,
  }
}

function receipt(id: unknown = JOB, state = 'processing', phase = 'media') {
  // Deliberately overcomplete fake RPC data. Public reports must re-project it.
  return {
    id, state, phase, subject_id: SUBJECT, lease_token: LEASE,
    object_path: STORAGE_PATH, debug: RAW_ERROR,
  }
}

function fakeAdmin(plan: Plan = {}) {
  const events: Event[] = []
  const claims = plan.claims ? [...plan.claims] : [{ ...CLAIM }]
  const batches = plan.batches ? [...plan.batches] : [[privateMedia()], []]
  const reply = (data: unknown): Reply => ({ data, error: null })
  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    events.push([name, { ...args }])
    if (plan.rpcThrows?.includes(name)) throw new Error(RAW_ERROR)
    if (plan.rpcErrors?.[name]) return { data: null, error: plan.rpcErrors[name]! }
    switch (name) {
      case 'account_deletion_claim': return reply(claims.length ? claims.shift() : null)
      case 'account_deletion_prepare_media': return reply(plan.prepare ?? { ready: true })
      case 'account_deletion_media_batch': return reply(batches.length ? batches.shift() : [])
      case 'account_deletion_mark_media_removed': return reply(true)
      case 'account_deletion_cleanup_content': return reply(plan.content ?? { ready: true })
      case 'account_deletion_finish': return reply(plan.finish ?? receipt(args.p_job, 'completed', 'complete'))
      case 'account_deletion_status': return reply(plan.status ?? receipt(args.p_receipt))
      case 'account_deletion_fail':
      case 'account_deletion_yield': return reply(true)
      case 'account_deletion_resume': return reply(plan.resume ?? true)
      default: throw new Error(`Unexpected fake lifecycle RPC: ${name}`)
    }
  })
  const remove = vi.fn(async (bucket: string, paths: string[]): Promise<Reply> => {
    events.push(['storage.remove', { bucket, paths: [...paths] }])
    if (plan.storageThrows) throw new Error(RAW_ERROR)
    return { data: [], error: plan.storageError ?? null }
  })
  const from = vi.fn((bucket: string) => ({
    remove: (paths: string[]) => remove(bucket, paths),
  }))
  const deleteUser = vi.fn(async (subject: string, softDelete: boolean): Promise<Reply> => {
    events.push(['auth.deleteUser', { subject, softDelete }])
    return { data: {}, error: plan.authError ?? null }
  })
  const admin = { rpc, storage: { from }, auth: { admin: { deleteUser } } }
  guards.admin.mockImplementation(() => {
    events.push(['construct', null])
    return admin
  })
  return { events, rpc, from, remove, deleteUser }
}

function enable() {
  vi.stubEnv('BULLA_ACCOUNT_CLEANUP_ENABLED', '1')
}

function safeReport(report: HostedCleanupReport) {
  const text = JSON.stringify(report)
  for (const marker of [SUBJECT, LEASE, IMAGE, IMAGE_PATH, STORAGE_PATH, RAW_ERROR]) {
    expect(text).not.toContain(marker)
  }
  for (const value of report.receipts) {
    expect(Object.keys(value).sort()).toEqual(['id', 'phase', 'state'])
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('BULLA_ACCOUNT_CLEANUP_ENABLED', undefined)
  vi.stubEnv('BULLA_ACCOUNT_CLEANUP_BUCKETS', undefined)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined)
  guards.admin.mockImplementation(() => { throw new Error('No fake Admin installed') })
  guards.sdk.mockImplementation(() => { throw new Error('SDK construction forbidden') })
  guards.server.mockImplementation(() => { throw new Error('Request client forbidden') })
  guards.env.mockImplementation(() => { throw new Error('Provider credentials forbidden') })
  guards.request.mockImplementation(() => { throw new Error('Request headers forbidden') })
  guards.auth.mockImplementation(() => { throw new Error('Credential flow forbidden') })
  guards.fetch.mockImplementation(async () => { throw new Error('Network forbidden') })
  vi.stubGlobal('fetch', guards.fetch)
})

afterEach(() => {
  try {
    for (const guard of [guards.sdk, guards.server, guards.env, guards.request, guards.auth, guards.fetch]) {
      expect(guard).not.toHaveBeenCalled()
    }
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }
})

describe.sequential('hosted account cleanup opt-in and bounded server-only entry points', () => {
  it.each([undefined, '', '0', 'false', 'true', '01', ' 1 ', '1\n'])(
    'does not even construct Admin without the exact opt-in (%j)',
    async flag => {
      vi.stubEnv('BULLA_ACCOUNT_CLEANUP_ENABLED', flag)
      expect(await runHostedAccountCleanup()).toEqual({ enabled: false, processed: 0, receipts: [] })
      expect(await resumeHostedAccountDeletion(JOB)).toBe(false)
      expect(guards.admin).not.toHaveBeenCalled()
    },
  )

  it('refuses local mode before Admin construction even with the exact opt-in', async () => {
    enable()
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    expect(await runHostedAccountCleanup()).toEqual({ enabled: false, processed: 0, receipts: [] })
    expect(await resumeHostedAccountDeletion(JOB)).toBe(false)
    expect(guards.admin).not.toHaveBeenCalled()
  })

  it.each([
    { maxJobs: 0 }, { maxJobs: -1 }, { maxJobs: 4 }, { maxJobs: 1.5 },
    { maxJobs: Number.NaN }, { maxJobs: Number.POSITIVE_INFINITY },
    { jobId: 'not-a-job' }, { jobId: '../another-job' },
  ])('rejects invalid bounded options before constructing Admin (%j)', async options => {
    enable()
    await expect(runHostedAccountCleanup(options)).rejects.toThrow('Invalid bounded account cleanup options')
    expect(guards.admin).not.toHaveBeenCalled()
  })

  it('refuses invalid operator resume identifiers before Admin construction', async () => {
    enable()
    for (const id of ['', 'not-a-job', '../another-job']) {
      expect(await resumeHostedAccountDeletion(id)).toBe(false)
    }
    expect(guards.admin).not.toHaveBeenCalled()
  })

  it('reports unavailable configuration without forwarding the constructor error', async () => {
    enable()
    guards.admin.mockImplementation(() => { throw new Error(RAW_ERROR) })
    const report = await runHostedAccountCleanup()
    expect(report).toEqual({
      enabled: true, processed: 0, receipts: [], error: 'configuration_unavailable',
    })
    safeReport(report)
  })

  it('does not claim work when the private claim RPC fails', async () => {
    enable()
    const fake = fakeAdmin({ rpcErrors: { account_deletion_claim: { message: RAW_ERROR } } })
    const report = await runHostedAccountCleanup()
    expect(report).toEqual({
      enabled: true, processed: 0, receipts: [], error: 'provider_unavailable',
    })
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
    safeReport(report)
  })

  it.each([
    { ...CLAIM, id: 'not-a-job' },
    { ...CLAIM, subject_id: 'not-a-user' },
    { ...CLAIM, lease_token: 'not-a-lease' },
    { ...CLAIM, phase: 'complete' },
  ])('rejects a malformed claim before any cleanup (%j)', async claim => {
    enable()
    const fake = fakeAdmin({ claims: [claim] })
    const report = await runHostedAccountCleanup()
    expect(report).toEqual({
      enabled: true, processed: 0, receipts: [], error: 'provider_unavailable',
    })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
    safeReport(report)
  })

  it('bounds a general operator invocation to three exact claimed subjects', async () => {
    enable()
    const claims = [1, 2, 3, 4].map(value => ({
      ...CLAIM,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`,
      subject_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(value).padStart(12, '0')}`,
      lease_token: `cccccccc-cccc-4ccc-8ccc-${String(value).padStart(12, '0')}`,
    }))
    const fake = fakeAdmin({ claims, batches: [] })
    const report = await runHostedAccountCleanup({ maxJobs: 3 })
    expect(guards.admin).toHaveBeenCalledTimes(1)
    expect(fake.rpc.mock.calls.filter(([name]) => name === 'account_deletion_claim')).toHaveLength(3)
    expect(fake.deleteUser.mock.calls).toEqual(claims.slice(0, 3).map(value => [value.subject_id, false]))
    expect(report).toEqual({
      enabled: true, processed: 3,
      receipts: claims.slice(0, 3).map(value => ({ id: value.id, state: 'completed', phase: 'complete' })),
    })
    safeReport(report)
  })
})

describe.sequential('fake hosted cleanup exact manifests, ordering and privacy', () => {
  it('removes exact Storage keys before content/Auth, acknowledges exact manifest IDs, and uses a hard delete', async () => {
    enable()
    vi.stubEnv('BULLA_ACCOUNT_CLEANUP_BUCKETS', `${PRIVATE_IMAGE_BUCKET},${STORAGE_BUCKET}`)
    const fake = fakeAdmin({ batches: [[privateMedia(), ownedMedia()], []] })
    const report = await runHostedAccountCleanup({ jobId: JOB, maxJobs: 3 })
    expect(fake.events).toEqual([
      ['construct', null],
      ['account_deletion_claim', { p_job: JOB }],
      ['account_deletion_prepare_media', FENCE],
      ['account_deletion_media_batch', FENCE],
      ['storage.remove', { bucket: PRIVATE_IMAGE_BUCKET, paths: [IMAGE_PATH] }],
      ['account_deletion_mark_media_removed', { ...FENCE, p_media: PRIVATE_MANIFEST }],
      ['storage.remove', { bucket: STORAGE_BUCKET, paths: [STORAGE_PATH] }],
      ['account_deletion_mark_media_removed', { ...FENCE, p_media: STORAGE_MANIFEST }],
      ['account_deletion_media_batch', FENCE],
      ['account_deletion_cleanup_content', FENCE],
      ['auth.deleteUser', { subject: SUBJECT, softDelete: false }],
      ['account_deletion_finish', FENCE],
    ])
    // Explicit job selection never fans out even if maxJobs is three.
    expect(fake.rpc.mock.calls.filter(([name]) => name === 'account_deletion_claim')).toHaveLength(1)
    expect(report).toEqual({
      enabled: true, processed: 1,
      receipts: [{ id: JOB, state: 'completed', phase: 'complete' }],
    })
    safeReport(report)
  })

  it.each([
    { name: 'foreign bucket', value: privateMedia({ bucket_id: 'public' }) },
    { name: 'foreign image path', value: privateMedia({ object_path: `${OTHER}.webp` }) },
    { name: 'image URL rather than key', value: privateMedia({ object_path: `/api/images/${IMAGE}` }) },
    { name: 'wrong image extension', value: privateMedia({ object_path: `${IMAGE}.png` }) },
    { name: 'uppercase image ID', value: privateMedia({ source_id: IMAGE.toUpperCase(), object_path: `${IMAGE.toUpperCase()}.webp` }) },
    { name: 'non-v4 image ID', value: privateMedia({ source_id: OTHER.replace('-4777-', '-1777-'), object_path: `${OTHER.replace('-4777-', '-1777-')}.webp` }) },
    { name: 'missing image ID', value: privateMedia({ source_id: null }) },
    { name: 'invalid manifest ID', value: privateMedia({ id: 'not-a-manifest' }) },
    { name: 'unknown source kind', value: { ...privateMedia(), source_kind: 'browser_path' } },
    { name: 'other subject prefix', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${OTHER}/fixture.txt` }) },
    { name: 'case-changed subject prefix', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT.toUpperCase()}/fixture.txt` }) },
    { name: 'traversal segment', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}/../fixture.txt` }) },
    { name: 'dot segment', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}/./fixture.txt` }) },
    { name: 'empty segment', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}//fixture.txt` }) },
    { name: 'backslash', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}/folder\\fixture.txt` }) },
    { name: 'control character', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}/fixture\u0000.txt` }) },
    { name: 'oversize key', value: ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET, object_path: `${SUBJECT}/${'a'.repeat(1025)}` }) },
    { name: 'null manifest', value: null },
  ])('validates the entire batch before removing any bytes: $name', async ({ value }) => {
    enable()
    // A valid first row MUST remain untouched when a later row is unsafe.
    const fake = fakeAdmin({ batches: [[privateMedia(), value]], status: receipt(JOB, 'blocked') })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_mark_media_removed', expect.anything())
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_cleanup_content', expect.anything())
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', {
      ...FENCE, p_code: 'media_ownership_review',
    })
    expect(report.receipts).toEqual([{ id: JOB, state: 'blocked', phase: 'media' }])
    safeReport(report)
  })

  it.each([
    { name: 'more than fifty objects', batch: Array.from({ length: 51 }, () => privateMedia()) },
    { name: 'non-array manifest', batch: { objects: [privateMedia()] } },
  ])('refuses unbounded/malformed batches before bytes or Auth: $name', async ({ batch }) => {
    enable()
    const fake = fakeAdmin({ batches: [batch], status: receipt(JOB, 'retry') })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', {
      ...FENCE, p_code: 'media_cleanup_failed',
    })
    safeReport(report)
  })

  it.each([' ', ',', '../private', 'BULLA-private'])(
    'refuses a malformed operator bucket allowlist (%j)',
    async buckets => {
      enable()
      vi.stubEnv('BULLA_ACCOUNT_CLEANUP_BUCKETS', buckets)
      const fake = fakeAdmin({ status: receipt(JOB, 'blocked') })
      const report = await runHostedAccountCleanup({ jobId: JOB })
      expect(fake.remove).not.toHaveBeenCalled()
      expect(fake.deleteUser).not.toHaveBeenCalled()
      expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', {
        ...FENCE, p_code: 'media_ownership_review',
      })
      safeReport(report)
    },
  )

  it('does not acknowledge media, clean content or delete Auth after a Storage error', async () => {
    enable()
    const fake = fakeAdmin({
      storageError: { message: RAW_ERROR, status: 500 }, status: receipt(JOB, 'retry'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.remove).toHaveBeenCalledExactlyOnceWith(PRIVATE_IMAGE_BUCKET, [IMAGE_PATH])
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_mark_media_removed', expect.anything())
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_cleanup_content', expect.anything())
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', {
      ...FENCE, p_code: 'media_cleanup_failed',
    })
    expect(report.receipts).toEqual([{ id: JOB, state: 'retry', phase: 'media' }])
    safeReport(report)
  })

  it('keeps thrown Storage transport errors private and incomplete', async () => {
    enable()
    const fake = fakeAdmin({ storageThrows: true, status: receipt(JOB, 'retry') })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_mark_media_removed', expect.anything())
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: 'cleanup_failed' })
    expect(report.receipts[0]!.state).toBe('retry')
    safeReport(report)
  })

  it('does not advance past a failed manifest acknowledgement after Storage succeeds', async () => {
    enable()
    const fake = fakeAdmin({
      rpcErrors: { account_deletion_mark_media_removed: { message: RAW_ERROR } },
      status: receipt(JOB, 'retry'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.remove).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_mark_media_removed', {
      ...FENCE, p_media: PRIVATE_MANIFEST,
    })
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_cleanup_content', expect.anything())
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: 'cleanup_failed' })
    safeReport(report)
  })

  it('keeps an ownership-blocked preparation incomplete without touching Storage or Auth', async () => {
    enable()
    const fake = fakeAdmin({ prepare: { ready: false }, status: receipt(JOB, 'blocked') })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_media_batch', expect.anything())
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_fail', expect.anything())
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(report.receipts).toEqual([{ id: JOB, state: 'blocked', phase: 'media' }])
    safeReport(report)
  })

  it.each(['media_ownership_review', 'shared_media_ownership'])(
    'persists only the fixed ownership refusal %s',
    async hint => {
      enable()
      const fake = fakeAdmin({
        rpcErrors: { account_deletion_prepare_media: { hint, message: RAW_ERROR } },
        status: receipt(JOB, 'blocked'),
      })
      const report = await runHostedAccountCleanup({ jobId: JOB })
      expect(fake.remove).not.toHaveBeenCalled()
      expect(fake.deleteUser).not.toHaveBeenCalled()
      expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: hint })
      safeReport(report)
    },
  )

  it('yields remaining media through the fenced RPC and does not advance to content/Auth', async () => {
    enable()
    const fake = fakeAdmin({
      batches: [[privateMedia()], [ownedMedia({ bucket_id: PRIVATE_IMAGE_BUCKET })]],
      status: receipt(JOB, 'queued'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.remove).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_yield', FENCE)
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_fail', expect.anything())
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_cleanup_content', expect.anything())
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(report.receipts).toEqual([{ id: JOB, state: 'queued', phase: 'media' }])
    safeReport(report)
  })

  it('does not delete Auth when content cleanup rechecks ownership and is not ready', async () => {
    enable()
    const fake = fakeAdmin({
      batches: [], content: { ready: false }, status: receipt(JOB, 'blocked', 'content'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_cleanup_content', FENCE)
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_finish', expect.anything())
    expect(report.receipts).toEqual([{ id: JOB, state: 'blocked', phase: 'content' }])
    safeReport(report)
  })

  it('treats Auth 404 as retry-safe and finishes only through the fenced completion RPC', async () => {
    enable()
    const fake = fakeAdmin({ authError: { status: 404, message: RAW_ERROR }, batches: [] })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith(SUBJECT, false)
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_finish', FENCE)
    expect(report.receipts).toEqual([{ id: JOB, state: 'completed', phase: 'complete' }])
    safeReport(report)
  })

  it('does not claim completion on any other Auth failure', async () => {
    enable()
    const fake = fakeAdmin({
      authError: { status: 503, message: RAW_ERROR }, batches: [],
      status: receipt(JOB, 'retry', 'auth'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith(SUBJECT, false)
    expect(fake.rpc).not.toHaveBeenCalledWith('account_deletion_finish', expect.anything())
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: 'provider_unavailable' })
    expect(report.receipts).toEqual([{ id: JOB, state: 'retry', phase: 'auth' }])
    safeReport(report)
  })

  it('does not relabel lost finish/status responses as completed or leak raw transport errors', async () => {
    enable()
    const fake = fakeAdmin({
      batches: [], rpcThrows: ['account_deletion_finish', 'account_deletion_status'],
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.deleteUser).toHaveBeenCalledExactlyOnceWith(SUBJECT, false)
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: 'cleanup_failed' })
    expect(report.receipts).toEqual([{ id: JOB, state: 'processing', phase: 'media' }])
    safeReport(report)
  })

  it('does not claim completion for a malformed finish receipt even after Auth succeeds', async () => {
    enable()
    const fake = fakeAdmin({
      batches: [], finish: { id: 'not-a-receipt', state: 'completed', phase: 'complete' },
      status: receipt(JOB, 'processing', 'auth'),
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.rpc).toHaveBeenCalledWith('account_deletion_fail', { ...FENCE, p_code: 'provider_unavailable' })
    expect(report.receipts).toEqual([{ id: JOB, state: 'processing', phase: 'auth' }])
    safeReport(report)
  })

  it('falls back to incomplete processing if failure persistence and status lookup both fail', async () => {
    enable()
    const fake = fakeAdmin({
      storageError: { message: RAW_ERROR },
      rpcErrors: { account_deletion_fail: { message: RAW_ERROR }, account_deletion_status: { message: RAW_ERROR } },
    })
    const report = await runHostedAccountCleanup({ jobId: JOB })
    expect(fake.deleteUser).not.toHaveBeenCalled()
    expect(report.receipts).toEqual([{ id: JOB, state: 'processing', phase: 'media' }])
    safeReport(report)
  })
})

describe.sequential('explicit fake hosted operator resume never bypasses ownership', () => {
  it('resumes only the exact job through the service RPC, without doing cleanup itself', async () => {
    enable()
    const fake = fakeAdmin()
    expect(await resumeHostedAccountDeletion(JOB)).toBe(true)
    expect(fake.events).toEqual([
      ['construct', null], ['account_deletion_resume', { p_job: JOB }],
    ])
    expect(fake.remove).not.toHaveBeenCalled()
    expect(fake.deleteUser).not.toHaveBeenCalled()
  })

  it.each(['media_ownership_review', 'shared_media_ownership'])(
    'does not override a provider ownership refusal on resume (%s)',
    async hint => {
      enable()
      const fake = fakeAdmin({
        rpcErrors: { account_deletion_resume: { hint, message: RAW_ERROR } },
      })
      expect(await resumeHostedAccountDeletion(JOB)).toBe(false)
      expect(fake.rpc).toHaveBeenCalledExactlyOnceWith('account_deletion_resume', { p_job: JOB })
      expect(fake.remove).not.toHaveBeenCalled()
      expect(fake.deleteUser).not.toHaveBeenCalled()
    },
  )
})

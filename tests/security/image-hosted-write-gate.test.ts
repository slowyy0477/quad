import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ client: vi.fn(), admin: vi.fn(), key: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('../../src/lib/supabase/server', () => ({ createClient: mocks.client }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }))
vi.mock('../../src/lib/env', () => ({ hasServiceRoleKey: mocks.key }))

import { createSupabaseImageBackend } from '../../src/features/uploads/supabase'

const actorId = '7dd1c344-ab36-4cb2-b833-c23f41d056b0'
const ok = (data: unknown) => ({ data, error: null })

function profileQuery(value: unknown) {
  const builder = {
    select: vi.fn(() => builder), eq: vi.fn(() => builder), is: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(value),
  }
  return builder
}

let admin: {
  rpc: ReturnType<typeof vi.fn>
  from: ReturnType<typeof vi.fn>
  storage: { getBucket: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> }
}
let profile: ReturnType<typeof profileQuery>
let storage: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.key.mockReturnValue(true)
  profile = profileQuery(ok({ id: actorId, status: 'active', suspended_until: null }))
  storage = { upload: vi.fn(), remove: vi.fn() }
  admin = {
    rpc: vi.fn().mockResolvedValue(ok({ version: 1, enabled: false, code: 'hosted_image_uploads_disabled' })),
    from: vi.fn(),
    storage: { getBucket: vi.fn(), from: vi.fn().mockReturnValue(storage) },
  }
  mocks.client.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue(ok({ user: { id: actorId } })) },
    from: vi.fn().mockReturnValue(profile),
  })
  mocks.admin.mockReturnValue(admin)
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real provider calls in hosted image gate tests'))
})

afterEach(() => { vi.restoreAllMocks() })

function noStorageOrCleanup() {
  expect(admin.from).not.toHaveBeenCalled()
  expect(admin.storage.getBucket).not.toHaveBeenCalled()
  expect(admin.storage.from).not.toHaveBeenCalled()
  expect(storage.upload).not.toHaveBeenCalled()
  expect(storage.remove).not.toHaveBeenCalled()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(admin.rpc).toHaveBeenCalledOnce()
  expect(admin.rpc).toHaveBeenCalledWith('bulla_image_upload_readiness')
}

describe('hosted image write gate (mocked transport, no test/runtime bypass)', () => {
  it('refuses writes before any reservation or deletion, preserving committed and neighbor objects', async () => {
    const syntheticObjects = new Map([
      ['6d486149-e87b-4e81-b341-a006f11c7d3d.webp', 'SYNTHETIC_COMMITTED'],
      ['8e2a3c7f-8175-4e6e-a3c3-d9f1b1407eb1.webp', 'SYNTHETIC_NEIGHBOR'],
    ])
    const before = [...syntheticObjects]
    storage.remove.mockImplementation(async (paths: string[]) => {
      paths.forEach(name => syntheticObjects.delete(name))
      return ok([])
    })
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({
      status: 503, code: 'hosted_image_uploads_disabled',
    })
    noStorageOrCleanup()
    expect([...syntheticObjects]).toEqual(before)
  })

  it.each([
    null, {}, [], true,
    { version: 1, enabled: 'true' },
    { version: '1', enabled: true },
    { version: 2, enabled: true },
  ])('fails closed on missing/malformed readiness: %o', async capability => {
    admin.rpc.mockResolvedValue(ok(capability))
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({
      status: 503, code: 'hosted_image_uploads_disabled',
    })
    noStorageOrCleanup()
  })

  it('keeps writes disabled when migration/readiness lookup is unavailable', async () => {
    admin.rpc.mockResolvedValue({ data: null, error: { message: 'Synthetic missing migration' } })
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({
      status: 503, code: 'hosted_image_uploads_disabled',
    })
    noStorageOrCleanup()
  })

  it('reaches the disabled gate after an expired temporary suspension without altering profile state', async () => {
    const syntheticProfile = { id: actorId, status: 'suspended', suspended_until: new Date(Date.now() - 60_000).toISOString() }
    const before = { ...syntheticProfile }
    profile.maybeSingle.mockResolvedValue(ok(syntheticProfile))
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({
      status: 503, code: 'hosted_image_uploads_disabled',
    })
    noStorageOrCleanup()
    expect(syntheticProfile).toEqual(before)
  })

  it.each([
    { id: actorId, status: 'suspended', suspended_until: new Date(Date.now() + 86_400_000).toISOString() },
    { id: actorId, status: 'suspended', suspended_until: null },
    { id: actorId, status: 'suspended', suspended_until: 'not-a-date' },
    { id: actorId, status: 'banned', suspended_until: new Date(0).toISOString() },
    { id: actorId, status: 'deactivated', suspended_until: new Date(0).toISOString() },
    { id: '8e2a3c7f-8175-4e6e-a3c3-d9f1b1407eb1', status: 'active', suspended_until: null },
  ])('denies an unavailable/forged own profile before service construction: %o', async value => {
    profile.maybeSingle.mockResolvedValue(ok(value))
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({ status: 403, code: 'upload_denied' })
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('does not gate authorized-read backend construction on a service key or mutation readiness', async () => {
    mocks.key.mockReturnValue(false)
    await expect(createSupabaseImageBackend(false)).resolves.toBeDefined()
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })
})

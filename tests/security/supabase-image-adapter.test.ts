import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), createAdmin: vi.fn(), hasKey: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('../../src/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdmin }))
vi.mock('../../src/lib/env', () => ({ hasServiceRoleKey: mocks.hasKey }))

import { createSupabaseImageBackend } from '../../src/features/uploads/supabase'
import { PRIVATE_IMAGE_BUCKET } from '../../src/features/uploads/contracts'

const actorId = '7dd1c344-ab36-4cb2-b833-c23f41d056b0'
const id = '6d486149-e87b-4e81-b341-a006f11c7d3d'
const projectId = '8e2a3c7f-8175-4e6e-a3c3-d9f1b1407eb1'
const data = Buffer.from('SYNTHETIC_WEBP_BUFFER_FOR_ADAPTER_CONTRACT_ONLY')
const normalized = {
  data, width: 120, height: 80, bytes: data.length, contentType: 'image/webp' as const,
  sha256: createHash('sha256').update(data).digest('hex'),
}
const reservation = {
  id, kind: 'avatar' as const, ownerId: actorId, actorId, profileId: actorId, projectId: null,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
}
const saved = { id, url: `/api/images/${id}`, kind: 'avatar', width: 120, height: 80, bytes: data.length, contentType: 'image/webp' }
const record = { id, kind: 'avatar', state: 'ready', width: 120, height: 80, byte_count: data.length, sha256: normalized.sha256 }
const ok = (data: unknown) => ({ data, error: null })

/** Fluent query mock only; it cannot contact PostgREST or store real bytes. */
function query(value: unknown) {
  const response = Promise.resolve(value)
  const builder = {
    select: vi.fn(() => builder), eq: vi.fn(() => builder), is: vi.fn(() => builder),
    or: vi.fn(() => builder), limit: vi.fn(() => builder),
    maybeSingle: vi.fn(() => response),
    then: response.then.bind(response),
  }
  return builder
}

let user: {
  auth: { getUser: ReturnType<typeof vi.fn> }
  from: ReturnType<typeof vi.fn>
  storage: { from: ReturnType<typeof vi.fn> }
}
let admin: {
  rpc: ReturnType<typeof vi.fn>
  from: ReturnType<typeof vi.fn>
  storage: { getBucket: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> }
}
let writeStorage: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
let readStorage: { download: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.hasKey.mockReturnValue(true)
  writeStorage = { upload: vi.fn().mockResolvedValue(ok({ path: `${id}.webp` })), remove: vi.fn().mockResolvedValue(ok([])) }
  readStorage = { download: vi.fn().mockResolvedValue(ok(new Blob([data], { type: 'image/webp' }))) }
  user = {
    auth: { getUser: vi.fn().mockResolvedValue(ok({ user: { id: actorId } })) },
    from: vi.fn().mockImplementation(() => query(ok({ id: actorId, status: 'active', suspended_until: null }))),
    storage: { from: vi.fn().mockReturnValue(readStorage) },
  }
  admin = {
    rpc: vi.fn().mockImplementation(async (name: string) => {
      // Synthetic capability ONLY, to retain lower-level adapter contract
      // coverage. Real migration 0032 returns false; the new gate regressions
      // exercise that refusal without an environment/auth bypass.
      if (name === 'bulla_image_upload_readiness') return ok({ version: 1, enabled: true })
      if (name === 'bulla_reserve_image') return ok(reservation)
      if (name === 'bulla_commit_image') return ok(saved)
      if (name === 'bulla_retire_image') return ok(true)
      if (name === 'bulla_forget_image') return ok(true)
      throw new Error('Unknown mock RPC')
    }),
    from: vi.fn().mockImplementation(() => query(ok([]))),
    storage: {
      getBucket: vi.fn().mockResolvedValue(ok({ public: false, file_size_limit: 2097152, allowed_mime_types: ['image/webp'] })),
      from: vi.fn().mockReturnValue(writeStorage),
    },
  }
  mocks.createClient.mockResolvedValue(user)
  mocks.createAdmin.mockReturnValue(admin)
  // Belt-and-braces: a mock accidentally escaping to HTTP fails immediately.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real provider calls in image tests'))
})

afterEach(() => { vi.restoreAllMocks() })

describe('hosted adapter contract (mocked provider; not hosted evidence)', () => {
  it('returns 503 with no service key and never offers raw client uploads', async () => {
    mocks.hasKey.mockReturnValue(false)
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({ status: 503 })
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.createAdmin).not.toHaveBeenCalled()
  })

  it('verifies the user and active own profile before constructing the service client', async () => {
    user.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({ status: 401 })
    expect(mocks.createAdmin).not.toHaveBeenCalled()
    user.auth.getUser.mockResolvedValue(ok({ user: { id: actorId } }))
    user.from.mockReturnValue(query(ok(null)))
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({ status: 403 })
    expect(mocks.createAdmin).not.toHaveBeenCalled()
  })

  it.each([
    { public: true, file_size_limit: 2097152, allowed_mime_types: ['image/webp'] },
    { public: false, file_size_limit: null, allowed_mime_types: ['image/webp'] },
    { public: false, file_size_limit: 2097152, allowed_mime_types: ['image/png', 'image/webp'] },
    null,
  ])('fails closed on a missing/public/unrestricted bucket: %o', async bucket => {
    admin.storage.getBucket.mockResolvedValue(ok(bucket))
    await expect(createSupabaseImageBackend(true)).rejects.toMatchObject({ status: 503 })
    expect(admin.storage.getBucket).toHaveBeenCalledWith(PRIVATE_IMAGE_BUCKET)
    expect(writeStorage.upload).not.toHaveBeenCalled()
  })

  it('passes only the verified actor and route target to the fixed reservation RPC', async () => {
    const backend = await createSupabaseImageBackend(true)
    expect(await backend.reserve({ kind: 'avatar' })).toEqual(reservation)
    expect(admin.rpc).toHaveBeenCalledWith('bulla_reserve_image', { p_actor: actorId, p_kind: 'avatar', p_project: null })
    await expect(backend.reserve({ kind: 'project-cover', projectId: '../private' })).rejects.toMatchObject({ status: 403 })
  })

  it.each([
    ['upload_denied', 403], ['upload_rate_limited', 429], ['image_quota_exceeded', 409],
  ])('maps mandatory server reservation denial %s to %s', async (code, status) => {
    const backend = await createSupabaseImageBackend(true)
    admin.rpc.mockResolvedValue(ok({ error: code }))
    await expect(backend.reserve({ kind: 'avatar' })).rejects.toMatchObject({ status })
  })

  it('rejects forged/incoherent reservation responses instead of adopting association fields', async () => {
    const backend = await createSupabaseImageBackend(true)
    admin.rpc.mockResolvedValue(ok({ ...reservation, actorId: projectId }))
    await expect(backend.reserve({ kind: 'avatar' })).rejects.toMatchObject({ status: 503 })
    admin.rpc.mockResolvedValue(ok({ ...reservation, id: '../private' }))
    await expect(backend.reserve({ kind: 'avatar' })).rejects.toMatchObject({ status: 503 })
  })

  it('uploads only normalized server buffers with no overwrite and commits exact metadata', async () => {
    const backend = await createSupabaseImageBackend(true)
    const slot = await backend.reserve({ kind: 'avatar' })
    await backend.publish(slot, normalized)
    expect(writeStorage.upload).toHaveBeenCalledWith(`${id}.webp`, data, { contentType: 'image/webp', upsert: false, cacheControl: '0' })
    expect(await backend.commit(slot, normalized)).toEqual(saved)
    expect(admin.rpc).toHaveBeenCalledWith('bulla_commit_image', {
      p_id: id, p_actor: actorId, p_sha256: normalized.sha256, p_bytes: data.length, p_width: 120, p_height: 80,
    })
    expect(user.storage.from).not.toHaveBeenCalled()
  })

  it('retirement prevents rollback from deleting an image whose commit actually succeeded', async () => {
    const backend = await createSupabaseImageBackend(true)
    admin.rpc.mockImplementation(async (name: string) => ok(name === 'bulla_retire_image' ? false : saved))
    await backend.rollback(reservation)
    expect(writeStorage.remove).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalledWith('bulla_forget_image', expect.anything())
  })

  it('removes failed normalized bytes before forgetting retired metadata', async () => {
    const backend = await createSupabaseImageBackend(true)
    await backend.rollback(reservation)
    expect(writeStorage.remove).toHaveBeenCalledWith([`${id}.webp`])
    expect(admin.rpc).toHaveBeenCalledWith('bulla_forget_image', { p_id: id })
    expect(writeStorage.remove.mock.invocationCallOrder[0]).toBeLessThan(
      admin.rpc.mock.invocationCallOrder[admin.rpc.mock.calls.findIndex(([name]) => name === 'bulla_forget_image')],
    )
  })

  it('retains metadata/quota charges when object deletion fails', async () => {
    writeStorage.remove.mockResolvedValue({ data: null, error: { message: 'synthetic unavailable' } })
    const backend = await createSupabaseImageBackend(true)
    await backend.rollback(reservation)
    expect(admin.rpc).not.toHaveBeenCalledWith('bulla_forget_image', expect.anything())
  })

  it('preserves a pre-existing object on an exclusive-upload collision', async () => {
    writeStorage.upload.mockResolvedValue({ data: null, error: { statusCode: '409', message: 'Object already exists' } })
    const backend = await createSupabaseImageBackend(true)
    await expect(backend.publish(reservation, normalized)).rejects.toMatchObject({ status: 503 })
    await backend.rollback(reservation)
    expect(writeStorage.remove).not.toHaveBeenCalled()
  })

  it('does not use service role for authorized image reads, including when no write key exists', async () => {
    mocks.hasKey.mockReturnValue(false)
    user.from.mockReturnValueOnce(query(ok(record))).mockReturnValueOnce(query(ok({ id })))
    const backend = await createSupabaseImageBackend(false)
    expect(await backend.read(id)).toEqual({ image: saved, data })
    expect(user.storage.from).toHaveBeenCalledWith(PRIVATE_IMAGE_BUCKET)
    expect(mocks.createAdmin).not.toHaveBeenCalled()
    expect(readStorage.download).toHaveBeenCalledWith(`${id}.webp`)
  })

  it('rechecks RLS after download and never delivers a revoked/stale grant', async () => {
    user.from.mockReturnValueOnce(query(ok(record))).mockReturnValueOnce(query(ok(null)))
    const backend = await createSupabaseImageBackend(false)
    expect(await backend.read(id)).toBeNull()
    expect(readStorage.download).toHaveBeenCalledOnce()
  })

  it('does not download unreadable metadata and refuses tampered/oversized objects', async () => {
    user.from.mockReturnValueOnce(query(ok(null)))
    const backend = await createSupabaseImageBackend(false)
    expect(await backend.read(id)).toBeNull()
    expect(readStorage.download).not.toHaveBeenCalled()
    user.from.mockReturnValueOnce(query(ok(record)))
    readStorage.download.mockResolvedValue(ok(new Blob([new Uint8Array(data.length + 1)], { type: 'image/webp' })))
    await expect(backend.read(id)).rejects.toMatchObject({ status: 503 })
    user.from.mockReturnValueOnce(query(ok(record)))
    readStorage.download.mockResolvedValue(ok(new Blob([new Uint8Array(data.length)], { type: 'image/webp' })))
    await expect(backend.read(id)).rejects.toMatchObject({ status: 503 })
  })
})

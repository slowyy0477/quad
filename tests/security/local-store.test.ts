import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

vi.mock('server-only', () => ({}))

let directory: string
let fixture: TempWorkspace | undefined
let target: string
let store: typeof import('../../src/lib/local/db')

beforeEach(async () => {
  fixture = undefined
  fixture = await createTempWorkspace('store')
  directory = fixture.directory
  target = path.join(directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_DIR', directory)
  vi.stubEnv('LOCAL_DATA_FILE', target)
  vi.stubEnv('LOCAL_DATA_PATH', target)
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  vi.resetModules()
  store = await import('../../src/lib/local/db')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  store?.resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('durable local store', () => {
  it('refuses corrupt data instead of silently replacing user accounts with an empty store', async () => {
    await fs.writeFile(target, '{broken-json', 'utf8')
    await expect(store.readStore()).rejects.toThrow()
    expect(await fs.readFile(target, 'utf8')).toBe('{broken-json')
  })

  it('rolls back a failed transaction and still accepts the next write', async () => {
    await expect(store.mutate((db) => {
      db.users.push({ id: 'discard', email: 'discard@example.test', password_hash: 'fixture', created_at: '2026-01-01' })
      throw new Error('reject transaction')
    })).rejects.toThrow('reject transaction')
    expect((await store.readStore()).users).toHaveLength(0)
    await store.mutate((db) => db.users.push({ id: 'keep', email: 'keep@example.test', password_hash: 'fixture', created_at: '2026-01-01' }))
    expect((await store.readStore()).users.map((u) => u.id)).toEqual(['keep'])
  })

  it('preserves both writers when independent server modules update the same file', async () => {
    await store.mutate(() => undefined)
    vi.resetModules()
    const other = await import('../../src/lib/local/db')
    await Promise.all([
      store.mutate(async (db) => {
        await new Promise((resolve) => setTimeout(resolve, 35))
        db.users.push({ id: 'first', email: 'first@example.test', password_hash: 'fixture', created_at: '2026-01-01' })
      }),
      other.mutate((db) => db.users.push({ id: 'second', email: 'second@example.test', password_hash: 'fixture', created_at: '2026-01-01' })),
    ])
    expect(JSON.parse(await fs.readFile(target, 'utf8')).users.map((u: { id: string }) => u.id).sort()).toEqual(['first', 'second'])
  })

  it('keeps the old durable snapshot when the atomic commit fails', async () => {
    await store.mutate(() => undefined)
    const before = await fs.readFile(target, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated disk failure'))
    await expect(store.mutate((db) => db.users.push({ id: 'never', email: 'never@example.test', password_hash: 'fixture', created_at: '2026-01-01' }))).rejects.toThrow('simulated disk failure')
    expect(await fs.readFile(target, 'utf8')).toBe(before)
    expect((await store.readStore()).users).toHaveLength(0)
  })

  it('honours the configured isolated store path and commits there', async () => {
    await store.mutate((db) => db.users.push({ id: 'u1', email: 'one@example.test', password_hash: 'fixture', created_at: '2026-01-01' }))
    const persisted = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(persisted.users.map((u: { id: string }) => u.id)).toEqual(['u1'])
  })
})

describe('isolated test workspaces', () => {
  it('prefers the Bulla root over legacy roots and creates it when missing', async () => {
    const root = path.join(directory, 'bulla-root')
    const quadRoot = path.join(directory, 'quad-root')
    const authRoot = path.join(directory, 'auth-root')
    vi.stubEnv('BULLA_TEST_TMP_DIR', root)
    vi.stubEnv('QUAD_TEST_TMP_DIR', quadRoot)
    vi.stubEnv('AUTH_TEST_ROOT', authRoot)
    const workspace = await createTempWorkspace('precedence', process.env.AUTH_TEST_ROOT)
    try {
      expect(path.dirname(workspace.directory)).toBe(await fs.realpath(root))
      await expect(fs.stat(quadRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(authRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('supports QUAD_TEST_TMP_DIR when the Bulla override is absent', async () => {
    const root = path.join(directory, 'legacy-quad')
    vi.stubEnv('BULLA_TEST_TMP_DIR', undefined)
    vi.stubEnv('QUAD_TEST_TMP_DIR', root)
    const workspace = await createTempWorkspace('legacy')
    try {
      expect(path.dirname(workspace.directory)).toBe(await fs.realpath(root))
    } finally {
      await workspace.cleanup()
    }
  })

  it('supports the auth-specific legacy root without requiring a particular drive', async () => {
    const root = path.join(directory, 'legacy-auth')
    vi.stubEnv('BULLA_TEST_TMP_DIR', undefined)
    vi.stubEnv('AUTH_TEST_ROOT', root)
    vi.stubEnv('QUAD_TEST_TMP_DIR', path.join(directory, 'legacy-quad'))
    const workspace = await createTempWorkspace('auth', process.env.AUTH_TEST_ROOT)
    try {
      expect(path.dirname(workspace.directory)).toBe(await fs.realpath(root))
    } finally {
      await workspace.cleanup()
    }
  })

  it('falls back to the platform temporary directory without creating fixtures outside this test', async () => {
    const root = path.join(directory, 'platform-tmp')
    vi.stubEnv('BULLA_TEST_TMP_DIR', undefined)
    vi.stubEnv('QUAD_TEST_TMP_DIR', undefined)
    vi.spyOn(os, 'tmpdir').mockReturnValue(root)
    const workspace = await createTempWorkspace('portable')
    try {
      expect(path.dirname(workspace.directory)).toBe(await fs.realpath(root))
    } finally {
      await workspace.cleanup()
    }
  })

  it.each(['relative-fixtures', path.join('..', 'fixtures'), 'C:drive-relative'])('rejects a relative root %s before touching the filesystem', async (root) => {
    vi.stubEnv('BULLA_TEST_TMP_DIR', root)
    const mkdir = vi.spyOn(fs, 'mkdir')
    await expect(createTempWorkspace('invalid')).rejects.toThrow('absolute path')
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('isolates concurrent fixtures and cleans up only its own directory, idempotently', async () => {
    vi.stubEnv('BULLA_TEST_TMP_DIR', path.join(directory, 'shared-root'))
    const workspaces = await Promise.all([createTempWorkspace('parallel'), createTempWorkspace('parallel')])
    try {
      const [first, second] = workspaces
      expect(first.directory).not.toBe(second.directory)
      await fs.writeFile(path.join(first.directory, 'fixture.txt'), 'first')
      await fs.writeFile(path.join(second.directory, 'fixture.txt'), 'second')
      await first.cleanup()
      await first.cleanup()
      await expect(fs.stat(first.directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(path.join(second.directory, 'fixture.txt'), 'utf8')).toBe('second')
    } finally {
      await Promise.all(workspaces.map((workspace) => workspace.cleanup()))
    }
  })

  it.each(['root', 'parent', 'prefix-sibling'])('refuses recursive cleanup when the resolved target is the %s', async (kind) => {
    const root = path.join(directory, 'guard-root')
    vi.stubEnv('BULLA_TEST_TMP_DIR', root)
    const workspace = await createTempWorkspace('guard')
    const unsafeTarget = kind === 'root' ? root : kind === 'parent' ? directory : `${root}-sibling`
    const realpath = vi.spyOn(fs, 'realpath').mockResolvedValueOnce(unsafeTarget)
    const remove = vi.spyOn(fs, 'rm')
    try {
      await expect(workspace.cleanup()).rejects.toThrow('outside its temporary root')
      expect(remove).not.toHaveBeenCalled()
      expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true)
    } finally {
      realpath.mockRestore()
      remove.mockRestore()
      await workspace.cleanup()
    }
  })
})

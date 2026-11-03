import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'
import type { LocalProfile } from '@/lib/local/db'

const request = vi.hoisted(() => ({ values: new Map<string, string>() }))
const next = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn((destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) }),
}))
const cloud = vi.hoisted(() => ({
  createClient: vi.fn(() => { throw new Error('Local department tests must not use Supabase') }),
}))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => request.values.has(name) ? { value: request.values.get(name)! } : undefined,
    set: (name: string, value: string) => { request.values.set(name, value) },
    delete: (name: string) => { request.values.delete(name) },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: next.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: next.redirect }))
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/server')>(),
  createClient: cloud.createClient,
}))

const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const createdAt = '2026-10-31T00:00:00.000Z'
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let actions: typeof import('@/features/profiles/actions')
let queries: typeof import('@/features/profiles/queries')

function profile(name: string): LocalProfile {
  return {
    id: `prf_${name}`, user_id: `usr_${name}`, username: name, display_name: name,
    avatar_url: null, bio: null, university_id: 'uni_one', department: 'Legacy computing department',
    programme: 'Legacy degree text', semester: null, website: null, github: null,
    visibility: 'private', searchable: true, onboarding_completed: false, created_at: createdAt,
  }
}

function form(overrides: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({
    username: 'synthetic_alice', displayName: 'Synthetic Alice', universityId: 'uni_one',
    degree: 'Computer Science', visibility: 'private', ...overrides,
  })) data.set(key, value)
  return data
}

/** Isolated fixture setup only, before the action under test; retain real sessions/budgets. */
async function initialProfile(overrides: Partial<LocalProfile>) {
  const snapshot = await db.readStore()
  Object.assign(snapshot.profiles[0], overrides)
  await fs.writeFile(db.localStorePath(), JSON.stringify(snapshot, null, 2), 'utf8')
}

beforeEach(async () => {
  fixture = undefined
  vi.resetModules()
  vi.clearAllMocks()
  request.values.clear()
  fixture = await createTempWorkspace('profile-departments',
    process.platform === 'win32' ? path.join(recoveryRoot, 'fixtures') : undefined)
  if (process.platform === 'win32') {
    const relative = path.relative(path.resolve(recoveryRoot), path.resolve(fixture.directory))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Department fixtures must stay in the D-drive recovery workspace.')
    }
  }
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'local.json'))
  db = await import('@/lib/local/db')
  session = await import('@/lib/local/session')
  actions = await import('@/features/profiles/actions')
  queries = await import('@/features/profiles/queries')

  // Reference/identity rows are fixture data, not app-side bypasses. The real
  // session helper creates an opaque cookie and matching persisted session row.
  const snapshot = await db.readStore()
  snapshot.users = ['alice', 'bob'].map((name) => ({
    id: `usr_${name}`, email: `${name}@example.test`, password_hash: '', created_at: createdAt,
  }))
  snapshot.profiles = ['alice', 'bob'].map(profile)
  snapshot.universities = ['one', 'two'].map((suffix) => ({
    id: `uni_${suffix}`, name: `Synthetic University ${suffix}`, short_name: null,
    city: null, country: 'Pakistan', student_count: 0, project_count: 0, created_at: createdAt,
  }))
  snapshot.departments = [
    { id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems', is_verified: true },
    { id: 'dept_two', university_id: 'uni_two', name: 'Design Engineering', is_verified: true },
    { id: 'dept_pending', university_id: 'uni_one', name: 'Uncurated Proposal', is_verified: false },
  ].map((row) => ({ ...row, slug: row.id, created_by: null, created_at: createdAt }))
  await fs.writeFile(db.localStorePath(), JSON.stringify(snapshot, null, 2), 'utf8')
  await session.startSession('usr_alice')
})

afterEach(async () => {
  try {
    expect(cloud.createClient).not.toHaveBeenCalled()
  } finally {
    request.values.clear()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    db?.resetLocalCache()
    const owned = fixture
    fixture = undefined
    await owned?.cleanup()
  }
})

describe('local self-declared department persistence with real opaque sessions', () => {
  it('onboards privately with a genuine reference and rereads the same department after reload', async () => {
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ departmentId: ' dept_one ' })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    db.resetLocalCache()
    expect((await db.readStore()).profiles[0]).toMatchObject({
      department_id: 'dept_one', department: 'Computing Systems', degree: 'Computer Science',
      programme: 'Legacy degree text', visibility: 'private', onboarding_completed: true,
    })
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: {
        department_id: 'dept_one', department: { id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems' },
        legacy_department: null,
      },
    })
  })

  it('preserves legacy text and never infers an ID from degree when an old client omits the field', async () => {
    expect((await actions.updateProfileAction({ status: 'idle' }, form({ universityId: 'uni_two' }))).status).toBe('success')
    const stored = (await db.readStore()).profiles[0]
    expect(stored.department).toBe('Legacy computing department')
    expect(stored).not.toHaveProperty('department_id')
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: { department_id: null, department: null, legacy_department: 'Legacy computing department' },
    })
  })

  it('preserves an existing scoped reference when omission leaves the campus unchanged', async () => {
    await initialProfile({ department_id: 'dept_one', department: 'Computing Systems' })
    expect((await actions.updateProfileAction({ status: 'idle' }, form())).status).toBe('success')
    expect((await db.readStore()).profiles[0]).toMatchObject({ department_id: 'dept_one', department: 'Computing Systems' })
  })

  it('refuses a campus change with an omitted existing department FK, without partial writes', async () => {
    await initialProfile({ department_id: 'dept_one', department: 'Computing Systems' })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ universityId: 'uni_two' })))
      .toMatchObject({ status: 'error', fieldErrors: { departmentId: expect.stringContaining('explicitly clear') } })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it.each([undefined, 'dept_one'])('explicitly clears legacy or reference-backed affiliation (%s)', async (departmentId) => {
    if (departmentId) await initialProfile({ department_id: departmentId, department: 'Computing Systems' })
    expect((await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: ' ', universityId: '' }))).status)
      .toBe('success')
    expect((await db.readStore()).profiles[0]).toMatchObject({
      university_id: null, department_id: null, department: null, degree: 'Computer Science', programme: 'Legacy degree text',
    })
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: { department_id: null, department: null, legacy_department: null },
    })
  })

  it('reselects at the new campus and synchronizes only the chosen reference text for discovery', async () => {
    await initialProfile({ department_id: 'dept_one', department: 'Computing Systems' })
    expect((await actions.updateProfileAction({ status: 'idle' }, form({
      universityId: 'uni_two', departmentId: 'dept_two', id: 'prf_bob', user_id: 'usr_bob',
    }))).status).toBe('success')
    const saved = await db.readStore()
    expect(saved.profiles[0]).toMatchObject({
      university_id: 'uni_two', department_id: 'dept_two', department: 'Design Engineering', visibility: 'private',
    })
    expect(saved.profiles[1]).toEqual(profile('bob'))
  })

  it.each<Record<string, string>>([
    { departmentId: 'dept_two' },
    { departmentId: 'dept_pending' },
    { departmentId: 'dept_missing' },
    { departmentId: 'dept_one', universityId: '' },
    { departmentId: '../local.json' },
    { departmentId: 'Computer Science' },
  ])('rejects unknown/unapproved/cross-campus input %j and retains the draft', async (invalid) => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const result = await actions.updateProfileAction({ status: 'idle' }, form(invalid))
    expect(result).toMatchObject({
      status: 'error', fieldErrors: { departmentId: expect.any(String) }, values: { departmentId: invalid.departmentId },
    })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('offers only curated campus references and does not expose a private department to a peer', async () => {
    await initialProfile({ department_id: 'dept_one', department: 'Computing Systems' })
    expect(await queries.listUniversities()).toMatchObject([
      { id: 'uni_one', departments: [{ id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems' }] },
      { id: 'uni_two', departments: [{ id: 'dept_two', university_id: 'uni_two', name: 'Design Engineering' }] },
    ])
    await session.startSession('usr_bob')
    expect(await queries.getProfileByUsername('alice')).toBeNull()
  })

  it('requires the real cookie/session and cannot adopt a posted owner ID', async () => {
    request.values.clear()
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    await expect(actions.updateProfileAction({ status: 'idle' }, form({
      departmentId: 'dept_one', user_id: 'usr_alice', id: 'prf_alice',
    }))).rejects.toThrow('TEST_REDIRECT:/login?next=/me/edit')
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })
})

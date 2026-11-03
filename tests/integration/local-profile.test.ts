import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'
import type { LocalProfile, Tables } from '@/lib/local/db'

const request = vi.hoisted(() => ({
  context: undefined as import('node:async_hooks').AsyncLocalStorage<Map<string, string>> | undefined,
  values: new Map<string, string>(),
}))
const cloud = vi.hoisted(() => ({
  createClient: vi.fn(() => { throw new Error('Local profiles requested Supabase') }),
  createServerClient: vi.fn(() => { throw new Error('Local authentication requested Supabase') }),
}))
const next = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn((destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) }),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => {
    const values = request.context?.getStore() ?? request.values
    return {
      get: (name: string) => values.has(name) ? { value: values.get(name)! } : undefined,
      set: (name: string, value: string) => { values.set(name, value) },
      delete: (name: string) => { values.delete(name) },
    }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: next.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: next.redirect }))
vi.mock('@supabase/ssr', () => ({ createServerClient: cloud.createServerClient }))
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/server')>(),
  createClient: cloud.createClient,
}))
// Exercise real opaque-session authentication, without touching demo accounts.
vi.mock('@/lib/local/seed', () => ({ ensureSeeded: async () => undefined }))

const contexts = new AsyncLocalStorage<Map<string, string>>()
request.context = contexts
const COOKIE = 'quad_local_session'
const timestamp = '2026-10-20T00:00:00.000Z'
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let actions: typeof import('@/features/profiles/actions')
let queries: typeof import('@/features/profiles/queries')
let schemas: typeof import('@/features/profiles/schemas')

function profile(name: string, universityId = 'uni_one'): LocalProfile {
  return {
    id: `prf_${name}`, user_id: `usr_${name}`, username: name, display_name: name,
    bio: null, avatar_url: null, university_id: universityId, department: null,
    programme: null, semester: null, website: null, github: null,
    visibility: 'public', searchable: true, onboarding_completed: false, created_at: timestamp,
  }
}

function form(values: Record<string, string>): FormData {
  const result = new FormData()
  for (const [key, value] of Object.entries(values)) result.set(key, value)
  return result
}

function editValues(overrides: Record<string, string> = {}) {
  return {
    displayName: '  Alice Updated  ', universityId: '  uni_two  ', degree: '  MSc Computing  ',
    semester: ' 7 ', graduationYear: ' 2029 ', headline: ' Building campus tools ',
    bio: ' A profile that persists. ', location: ' Islamabad ', website: 'https://alice.example.test',
    githubUsername: 'alice-dev', visibility: 'private', ...overrides,
  }
}

function onboardingValues(overrides: Record<string, string> = {}) {
  return {
    username: '  Alice_Campus  ', displayName: ' Alice Campus ', universityId: 'uni_one',
    degree: ' BSc Computing ', semester: '2', graduationYear: '2030',
    headline: ' Looking for collaborators ', bio: ' Building something together. ', ...overrides,
  }
}

async function persisted(): Promise<Tables> {
  return JSON.parse(await fs.readFile(db.localStorePath(), 'utf8')) as Tables
}

async function cookieJar(userId: string) {
  const values = new Map<string, string>()
  await contexts.run(values, () => session.startSession(userId))
  return values
}

function expectRevalidation() {
  expect(next.revalidatePath).toHaveBeenCalledWith('/', 'layout')
  expect(next.revalidatePath).toHaveBeenCalledWith('/me')
  expect(next.revalidatePath).toHaveBeenCalledWith('/me/edit')
  expect(next.revalidatePath).toHaveBeenCalledWith('/u/[username]', 'page')
}

beforeEach(async () => {
  fixture = undefined
  vi.resetModules()
  vi.clearAllMocks()
  request.values.clear()
  fixture = await createTempWorkspace('profile')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'local.json'))
  vi.spyOn(process, 'cwd').mockReturnValue(fixture.directory)
  db = await import('@/lib/local/db')
  session = await import('@/lib/local/session')
  actions = await import('@/features/profiles/actions')
  queries = await import('@/features/profiles/queries')
  schemas = await import('@/features/profiles/schemas')
  await db.mutate((store) => {
    for (const name of ['alice', 'bob', 'carol']) {
      store.users.push({ id: `usr_${name}`, email: `${name}@example.test`, password_hash: '', created_at: timestamp })
      store.profiles.push(profile(name))
    }
    for (const suffix of ['one', 'two']) {
      store.universities.push({
        id: `uni_${suffix}`, name: `University ${suffix}`, short_name: suffix,
        city: null, country: 'Pakistan', student_count: 0, project_count: 0, created_at: timestamp,
      })
    }
  })
  await session.startSession('usr_alice')
})

afterEach(async () => {
  try {
    expect(cloud.createClient).not.toHaveBeenCalled()
    expect(cloud.createServerClient).not.toHaveBeenCalled()
  } finally {
    request.values.clear()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    db?.resetLocalCache()
    const ownedFixture = fixture
    fixture = undefined
    await ownedFixture?.cleanup()
  }
})

describe('local profile persistence and validation', () => {
  it('edits the authenticated profile durably and rereads all editable values without Supabase', async () => {
    await db.mutate((store) => {
      const me = store.profiles[0]
      me.visibility = 'connections'
      me.searchable = false
      me.allow_messages_from = 'nobody'
      me.allow_connection_requests = false
      me.programme = 'Legacy programme'
      me.department = 'Legacy department'
      me.github = 'https://github.com/legacy-handle'
      me.linkedin_url = 'https://linkedin.com/in/alice'
      me.twitter_username = 'alice'
    })
    const others = (await persisted()).profiles.slice(1)
    expect(await actions.updateProfileAction({ status: 'idle' }, form(editValues()))).toEqual({
      status: 'success', message: 'Saved.',
    })
    db.resetLocalCache()
    const expected = {
      id: 'prf_alice', username: 'alice', display_name: 'Alice Updated', degree: 'MSc Computing',
      semester: 7, graduation_year: 2029, headline: 'Building campus tools',
      bio: 'A profile that persists.', location: 'Islamabad', website: 'https://alice.example.test',
      github_username: 'alice-dev', visibility: 'private', university_id: 'uni_two',
      linkedin_url: 'https://linkedin.com/in/alice', twitter_username: 'alice',
      onboarding_completed: false,
    }
    expect(await queries.getMyProfile()).toMatchObject({ state: 'ok', profile: expected })
    expect(await queries.getProfileByUsername(' ALICE ')).toMatchObject(expected)
    const saved = await persisted()
    expect(saved.profiles[0]).toMatchObject({
      ...expected, semester: '7', user_id: 'usr_alice', searchable: false,
      allow_messages_from: 'nobody', allow_connection_requests: false,
      programme: 'Legacy programme', department: 'Legacy department', github: 'https://github.com/legacy-handle',
    })
    expect(saved.profiles.slice(1)).toEqual(others)
    expect(queries.toProfileSummary(saved.profiles[0]).headline).toBe('Building campus tools')
    expectRevalidation()
  })

  it('onboards once, normalizes the username, and preserves existing privacy preferences', async () => {
    await db.mutate((store) => {
      Object.assign(store.profiles[0], {
        visibility: 'private', searchable: false, allow_messages_from: 'nobody', allow_connection_requests: false,
      })
    })
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues())))
      .rejects.toThrow('TEST_REDIRECT:/me')
    db.resetLocalCache()
    expect((await persisted()).profiles[0]).toMatchObject({
      username: 'alice_campus', display_name: 'Alice Campus', university_id: 'uni_one', degree: 'BSc Computing',
      semester: '2', graduation_year: 2030, headline: 'Looking for collaborators',
      bio: 'Building something together.', onboarding_completed: true, onboarding_step: 12,
      visibility: 'private', searchable: false, allow_messages_from: 'nobody', allow_connection_requests: false,
    })
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: { username: 'alice_campus', semester: 2, graduation_year: 2030, onboarding_completed: true },
    })
    expect(await queries.getProfileByUsername('Alice_Campus')).not.toBeNull()
    expect(await queries.getProfileByUsername('alice')).toBeNull()
    expectRevalidation()
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({ username: 'another_handle' }))))
      .toMatchObject({ status: 'error', message: expect.stringContaining('already complete') })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it.each(['onboarding', 'edit'] as const)('accepts a blank optional university during %s', async (operation) => {
    if (operation === 'onboarding') {
      await expect(actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({ universityId: '  ' }))))
        .rejects.toThrow('TEST_REDIRECT:/me')
    } else {
      expect((await actions.updateProfileAction({ status: 'idle' }, form(editValues({ universityId: '  ' })))).status).toBe('success')
    }
    db.resetLocalCache()
    expect((await persisted()).profiles[0].university_id).toBeNull()
    expect(await queries.getMyProfile()).toMatchObject({ state: 'ok', profile: { university_id: null, university: null } })
  })

  it('keeps legacy mappings but never resurrects values explicitly cleared by editing', async () => {
    await db.mutate((store) => {
      const me = store.profiles[0]
      delete me.onboarding_completed
      Object.assign(me, {
        programme: 'Legacy degree', department: 'Computing', semester: 'Semester 6',
        github: 'https://github.com/legacy-handle', headline: 'Old headline', location: 'Old location', graduation_year: 2028,
      })
    })
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: { degree: 'Legacy degree', semester: 6, github_username: 'legacy-handle', onboarding_completed: true },
    })
    const input = editValues({
      degree: '', semester: '', universityId: '', githubUsername: '', graduationYear: '', headline: '', bio: '', location: '', website: '',
    })
    expect((await actions.updateProfileAction({ status: 'idle' }, form(input))).status).toBe('success')
    db.resetLocalCache()
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: {
        degree: null, semester: null, graduation_year: null, headline: null, bio: null,
        location: null, website: null, github_username: null, university_id: null, onboarding_completed: true,
      },
    })
    expect((await persisted()).profiles[0]).toMatchObject({ programme: 'Legacy degree', degree: null, github_username: null })
  })

  it.each([
    ['displayName', ''],
    ['displayName', 'x'.repeat(81)],
    ['universityId', '../local.json'],
    ['universityId', 'uni_missing'],
    ['universityId', '550e8400-e29b-41d4-a716-446655440000'],
    ['degree', 'x'.repeat(161)],
    ['semester', '0'],
    ['semester', '2.5'],
    ['graduationYear', '2101'],
    ['headline', 'x'.repeat(121)],
    ['bio', 'x'.repeat(1001)],
    ['location', 'x'.repeat(121)],
    ['website', 'javascript:alert(1)'],
    ['githubUsername', '-invalid-'],
    ['visibility', 'everyone'],
  ])('rejects invalid %s input without persisting any other changes', async (field, value) => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const state = await actions.updateProfileAction({ status: 'idle' }, form(editValues({ [field]: value })))
    expect(state.status).toBe('error')
    expect(state.fieldErrors?.[field]).toBeTruthy()
    expect(state.values?.[field]).toBe(value)
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('requires an explicit valid visibility rather than widening a private profile when it is absent', async () => {
    await db.mutate((store) => { store.profiles[0].visibility = 'private' })
    const input = form(editValues())
    input.delete('visibility')
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await actions.updateProfileAction({ status: 'idle' }, input)).toMatchObject({
      status: 'error', fieldErrors: { visibility: expect.any(String) },
    })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('rejects malformed onboarding, unknown universities, and every foundation/brand reserved username', async () => {
    const migration = await fs.readFile(new URL('../../supabase/migrations/0004_profiles.sql', import.meta.url), 'utf8')
    const entries = migration.split('insert into public.reserved_usernames (username, reason) values')[1].split(';')[0]
    const foundation = Array.from(entries.matchAll(/\('([^']+)',/g), (match) => match[1])
    expect(foundation.length).toBeGreaterThan(50)
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    for (const username of [...foundation, 'bulla', 'bullaapp', 'bullasupport', '123456', 'bad-handle']) {
      const state = await actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({ username: ` ${username.toUpperCase()} ` })))
      expect(state.status, username).toBe('error')
      expect(state.fieldErrors?.username, username).toBeTruthy()
    }
    expect(await actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({ universityId: 'uni_missing' }))))
      .toMatchObject({ status: 'error', fieldErrors: { universityId: expect.any(String) } })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('keeps cloud UUID validation strict while allowing optional local directory IDs', () => {
    for (const [cloudSchema, localSchema, input] of [
      [schemas.onboardingSchema, schemas.localOnboardingSchema, onboardingValues()],
      [schemas.profileEditSchema, schemas.localProfileEditSchema, editValues()],
    ] as const) {
      expect(cloudSchema.safeParse({ ...input, universityId: 'uni_one' }).success).toBe(false)
      expect(localSchema.safeParse({ ...input, universityId: 'uni_one' }).success).toBe(true)
      expect(cloudSchema.safeParse({ ...input, universityId: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true)
      for (const universityId of ['', undefined]) {
        expect(cloudSchema.safeParse({ ...input, universityId }).success).toBe(true)
        expect(localSchema.safeParse({ ...input, universityId }).success).toBe(true)
      }
    }
  })

  it('rejects a case-insensitive duplicate from an existing profile', async () => {
    await db.mutate((store) => { store.profiles[1].username = 'BoB' })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({ username: ' bOB ' }))))
      .toMatchObject({ status: 'error', fieldErrors: { username: 'That username is already taken.' } })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('allows exactly one concurrent normalized username winner across authenticated owners', async () => {
    const jars = await Promise.all(['alice', 'bob', 'carol'].map((name) => cookieJar(`usr_${name}`)))
    const attempts = await Promise.allSettled(jars.map((jar, index) =>
      contexts.run(jar, () => actions.completeOnboardingAction({ status: 'idle' }, form(onboardingValues({
        username: index % 2 ? ' SHARED_Handle ' : 'shared_handle',
      })))),
    ))
    const successes = attempts.filter((result) =>
      result.status === 'rejected' && result.reason instanceof Error && result.reason.message === 'TEST_REDIRECT:/me')
    const failures = attempts.filter((result) => result.status === 'fulfilled')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(2)
    for (const result of failures) {
      expect(result.value).toMatchObject({ status: 'error', fieldErrors: { username: 'That username is already taken.' } })
    }
    db.resetLocalCache()
    const saved = await persisted()
    expect(saved.profiles.filter((row) => row.username === 'shared_handle')).toHaveLength(1)
    expect(saved.profiles.filter((row) => row.onboarding_completed)).toHaveLength(1)
    expect(new Set(saved.profiles.map((row) => row.username.toLowerCase())).size).toBe(3)
  })

  it('does not report success or change the durable snapshot after a failed atomic commit', async () => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Fixture commit failed'))
    expect(await actions.updateProfileAction({ status: 'idle' }, form(editValues()))).toMatchObject({
      status: 'error', message: expect.stringContaining('could not be saved to the local store'),
    })
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
    expect((await actions.updateProfileAction({ status: 'idle' }, form(editValues()))).status).toBe('success')
  })
})

describe('local profile authorization and visibility', () => {
  it.each(['onboarding', 'edit'] as const)('denies anonymous and forged sessions during %s', async (operation) => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    const action = operation === 'onboarding' ? actions.completeOnboardingAction : actions.updateProfileAction
    const input = form(operation === 'onboarding' ? onboardingValues() : editValues())
    for (const token of [undefined, 'usr_bob.forged-owner', randomBytes(32).toString('base64url')]) {
      request.values.clear()
      if (token) request.values.set(COOKIE, token)
      await expect(action({ status: 'idle' }, input)).rejects.toThrow(
        `TEST_REDIRECT:/login?next=${operation === 'onboarding' ? '/onboarding' : '/me/edit'}`,
      )
    }
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('ignores forged ownership and protected columns even for a staff member', async () => {
    await db.mutate((store) => {
      store.user_roles.push({ id: 'rol_alice', user_id: 'usr_alice', role: 'admin', created_at: timestamp })
    })
    const before = await persisted()
    const input = form(editValues({
      id: 'prf_bob', profileId: 'prf_bob', profile_id: 'prf_bob', userId: 'usr_bob', user_id: 'usr_bob',
      username: 'hijacked', status: 'suspended', follower_count: '999', avatar_url: 'https://forged.example.test',
      onboarding_completed: 'true', arbitrary_column: 'not persisted',
    }))
    expect((await actions.updateProfileAction({ status: 'idle' }, input)).status).toBe('success')
    const saved = await persisted()
    expect(saved.profiles[0]).toMatchObject({ id: 'prf_alice', user_id: 'usr_alice', username: 'alice', display_name: 'Alice Updated', avatar_url: null, onboarding_completed: false })
    expect(saved.profiles.slice(1)).toEqual(before.profiles.slice(1))
    expect(saved.user_roles).toEqual(before.user_roles)
    for (const key of ['status', 'follower_count', 'arbitrary_column', 'profileId']) expect(saved.profiles[0]).not.toHaveProperty(key)
  })

  it.each(['role', 'roles', 'user_roles'])('refuses read-only %s assignment without saving other changes', async (key) => {
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    for (const [action, values] of [
      [actions.completeOnboardingAction, onboardingValues()],
      [actions.updateProfileAction, editValues()],
    ] as const) {
      const state = await action({ status: 'idle' }, form({ ...values, [key]: 'admin' }))
      expect(state).toMatchObject({ status: 'error', message: expect.stringContaining('read-only') })
      expect(state.values).not.toHaveProperty(key)
    }
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('reports a missing owner profile honestly and never adopts a posted victim profile', async () => {
    await db.mutate((store) => { store.profiles = store.profiles.filter((row) => row.user_id !== 'usr_alice') })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await queries.getMyProfile()).toEqual({ state: 'missing', userId: 'usr_alice' })
    for (const [action, values] of [
      [actions.completeOnboardingAction, onboardingValues()],
      [actions.updateProfileAction, editValues()],
    ] as const) {
      expect(await action({ status: 'idle' }, form({ ...values, profileId: 'prf_bob', user_id: 'usr_bob' })))
        .toMatchObject({ status: 'error', message: expect.stringContaining('has no profile') })
    }
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
  })

  it('refuses suspended owners and hides suspended or disabled profile lookups', async () => {
    await db.mutate((store) => {
      store.profile_account_states.push({ id: 'sta_alice', profile_id: 'prf_alice', status: 'suspended', suspended_until: null, warning_count: 0 })
    })
    const before = await fs.readFile(db.localStorePath(), 'utf8')
    expect(await queries.getProfileByUsername('alice')).toBeNull()
    expect(await queries.getMyProfile()).toEqual({ state: 'signed-out' })
    for (const [action, values, destination] of [
      [actions.completeOnboardingAction, onboardingValues(), '/onboarding'],
      [actions.updateProfileAction, editValues(), '/me/edit'],
    ] as const) {
      await expect(action({ status: 'idle' }, form(values)))
        .rejects.toThrow(`TEST_REDIRECT:/login?next=${destination}`)
    }
    expect(await fs.readFile(db.localStorePath(), 'utf8')).toBe(before)
    await db.mutate((store) => { store.users[0].disabled_at = timestamp })
    expect(await queries.getMyProfile()).toEqual({ state: 'signed-out' })
    expect(await queries.getProfileByUsername('alice')).toBeNull()
    await expect(actions.updateProfileAction({ status: 'idle' }, form(editValues()))).rejects.toThrow('TEST_REDIRECT:/login?next=/me/edit')
  })

  it('uses shared accepted-connection, block and suspension rules for handle and directory lookups', async () => {
    await db.mutate((store) => {
      store.profiles[1].visibility = 'connections'
      store.connections.push({ id: 'con_bob', requester_id: 'prf_alice', addressee_id: 'prf_bob', status: 'pending', message: null, created_at: timestamp, responded_at: null })
    })
    expect(await queries.getProfileByUsername('bob')).toBeNull()
    await db.mutate((store) => { store.connections[0].status = 'accepted' })
    expect(await queries.getProfileByUsername('bob')).not.toBeNull()
    await db.mutate((store) => {
      store.blocks.push({ id: 'blk_bob', blocker_id: 'prf_bob', blocked_id: 'prf_alice', reason: null, created_at: timestamp })
    })
    expect(await queries.getProfileByUsername('bob')).toBeNull()
    expect((await queries.listRecentProfiles()).map((row) => row.id)).not.toContain('prf_bob')
    await db.mutate((store) => {
      store.blocks = []
      store.profile_account_states.push({ id: 'sta_bob', profile_id: 'prf_bob', status: 'suspended', suspended_until: '2099-01-01T00:00:00.000Z', warning_count: 0 })
    })
    expect(await queries.getProfileByUsername('bob')).toBeNull()
    expect((await queries.listRecentProfiles()).map((row) => row.id)).not.toContain('prf_bob')
  })

  it('derives real graph and content counts without disclosing unreadable, blocked or inactive rows', async () => {
    await db.mutate((store) => {
      store.profiles[1].university_id = 'uni_two'
      store.profiles[2].visibility = 'private'
      for (const name of ['daria', 'eren', 'frank', 'grace', 'hank', 'pending', 'rejected']) {
        store.users.push({ id: `usr_${name}`, email: `${name}@example.test`, password_hash: '', created_at: timestamp })
        store.profiles.push(profile(name))
      }
      store.profiles.find((row) => row.username === 'daria')!.visibility = 'university'
      Object.assign(store.profiles.find((row) => row.username === 'eren')!, { visibility: 'university', university_id: 'uni_two' })
      store.profiles.find((row) => row.username === 'frank')!.visibility = 'connections'
      store.profile_account_states.push({ id: 'sta_grace', profile_id: 'prf_grace', status: 'suspended', suspended_until: null, warning_count: 0 })
      store.blocks.push({ id: 'blk_hank', blocker_id: 'prf_hank', blocked_id: 'prf_alice', reason: null, created_at: timestamp })
      for (const [index, name] of ['bob', 'bob', 'carol', 'daria', 'eren', 'frank', 'grace', 'hank', 'missing', 'alice'].entries()) {
        store.follows.push(
          { id: `fol_in${index}`, follower_id: `prf_${name}`, following_id: 'prf_alice', created_at: timestamp },
          { id: `fol_out${index}`, follower_id: 'prf_alice', following_id: `prf_${name}`, created_at: timestamp },
        )
        store.connections.push({
          id: `con_${index}`, requester_id: `prf_${name}`, addressee_id: 'prf_alice', status: 'accepted',
          message: null, created_at: timestamp, responded_at: timestamp,
        })
      }
      for (const name of ['pending', 'rejected'] as const) {
        store.connections.push({
          id: `con_${name}`, requester_id: 'prf_alice', addressee_id: `prf_${name}`, status: name,
          message: null, created_at: timestamp, responded_at: null,
        })
      }
      for (const visibility of ['public', 'private'] as const) {
        store.posts.push({
          id: `pst_${visibility}`, author_id: 'prf_alice', body: 'Profile post', visibility,
          project_id: null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0,
          created_at: timestamp, deleted_at: null,
        })
        store.projects.push({
          id: `prj_${visibility}`, owner_id: 'prf_alice', slug: visibility, title: 'Profile project', purpose: 'Build',
          description: null, category: 'other', status: 'active', visibility, is_seeking_members: false,
          team_size_target: null, member_count: 1, created_at: timestamp, deleted_at: null,
        })
      }
      store.posts.push({ ...store.posts[0], id: 'pst_hidden', moderation_status: 'hidden' })
      store.posts.push({ ...store.posts[0], id: 'pst_deleted', deleted_at: timestamp })
      store.projects.push({ ...store.projects[0], id: 'prj_deleted', slug: 'deleted', deleted_at: timestamp })
      store.content_moderation.push({ id: 'mod_hidden', kind: 'project', target_id: 'prj_hidden', status: 'hidden' })
      store.projects.push({ ...store.projects[0], id: 'prj_hidden', slug: 'hidden' })
    })
    expect(await queries.getMyProfile()).toMatchObject({
      state: 'ok', profile: { follower_count: 3, following_count: 3, connection_count: 3, post_count: 2, project_count: 2 },
    })
    const observer = await cookieJar('usr_bob')
    expect(await contexts.run(observer, () => queries.getProfileByUsername('alice'))).toMatchObject({
      follower_count: 2, following_count: 2, connection_count: null, post_count: 1, project_count: 1,
    })
    await db.mutate((store) => {
      store.blocks.push({ id: 'blk_observer', blocker_id: 'prf_bob', blocked_id: 'prf_eren', reason: null, created_at: timestamp })
    })
    expect(await contexts.run(observer, () => queries.getProfileByUsername('alice'))).toMatchObject({
      follower_count: 1, following_count: 1, connection_count: null,
    })
    request.values.clear()
    expect(await queries.getProfileByUsername('alice')).toMatchObject({
      follower_count: 1, following_count: 1, connection_count: null, post_count: 1, project_count: 1,
    })
  })
})

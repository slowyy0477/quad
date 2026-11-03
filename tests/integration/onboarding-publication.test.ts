import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

type CloudResponse = { data: Record<string, unknown> | null; error: null }
type CloudOperation = {
  table: string
  kind: 'read' | 'write'
  columns?: string
  payload?: Record<string, unknown>
  filters: ['eq' | 'is', string, unknown][]
}
type CloudQuery = {
  update(payload: Record<string, unknown>): CloudQuery
  eq(column: string, value: unknown): CloudQuery
  is(column: string, value: null): CloudQuery
  select(columns: string): CloudQuery
  maybeSingle(): Promise<CloudResponse>
}

vi.mock('server-only', () => ({}))
const request = vi.hoisted(() => ({
  local: false,
  ownerId: '11111111-1111-4111-8111-111111111111',
  cookies: new Map<string, string>(),
}))
const cloud = vi.hoisted(() => ({
  createClient: vi.fn(),
  operations: [] as CloudOperation[],
  responses: new Map<string, CloudResponse>(),
}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => request.local
    ? (await import('@/lib/local/session')).getLocalUser()
    : { id: request.ownerId },
  createClient: cloud.createClient,
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => request.cookies.has(name) ? { value: request.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => { request.cookies.set(name, value) },
    delete: (name: string) => { request.cookies.delete(name) },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) },
}))

const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const CLOUD_OWNER = '11111111-1111-4111-8111-111111111111'
let fixture: TempWorkspace | undefined
let db: typeof import('@/lib/local/db')
let session: typeof import('@/lib/local/session')
let actions: typeof import('@/features/profiles/actions')
let schemas: typeof import('@/features/profiles/schemas')

/** Separate no-network read/write responses; a snapshot is not an affected-row receipt. */
function cloudBuilder(table: string): CloudQuery {
  const operation: CloudOperation = { table, kind: 'read', filters: [] }
  cloud.operations.push(operation)
  const query: CloudQuery = {
    update(payload) { operation.kind = 'write'; operation.payload = payload; return query },
    eq(column, value) { operation.filters.push(['eq', column, value]); return query },
    is(column, value) { operation.filters.push(['is', column, value]); return query },
    select(columns) { operation.columns = columns; return query },
    async maybeSingle() {
      const response = cloud.responses.get(`${table}:${operation.kind}`)
      if (!response) throw new Error(`Unexpected synthetic cloud operation: ${table}:${operation.kind}`)
      return response
    },
  }
  return query
}

function cloudProfileWrite() {
  const operation = cloud.operations.find((entry) => entry.table === 'profiles' && entry.kind === 'write')
  expect(operation).toBeDefined()
  return operation!
}

function form(overrides: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({
    username: 'student_publication', displayName: 'Student Publication', universityId: '', departmentId: '',
    visibility: 'private',
    degree: '', semester: '', graduationYear: '', headline: '', bio: '', ...overrides,
  })) data.set(key, value)
  return data
}

function legacyForm() {
  const data = form()
  data.delete('departmentId')
  data.delete('visibility')
  return data
}

async function setup(local: boolean) {
  vi.resetModules()
  vi.resetAllMocks()
  request.local = local
  request.cookies.clear()
  cloud.operations.length = 0
  cloud.responses.clear()
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', local ? 'local' : 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', local ? '' : 'https://synthetic-provider.example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', local ? '' : 'synthetic-public-key-only-no-network')
  if (local) {
    fixture = await createTempWorkspace('onboarding-publication',
      process.platform === 'win32' ? path.join(recoveryRoot, 'fixtures') : undefined)
    if (process.platform === 'win32') {
      const relative = path.relative(path.resolve(recoveryRoot), path.resolve(fixture.directory))
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Publication fixtures must stay in the D-drive recovery workspace.')
      }
    }
    vi.spyOn(process, 'cwd').mockReturnValue(fixture.directory)
    vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'local.json'))
    db = await import('@/lib/local/db')
    session = await import('@/lib/local/session')
    const owner = await session.createAccount({
      email: 'publication@example.test', password: 'a synthetic private phrase', displayName: 'Student',
    })
    expect(owner).not.toBeNull()
    request.ownerId = owner!.user.id
    cloud.createClient.mockImplementation(() => { throw new Error('Local publication tests must not use Supabase') })

    // Use the actual opaque-session issuer and reader, including the locked
    // mutation's SHA-256 lookup. No getUser-only identity or budget bypass.
    await session.startSession(request.ownerId)
    const token = request.cookies.get(session.LOCAL_SESSION_COOKIE)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const authenticated = await db.readStore()
    expect(authenticated.sessions).toHaveLength(1)
    expect(authenticated.sessions[0]).toMatchObject({
      user_id: request.ownerId,
      token_hash: createHash('sha256').update(token!).digest('hex'),
    })
    expect(authenticated.sessions[0].token_hash).not.toBe(token)
    expect(session.getLocalUserFromSnapshot(authenticated, token)?.id).toBe(request.ownerId)

    // Synthetic legacy-account setup only, with a real current session. Keep
    // the store lock and mutation ledger intact; never edit the owner's store.
    await db.mutate((store) => {
      store.users.push({ ...owner!.user, id: 'usr_existing', email: 'existing-publication@example.test' })
      store.profiles.push({ ...owner!.profile, id: 'prf_existing', user_id: 'usr_existing', username: 'existing',
        onboarding_completed: true, visibility: 'public', searchable: false })
    })
  } else {
    request.ownerId = CLOUD_OWNER
    cloud.createClient.mockResolvedValue({ from: cloudBuilder })
    cloud.responses.set('profiles:read', {
      data: { id: CLOUD_OWNER, university_id: null, department_id: null, program_id: null }, error: null,
    })
    cloud.responses.set('profiles:write', { data: { id: CLOUD_OWNER }, error: null })
  }
  actions = await import('@/features/profiles/actions')
  schemas = await import('@/features/profiles/schemas')
}

beforeEach(() => { fixture = undefined })
afterEach(async () => {
  request.cookies.clear()
  request.local = false
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  db?.resetLocalCache()
  const owned = fixture
  fixture = undefined
  await owned?.cleanup()
})

describe('local explicit profile publication without rewriting existing accounts', () => {
  it('creates new profiles private until publication without modifying existing users', async () => {
    await setup(true)
    const before = await db.readStore()
    expect(before.profiles[0].visibility).toBe('private')
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'public' })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    db.resetLocalCache()
    const after = await db.readStore()
    expect(after.profiles[0]).toMatchObject({ visibility: 'public', onboarding_completed: true })
    expect(after.profiles[1]).toEqual(before.profiles[1])
  })

  it.each(['private', 'connections', 'university', 'public'] as const)('saves the explicit %s audience', async (visibility) => {
    await setup(true)
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ visibility })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    db.resetLocalCache()
    expect((await db.readStore()).profiles[0].visibility).toBe(visibility)
  })

  it('does not silently change legacy privacy/search/messaging when an older form omits the choice', async () => {
    await setup(true)
    await db.mutate((store) => {
      Object.assign(store.profiles[0], {
        visibility: 'connections', searchable: false, allow_messages_from: 'nobody',
        department: 'Legacy department', programme: 'Legacy programme',
      })
    })
    await expect(actions.completeOnboardingAction({ status: 'idle' }, legacyForm()))
      .rejects.toThrow('TEST_REDIRECT:/me')
    expect((await db.readStore()).profiles[0]).toMatchObject({
      visibility: 'connections', searchable: false, allow_messages_from: 'nobody',
      department: 'Legacy department', programme: 'Legacy programme',
    })
  })

  it('rejects forged audience/ownership and replay of completed onboarding', async () => {
    await setup(true)
    const before = (await db.readStore()).profiles
    expect(await actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'all' })))
      .toMatchObject({ status: 'error', fieldErrors: { visibility: expect.any(String) } })
    expect((await db.readStore()).profiles).toEqual(before)
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'private', user_id: 'usr_existing' })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    const saved = (await db.readStore()).profiles
    expect(saved[1]).toEqual(before[1])
    expect(await actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'public' })))
      .toMatchObject({ status: 'error', message: expect.stringContaining('already complete') })
    expect((await db.readStore()).profiles).toEqual(saved)
  })

  it('requires the real session cookie even when a form posts an owner ID', async () => {
    await setup(true)
    const before = await db.readStore()
    request.cookies.clear()
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({
      visibility: 'public', user_id: request.ownerId,
    }))).rejects.toThrow('TEST_REDIRECT:/login?next=/onboarding')
    db.resetLocalCache()
    expect(await db.readStore()).toEqual(before)
  })
})

describe('cloud onboarding publication and no-op/replay detection', () => {
  it.each(['private', 'connections', 'university', 'public'] as const)('writes the explicit %s audience to only the unfinished owner row', async (visibility) => {
    await setup(false)
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ visibility, id: 'victim', role: 'admin' })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    const write = cloudProfileWrite()
    expect(write.payload).toMatchObject({ visibility, department_id: null, onboarding_completed: true })
    expect(write.payload).not.toHaveProperty('role')
    expect(write.filters).toEqual([
      ['eq', 'id', CLOUD_OWNER], ['eq', 'onboarding_completed', false],
      ['is', 'university_id', null], ['is', 'department_id', null], ['is', 'program_id', null],
    ])
    expect(write.columns).toBe('id')
    expect(cloud.operations.filter((entry) => entry.kind === 'read')).toEqual([{
      table: 'profiles', kind: 'read', columns: 'id, university_id, department_id, program_id',
      filters: [['eq', 'id', CLOUD_OWNER]],
    }])
  })

  it('leaves the existing database audience unchanged if an old client omitted the field', async () => {
    await setup(false)
    await expect(actions.completeOnboardingAction({ status: 'idle' }, legacyForm()))
      .rejects.toThrow('TEST_REDIRECT:/me')
    const write = cloudProfileWrite()
    expect(write.payload).not.toHaveProperty('visibility')
    expect(write.payload).not.toHaveProperty('department_id')
    expect(write.payload).not.toHaveProperty('program_id')
    expect(write.filters).toEqual([['eq', 'id', CLOUD_OWNER], ['eq', 'onboarding_completed', false]])
    expect(write.columns).toBe('id')
    expect(cloud.operations.filter((entry) => entry.kind === 'read')).toHaveLength(0)
  })

  it('guards a real existing affiliation snapshot when explicitly clearing the campus and department', async () => {
    await setup(false)
    const affiliation = {
      id: CLOUD_OWNER,
      university_id: '22222222-2222-4222-8222-222222222222',
      department_id: '33333333-3333-4333-8333-333333333333',
      program_id: '44444444-4444-4444-8444-444444444444',
    }
    cloud.responses.set('profiles:read', { data: affiliation, error: null })
    await expect(actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'public' })))
      .rejects.toThrow('TEST_REDIRECT:/me')
    const write = cloudProfileWrite()
    expect(write.payload).toMatchObject({
      university_id: null, department_id: null, program_id: null, visibility: 'public',
    })
    expect(write.filters).toEqual([
      ['eq', 'id', CLOUD_OWNER], ['eq', 'onboarding_completed', false],
      ['eq', 'university_id', affiliation.university_id], ['eq', 'department_id', affiliation.department_id],
      ['eq', 'program_id', affiliation.program_id],
    ])
  })

  it.each([null, {
    id: '99999999-9999-4999-8999-999999999999',
    university_id: null, department_id: null, program_id: null,
  }])(
    'refuses an unreadable or mismatched affiliation snapshot (%j) before any write', async (snapshot) => {
      await setup(false)
      cloud.responses.set('profiles:read', { data: snapshot, error: null })
      expect(await actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'public' })))
        .toMatchObject({ status: 'error', message: expect.stringContaining('Nothing was saved') })
      expect(cloud.operations.some((entry) => entry.kind === 'write')).toBe(false)
    },
  )

  it.each([null, { id: '99999999-9999-4999-8999-999999999999' }])(
    'does not claim a missing/already-completed or different owner row was saved (%j)', async (saved) => {
      await setup(false)
      cloud.responses.set('profiles:write', { data: saved, error: null })
      expect(await actions.completeOnboardingAction({ status: 'idle' }, form({ visibility: 'public' })))
        .toMatchObject({ status: 'error', message: expect.stringContaining('No unfinished profile was saved') })
      expect(cloudProfileWrite().columns).toBe('id')
    },
  )

  it('rejects unknown publication values in both adapter schemas', async () => {
    await setup(false)
    for (const schema of [schemas.onboardingSchema, schemas.localOnboardingSchema]) {
      expect(schema.safeParse(Object.fromEntries(form({ visibility: 'everyone' }))).success).toBe(false)
    }
  })
})

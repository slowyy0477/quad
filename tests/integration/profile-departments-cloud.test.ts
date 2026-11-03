import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ApiError = { code?: string; message?: string; hint?: string } | null
type ApiResponse = { data: unknown; error: ApiError }
type Operation = { table: string; kind: 'read' | 'write'; columns?: string; payload?: Record<string, unknown>; filters: [string, unknown][] }
type MockQuery = {
  select(columns: string): MockQuery
  update(payload: Record<string, unknown>): MockQuery
  eq(column: string, value: unknown): MockQuery
  is(column: string, value: null): MockQuery
  ilike(column: string, value: string): MockQuery
  order(): MockQuery
  returns(): Promise<ApiResponse>
  maybeSingle(): Promise<ApiResponse>
}

const owner = '11111111-1111-4111-8111-111111111111'
const university = '22222222-2222-4222-8222-222222222222'
const otherUniversity = '33333333-3333-4333-8333-333333333333'
const department = '44444444-4444-4444-8444-444444444444'
const otherDepartment = '55555555-5555-4555-8555-555555555555'
const program = '66666666-6666-4666-8666-666666666666'
const cloud = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  calls: [] as Operation[],
  responses: new Map<string, ApiResponse>(),
}))
const next = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  redirect: vi.fn((destination: string): never => { throw new Error(`TEST_REDIRECT:${destination}`) }),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: cloud.createClient, getUser: cloud.getUser }))
vi.mock('next/cache', () => ({ revalidatePath: next.revalidatePath }))
vi.mock('next/navigation', () => ({ redirect: next.redirect }))

let actions: typeof import('@/features/profiles/actions')
let queries: typeof import('@/features/profiles/queries')

/** A no-network adapter double. This tests query construction, not hosted RLS. */
function builder(table: string) {
  const operation: Operation = { table, kind: 'read', filters: [] }
  cloud.calls.push(operation)
  const response = () => cloud.responses.get(`${table}:${operation.kind}`) ?? { data: null, error: null }
  const query: MockQuery = {
    select(columns: string) { operation.columns = columns; return query },
    update(payload: Record<string, unknown>) { operation.kind = 'write'; operation.payload = payload; return query },
    eq(column: string, value: unknown) { operation.filters.push([column, value]); return query },
    is(column: string, value: null) { operation.filters.push([column, value]); return query },
    ilike(column: string, value: string) { operation.filters.push([column, value]); return query },
    order() { return query },
    async returns() { return response() },
    async maybeSingle() { return response() },
  }
  return query
}

function form(overrides: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({
    username: 'synthetic_student', displayName: 'Synthetic Student', universityId: university,
    degree: 'Computer Science', visibility: 'private', ...overrides,
  })) data.set(key, value)
  return data
}

function profileWrite() {
  return cloud.calls.find((call) => call.table === 'profiles' && call.kind === 'write')
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  cloud.calls.length = 0
  cloud.responses.clear()
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic-provider.example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-no-network-public-key')
  cloud.getUser.mockResolvedValue({ id: owner })
  cloud.createClient.mockResolvedValue({ from: builder })
  cloud.responses.set('profiles:read', {
    data: { id: owner, university_id: university, department_id: department, program_id: program }, error: null,
  })
  cloud.responses.set('profiles:write', { data: { id: owner }, error: null })
  cloud.responses.set('departments:read', {
    data: { id: department, university_id: university, name: 'Computing Systems', is_verified: true, university: { status: 'approved' } },
    error: null,
  })
  actions = await import('@/features/profiles/actions')
  queries = await import('@/features/profiles/queries')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('cloud self-declared department writes use scoped, curated references', () => {
  it.each(['onboarding', 'edit'] as const)('saves a genuine selection during %s without changing a same-department program', async (operation) => {
    const data = form({ departmentId: department, id: 'posted_victim', program_id: 'posted_program', is_verified: 'true' })
    if (operation === 'onboarding') {
      await expect(actions.completeOnboardingAction({ status: 'idle' }, data)).rejects.toThrow('TEST_REDIRECT:/me')
    } else {
      expect(await actions.updateProfileAction({ status: 'idle' }, data)).toEqual({ status: 'success', message: 'Saved.' })
    }
    const write = profileWrite()!
    expect(write.payload).toMatchObject({ university_id: university, department_id: department, degree: 'Computer Science', visibility: 'private' })
    expect(write.payload).not.toHaveProperty('program_id')
    expect(write.payload).not.toHaveProperty('is_verified')
    expect(write.filters).toContainEqual(['id', owner])
    expect(write.filters).toContainEqual(['university_id', university])
    expect(write.filters).toContainEqual(['department_id', department])
    expect(write.filters).toContainEqual(['program_id', program])
    expect(write.columns).toBe('id')
    const referenceRead = cloud.calls.find((call) => call.table === 'departments')!
    expect(referenceRead.filters).toEqual([
      ['id', department], ['university_id', university], ['is_verified', true], ['university.status', 'approved'],
    ])
    expect(referenceRead.columns).toContain('departments_university_id_fkey!inner')
  })

  it.each(['onboarding', 'edit'] as const)('preserves legacy affiliation when an old %s client omits the field', async (operation) => {
    if (operation === 'onboarding') {
      await expect(actions.completeOnboardingAction({ status: 'idle' }, form())).rejects.toThrow('TEST_REDIRECT:/me')
    } else {
      expect((await actions.updateProfileAction({ status: 'idle' }, form())).status).toBe('success')
    }
    expect(profileWrite()?.payload).not.toHaveProperty('department_id')
    expect(profileWrite()?.payload).not.toHaveProperty('program_id')
    expect(cloud.calls.filter((call) => call.kind === 'read')).toHaveLength(0)
  })

  it('explicitly clears the department and linked program without deriving either from degree text', async () => {
    expect((await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: '' }))).status).toBe('success')
    expect(profileWrite()?.payload).toMatchObject({
      department_id: null, program_id: null, degree: 'Computer Science',
    })
    expect(cloud.calls.some((call) => call.table === 'departments')).toBe(false)
  })

  it('reselects at another campus, clears only the old linked program and guards the original snapshot', async () => {
    cloud.responses.set('departments:read', {
      data: { id: otherDepartment, university_id: otherUniversity, name: 'Design Engineering', is_verified: true, university: { status: 'approved' } },
      error: null,
    })
    expect((await actions.updateProfileAction({ status: 'idle' }, form({
      universityId: otherUniversity, departmentId: otherDepartment,
    }))).status).toBe('success')
    expect(profileWrite()?.payload).toMatchObject({
      university_id: otherUniversity, department_id: otherDepartment, program_id: null, degree: 'Computer Science',
    })
    expect(profileWrite()?.filters).toContainEqual(['university_id', university])
    expect(profileWrite()?.filters).toContainEqual(['department_id', department])
    expect(profileWrite()?.filters).toContainEqual(['program_id', program])
  })

  it.each([
    { id: department, university_id: otherUniversity, is_verified: true, university: { status: 'approved' } },
    { id: department, university_id: university, is_verified: false, university: { status: 'approved' } },
    { id: department, university_id: university, is_verified: true, university: { status: 'pending' } },
    null,
  ])('refuses a missing/unapproved/cross-campus reference even if an adapter returns it', async (invalid) => {
    cloud.responses.set('departments:read', { data: invalid, error: null })
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: department })))
      .toMatchObject({ status: 'error', fieldErrors: { departmentId: expect.any(String) }, values: { departmentId: department } })
    expect(profileWrite()).toBeUndefined()
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('requires a university before querying a selected department', async () => {
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ universityId: '', departmentId: department })))
      .toMatchObject({ status: 'error', fieldErrors: { departmentId: expect.any(String) } })
    expect(cloud.calls.some((call) => call.table === 'departments')).toBe(false)
    expect(profileWrite()).toBeUndefined()
  })

  it('fails closed on an unreadable owner or reference-query error', async () => {
    cloud.responses.set('profiles:read', { data: null, error: null })
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: department })))
      .toMatchObject({ status: 'error', message: expect.stringContaining('Nothing was saved') })
    expect(profileWrite()).toBeUndefined()
    cloud.responses.set('profiles:read', {
      data: { id: owner, university_id: university, department_id: department, program_id: program }, error: null,
    })
    cloud.responses.set('departments:read', { data: null, error: { code: 'synthetic_read_failure' } })
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: department })))
      .toMatchObject({ status: 'error', fieldErrors: { departmentId: expect.stringContaining('could not be checked') } })
    expect(profileWrite()).toBeUndefined()
  })

  it('does not call a raced/missing update a successful save', async () => {
    cloud.responses.set('profiles:write', { data: null, error: null })
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ departmentId: '' })))
      .toMatchObject({ status: 'error', message: expect.stringContaining('Nothing was saved') })
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it('translates the existing FK affiliation trigger refusal for omitted old-client departments', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    cloud.responses.set('profiles:write', { data: null, error: { code: '23514', hint: 'affiliation_mismatch' } })
    expect(await actions.updateProfileAction({ status: 'idle' }, form({ universityId: otherUniversity })))
      .toMatchObject({ status: 'error', fieldErrors: { departmentId: expect.any(String) } })
    expect(profileWrite()?.payload).not.toHaveProperty('department_id')
    expect(diagnostic).toHaveBeenCalled()
  })

  it('loads approved university options with curated, same-campus department references and no profile metadata', async () => {
    cloud.responses.set('universities:read', {
      data: [{
        id: university, name: 'Synthetic University', short_name: null, country: 'Pakistan',
        departments: [
          { id: department, university_id: university, name: 'Computing Systems', is_verified: true },
          { id: otherDepartment, university_id: otherUniversity, name: 'Other Campus', is_verified: true },
          { id: 'uncurated', university_id: university, name: 'Proposal', is_verified: false },
        ],
      }], error: null,
    })
    expect(await queries.listUniversities()).toEqual([{
      id: university, name: 'Synthetic University', short_name: null, country: 'Pakistan',
      departments: [{ id: department, university_id: university, name: 'Computing Systems' }],
    }])
    const call = cloud.calls.find((operation) => operation.table === 'universities')!
    expect(call.filters).toContainEqual(['status', 'approved'])
    expect(call.filters).toContainEqual(['departments.is_verified', true])
    expect(call.columns).not.toMatch(/profiles|student_count|project_count/)
  })
})

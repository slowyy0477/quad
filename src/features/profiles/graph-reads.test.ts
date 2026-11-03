import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  getUser: vi.fn(),
  createClient: vi.fn(),
  getGraphCounts: vi.fn(),
  reply: { data: null as unknown, error: null as unknown },
  operations: [] as [string, ...unknown[]][],
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: boundary.getUser, createClient: boundary.createClient,
}))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/local/db', () => ({
  readStore: () => { throw new Error('Hosted profile reads must not open local data.') },
}))
vi.mock('@/features/connections/graph-reads', () => ({
  getGraphCounts: boundary.getGraphCounts,
}))

import {
  getMyProfile, getProfileByUsername, getProfileByUsernameResult,
} from '@/features/profiles/queries'

const OWNER = '00000000-0000-4000-8000-000000000001'
const SUBJECT = '00000000-0000-4000-8000-000000000002'
const READ_ERROR = 'The profile could not be loaded. Please try again.'
const COUNT_ERROR = 'Relationship counts could not be loaded. Please try again.'

function profile(id = OWNER, username = 'alice') {
  return {
    id, username, display_name: 'Alice', avatar_url: null, headline: null, bio: null,
    degree: null, semester: null, graduation_year: null, location: null, website: null,
    github_username: null, linkedin_url: null, twitter_username: null,
    visibility: 'public', onboarding_completed: true,
    // Deliberately hostile extra maintained values: the DTO must replace them.
    follower_count: 987654, following_count: 876543, connection_count: 765432,
    post_count: 1, project_count: 2, created_at: '2026-11-02T00:00:00.000Z',
    university_id: null, university: null, department_id: null, department: null,
  }
}

function ordinaryClient() {
  const query = {
    select(columns: string) { boundary.operations.push(['select', columns]); return query },
    eq(column: string, value: unknown) { boundary.operations.push(['eq', column, value]); return query },
    is(column: string, value: unknown) { boundary.operations.push(['is', column, value]); return query },
    ilike(column: string, value: string) { boundary.operations.push(['ilike', column, value]); return query },
    async maybeSingle() { boundary.operations.push(['maybeSingle']); return boundary.reply },
  }
  return {
    from(table: string) {
      if (table !== 'profiles') throw new Error('Only the ordinary profile projection is expected.')
      boundary.operations.push(['from', table])
      return query
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.operations = []
  boundary.reply = { data: profile(), error: null }
  boundary.getUser.mockResolvedValue({ id: OWNER })
  boundary.createClient.mockResolvedValue(ordinaryClient())
  boundary.getGraphCounts.mockResolvedValue({
    counts: { follower_count: 0, following_count: 2, connection_count: 1 },
    error: null, unavailable: false,
  })
})

describe('ordinary-provider full-profile graph DTO', () => {
  it('projects no maintained graph columns and obtains real caller-bound owner counts', async () => {
    const result = await getMyProfile()
    expect(result).toMatchObject({
      state: 'ok',
      profile: { follower_count: 0, following_count: 2, connection_count: 1, graph_counts_error: null },
    })
    const projection = boundary.operations.find(([operation]) => operation === 'select')?.[1]
    expect(typeof projection).toBe('string')
    for (const column of ['follower_count', 'following_count', 'connection_count']) {
      expect((projection as string).split(/\W+/)).not.toContain(column)
    }
    expect(boundary.operations).toContainEqual(['eq', 'id', OWNER])
    expect(boundary.getGraphCounts).toHaveBeenCalledExactlyOnceWith(OWNER)
    expect(JSON.stringify(result)).not.toMatch(/987654|876543|765432/)
  })

  it('withholds foreign connections in both the result and compatibility profile reader', async () => {
    boundary.reply = { data: profile(SUBJECT, 'bob'), error: null }
    boundary.getGraphCounts.mockResolvedValue({
      counts: { follower_count: 3, following_count: 4, connection_count: null },
      error: null, unavailable: false,
    })
    const result = await getProfileByUsernameResult('bob')
    expect(result).toMatchObject({
      state: 'ok', profile: { follower_count: 3, following_count: 4, connection_count: null },
    })
    expect(boundary.getGraphCounts).toHaveBeenCalledExactlyOnceWith(SUBJECT)
    expect(await getProfileByUsername('bob')).toMatchObject({ connection_count: null })
    expect(JSON.stringify(result)).not.toContain('765432')
  })

  it('retains a readable identity while making a graph-provider error explicit, not zero', async () => {
    boundary.getGraphCounts.mockResolvedValue({ counts: null, error: COUNT_ERROR, unavailable: false })
    expect(await getMyProfile()).toMatchObject({
      state: 'ok', profile: {
        id: OWNER, follower_count: null, following_count: null,
        connection_count: null, graph_counts_error: COUNT_ERROR,
      },
    })
  })

  it('does not invent graph counts for a readable nonpublic foreign profile', async () => {
    boundary.reply = { data: { ...profile(SUBJECT, 'bob'), visibility: 'connections' }, error: null }
    boundary.getGraphCounts.mockResolvedValue({ counts: null, error: null, unavailable: true })
    expect(await getProfileByUsernameResult('bob')).toMatchObject({
      state: 'ok', profile: {
        visibility: 'connections', follower_count: null, following_count: null,
        connection_count: null, graph_counts_error: null,
      },
    })
  })

  it('does not treat a provider failure as a missing account or trigger a count query', async () => {
    boundary.reply = { data: null, error: { code: '42501', message: 'synthetic-private-provider-detail' } }
    expect(await getMyProfile()).toEqual({ state: 'error', message: READ_ERROR })
    expect(await getProfileByUsernameResult('alice')).toEqual({ state: 'error', message: READ_ERROR })
    await expect(getProfileByUsername('alice')).rejects.toThrow(READ_ERROR)
    expect(boundary.getGraphCounts).not.toHaveBeenCalled()
  })

  it('rejects a mismatched provider owner before any graph read', async () => {
    boundary.reply = { data: profile(SUBJECT), error: null }
    expect(await getMyProfile()).toEqual({ state: 'error', message: READ_ERROR })
    expect(boundary.getGraphCounts).not.toHaveBeenCalled()
  })

  it('rejects an unexpected returned handle and escapes legitimate exact-handle lookup', async () => {
    boundary.reply = { data: profile(SUBJECT, 'bob'), error: null }
    expect(await getProfileByUsernameResult('alice')).toEqual({ state: 'error', message: READ_ERROR })
    expect(boundary.getGraphCounts).not.toHaveBeenCalled()
    boundary.reply = { data: profile(SUBJECT, 'Bob_Campus'), error: null }
    boundary.getGraphCounts.mockResolvedValue({
      counts: { follower_count: 0, following_count: 0, connection_count: null },
      error: null, unavailable: false,
    })
    expect(await getProfileByUsernameResult('  bOb_Campus  ')).toMatchObject({
      state: 'ok', profile: { username: 'Bob_Campus' },
    })
    expect(boundary.operations).toContainEqual(['ilike', 'username', 'bOb\\_Campus'])
  })

  it('keeps genuinely absent rows distinct from provider errors and signed-out state', async () => {
    boundary.reply = { data: null, error: null }
    expect(await getMyProfile()).toEqual({ state: 'missing', userId: OWNER })
    expect(await getProfileByUsernameResult('alice')).toEqual({ state: 'missing' })
    expect(await getProfileByUsername('alice')).toBeNull()
    boundary.getUser.mockResolvedValue(null)
    expect(await getMyProfile()).toEqual({ state: 'signed-out' })
    expect(boundary.getGraphCounts).not.toHaveBeenCalled()
  })
})

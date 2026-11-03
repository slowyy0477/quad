import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  userId: 'owner' as string | null,
  configured: true,
  rows: [] as Record<string, unknown>[],
  queries: 0,
  filters: [] as [string, unknown][],
}))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => fixture.configured }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => false }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => fixture.userId ? { id: fixture.userId } : null,
  createClient: async () => ({
    from: () => {
      fixture.queries++
      const filters: [string, unknown][] = []
      let values: Record<string, unknown> | null = null
      const builder = {
        update: (input: Record<string, unknown>) => { values = input; return builder },
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push([key, value]); fixture.filters.push([key, value]); return builder },
        single: async () => {
          const rows = fixture.rows.filter(row => filters.every(([key, value]) => row[key] === value))
          if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'Expected one own row' } }
          if (values) Object.assign(rows[0], values)
          return { data: { ...rows[0] }, error: null }
        },
      }
      return builder
    },
  }),
}))

import { updatePrivacyAction } from '@/features/settings/actions'
import { getOwnSettings } from '@/features/settings/queries'

function privacy(visibility = 'private') {
  const form = new FormData()
  form.set('visibility', visibility)
  form.set('allow_messages_from', 'nobody')
  form.set('profile_id', 'neighbor')
  form.set('id', 'neighbor')
  form.set('role', 'admin')
  return form
}

beforeEach(() => {
  fixture.userId = 'owner'
  fixture.configured = true
  fixture.queries = 0
  fixture.filters = []
  fixture.rows = ['owner', 'moderator', 'neighbor'].map(id => ({
    id, visibility: 'public', allow_messages_from: 'everyone',
    allow_connection_requests: true, searchable: true,
  }))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('hosted personal settings owner scope', () => {
  it('reads the authenticated owner even when other profiles are visible', async () => {
    const result = await getOwnSettings()
    expect(result.error).toBeNull()
    expect(fixture.filters).toEqual([['id', 'owner']])
    expect(result.profile?.visibility).toBe('public')
  })

  it('ignores forged target/role fields and changes only the verified owner', async () => {
    const before = structuredClone(fixture.rows.slice(1))
    expect((await updatePrivacyAction({ status: 'idle' }, privacy())).status).toBe('saved')
    expect(fixture.rows[0].visibility).toBe('private')
    expect(fixture.rows[0]).not.toHaveProperty('role')
    expect(fixture.rows.slice(1)).toEqual(before)
    expect(fixture.filters).toEqual([['id', 'owner']])
  })

  it('cannot bulk-change users when a moderator saves personal privacy', async () => {
    fixture.userId = 'moderator'
    const ownerBefore = structuredClone(fixture.rows[0])
    const neighborBefore = structuredClone(fixture.rows[2])
    expect((await updatePrivacyAction({ status: 'idle' }, privacy())).status).toBe('saved')
    expect(fixture.rows[1].visibility).toBe('private')
    expect(fixture.rows[0]).toEqual(ownerBefore)
    expect(fixture.rows[2]).toEqual(neighborBefore)
    expect(fixture.filters).toEqual([['id', 'moderator']])
  })

  it('refuses signed-out reads and writes before querying profiles', async () => {
    fixture.userId = null
    expect((await getOwnSettings()).profile).toBeNull()
    expect((await updatePrivacyAction({ status: 'idle' }, privacy())).status).toBe('error')
    expect(fixture.queries).toBe(0)
  })

  it('does not report success when no own profile row was updated', async () => {
    fixture.userId = 'missing'
    const before = structuredClone(fixture.rows)
    expect((await updatePrivacyAction({ status: 'idle' }, privacy())).status).toBe('error')
    expect(fixture.rows).toEqual(before)
  })

  it('does not query a missing provider configuration', async () => {
    fixture.configured = false
    expect((await updatePrivacyAction({ status: 'idle' }, privacy())).status).toBe('error')
    expect(fixture.queries).toBe(0)
  })

  it('rejects invalid field values without a database mutation', async () => {
    expect((await updatePrivacyAction({ status: 'idle' }, privacy('admin'))).status).toBe('error')
    expect(fixture.queries).toBe(0)
  })
})

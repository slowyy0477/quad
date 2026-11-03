import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

/**
 * Fake provider boundary only: no network, key lookup, server or real account.
 * The separate SQL fixture exercises actual ownership predicates and grants.
 * These cases are authored for main and have not been executed by this worker.
 */
const fake = vi.hoisted(() => ({
  original: vi.fn(),
  sdk: vi.fn(),
  rpc: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  budget: vi.fn(),
  fetch: vi.fn(async (): Promise<never> => { throw new Error('Synthetic export forbids network') }),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: fake.original }))
vi.mock('@supabase/supabase-js', () => ({ createClient: fake.sdk }))
vi.mock('@/lib/env', () => ({
  publicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://account-export.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'FAKE-NO-NETWORK-PUBLIC-KEY',
  }),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/local/auth-security', () => ({
  authAttemptSource: () => 'synthetic-source', consumeAuthAttempt: fake.budget,
}))

import { exportHostedAccount } from '@/features/account/hosted'
import { LOCAL_EXPORT_SPECS } from '@/features/account/export'
import { EXPORT_SECTION_NAMES, type ExportSection } from '@/features/account/policy'
import { exportOptionsSchema, exportRequestSchema } from '@/features/account/schemas'

const SUBJECT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const PROJECT = '33333333-3333-4333-8333-333333333333'
const DEPARTMENT = '44444444-4444-4444-8444-444444444444'
const SENT = '55555555-5555-4555-8555-555555555555'
const RECEIVED = '66666666-6666-4666-8666-666666666666'
const PASSWORD = 'Synthetic current password, not a real credential'
const timestamp = '2026-10-31T00:00:00.000Z'
const user = {
  id: SUBJECT, email: 'synthetic@account-export.example.test', is_anonymous: false, factors: [],
  user_metadata: { private: 'FAKE-PROVIDER-IDENTITY-SECRET' },
}

function page(records: Record<string, unknown>[] = []) {
  return { records, next_cursor: null }
}

function allPages() {
  return Object.fromEntries(EXPORT_SECTION_NAMES.map(section => [section, page()]))
}

function reply(sections: Record<string, unknown>, subjectId = SUBJECT) {
  fake.rpc.mockResolvedValue({ data: { subject_id: subjectId, sections }, error: null })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fake.fetch)
  fake.fetch.mockImplementation(async () => { throw new Error('Synthetic export forbids network') })
  fake.budget.mockReturnValue({ allowed: true })
  fake.original.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => {
      if (table !== 'user_roles') throw new Error('Unexpected fake provider relation')
      return {
        select: (columns: string) => {
          if (columns !== 'role') throw new Error('Unexpected fake role projection')
          return {
            eq: async (column: string, id: string) => {
              if (column !== 'user_id' || id !== SUBJECT) throw new Error('Unexpected fake role subject')
              return { data: [], error: null }
            },
          }
        },
      }
    },
  })
  fake.signIn.mockResolvedValue({
    data: { user, session: { access_token: 'FAKE-ACCESS-SECRET', refresh_token: 'FAKE-REFRESH-SECRET' } },
    error: null,
  })
  fake.signOut.mockResolvedValue({ error: null })
  fake.sdk.mockReturnValue({
    auth: {
      signInWithPassword: fake.signIn,
      getUser: async () => ({ data: { user }, error: null }),
      signOut: fake.signOut,
    },
    rpc: fake.rpc,
  })
  reply(allPages())
})

afterEach(() => {
  try { expect(fake.fetch).not.toHaveBeenCalled() } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

describe('fake hosted invitation export boundary', () => {
  it('preserves own sender fields and department_id while stripping all received notes, identities, private project data and credentials', async () => {
    const sections = allPages()
    sections.profile = page([{ id: SUBJECT, department_id: DEPARTMENT, staff_note: 'FAKE-INTERNAL-NOTE' }])
    sections.project_invites_sent = page([{
      id: SENT, project_id: PROJECT, message: 'SELF-AUTHORED-NOTE', proposed_role: 'Own proposed role',
      status: 'accepted', responded_at: timestamp, created_at: timestamp, updated_at: timestamp,
      inviter_id: SUBJECT, invitee_id: OTHER, password_hash: 'FAKE-HASH-SECRET', metadata: user.user_metadata,
    }])
    sections.project_invites_received = page([{
      id: RECEIVED, project_id: PROJECT, status: 'declined', responded_at: timestamp,
      created_at: timestamp, updated_at: timestamp, message: 'OTHER-AUTHOR-PRIVATE-NOTE',
      proposed_role: 'OTHER-AUTHOR-PRIVATE-ROLE', inviter_id: OTHER, invitee_id: SUBJECT,
      project_title: 'PRIVATE-PROJECT-TITLE', project_description: 'PRIVATE-PROJECT-DESCRIPTION',
    }])
    reply(sections)
    const result = await exportHostedAccount({ password: PASSWORD }, { limit: 25 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sections.project_invites_sent?.records).toEqual([{
      id: SENT, project_id: PROJECT, message: 'SELF-AUTHORED-NOTE', proposed_role: 'Own proposed role',
      status: 'accepted', responded_at: timestamp, created_at: timestamp, updated_at: timestamp,
    }])
    expect(result.value.sections.project_invites_received?.records).toEqual([{
      id: RECEIVED, project_id: PROJECT, status: 'declined', responded_at: timestamp,
      created_at: timestamp, updated_at: timestamp,
    }])
    expect(result.value.sections.profile?.records[0]).toHaveProperty('department_id', DEPARTMENT)
    expect(Object.keys(result.value.sections)).toEqual(EXPORT_SECTION_NAMES)
    for (const marker of [
      OTHER, PASSWORD, 'FAKE-ACCESS-SECRET', 'FAKE-REFRESH-SECRET', 'FAKE-HASH-SECRET',
      'FAKE-PROVIDER-IDENTITY-SECRET', 'FAKE-INTERNAL-NOTE', 'OTHER-AUTHOR-PRIVATE-NOTE',
      'OTHER-AUTHOR-PRIVATE-ROLE', 'PRIVATE-PROJECT-TITLE', 'PRIVATE-PROJECT-DESCRIPTION',
    ]) expect(JSON.stringify(result.value)).not.toContain(marker)
    expect(fake.rpc).toHaveBeenCalledWith('account_export', { p_section: null, p_after: null, p_limit: 25 })
    expect(fake.signIn).toHaveBeenCalledWith({ email: user.email, password: PASSWORD })
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(fake.sdk).toHaveBeenCalledWith(
      'https://account-export.invalid', 'FAKE-NO-NETWORK-PUBLIC-KEY',
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    )
  })

  it('refuses wrong reauthentication before invitation RPC work and does not reflect raw provider errors', async () => {
    fake.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, message: 'RAW-PRIVATE-PROVIDER-ERROR' } })
    const result = await exportHostedAccount({ password: PASSWORD }, { section: 'project_invites_sent' })
    expect(result).toEqual({ ok: false, code: 'invalid_password' })
    expect(fake.rpc).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('RAW-PRIVATE-PROVIDER-ERROR')
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('fails closed when a backend omits the new sections or binds the response to another account', async () => {
    const olderContract = allPages()
    delete olderContract.project_invites_sent
    delete olderContract.project_invites_received
    reply(olderContract)
    expect(await exportHostedAccount({ password: PASSWORD }, {})).toEqual({ ok: false, code: 'unavailable' })
    reply({ project_invites_received: page() }, OTHER)
    expect(await exportHostedAccount({ password: PASSWORD }, { section: 'project_invites_received' }))
      .toEqual({ ok: false, code: 'unavailable' })
  })

  it('rejects oversized section pages/fields without returning the private payload', async () => {
    reply({ project_invites_received: page([{}, {}, {}]) })
    expect(await exportHostedAccount({ password: PASSWORD }, { section: 'project_invites_received', limit: 2 }))
      .toEqual({ ok: false, code: 'unavailable' })
    reply({ project_invites_sent: page([{ id: SENT, message: 'OVERSIZED-PRIVATE-NOTE'.repeat(1001) }]) })
    expect(await exportHostedAccount({ password: PASSWORD }, { section: 'project_invites_sent', limit: 1 }))
      .toEqual({ ok: false, code: 'export_too_large' })
  })
})

describe('account export projection source parity', () => {
  it('admits only the named invitation sections through existing strict schemas and bounded continuations', () => {
    for (const section of ['project_invites_sent', 'project_invites_received'] as const) {
      expect(exportOptionsSchema.safeParse({ section, limit: 2, after: SENT }).success).toBe(true)
      expect(exportRequestSchema.safeParse({ password: PASSWORD, section, limit: 2, after: SENT }).success).toBe(true)
      for (const options of [
        { section, limit: 101 }, { section, after: "' OR true --" }, { section, inviter_id: OTHER },
      ]) expect(exportOptionsSchema.safeParse(options).success).toBe(false)
    }
    expect(exportRequestSchema.safeParse({ password: PASSWORD, after: SENT }).success).toBe(false)
    expect(exportRequestSchema.safeParse({ password: PASSWORD, section: 'project_invites', userId: OTHER }).success).toBe(false)
  })

  it('keeps every hosted positive projection aligned with 0038 and preserves all earlier SQL section branches', async () => {
    const [hosted, current, previous] = await Promise.all([
      readFile(new URL('../../src/features/account/hosted.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../supabase/migrations/0038_account_invitation_exports.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../supabase/migrations/0026_account_lifecycle.sql', import.meta.url), 'utf8'),
    ])
    const block = hosted.replace(/\r\n/g, '\n').match(/const hostedFields: Record<ExportSection, string> = \{([\s\S]*?)\n\}/)?.[1]
    if (!block) throw new Error('Hosted export projection declaration was not found')
    const hostedFields = new Map([...block.matchAll(/\b([a-z_]+): '([^']+)'/g)].map(match => [match[1]!, match[2]!] as const))
    const branches = (sql: string) => new Map(
      [...sql.replace(/\r\n/g, '\n').matchAll(/^    when '([^']+)' then .*v_fields := string_to_array\('([^']+)', ' '\);$/gm)]
        .map(match => [match[1]!, { fields: match[2]!, branch: match[0] }] as const),
    )
    const currentBranches = branches(current)
    expect([...hostedFields.keys()]).toEqual(EXPORT_SECTION_NAMES)
    expect([...currentBranches.keys()]).toEqual(EXPORT_SECTION_NAMES)
    for (const section of EXPORT_SECTION_NAMES) {
      expect(currentBranches.get(section)?.fields).toBe(hostedFields.get(section))
    }
    for (const [section, old] of branches(previous)) {
      expect(currentBranches.get(section)?.branch).toBe(old.branch)
    }
    for (const section of ['project_invites_sent', 'project_invites_received'] as ExportSection[]) {
      expect(LOCAL_EXPORT_SPECS[section].fields).toEqual(hostedFields.get(section)?.split(' '))
    }
    expect(LOCAL_EXPORT_SPECS.profile.fields).toContain('department_id')
    expect(hostedFields.get('profile')?.split(' ')).toContain('department_id')
    const names = current.match(/v_names text\[\] := array\[([\s\S]*?)\];/)?.[1]
    expect([...(names ?? '').matchAll(/'([^']+)'/g)].map(match => match[1])).toEqual(EXPORT_SECTION_NAMES)
  })
})

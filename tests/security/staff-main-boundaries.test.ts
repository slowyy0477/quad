import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), createClient: vi.fn(), authUser: vi.fn(),
  requireStaffAssurance: vi.fn(), readStore: vi.fn(), from: vi.fn(), rpc: vi.fn(),
  describeWriteError: vi.fn(), echoValues: vi.fn(), checkRateLimit: vi.fn(),
}))
vi.mock('@/features/auth/staff-mfa', () => ({
  requireStaffAssurance: mocks.requireStaffAssurance,
  StaffAssuranceError: class StaffAssuranceError extends Error {
    constructor(readonly reason: string) {
      super('Synthetic sanitized staff refusal')
      this.name = 'StaffAssuranceError'
    }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: mocks.getUser, createClient: mocks.createClient,
}))
vi.mock('@/lib/local/db', () => ({ readStore: mocks.readStore }))
vi.mock('@/lib/env', () => ({ isSupabaseConfigured: () => true }))
vi.mock('@/lib/form-state', () => ({
  describeWriteError: mocks.describeWriteError, echoValues: mocks.echoValues,
}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }))

import { getAdminRole, getStaffRole } from '@/features/admin/queries'
import { StaffAssuranceError } from '@/features/auth/staff-mfa'
import { action, requireRole, type ActionContext } from '@/lib/action'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const RAW_DETAIL = 'S34-SYNTHETIC-PRIVATE-PROVIDER-DETAIL'
const REPO_ROOT = join(import.meta.dirname, '..', '..')

function observation(role: 'admin' | 'moderator' = 'admin', userId = USER) {
  return { userId, role, verifiedAt: 1_793_448_000, validUntil: 1_793_448_300 }
}

function context(): ActionContext {
  return {
    user: {
      id: USER,
      user_metadata: { role: 'admin' },
      app_metadata: {},
      aud: 'authenticated',
      created_at: '2026-10-31T00:00:00.000Z',
    },
    supabase: {
      from: mocks.from, rpc: mocks.rpc,
      auth: { getUser: mocks.authUser },
    } as unknown as ActionContext['supabase'],
  }
}

function localStore(role: 'admin' | 'moderator' | null = 'admin') {
  return {
    users: [{ id: 'usr_staff', disabled_at: null as string | null }],
    profiles: [{ id: 'pro_staff', user_id: 'usr_staff' }],
    profile_account_states: [],
    user_roles: role ? [{ user_id: 'usr_staff', role }] : [],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '')
  vi.stubEnv('QUAD_ALLOW_LOCAL_IN_PRODUCTION', '')
  mocks.getUser.mockResolvedValue({ id: USER, user_metadata: { role: 'admin' } })
  mocks.authUser.mockResolvedValue({ data: { user: context().user }, error: null })
  mocks.createClient.mockResolvedValue(context().supabase)
  mocks.requireStaffAssurance.mockResolvedValue(observation())
  mocks.readStore.mockResolvedValue(localStore())
  mocks.describeWriteError.mockReturnValue({ message: 'Synthetic unexpected write refusal' })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

function expectNoRawFailurePath() {
  expect(console.error).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
  expect(console.log).not.toHaveBeenCalled()
  expect(mocks.describeWriteError).not.toHaveBeenCalled()
}

describe('shared cloud staff read boundary', () => {
  it.each(['admin', 'moderator'] as const)('returns only the freshly assured own %s role', async role => {
    mocks.requireStaffAssurance.mockResolvedValue(observation(role))
    expect(await getStaffRole()).toBe(role)
    expect(mocks.requireStaffAssurance).toHaveBeenCalledTimes(1)
    expect(mocks.requireStaffAssurance).toHaveBeenCalledWith()
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.readStore).not.toHaveBeenCalled()
  })

  it('preserves the administrator-only projection without elevating moderators', async () => {
    mocks.requireStaffAssurance.mockResolvedValueOnce(observation('moderator'))
    expect(await getAdminRole()).toBeNull()
    expect(await getAdminRole()).toBe('admin')
    expect(mocks.requireStaffAssurance).toHaveBeenCalledTimes(2)
  })

  it('refuses a signed-out caller before requesting staff assurance', async () => {
    mocks.getUser.mockResolvedValue(null)
    expect(await getStaffRole()).toBeNull()
    expect(mocks.requireStaffAssurance).not.toHaveBeenCalled()
  })

  it('refuses a different verified subject or a malformed role', async () => {
    mocks.requireStaffAssurance.mockResolvedValueOnce(observation('admin', OTHER))
    expect(await getStaffRole()).toBeNull()
    mocks.requireStaffAssurance.mockResolvedValueOnce({ ...observation(), role: 'owner' })
    expect(await getStaffRole()).toBeNull()
  })

  it.each(['signed_out', 'not_staff', 'mfa_required', 'unavailable', 'local_unsupported'] as const)(
    'fails closed on %s without logging a provider error', async reason => {
      mocks.requireStaffAssurance.mockRejectedValue(new StaffAssuranceError(reason))
      expect(await getStaffRole()).toBeNull()
      expectNoRawFailurePath()
    },
  )

  it('sanitizes user-lookup and unexpected assurance failures', async () => {
    mocks.getUser.mockRejectedValueOnce(new Error(RAW_DETAIL))
    expect(await getStaffRole()).toBeNull()
    mocks.requireStaffAssurance.mockRejectedValueOnce({ code: 'provider_failure', message: RAW_DETAIL })
    expect(await getStaffRole()).toBeNull()
    expectNoRawFailurePath()
  })

  it('never retains a layout grant after revocation or expiry', async () => {
    expect(await getStaffRole()).toBe('admin')
    mocks.requireStaffAssurance.mockRejectedValueOnce(new StaffAssuranceError('mfa_required'))
    expect(await getStaffRole()).toBeNull()
    expect(await getStaffRole()).toBe('admin')
    expect(mocks.requireStaffAssurance).toHaveBeenCalledTimes(3)
  })
})

describe('shared cloud staff action boundary', () => {
  it.each([
    ['moderator', 'moderator', null],
    ['admin', 'moderator', null],
    ['admin', 'admin', null],
    ['moderator', 'admin', 'That is not available to your account.'],
  ] as const)('checks assured %s against requested %s on every step', async (held, requested, refusal) => {
    mocks.requireStaffAssurance.mockResolvedValue(observation(held))
    expect(await requireRole(requested)(context(), undefined)).toBe(refusal)
    expect(mocks.requireStaffAssurance).toHaveBeenCalledTimes(1)
    expect(mocks.requireStaffAssurance).toHaveBeenCalledWith()
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('binds to the wrapper user instead of another verified staff subject', async () => {
    mocks.requireStaffAssurance.mockResolvedValue(observation('admin', OTHER))
    expect(await requireRole('admin')(context(), undefined))
      .toBe('Your staff verification could not be checked. Please try again.')
    expectNoRawFailurePath()
  })

  it('does not let editable metadata or a malformed assured role grant administrator access', async () => {
    mocks.requireStaffAssurance.mockResolvedValueOnce(observation('moderator'))
    expect(await requireRole('admin')(context(), undefined)).toBe('That is not available to your account.')
    mocks.requireStaffAssurance.mockResolvedValueOnce({ ...observation(), role: 'owner' })
    expect(await requireRole('moderator')(context(), undefined)).toBe('That is not available to your account.')
  })

  it.each([
    ['signed_out', 'Please sign in to do that.'],
    ['not_staff', 'That is not available to your account.'],
    ['mfa_required', 'Verify your authenticator in Settings → Security before using staff tools.'],
    ['unavailable', 'Your staff verification could not be checked. Please try again.'],
    ['local_unsupported', 'Local staff tools are private-preview only and do not provide MFA.'],
  ] as const)('maps %s to fixed refusal copy, not an unexpected-error log', async (reason, refusal) => {
    mocks.requireStaffAssurance.mockRejectedValue(new StaffAssuranceError(reason))
    expect(await requireRole('moderator')(context(), undefined)).toBe(refusal)
    expectNoRawFailurePath()
  })

  it('sanitizes unknown exceptions and does not trust a posted reason/message shape', async () => {
    for (const error of [
      new Error(RAW_DETAIL),
      { reason: 'mfa_required', message: RAW_DETAIL, code: 'provider_failure' },
    ]) {
      mocks.requireStaffAssurance.mockRejectedValueOnce(error)
      expect(await requireRole('admin')(context(), undefined))
        .toBe('Your staff verification could not be checked. Please try again.')
    }
    expectNoRawFailurePath()
  })

  it('rechecks the action independently of a successful page and never reaches a refused service', async () => {
    expect(await getStaffRole()).toBe('admin')
    const service = vi.fn(async () => 'Synthetic saved decision')
    const guarded = action(z.object({ reason: z.string().min(1) }))
      .use(requireRole('moderator')).run(service)
    mocks.requireStaffAssurance.mockRejectedValueOnce(new StaffAssuranceError('mfa_required'))
    expect(await guarded({ reason: 'Synthetic reviewed conduct' })).toEqual({
      ok: false, code: 'refused',
      error: 'Verify your authenticator in Settings → Security before using staff tools.',
    })
    expect(service).not.toHaveBeenCalled()
    expect(await guarded({ reason: 'Synthetic reviewed conduct' })).toEqual({
      ok: true, value: 'Synthetic saved decision',
    })
    expect(service).toHaveBeenCalledTimes(1)
    expect(mocks.requireStaffAssurance).toHaveBeenCalledTimes(3)
    expectNoRawFailurePath()
  })

  it('keeps an unexpected provider outage out of the wrapper raw-error mapper', async () => {
    const service = vi.fn()
    const guarded = action(z.object({})).use(requireRole('admin')).run(service)
    mocks.requireStaffAssurance.mockRejectedValueOnce(new Error(RAW_DETAIL))
    expect(await guarded({})).toEqual({
      ok: false, code: 'refused',
      error: 'Your staff verification could not be checked. Please try again.',
    })
    expect(service).not.toHaveBeenCalled()
    expectNoRawFailurePath()
  })
})

describe('private-local staff role flow remains separate from cloud MFA', () => {
  it.each(['admin', 'moderator'] as const)('retains an active private-local %s without claiming MFA', async role => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NODE_ENV', 'test')
    mocks.getUser.mockResolvedValue({ id: 'usr_staff' })
    mocks.readStore.mockResolvedValue(localStore(role))
    expect(await getStaffRole()).toBe(role)
    expect(mocks.requireStaffAssurance).not.toHaveBeenCalled()
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('preserves disabled-account and expired-suspension checks', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NODE_ENV', 'test')
    mocks.getUser.mockResolvedValue({ id: 'usr_staff' })
    const store = localStore()
    store.users[0].disabled_at = '2026-10-31T00:00:00Z'
    mocks.readStore.mockResolvedValue(store)
    expect(await getStaffRole()).toBeNull()
    store.users[0].disabled_at = null
    mocks.readStore.mockResolvedValue({
      ...store,
      profile_account_states: [{
        profile_id: 'pro_staff', status: 'suspended',
        suspended_until: new Date(Date.now() + 60_000).toISOString(),
      }],
    })
    expect(await getStaffRole()).toBeNull()
    mocks.readStore.mockResolvedValue({
      ...store,
      profile_account_states: [{
        profile_id: 'pro_staff', status: 'suspended',
        suspended_until: new Date(Date.now() - 60_000).toISOString(),
      }],
    })
    expect(await getStaffRole()).toBe('admin')
    expect(mocks.requireStaffAssurance).not.toHaveBeenCalled()
  })

  it('refuses public-local staff before even resolving its session or store', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NODE_ENV', 'production')
    expect(await getStaffRole()).toBeNull()
    expect(mocks.getUser).not.toHaveBeenCalled()
    expect(mocks.readStore).not.toHaveBeenCalled()
    expect(mocks.requireStaffAssurance).not.toHaveBeenCalled()
    expectNoRawFailurePath()
  })

  it('preserves the explicit private-preview override, not arbitrary truthy flags', async () => {
    vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
    vi.stubEnv('NODE_ENV', 'production')
    mocks.getUser.mockResolvedValue({ id: 'usr_staff' })
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', 'true')
    expect(await getStaffRole()).toBeNull()
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '1')
    expect(await getStaffRole()).toBe('admin')
    expect(mocks.requireStaffAssurance).not.toHaveBeenCalled()
  })
})

describe('main staff entrypoint mounting inventory (source contract, not browser proof)', () => {
  it('keeps a fresh shared role check in every existing administrator page', async () => {
    async function pages(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true })
      const nested = await Promise.all(entries.map(async entry => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? pages(path) : entry.name === 'page.tsx' ? [path] : []
      }))
      return nested.flat()
    }
    const paths = await pages(join(REPO_ROOT, 'src', 'app', 'admin'))
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) {
      expect(await readFile(path, 'utf8'), path).toMatch(/\bget(?:Staff|Admin)Role\(\)/)
    }
  })

  it('keeps the shared staff step on cloud report, university and bug decisions', async () => {
    const moderation = await readFile(join(REPO_ROOT, 'src/features/moderation/actions.ts'), 'utf8')
    const bugs = await readFile(join(REPO_ROOT, 'src/features/bugs/actions.ts'), 'utf8')
    for (const name of ['decideReport', 'reviewUniversity']) {
      const start = moderation.indexOf(`const ${name} = action(`)
      const end = moderation.indexOf('.run(', start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      expect(moderation.slice(start, end)).toContain(".use(requireRole('moderator'))")
    }
    expect(bugs).toMatch(/\.use\(requireRole\('admin'\)\)/)
  })
})

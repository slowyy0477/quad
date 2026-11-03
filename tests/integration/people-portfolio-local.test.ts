import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'
import type { LocalGoal, LocalIdea, LocalPost, LocalProfile, LocalProject, Tables } from '@/lib/local/db'

const auth = vi.hoisted(() => ({
  userId: 'usr_alice' as string | null,
  createClient: vi.fn(() => { throw new Error('Local discovery requested hosted data') }),
}))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'quad_local_session' && auth.userId
      ? { name, value: syntheticSessionToken(auth.userId) } : undefined,
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => (await import('@/lib/local/session')).getLocalUser(),
  createClient: auth.createClient,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { readStore, resetLocalCache } from '@/lib/local/db'
import { discoverPeople, listDiscoveryUniversities } from '@/features/search/people'
import { parseKind, searchAll } from '@/features/search/queries'
import { parsePeopleFilters, peopleHref } from '@/features/search/filters'
import {
  belowKeyset, decodeKeysetCursor, encodeKeysetCursor, keysetDate, keysetScope,
} from '@/features/search/paging'
import { getProfilePortfolio, parsePortfolioCursors, PORTFOLIO_SECTIONS } from '@/features/profiles/portfolio'

const AT = '2026-10-20T00:00:00.000Z'
let fixture: TempWorkspace | undefined

/** Synthetic 32-byte bearer; the fixture stores only its digest, like the app. */
function syntheticSessionToken(userId: string): string {
  return createHash('sha256').update(`people-discovery-test-cookie:${userId}`).digest('base64url')
}

/**
 * Read-contract fixtures only, not application writes. Seed the uniquely owned
 * synthetic file directly; do not bypass mutate's cookie-derived auth/budgets
 * with a mocked getUser or a maintenance-write exception.
 */
async function seedSyntheticFixture(change: (db: Tables) => void) {
  if (!fixture) throw new Error('No isolated discovery fixture')
  const file = path.join(fixture.directory, 'synthetic.json')
  if (process.env.LOCAL_DATA_PATH !== file) throw new Error('Unexpected discovery fixture target')
  const db = await readStore()
  change(db)
  await fs.writeFile(file, JSON.stringify(db), { mode: 0o600 })
  resetLocalCache()
}

function profile(name: string, overrides: Partial<LocalProfile> = {}): LocalProfile {
  return {
    id: `prf_${name}`, user_id: `usr_${name}`, username: `person_${name}`,
    display_name: `Discover ${name}`, bio: 'Not part of people search',
    avatar_url: null, university_id: 'uni_one', department: 'Computer Science',
    programme: null, semester: null, website: null, github: null,
    visibility: 'public', searchable: true, created_at: AT, ...overrides,
  }
}

function project(name: string, visibility: LocalProject['visibility'] = 'public'): LocalProject {
  return {
    id: `prj_${name}`, owner_id: 'prf_bob', slug: `project-${name}`, title: `Project ${name}`,
    purpose: 'Work, not a mastery score', description: null, category: 'other', status: 'active',
    visibility, is_seeking_members: false, team_size_target: null, member_count: 99999,
    created_at: AT, deleted_at: null,
  }
}

function idea(name: string, visibility: LocalIdea['visibility'] = 'public'): LocalIdea {
  return {
    id: `ide_${name}`, author_id: 'prf_bob', title: `Idea ${name}`, description: 'A real idea',
    category: 'other', status: 'open', visibility, upvote_count: 99999, interest_count: 99999,
    converted_project_id: null, created_at: AT, deleted_at: null,
  }
}

function goal(name: string, visibility = 'public'): LocalGoal {
  return {
    id: `gol_${name}`, profile_id: 'prf_bob', semester_id: 'sem_private', course_id: 'crs_private',
    title: `Goal ${name}`, description: 'An intention, not measured mastery', category: 'reading',
    status: 'active', target_value: 100, current_value: 99, unit: 'papers', progress_percent: 99,
    visibility, target_date: '2026-12-01', completed_at: null,
    milestone_count: 99999, completed_milestone_count: 99999, created_at: AT,
  }
}

function post(name: string, visibility: LocalPost['visibility'] = 'public'): LocalPost {
  return {
    id: `pst_${name}`, author_id: 'prf_bob', body: `Post ${name}`, visibility,
    project_id: 'prj_private', goal_id: 'gol_private', moderation_status: 'active',
    like_count: 99999, comment_count: 99999, created_at: AT, deleted_at: null,
  }
}

function addProfile(db: Tables, row: LocalProfile) {
  db.profiles.push(row)
  db.users.push({
    id: row.user_id, email: `${row.username}@synthetic.example.test`, password_hash: '',
    created_at: AT,
  })
  db.sessions.push({
    id: `ses_${row.username.replace(/_/g, '')}`, user_id: row.user_id,
    token_hash: createHash('sha256').update(syntheticSessionToken(row.user_id)).digest('hex'),
    created_at: AT, expires_at: '2099-01-01T00:00:00.000Z',
  })
}

beforeEach(async () => {
  fixture = await createTempWorkspace('people-portfolio')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', path.join(fixture.directory, 'synthetic.json'))
  auth.userId = 'usr_alice'
  vi.clearAllMocks()
  await seedSyntheticFixture((db) => {
    for (const name of ['alice', 'bob', 'carol', 'private', 'unlisted', 'campus',
      'othercampus', 'connected', 'pending', 'blockout', 'blockin', 'suspended', 'expired', 'disabled']) {
      addProfile(db, profile(name))
    }
    db.profiles.find((row) => row.id === 'prf_carol')!.university_id = 'uni_two'
    db.profiles.find((row) => row.id === 'prf_private')!.visibility = 'private'
    db.profiles.find((row) => row.id === 'prf_unlisted')!.searchable = false
    db.profiles.find((row) => row.id === 'prf_campus')!.visibility = 'university'
    Object.assign(db.profiles.find((row) => row.id === 'prf_othercampus')!,
      { visibility: 'university', university_id: 'uni_two' })
    db.profiles.find((row) => row.id === 'prf_connected')!.visibility = 'connections'
    db.profiles.find((row) => row.id === 'prf_pending')!.visibility = 'connections'
    db.users.find((row) => row.id === 'usr_disabled')!.disabled_at = AT
    db.profile_account_states.push({
      id: 'pas_suspended', profile_id: 'prf_suspended', status: 'suspended',
      suspended_until: '2099-01-01T00:00:00.000Z', warning_count: 0,
    }, {
      id: 'pas_expired', profile_id: 'prf_expired', status: 'suspended',
      suspended_until: '2000-01-01T00:00:00.000Z', warning_count: 0,
    })
    db.connections.push({
      id: 'con_accepted', requester_id: 'prf_alice', addressee_id: 'prf_connected',
      status: 'accepted', message: null, created_at: AT, responded_at: AT,
    }, {
      id: 'con_pending', requester_id: 'prf_alice', addressee_id: 'prf_pending',
      status: 'pending', message: null, created_at: AT, responded_at: null,
    })
    db.blocks.push(
      { id: 'blk_out', blocker_id: 'prf_alice', blocked_id: 'prf_blockout', reason: null, created_at: AT },
      { id: 'blk_in', blocker_id: 'prf_blockin', blocked_id: 'prf_alice', reason: null, created_at: AT },
    )
    for (const suffix of ['one', 'two']) db.universities.push({
      id: `uni_${suffix}`, name: `Synthetic University ${suffix}`, short_name: suffix,
      city: null, country: 'Pakistan', student_count: 99999, project_count: 99999, created_at: AT,
    })
    db.skills.push({
      id: 'skl_typescript', name: 'TypeScript', slug: 'typescript', category: 'language',
      is_approved: true, usage_count: 99999, created_by: null, created_at: AT,
    }, {
      id: 'skl_secret', name: 'Secret unapproved skill', slug: 'secret', category: 'other',
      is_approved: false, usage_count: 99999, created_by: 'prf_bob', created_at: AT,
    })
    for (const name of ['bob', 'private', 'unlisted', 'campus', 'othercampus', 'connected',
      'pending', 'blockout', 'blockin', 'suspended', 'disabled']) db.profile_skills.push({
      id: `psk_${name}`, profile_id: `prf_${name}`, skill_id: 'skl_typescript', level: 'familiar',
      is_learning: true, display_order: 0, endorsement_count: 99999, created_at: AT,
    })
    db.profile_skills.push({
      id: 'psk_secret', profile_id: 'prf_bob', skill_id: 'skl_secret', level: 'advanced',
      is_learning: false, display_order: 1, endorsement_count: 99999, created_at: AT,
    })
  })
})

afterEach(async () => {
  expect(auth.createClient).not.toHaveBeenCalled()
  resetLocalCache()
  vi.unstubAllEnvs()
  const owned = fixture
  fixture = undefined
  await owned?.cleanup()
})

describe('canonical people URLs and privacy', () => {
  it('supports canonical type=people, legacy tab=person, first-wins parameters and escaped URLs', () => {
    expect(parseKind('people')).toBe('person')
    expect(parseKind('person')).toBe('person')
    expect(parseKind('projects')).toBe('project')
    expect(parseKind('__proto__')).toBe('person')
    const filters = parsePeopleFilters({
      q: ['  Alice & Bob  ', 'ignored'], university: ' uni_one ',
      department: ' Computing, ("A") ', skill: ' 50%_\\literal ',
    })
    const url = new URL(peopleHref(filters, 'opaque_cursor'), 'https://bulla.test')
    expect(url.searchParams.get('type')).toBe('people')
    expect(url.searchParams.get('q')).toBe('Alice & Bob')
    expect(url.searchParams.get('department')).toBe('Computing, ("A")')
    expect(url.searchParams.get('skill')).toBe('50%_\\literal')
    expect(url.searchParams.get('university')).toBe('uni_one')
    expect(url.searchParams.get('cursor')).toBe('opaque_cursor')
    expect(new URL(peopleHref(filters), 'https://bulla.test').searchParams.has('cursor')).toBe(false)
  })

  it('combines university, department and skill over readable searchable profiles only', async () => {
    const page = await discoverPeople({
      universityId: 'uni_one', department: 'SCIENCE', skill: 'script', query: 'discover',
    })
    expect(page.error).toBeNull()
    expect(page.people?.map((row) => row.id).sort()).toEqual(['prf_bob', 'prf_campus', 'prf_connected'])
    expect(page.people?.find((row) => row.id === 'prf_bob')).toMatchObject({
      university: { id: 'uni_one', name: 'Synthetic University one' }, department: 'Computer Science',
      skills: [{ name: 'TypeScript', level: 'familiar', is_learning: true }],
    })
    expect(JSON.stringify(page)).not.toMatch(/99999|secret|email|password|usage_count|endorsement_count|post_count|student_count/i)
    expect(page).not.toHaveProperty('total')
  })

  it('empty names browse, and existing searchAll person reads use the new count-free contract', async () => {
    const page = await searchAll({ query: '', kind: 'person', skill: 'script', universityId: 'uni_one' })
    expect(page.results).toHaveLength(3)
    expect(page.total).toBeNull()
    expect(page.error).toBeNull()
  })

  it('does not infer opted-out or private accounts from empty results, even for their own searches', async () => {
    expect((await discoverPeople({ query: 'unlisted' })).people).toEqual([])
    auth.userId = 'usr_unlisted'
    expect((await discoverPeople({ query: 'unlisted' })).people).toEqual([])
    // Opting out of search does not turn a readable direct profile into a private profile.
    expect((await getProfilePortfolio('prf_unlisted')).portfolio?.profileId).toBe('prf_unlisted')
    auth.userId = 'usr_alice'
    expect((await discoverPeople({ query: 'private' })).people).toEqual([])
  })

  it('does not match unapproved skill names hidden by the catalogue contract', async () => {
    expect((await discoverPeople({ skill: 'secret' })).people).toEqual([])
    auth.userId = 'usr_bob'
    expect((await discoverPeople({ skill: 'secret' })).people?.map((row) => row.id)).toEqual(['prf_bob'])
  })

  it('keeps name, department and skill metacharacters literal', async () => {
    await seedSyntheticFixture((db) => {
      const bob = db.profiles.find((row) => row.id === 'prf_bob')!
      bob.display_name = '50%_\\name,("literal")'
      bob.department = 'Dept %_\\,("literal")'
      db.skills[0].name = 'Skill %_\\,("literal")'
    })
    const page = await discoverPeople({
      query: '50%_\\name,("literal")', department: '%_\\,("literal")', skill: '%_\\,("literal")',
    })
    expect(page.people?.map((row) => row.id)).toEqual(['prf_bob'])
    expect((await discoverPeople({ query: '50normalname' })).people).toEqual([])
  })

  it('rejects oversized filters and invalid IDs instead of broadening them', async () => {
    for (const filters of [
      { query: 'x'.repeat(121) }, { department: 'x'.repeat(161) }, { skill: 'x'.repeat(61) },
      { universityId: 'uni_one),or(private)' },
    ]) expect((await discoverPeople(filters)).people).toBeNull()
    expect((await discoverPeople({ query: 'x' })).error).toMatch(/two characters/)
  })

  it('requires an active verified reader and excludes self only when requested', async () => {
    expect((await discoverPeople({ excludeSelf: true })).people?.some((row) => row.id === 'prf_alice')).toBe(false)
    auth.userId = null
    expect((await discoverPeople()).people).toBeNull()
    auth.userId = 'usr_disabled'
    expect((await discoverPeople()).people).toBeNull()
    auth.userId = 'usr_suspended'
    expect((await discoverPeople()).people).toBeNull()
  })

  it('resolves the reader through the real hashed cookie/session verifier, not a selected user ID alone', async () => {
    auth.userId = 'usr_bob'
    expect((await getProfilePortfolio('prf_bob')).portfolio?.isSelf).toBe(true)
    await seedSyntheticFixture((db) => {
      db.sessions = db.sessions.filter((row) => row.user_id !== 'usr_bob')
    })
    expect((await discoverPeople()).people).toBeNull()
    expect((await getProfilePortfolio('prf_bob')).portfolio?.isSelf).toBe(false)
  })

  it('expired temporary suspensions admit fresh discovery/portfolio reads without altering account state', async () => {
    expect((await discoverPeople({ query: 'expired' })).people?.map((row) => row.id)).toEqual(['prf_expired'])
    expect((await getProfilePortfolio('prf_expired')).portfolio?.profileId).toBe('prf_expired')
    auth.userId = 'usr_expired'
    expect((await discoverPeople({ query: 'Discover bob' })).people?.map((row) => row.id)).toEqual(['prf_bob'])
  })

  it('the bounded institution picker never carries profile-derived counters', async () => {
    const picker = await listDiscoveryUniversities(1)
    expect(picker.universities).toHaveLength(1)
    expect(picker.hasMore).toBe(true)
    expect(Object.keys(picker.universities[0]).sort()).toEqual(['id', 'name', 'short_name'])
    expect(JSON.stringify(picker)).not.toContain('99999')
  })
})

describe('people keyset pages', () => {
  beforeEach(async () => {
    await seedSyntheticFixture((db) => {
      for (let index = 1; index <= 7; index++) {
        addProfile(db, profile(`pager${String(index).padStart(2, '0')}`, { display_name: 'Pager Person' }))
      }
    })
  })

  it('ties are deterministic, lookahead is readable-only, and hiding the boundary does not repeat page one', async () => {
    const first = await discoverPeople({ query: 'Pager', limit: 2 })
    expect(first.people?.map((row) => row.id)).toEqual(['prf_pager07', 'prf_pager06'])
    expect(first.nextCursor).not.toBeNull()
    await seedSyntheticFixture((db) => {
      db.profiles.find((row) => row.id === 'prf_pager06')!.visibility = 'private'
      addProfile(db, profile('pager08', { display_name: 'Pager Person', created_at: '2026-10-21T00:00:00.000Z' }))
    })
    const second = await discoverPeople({ query: 'Pager', limit: 2, cursor: first.nextCursor! })
    expect(second.people?.map((row) => row.id)).toEqual(['prf_pager05', 'prf_pager04'])
    const third = await discoverPeople({ query: 'Pager', limit: 2, cursor: second.nextCursor! })
    expect(third.people?.map((row) => row.id)).toEqual(['prf_pager03', 'prf_pager02'])
    const last = await discoverPeople({ query: 'Pager', limit: 2, cursor: third.nextCursor! })
    expect(last.people?.map((row) => row.id)).toEqual(['prf_pager01'])
    expect(last.nextCursor).toBeNull()
  })

  it('an exact-size page has no speculative next cursor', async () => {
    const first = await discoverPeople({ query: 'Pager', limit: 7 })
    expect(first.people).toHaveLength(7)
    expect(first.nextCursor).toBeNull()
  })

  it('changing a filter resets the boundary; malicious/truncated cursors are ignored safely', async () => {
    const first = await discoverPeople({ query: 'Pager', limit: 2 })
    const changed = await discoverPeople({
      query: 'Pager', department: 'Computer', limit: 2, cursor: first.nextCursor!,
    })
    expect(changed.people?.map((row) => row.id)).toEqual(['prf_pager07', 'prf_pager06'])
    for (const cursor of ['%%%not-base64%%%', 'x'.repeat(2000), first.nextCursor!.slice(0, -3)]) {
      expect((await discoverPeople({ query: 'Pager', cursor, limit: 2 })).people).toEqual(first.people)
    }
    const scope = keysetScope(['people', 'pager', null, '', '', false])
    const malicious = encodeKeysetCursor({ createdAt: AT, id: 'prf_x),or(private)' }, scope)
    expect(decodeKeysetCursor(malicious, scope, true)).toBeNull()
  })

  it('page limits are finite and clamped, and hidden lookahead does not announce more people', async () => {
    expect((await discoverPeople({ query: 'Pager', limit: 0 })).people).toHaveLength(1)
    expect((await discoverPeople({ query: 'Pager', limit: Number.NaN })).people).toHaveLength(7)
    expect((await discoverPeople({ query: 'Pager', limit: Number.POSITIVE_INFINITY })).people).toHaveLength(7)
    await seedSyntheticFixture((db) => {
      for (const row of db.profiles) if (row.id.startsWith('prf_pager') && row.id !== 'prf_pager07') row.searchable = false
    })
    const page = await discoverPeople({ query: 'Pager', limit: 1 })
    expect(page.people?.map((row) => row.id)).toEqual(['prf_pager07'])
    expect(page.nextCursor).toBeNull()
  })

  it('preserves microsecond timestamps and rejects impossible dates', () => {
    const scope = keysetScope(['microseconds'])
    const at = '2026-10-20T00:00:00.000999+00:00'
    const cursor = decodeKeysetCursor(encodeKeysetCursor({ createdAt: at, id: 'prf_micro' }, scope), scope, true)!
    expect(cursor.createdAt).toBe('2026-10-20T00:00:00.000999Z')
    expect(belowKeyset({ id: 'prf_zzzz', created_at: '2026-10-20T00:00:00.000998Z' }, cursor)).toBe(true)
    expect(keysetDate('2026-02-30T00:00:00.000Z')).toBeNull()
  })
})

describe('permission-safe profile portfolio', () => {
  beforeEach(async () => {
    await seedSyntheticFixture((db) => {
      db.connections.push({
        id: 'con_bob', requester_id: 'prf_alice', addressee_id: 'prf_bob',
        status: 'accepted', message: null, created_at: AT, responded_at: AT,
      })
      for (const visibility of ['public', 'university', 'connections', 'private'] as const) {
        db.projects.push(project(visibility, visibility))
        db.ideas.push(idea(visibility, visibility))
        db.goals.push(goal(visibility, visibility))
        db.posts.push(post(visibility, visibility))
      }
      db.project_members.push({ id: 'mem_private', project_id: 'prj_private', profile_id: 'prf_alice', role: 'member', created_at: AT })
      db.projects.push({ ...project('deleted'), deleted_at: AT }, project('hidden'))
      db.ideas.push({ ...idea('deleted'), deleted_at: AT }, idea('hidden'))
      db.posts.push({ ...post('deleted'), deleted_at: AT }, { ...post('hidden'), moderation_status: 'hidden' })
      db.content_moderation.push(
        { id: 'mod_project', kind: 'project', target_id: 'prj_hidden', status: 'hidden' },
        { id: 'mod_idea', kind: 'idea', target_id: 'ide_hidden', status: 'removed' },
      )
      db.daily_logs.push({
        id: 'log_private', profile_id: 'prf_bob', log_date: '2026-10-20', hours_studied: 99,
        mood: 1, productivity: 1, summary: 'PRIVATE LEARNING SENTINEL', wins: null, blockers: null,
        created_at: AT, updated_at: AT,
      })
    })
  })

  it('a readable profile does not publish private goals, posts or ideas; membership permits its private project only', async () => {
    const result = await getProfilePortfolio('prf_bob')
    expect(result.error).toBeNull()
    const portfolio = result.portfolio!
    expect(portfolio.isSelf).toBe(false)
    expect(portfolio.projects.items?.map((row) => row.id).sort()).toEqual([
      'prj_connections', 'prj_private', 'prj_public', 'prj_university',
    ])
    for (const section of ['ideas', 'goals', 'posts'] as const) {
      expect(portfolio[section].items).toHaveLength(3)
      expect(portfolio[section].items?.some((row) => row.id.endsWith('private'))).toBe(false)
    }
    expect(JSON.stringify(portfolio)).not.toMatch(/99999|PRIVATE LEARNING|"(?:current_value|target_value|progress_percent|milestone_count|semester_id|course_id|goal_id|like_count|activity|mastery)"\s*:/i)
    for (const section of PORTFOLIO_SECTIONS) for (const item of portfolio[section].items ?? []) {
      expect(Object.keys(item).sort()).toEqual([
        'created_at', 'excerpt', 'href', 'id', 'status', 'target_date', 'title', 'visibility',
      ])
    }
    expect(portfolio.projects.items?.find((row) => row.id === 'prj_public')?.href).toBe('/projects/project-public')
    expect(portfolio.ideas.items?.find((row) => row.id === 'ide_public')?.href).toBe('/ideas/ide_public')
    expect(portfolio.posts.items?.find((row) => row.id === 'pst_public')?.href).toBe('/post/pst_public')
    expect(portfolio.goals.items?.every((row) => row.href === null)).toBe(true)
  })

  it('a different-campus stranger sees only independently public content', async () => {
    auth.userId = 'usr_carol'
    const portfolio = (await getProfilePortfolio('prf_bob')).portfolio!
    for (const section of PORTFOLIO_SECTIONS) {
      expect(portfolio[section].items).toHaveLength(1)
      expect(portfolio[section].items?.[0].visibility).toBe('public')
    }
  })

  it('signed-out visitors can read public portfolios without any private learning', async () => {
    auth.userId = null
    const portfolio = (await getProfilePortfolio('prf_bob')).portfolio!
    expect(portfolio.isSelf).toBe(false)
    for (const section of PORTFOLIO_SECTIONS) expect(portfolio[section].items).toHaveLength(1)
  })

  it('owners retain private readable items, never hidden/deleted moderation items or fabricated metrics', async () => {
    auth.userId = 'usr_bob'
    const portfolio = (await getProfilePortfolio('prf_bob')).portfolio!
    expect(portfolio.isSelf).toBe(true)
    for (const section of PORTFOLIO_SECTIONS) expect(portfolio[section].items).toHaveLength(4)
    expect(JSON.stringify(portfolio)).not.toMatch(/99999|PRIVATE LEARNING|_count|progress_percent/)
  })

  it('hidden, blocked, missing and invalid profile targets use the same non-disclosing result', async () => {
    const absent = { portfolio: null, error: null }
    for (const target of ['prf_private', 'prf_blockout', 'prf_blockin', 'prf_disabled', 'prf_suspended',
      'prf_doesnotexist', 'not-a-valid-id']) expect(await getProfilePortfolio(target)).toEqual(absent)
    await seedSyntheticFixture((db) => { db.profiles.find((row) => row.id === 'prf_bob')!.visibility = 'private' })
    expect(await getProfilePortfolio('prf_bob')).toEqual(absent)
  })

  it('per-section pages are independently bounded, stable after removal and scoped to the profile', async () => {
    await seedSyntheticFixture((db) => {
      for (let index = 1; index <= 5; index++) {
        const name = `page${index}`
        db.projects.push({ ...project(name), created_at: '2026-10-21T00:00:00.000001Z' })
        db.ideas.push({ ...idea(name), created_at: '2026-10-21T00:00:00.000001Z' })
        db.goals.push({ ...goal(name), created_at: '2026-10-21T00:00:00.000001Z' })
        db.posts.push({ ...post(name), created_at: '2026-10-21T00:00:00.000001Z' })
      }
    })
    const first = (await getProfilePortfolio('prf_bob', { limit: 2 })).portfolio!
    for (const section of PORTFOLIO_SECTIONS) {
      expect(first[section].items).toHaveLength(2)
      expect(first[section].nextCursor).not.toBeNull()
      expect(first[section].items?.map((row) => row.id.split('_')[1])).toEqual(['page5', 'page4'])
    }
    const cursors = parsePortfolioCursors({
      portfolio_projects: [first.projects.nextCursor!, 'ignored'],
      portfolio_goals: first.goals.nextCursor!,
    })
    await seedSyntheticFixture((db) => { db.projects = db.projects.filter((row) => row.id !== 'prj_page4') })
    const second = (await getProfilePortfolio('prf_bob', { limit: 2, cursors })).portfolio!
    expect(second.projects.items?.map((row) => row.id)).toEqual(['prj_page3', 'prj_page2'])
    expect(second.goals.items?.map((row) => row.id)).toEqual(['gol_page3', 'gol_page2'])
    expect(second.posts.items).toEqual(first.posts.items)
    const wrongSection = (await getProfilePortfolio('prf_bob', {
      limit: 2, cursors: { ideas: first.projects.nextCursor! },
    })).portfolio!
    expect(wrongSection.ideas.items).toEqual(first.ideas.items)
  })

  it('portfolio limits are clamped and oversized descriptions are not sent to the component', async () => {
    await seedSyntheticFixture((db) => {
      db.ideas.find((row) => row.id === 'ide_public')!.description = 'x'.repeat(4000)
      for (let index = 1; index <= 20; index++) db.projects.push(project(`extra${index}`))
    })
    const result = (await getProfilePortfolio('prf_bob', { limit: 100000 })).portfolio!
    expect(result.projects.items).toHaveLength(12)
    expect(result.ideas.items?.find((row) => row.id === 'ide_public')?.excerpt).toHaveLength(240)
    expect((await getProfilePortfolio('prf_bob', { limit: 0 })).portfolio?.projects.items).toHaveLength(1)
  })
})

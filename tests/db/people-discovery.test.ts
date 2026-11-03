/**
 * Synthetic Postgres/RLS + real Supabase query-builder tests.
 * HTTP is intercepted and translated to parameterized SQL in isolated PGlite.
 * This is not hosted PostgREST/Auth/transport or concurrent-connection evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

const auth = vi.hoisted(() => ({
  userId: null as string | null,
  client: undefined as unknown,
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => auth.userId ? { id: auth.userId } : null,
  createClient: async () => auth.client,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { discoverPeople, listDiscoveryUniversities } from '@/features/search/people'
import {
  decodeKeysetCursor, encodeKeysetCursor, keysetScope, hostedKeysetFilter,
} from '@/features/search/paging'
import { getProfilePortfolio, PORTFOLIO_SECTIONS } from '@/features/profiles/portfolio'

let db: TestDb
const users: Record<string, string> = {}
let uniA: string
let uniB: string
let deptA: string
let deptB: string
let typescript: string
let secretSkill: string
const pagers: string[] = []
const AT = '2026-10-20T00:00:00.000000Z'
const requests: { path: string; params: URLSearchParams; body?: Record<string, unknown> }[] = []
let failTable: string | null = null
let queue: Promise<unknown> = Promise.resolve()

const ALLOWED_COLUMNS: Record<string, string[]> = {
  profiles: ['id', 'username', 'status', 'suspended_until'],
  universities: ['id', 'name', 'short_name'],
  projects: ['id', 'slug', 'title', 'tagline', 'status', 'visibility', 'created_at'],
  ideas: ['id', 'title', 'description', 'status', 'visibility', 'created_at'],
  goals: ['id', 'title', 'description', 'status', 'visibility', 'target_date', 'created_at'],
  posts: ['id', 'body', 'visibility', 'created_at'],
}

async function runAsReader(reader: string | null, sql: string, params: unknown[]) {
  // The shared harness has one session: serialize it so claims cannot interleave.
  const request = queue.then(() => reader ? db.asUser(reader, sql, params) : db.asAnon(sql, params))
  queue = request.then(() => undefined, () => undefined)
  return request
}

function timeColumn(column: string): string {
  return column === 'created_at'
    ? `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`
    : column === 'target_date' ? `to_char(target_date, 'YYYY-MM-DD') as target_date`
    : column === 'suspended_until'
      ? `to_char(suspended_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as suspended_until` : column
}

function readSql(table: string, query: URLSearchParams): { sql: string; values: unknown[] } {
  const columns = query.get('select')?.split(',') ?? []
  if (!ALLOWED_COLUMNS[table] || !columns.length ||
    columns.some((column) => !ALLOWED_COLUMNS[table].includes(column))) {
    throw new Error('Synthetic reader rejected an unexpected projection')
  }
  const clauses: string[] = []
  const values: unknown[] = []
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}` }
  for (const [key, value] of query) {
    if (['select', 'order', 'limit'].includes(key)) continue
    if (key === 'or') {
      const match = /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^,)]+)\)\)$/.exec(value)
      if (!match || match[1] !== match[2]) throw new Error('Unexpected keyset expression')
      const at = parameter(match[1])
      const id = parameter(match[3])
      clauses.push(`(created_at < ${at}::timestamptz or (created_at = ${at}::timestamptz and id < ${id}::uuid))`)
      continue
    }
    if (!['id', 'owner_id', 'author_id', 'profile_id', 'deleted_at', 'status', 'moderation_status'].includes(key)) {
      throw new Error('Unexpected synthetic filter column')
    }
    if (value === 'is.null') clauses.push(`${key} is null`)
    else if (value.startsWith('eq.')) clauses.push(`${key} = ${parameter(value.slice(3))}`)
    else throw new Error('Unexpected synthetic comparison')
  }
  const order = query.get('order')?.split(',').map((part) => {
    const [column, direction] = part.split('.')
    if (!['created_at', 'id', 'name'].includes(column) || !['asc', 'desc'].includes(direction)) {
      throw new Error('Unexpected synthetic order')
    }
    return `${column} ${direction}`
  }).join(', ')
  const limit = query.get('limit')
  if (limit && !/^\d{1,3}$/.test(limit)) throw new Error('Unexpected synthetic limit')
  return {
    sql: `select ${columns.map(timeColumn).join(', ')} from public.${table}` +
      (clauses.length ? ` where ${clauses.join(' and ')}` : '') +
      (order ? ` order by ${order}` : '') + (limit ? ` limit ${limit}` : ''),
    values,
  }
}

const syntheticFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== 'bulla.synthetic.invalid') throw new Error('Real network is forbidden by this test')
  const path = url.pathname.replace('/rest/v1/', '')
  const reader = auth.userId
  try {
    if (path === 'rpc/people_discovery') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ path, params: url.searchParams, body })
      const rows = await runAsReader(reader, `
        select id, username, display_name, avatar_url, headline,
               to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
               university_id, university_name, university_short_name, department, skills
          from public.people_discovery($1, $2, $3, $4, $5, $6, $7, $8)
      `, [body.p_query, body.p_university_id, body.p_department, body.p_skill,
        body.p_after_created_at, body.p_after_id, body.p_limit, body.p_exclude_self])
      return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } })
    }
    requests.push({ path, params: url.searchParams })
    if (path === failTable) throw new Error('Synthetic section failure')
    const query = readSql(path, url.searchParams)
    const rows = await runAsReader(reader, query.sql, query.values)
    return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({
      code: 'XX000', message: 'Synthetic query rejected', details: null, hint: null,
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
}

beforeAll(async () => {
  db = await createTestDb()
  const universities = await db.asService<{ id: string }>(`
    insert into public.universities (name, country, status)
    values ('Discovery Synthetic A', 'Pakistan', 'approved'),
           ('Discovery Synthetic B', 'Pakistan', 'approved') returning id
  `)
  uniA = universities[0].id
  uniB = universities[1].id
  const departments = await db.asService<{ id: string }>(`
    insert into public.departments (university_id, name)
    values ($1, 'Computer Science'), ($2, 'Computer Science') returning id
  `, [uniA, uniB])
  deptA = departments[0].id
  deptB = departments[1].id

  for (const name of ['alice', 'bob', 'carol', 'private', 'unlisted', 'campus', 'othercampus',
    'connected', 'pending', 'blockout', 'blockin', 'suspended', 'expired', 'banned', 'deleted', 'staff']) {
    users[name] = await db.createUser({
      username: `discovery_${name}`, fullName: `Discover ${name}`,
      universityId: name === 'carol' || name === 'othercampus' ? uniB : uniA,
      visibility: name === 'private' ? 'private'
        : name === 'campus' || name === 'othercampus' ? 'university'
        : name === 'connected' || name === 'pending' ? 'connections' : 'public',
      ...(name === 'staff' ? { role: 'moderator' as const } : {}),
    })
    await db.asService(`update public.profiles set department_id = $2, created_at = $3 where id = $1`,
      [users[name], name === 'carol' || name === 'othercampus' ? deptB : deptA, AT])
  }
  await db.asService(`update public.profiles set searchable = false where id = $1`, [users.unlisted])
  await db.asService(`update public.profiles set status = 'suspended', suspended_until = '2099-01-01' where id = $1`, [users.suspended])
  await db.asService(`update public.profiles set status = 'suspended', suspended_until = '2000-01-01' where id = $1`, [users.expired])
  await db.asService(`update public.profiles set status = 'banned' where id = $1`, [users.banned])
  await db.asService(`update public.profiles set deleted_at = now() where id = $1`, [users.deleted])
  await db.asService(`
    insert into public.connections (requester_id, addressee_id, status)
    values ($1, $2, 'accepted'), ($1, $3, 'accepted'), ($1, $4, 'pending')
  `, [users.alice, users.bob, users.connected, users.pending])
  await db.asService(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($3, $1)`,
    [users.alice, users.blockout, users.blockin])
  typescript = (await db.asService<{ id: string }>(`
    insert into public.skills (name, is_approved) values ('TypeScript', true) returning id
  `))[0].id
  secretSkill = (await db.asService<{ id: string }>(`
    insert into public.skills (name, is_approved, created_by)
    values ('Secret unapproved skill', false, $1) returning id
  `, [users.bob]))[0].id
  for (const name of ['bob', 'private', 'unlisted', 'campus', 'othercampus', 'connected',
    'pending', 'blockout', 'blockin', 'suspended', 'banned', 'deleted']) {
    await db.asService(`insert into public.profile_skills (profile_id, skill_id, level, is_learning)
      values ($1, $2, 'familiar', true)`, [users[name], typescript])
  }
  await db.asService(`insert into public.profile_skills (profile_id, skill_id, level)
    values ($1, $2, 'advanced')`, [users.bob, secretSkill])

  for (let index = 1; index <= 7; index++) {
    const id = `1000000${index}-0000-4000-8000-000000000001`
    pagers.push(id)
    await db.asService(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values ($1, $2, now(), '{"full_name":"Pager Person"}'::jsonb)`,
    [id, `pager${index}@synthetic.example.test`])
    await db.asService(`update public.profiles set university_id = $2, created_at = $3 where id = $1`,
      [id, uniA, AT])
    // Raw Auth signup stays private under 0030; pager fixtures explicitly consent
    // to public discovery through the owning user's ordinary RLS update.
    await db.asUser(id, `update public.profiles set visibility = 'public', searchable = true where id = $1`,
      [id])
  }

  for (const visibility of ['public', 'university', 'connections', 'private']) {
    await db.asService(`
      insert into public.projects (owner_id, title, tagline, visibility, created_at)
      values ($1, $2, 'A real project', $3, $4)
    `, [users.bob, `Portfolio project ${visibility}`, visibility, AT])
    await db.asService(`
      insert into public.ideas (author_id, title, description, visibility, created_at)
      values ($1, $2, 'A real idea shared with the permitted audience.', $3, $4)
    `, [users.bob, `Portfolio idea ${visibility}`, visibility, AT])
    await db.asService(`
      insert into public.goals (profile_id, title, description, visibility, target_date, created_at)
      values ($1, $2, 'A self-declared intention', $3, '2026-12-01', $4)
    `, [users.bob, `Portfolio goal ${visibility}`, visibility, AT])
    await db.asService(`
      insert into public.posts (author_id, body, visibility, created_at)
      values ($1, $2, $3, $4)
    `, [users.bob, `Portfolio post ${visibility}`, visibility, AT])
  }
  await db.asService(`
    insert into public.project_members (project_id, profile_id, role)
    select id, $1, 'member' from public.projects
     where owner_id = $2 and visibility = 'private'
  `, [users.alice, users.bob])
  for (const section of ['projects', 'ideas', 'posts'] as const) {
    const owner = section === 'projects' ? 'owner_id' : 'author_id'
    const title = section === 'posts' ? 'body' : 'title'
    for (const state of ['hidden', 'deleted']) {
      await db.asService(`
        insert into public.${section} (${owner}, ${title}, visibility, moderation_status, deleted_at${section === 'ideas' ? ', description' : ''})
        values ($1, $2, 'public', $3, $4${section === 'ideas' ? ", 'A synthetic moderation fixture with enough description.'" : ''})
      `, [users.bob, `Portfolio ${section} ${state}`, state === 'hidden' ? 'hidden' : 'active',
        state === 'deleted' ? AT : null])
    }
  }
  // Private learning rows and raw counters must never be consulted by the API.
  await db.asService(`insert into public.daily_logs (profile_id, log_date, summary)
    values ($1, '2026-10-20', 'PRIVATE LEARNING SENTINEL')`, [users.bob])
  await db.asService(`update public.profiles set post_count = 99999, project_count = 99999 where id = $1`, [users.bob])
  auth.client = createSupabaseClient('https://bulla.synthetic.invalid', 'synthetic-anon-key-not-a-credential', {
    global: { fetch: syntheticFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}, 60000)

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  auth.userId = users.alice
  requests.length = 0
  failTable = null
})

afterAll(async () => {
  await queue
  await db?.close()
  vi.unstubAllEnvs()
})

describe('forward people RPC permissions and literal filters', () => {
  it('is invoker-scoped, has no anonymous execute grant and returns no count/score columns', async () => {
    const flags = await db.asService<{ prosecdef: boolean; config: string[] }>(`
      select prosecdef, proconfig as config from pg_proc
       where oid = 'public.people_discovery(text,uuid,text,text,timestamptz,uuid,integer,boolean)'::regprocedure
    `)
    expect(flags[0].prosecdef).toBe(false)
    expect(flags[0].config).toContain('search_path=""')
    await expectRejection(() => db.asAnon('select * from public.people_discovery()'), REJECTS.permissionDenied)
    const page = await discoverPeople({ universityId: uniA, department: 'SCIENCE', skill: 'script', query: 'discover' })
    expect(page.error).toBeNull()
    expect(page.people?.map((row) => row.id).sort()).toEqual([users.bob, users.campus, users.connected].sort())
    expect(JSON.stringify(page)).not.toMatch(/99999|secret|usage_count|post_count|student_count|endorsement_count|relevance|mastery/i)
    expect(page).not.toHaveProperty('total')
  })

  it('RLS plus the searchable/status/block predicates exclude private, unlisted, inactive and blocked profiles', async () => {
    const rows = await db.asUser<{ id: string }>(users.alice, `
      select id from public.people_discovery('discover')
    `)
    const ids = rows.map((row) => row.id)
    expect(ids).toContain(users.alice)
    expect(ids).toContain(users.bob)
    expect(ids).toContain(users.campus)
    expect(ids).toContain(users.connected)
    for (const name of ['private', 'unlisted', 'othercampus', 'pending', 'blockout', 'blockin',
      'suspended', 'banned', 'deleted']) expect(ids).not.toContain(users[name])
  })

  it('ordinary staff discovery is not a moderation queue for private or opted-out profiles', async () => {
    const ids = (await db.asUser<{ id: string }>(users.staff, `select id from public.people_discovery('discover')`))
      .map((row) => row.id)
    expect(ids).not.toContain(users.private)
    expect(ids).not.toContain(users.unlisted)
    expect(ids).not.toContain(users.suspended)
  })

  it('inactive readers cannot use the RPC, while expired temporary suspensions permit fresh reads', async () => {
    expect(await db.asUser(users.banned, `select id from public.people_discovery('discover')`)).toEqual([])
    expect(await db.asUser(users.suspended, `select id from public.people_discovery('discover')`)).toEqual([])
    const page = await discoverPeople({ query: 'expired' })
    expect(page.people?.map((row) => row.id)).toEqual([users.expired])
    expect((await getProfilePortfolio(users.expired)).portfolio?.profileId).toBe(users.expired)
  })

  it('unapproved skills cannot be used as an existence oracle; own proposals stay readable by their creator', async () => {
    expect((await discoverPeople({ skill: 'secret' })).people).toEqual([])
    auth.userId = users.bob
    expect((await discoverPeople({ skill: 'secret' })).people?.map((row) => row.id)).toEqual([users.bob])
  })

  it('literal percent/underscore/backslash/comma/quotes do not expand into SQL or PostgREST syntax', async () => {
    const person = await db.createUser({ fullName: 'Literal 50%_\\name,("A")', username: 'literal_person', universityId: uniA })
    const dept = (await db.asService<{ id: string }>(`
      insert into public.departments (university_id, name) values ($1, 'Dept %_\\,("A")') returning id
    `, [uniA]))[0].id
    const skill = (await db.asService<{ id: string }>(`
      insert into public.skills (name, is_approved) values ('Skill %_\\,("A")', true) returning id
    `))[0].id
    await db.asService(`update public.profiles set department_id = $2 where id = $1`, [person, dept])
    await db.asService(`insert into public.profile_skills (profile_id, skill_id) values ($1, $2)`, [person, skill])
    const page = await discoverPeople({
      query: '50%_\\name,("A")', department: '%_\\,("A")', skill: '%_\\,("A")',
    })
    expect(page.error).toBeNull()
    expect(page.people?.map((row) => row.id)).toEqual([person])
    expect(requests[0].body?.p_query).toBe('50%_\\name,("A")')
    expect(requests[0].params.has('or')).toBe(false)
  })

  it('the SQL boundary clamps direct callers and refuses oversized terms without exposing metadata', async () => {
    expect(await db.asUser(users.alice, `select id from public.people_discovery(repeat('a', 121))`)).toEqual([])
    expect(await db.asUser(users.alice, `select id from public.people_discovery('', null, repeat('a', 161))`)).toEqual([])
    expect(await db.asUser(users.alice, `select id from public.people_discovery('', null, '', repeat('a', 61))`)).toEqual([])
    const rows = await db.asUser(users.alice, `select id from public.people_discovery('Pager', null, '', '', null, null, 0)`)
    expect(rows).toHaveLength(2) // one display row plus one readable lookahead
    expect((await discoverPeople({ universityId: 'uni_localnotuuid' })).people).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('the reference picker uses minimal catalogue columns and a bounded query, not student counts', async () => {
    const picker = await listDiscoveryUniversities(1)
    expect(picker.error).toBeNull()
    expect(picker.universities).toHaveLength(1)
    expect(picker.hasMore).toBe(true)
    expect(requests[0].params.get('select')).toBe('id,name,short_name')
    expect(requests[0].params.get('limit')).toBe('2')
  })
})

describe('hosted adapter keyset paging over synthetic SQL', () => {
  it('uses two-key descending pages, survives deleted boundaries and carries only a validated tuple', async () => {
    const first = await discoverPeople({ query: 'Pager', limit: 2 })
    expect(first.error).toBeNull()
    expect(first.people?.map((row) => row.id)).toEqual([pagers[6], pagers[5]])
    await db.asService(`update public.profiles set searchable = false where id = $1`, [pagers[5]])
    const second = await discoverPeople({ query: 'Pager', limit: 2, cursor: first.nextCursor! })
    expect(second.people?.map((row) => row.id)).toEqual([pagers[4], pagers[3]])
    expect(requests.at(-1)?.body?.p_after_id).toBe(pagers[5])
    await db.asService(`update public.profiles set searchable = true where id = $1`, [pagers[5]])
  })

  it('preserves microseconds rather than rounding them into a repeated or skipped page', async () => {
    await db.asService(`update public.profiles set created_at = $2 where id = $1`,
      [pagers[0], '2026-10-20T00:00:00.000999Z'])
    await db.asService(`update public.profiles set created_at = $2 where id = $1`,
      [pagers[1], '2026-10-20T00:00:00.000998Z'])
    const first = await discoverPeople({ query: 'Pager', limit: 1 })
    expect(first.people?.[0].id).toBe(pagers[0])
    const second = await discoverPeople({ query: 'Pager', limit: 1, cursor: first.nextCursor! })
    expect(second.people?.[0].id).toBe(pagers[1])
    expect(requests.at(-1)?.body?.p_after_created_at).toBe('2026-10-20T00:00:00.000999Z')
    await db.asService(`update public.profiles set created_at = $2 where id = any($1::uuid[])`, [pagers, AT])
  })

  it('a changed filter or forged cursor resets paging and never reaches string-built search syntax', async () => {
    const first = await discoverPeople({ query: 'Pager', limit: 2 })
    const changed = await discoverPeople({ query: 'Pager', universityId: uniA, limit: 2, cursor: first.nextCursor! })
    expect(changed.people).toEqual(first.people)
    expect(requests.at(-1)?.body?.p_after_id).toBeNull()
    const scope = keysetScope(['people', 'pager', null, '', '', false])
    const forged = encodeKeysetCursor({ createdAt: AT, id: `${pagers[0]},or(id.neq.null)` }, scope)
    expect(decodeKeysetCursor(forged, scope, false)).toBeNull()
    expect((await discoverPeople({ query: 'Pager', cursor: forged, limit: 2 })).people).toEqual(first.people)
    expect(() => hostedKeysetFilter({ createdAt: AT, id: 'not-a-uuid' })).toThrow(/Invalid hosted/)
  })

  it('a hidden lookahead does not produce a more-results signal or any total count', async () => {
    const page = await discoverPeople({ query: 'Discover bob', limit: 1 })
    expect(page.people).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
    expect(page).not.toHaveProperty('total')
  })
})

describe('portfolio hosted adapter honors each content permission contract', () => {
  it('profile readability is a gate, not authorization for all its goals/ideas/posts', async () => {
    const result = await getProfilePortfolio(users.bob)
    expect(result.error).toBeNull()
    const portfolio = result.portfolio!
    expect(portfolio.isSelf).toBe(false)
    expect(portfolio.projects.items).toHaveLength(4) // reader is a member of the private project
    for (const section of ['ideas', 'goals', 'posts'] as const) {
      expect(portfolio[section].items).toHaveLength(3)
      expect(portfolio[section].items?.some((row) => row.visibility === 'private')).toBe(false)
    }
    expect(JSON.stringify(portfolio)).not.toMatch(/99999|PRIVATE LEARNING|_count|semester_id|course_id|goal_id|current_value|progress_percent/)
    expect(requests.map((row) => row.path).sort()).toEqual(['goals', 'ideas', 'posts', 'profiles', 'projects'])
    for (const request of requests) {
      expect(request.params.get('select')).not.toMatch(/count|semester|course|goal_id|progress|current_value|target_value/)
      if (request.path !== 'profiles') expect(request.params.get('limit')).toBe('7')
    }
  })

  it('other-campus strangers and signed-out readers get public items only, not private learning totals', async () => {
    for (const reader of [users.carol, null]) {
      auth.userId = reader
      const portfolio = (await getProfilePortfolio(users.bob)).portfolio!
      expect(portfolio.isSelf).toBe(false)
      for (const section of PORTFOLIO_SECTIONS) {
        expect(portfolio[section].items).toHaveLength(1)
        expect(portfolio[section].items?.[0].visibility).toBe('public')
      }
    }
  })

  it('owners see their own private live items, without fabricated proficiency or hidden moderation rows', async () => {
    auth.userId = users.bob
    const portfolio = (await getProfilePortfolio(users.bob)).portfolio!
    expect(portfolio.isSelf).toBe(true)
    for (const section of PORTFOLIO_SECTIONS) expect(portfolio[section].items).toHaveLength(4)
    expect(JSON.stringify(portfolio)).not.toMatch(/PRIVATE LEARNING|99999|_count/)
  })

  it('missing, unreadable, inactive and blocked profiles return the same result before content queries', async () => {
    for (const id of [users.private, users.blockout, users.blockin, users.banned, users.deleted,
      '00000000-0000-4000-8000-000000000000']) {
      requests.length = 0
      expect(await getProfilePortfolio(id)).toEqual({ portfolio: null, error: null })
      expect(requests.map((row) => row.path)).toEqual(['profiles'])
    }
  })

  it('direct opt-out does not hide an otherwise public portfolio', async () => {
    const portfolio = (await getProfilePortfolio(users.unlisted)).portfolio!
    expect(portfolio.profileId).toBe(users.unlisted)
    expect(portfolio.isSelf).toBe(false)
  })

  it('section errors are reported as errors, never disguised as empty readable lists', async () => {
    failTable = 'goals'
    const result = await getProfilePortfolio(users.bob)
    expect(result.error).toBeNull()
    expect(result.portfolio?.goals.items).toBeNull()
    expect(result.portfolio?.goals.error).toMatch(/could not be loaded/)
    expect(result.portfolio?.projects.items).toHaveLength(4)
  })

  it('pages each section independently using validated UUID/time filters and no offsets', async () => {
    const first = (await getProfilePortfolio(users.bob, { limit: 1 })).portfolio!
    for (const section of PORTFOLIO_SECTIONS) expect(first[section].nextCursor).not.toBeNull()
    requests.length = 0
    const second = (await getProfilePortfolio(users.bob, {
      limit: 1, cursors: { projects: first.projects.nextCursor!, goals: first.goals.nextCursor! },
    })).portfolio!
    expect(second.projects.items?.[0].id).not.toBe(first.projects.items?.[0].id)
    expect(second.goals.items?.[0].id).not.toBe(first.goals.items?.[0].id)
    expect(second.ideas.items).toEqual(first.ideas.items)
    for (const request of requests) expect(request.params.has('offset')).toBe(false)
    expect(requests.find((row) => row.path === 'projects')?.params.get('or')).toMatch(/created_at.lt.*and\(created_at.eq.*id.lt/)
    expect(requests.find((row) => row.path === 'ideas')?.params.has('or')).toBe(false)
  })
})

/**
 * S06 direct client-role SQL acceptance. This harness has ONE connection:
 * sequential boundary/rollback checks below are not concurrency evidence.
 * The separate native-Postgres test owns independent-connection acceptance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RATE_LIMITS, type RateLimitBucket } from '../../src/lib/rate-limit/budgets'
import { createTestDb, expectRejection, REJECTS, type TestDb } from '../db/harness'

let db: TestDb
let peer: string
let sequence = 0

beforeAll(async () => {
  db = await createTestDb()
  peer = await db.createUser({ username: 'abuse_peer' })
}, 120_000)
afterAll(async () => { await db?.close() })

async function actor(staff = false) {
  sequence += 1
  return db.createUser({ username: `abuse_actor_${sequence}`, ...(staff ? { role: 'admin' as const } : {}) })
}

/** Synthetic operator seeding, never available to authenticated callers. */
async function setHits(user: string, bucket: RateLimitBucket, hits: number) {
  const { windowSeconds } = RATE_LIMITS[bucket]
  await db.asService(
    `insert into app.rate_limit_windows (bucket, subject, window_start, hits)
     values ($1, $2, to_timestamp(floor(extract(epoch from clock_timestamp()) / $3) * $3), $4)
     on conflict (bucket, subject, window_start) do update set hits = excluded.hits`,
    [bucket, user, windowSeconds, hits],
  )
}

async function hits(user: string, bucket: RateLimitBucket) {
  const rows = await db.asService<{ hits: number }>(
    `select coalesce(sum(hits), 0)::int as hits from app.rate_limit_windows
      where subject = $1 and bucket = $2`,
    [user, bucket],
  )
  return rows[0]!.hits
}

async function preflight(user: string, bucket: RateLimitBucket) {
  const { limit, windowSeconds } = RATE_LIMITS[bucket]
  return db.asUser<{ allowed: boolean }>(
    user, `select public.check_rate_limit($1, $2, $3) as allowed`,
    [bucket, limit, windowSeconds],
  )
}

type Fixture = {
  user: string
  posts: string[]
  ownPost: string
  projects: string[]
  ownedProjects: string[]
  ideas: string[]
  opportunities: string[]
  events: string[]
  conversation: string
}

async function fixture(user: string): Promise<Fixture> {
  const seed = async (sql: string, params: unknown[]) =>
    (await db.asService<{ id: string }>(sql, params)).map(row => row.id)
  const posts = await seed(
    `insert into public.posts (author_id, body) values ($1, 'Peer fixture one'), ($1, 'Peer fixture two') returning id`, [peer],
  )
  const [ownPost] = await seed(
    `insert into public.posts (author_id, body) values ($1, 'Own fixture') returning id`, [user],
  )
  const projects = await seed(
    `insert into public.projects (owner_id, title, category)
     values ($1, 'Peer project one', 'web'), ($1, 'Peer project two', 'web') returning id`, [peer],
  )
  const ownedProjects = await seed(
    `insert into public.projects (owner_id, title, category)
     values ($1, 'Own invitation project one', 'web'),
            ($1, 'Own invitation project two', 'web') returning id`, [user],
  )
  const ideas = await seed(
    `insert into public.ideas (author_id, title, description)
     values ($1, 'Peer idea one', 'Synthetic idea description for SQL acceptance.'),
            ($1, 'Peer idea two', 'Synthetic idea description for SQL acceptance.') returning id`, [peer],
  )
  const opportunities = await seed(
    `insert into public.opportunities (posted_by, title, organisation, description, type, apply_email)
     values ($1, 'Peer opening one', 'Fixture', 'Synthetic description for SQL acceptance.', 'internship', 'fixture@example.test'),
            ($1, 'Peer opening two', 'Fixture', 'Synthetic description for SQL acceptance.', 'internship', 'fixture@example.test') returning id`, [peer],
  )
  const events = await seed(
    `insert into public.events (created_by, title, starts_at)
     values ($1, 'Peer event one', now() + interval '1 day'), ($1, 'Peer event two', now() + interval '1 day') returning id`, [peer],
  )
  const [conversation] = await seed(
    `insert into public.conversations (type, title, created_by)
     values ('group', 'Synthetic abuse fixture', $1) returning id`, [user],
  )
  await db.asService(
    `insert into public.conversation_participants (conversation_id, profile_id, role)
     values ($1, $2, 'admin'), ($1, $3, 'member')`, [conversation, user, peer],
  )
  return { user, posts, ownPost, projects, ownedProjects, ideas, opportunities, events, conversation }
}

type Statement = { sql: string; params?: unknown[] }
const INSERTS: {
  table: string
  bucket: RateLimitBucket
  statement: (fixture: Fixture, attempt: number) => Statement
}[] = [
  { table: 'posts', bucket: 'post:write', statement: () => ({ sql: `insert into public.posts (body) values ('Direct post fixture') returning 1` }) },
  { table: 'comments', bucket: 'comment:write', statement: f => ({ sql: `insert into public.comments (post_id, body) values ($1, 'Direct comment fixture') returning 1`, params: [f.posts[0]] }) },
  { table: 'idea_comments', bucket: 'comment:write', statement: f => ({ sql: `insert into public.idea_comments (idea_id, body) values ($1, 'Direct idea comment fixture') returning 1`, params: [f.ideas[0]] }) },
  { table: 'post_likes', bucket: 'reaction:write', statement: (f, i) => ({ sql: `insert into public.post_likes (post_id, profile_id) values ($1, $2) returning 1`, params: [f.posts[i], f.user] }) },
  { table: 'idea_votes', bucket: 'reaction:write', statement: (f, i) => ({ sql: `insert into public.idea_votes (idea_id, profile_id) values ($1, $2) returning 1`, params: [f.ideas[i], f.user] }) },
  { table: 'project_stars', bucket: 'reaction:write', statement: (f, i) => ({ sql: `insert into public.project_stars (project_id, profile_id) values ($1, $2) returning 1`, params: [f.projects[i], f.user] }) },
  { table: 'post_saves', bucket: 'save:write', statement: (f, i) => ({ sql: `insert into public.post_saves (post_id, profile_id) values ($1, $2) returning 1`, params: [f.posts[i], f.user] }) },
  { table: 'opportunity_saves', bucket: 'save:write', statement: (f, i) => ({ sql: `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2) returning 1`, params: [f.opportunities[i], f.user] }) },
  { table: 'messages', bucket: 'message:write', statement: f => ({ sql: `insert into public.messages (conversation_id, body) values ($1, 'Direct message fixture') returning 1`, params: [f.conversation] }) },
  { table: 'projects', bucket: 'project:write', statement: () => ({ sql: `insert into public.projects (title) values ('Direct project fixture') returning 1` }) },
  { table: 'project_invites', bucket: 'project:write', statement: (f, i) => ({ sql: `insert into public.project_invites (project_id, invitee_id, message) values ($1, $2, 'Direct invitation fixture') returning 1`, params: [f.ownedProjects[i], peer] }) },
  { table: 'ideas', bucket: 'idea:write', statement: () => ({ sql: `insert into public.ideas (title, description) values ('Direct idea fixture', 'Synthetic description for an abuse test.') returning 1` }) },
  { table: 'opportunities', bucket: 'opportunity:write', statement: () => ({ sql: `insert into public.opportunities (title, organisation, description, type, apply_email) values ('Direct opening fixture', 'Fixture', 'Synthetic description for an abuse test.', 'internship', 'fixture@example.test') returning 1` }) },
  { table: 'events', bucket: 'event:write', statement: () => ({ sql: `insert into public.events (title, starts_at) values ('Direct event fixture', now() + interval '1 day') returning 1` }) },
  { table: 'event_attendees', bucket: 'event:rsvp', statement: (f, i) => ({ sql: `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going') returning 1`, params: [f.events[i], f.user] }) },
  { table: 'reports', bucket: 'report:file', statement: (f, i) => ({ sql: `insert into public.reports (kind, reason, post_id) values ('post', 'Spam or advertising', $1) returning 1`, params: [f.posts[i]] }) },
  { table: 'universities', bucket: 'university:request', statement: (f, i) => ({ sql: `insert into public.universities (name) values ($1) returning 1`, params: [`Fixture University ${f.user} ${i}`] }) },
  { table: 'bug_reports', bucket: 'bug:file', statement: () => ({ sql: `insert into public.bug_reports (title, body) values ('Direct bug fixture', 'Synthetic bug description for acceptance.') returning 1` }) },
]

const MODERATION_TARGETS: {
  table: string
  kind: string
  column: string
  bucket: RateLimitBucket
  targets: (fixture: Fixture) => Promise<string[]>
}[] = [
  { table: 'posts', kind: 'post', column: 'post_id', bucket: 'post:write', targets: async f => f.posts },
  {
    table: 'comments', kind: 'comment', column: 'comment_id', bucket: 'comment:write',
    targets: async f => (await db.asService<{ id: string }>(
      `insert into public.comments (post_id, author_id, body)
       values ($1, $2, 'Moderation comment one'), ($1, $2, 'Moderation comment two') returning id`,
      [f.posts[0], peer],
    )).map(row => row.id),
  },
  { table: 'projects', kind: 'project', column: 'project_id', bucket: 'project:write', targets: async f => f.projects },
  { table: 'ideas', kind: 'idea', column: 'idea_id', bucket: 'idea:write', targets: async f => f.ideas },
  {
    table: 'messages', kind: 'message', column: 'message_id', bucket: 'message:write',
    targets: async f => (await db.asService<{ id: string }>(
      `insert into public.messages (conversation_id, sender_id, body)
       values ($1, $2, 'Moderation message one'), ($1, $2, 'Moderation message two') returning id`,
      [f.conversation, peer],
    )).map(row => row.id),
  },
]

describe('fixed server-owned abuse contract', () => {
  it('matches every TypeScript budget exactly to the SQL catalogue', async () => {
    const rows = await db.asService<{ bucket: RateLimitBucket; limit: number; windowSeconds: number }>(
      `select bucket, b.hit_limit as "limit", b.window_seconds as "windowSeconds"
       from unnest($1::text[]) bucket cross join lateral app.abuse_budget(bucket) b`,
      [Object.keys(RATE_LIMITS)],
    )
    expect(rows).toHaveLength(Object.keys(RATE_LIMITS).length)
    expect(Object.fromEntries(rows.map(({ bucket, ...policy }) => [bucket, policy]))).toEqual(RATE_LIMITS)
  })

  it.each([
    ['bug:file', 100000, 3600],
    ['bug:file', 5, 1],
    ['bug:file', null, 3600],
    ['bug:file', 5, null],
    ['test:caller-owned', 100000, 3600],
    [' bug:file ', 5, 3600],
    [null, 5, 3600],
  ])('refuses caller policy changes/aliases: %s, %s, %s', async (bucket, limit, seconds) => {
    const user = await actor()
    const error = await expectRejection(
      () => db.asUser(user, `select public.check_rate_limit($1, $2, $3)`, [bucket, limit, seconds]),
      /server-owned abuse budget|parameters are server-owned/i,
    )
    expect(error).toMatchObject({ code: '22023' })
    expect(await hits(user, 'bug:file')).toBe(0)
  })

  it('does not charge repeated preflights, and a wrapper plus write spends one hit', async () => {
    const user = await actor()
    for (let i = 0; i < 8; i += 1) expect((await preflight(user, 'bug:file'))[0]!.allowed).toBe(true)
    expect(await hits(user, 'bug:file')).toBe(0)
    await setHits(user, 'bug:file', RATE_LIMITS['bug:file'].limit - 1)
    expect((await preflight(user, 'bug:file'))[0]!.allowed).toBe(true)
    await db.asUser(user, `insert into public.bug_reports (title, body) values ('Wrapped fixture', 'Synthetic bug fixture description.')`)
    expect(await hits(user, 'bug:file')).toBe(RATE_LIMITS['bug:file'].limit)
    expect((await preflight(user, 'bug:file'))[0]!.allowed).toBe(false)
  })

  it('pins the private function/ledger ACLs and unchanged public RPC audience', async () => {
    const rows = await db.asService<{ role: string; signature: string; allowed: boolean }>(
      `select role, signature, has_function_privilege(role, signature, 'EXECUTE') allowed
       from unnest(array['anon', 'authenticated', 'service_role']) role
       cross join unnest(array[
         'app.abuse_budget(text)', 'app.consume_abuse_budget(text,integer,integer)',
         'app.enforce_abuse_budget()'
       ]) signature`,
    )
    expect(rows).toHaveLength(9)
    expect(rows.filter(row => row.allowed)).toEqual([])
    const ledger = await db.asService<{ allowed: boolean }>(
      `select has_table_privilege(role, 'app.rate_limit_windows', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed
       from unnest(array['anon', 'authenticated', 'service_role']) role`,
    )
    expect(ledger.every(row => !row.allowed)).toBe(true)
    await expectRejection(() => db.asAnon(`select public.check_rate_limit('bug:file', 5, 3600)`), REJECTS.permissionDenied)
    await expectRejection(() => db.asUser(peer, `select app.consume_abuse_budget('bug:file', 5, 3600)`), REJECTS.permissionDenied)
  })

  it('has both INSERT and UPDATE guards on exactly the covered tables', async () => {
    const rows = await db.asService<{ table: string; insert: boolean; update: boolean }>(
      `select c.relname as "table", (t.tgtype::int & 4) <> 0 as insert,
              (t.tgtype::int & 16) <> 0 as update
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'mandatory_abuse_budget' and not t.tgisinternal order by 1`,
    )
    expect(rows.map(row => row.table)).toEqual(INSERTS.map(spec => spec.table).sort())
    expect(rows.every(row => row.insert && row.update)).toBe(true)
  })
})

describe('mandatory raw SQL INSERT budgets (sequential acceptance)', () => {
  it.each(INSERTS)('$table permits N, refuses N+1 without the action wrapper', async spec => {
    const user = await actor()
    const f = await fixture(user)
    await setHits(user, spec.bucket, RATE_LIMITS[spec.bucket].limit - 1)
    const first = spec.statement(f, 0)
    expect(await db.asUser(user, first.sql, first.params)).toHaveLength(1)
    expect(await hits(user, spec.bucket)).toBe(RATE_LIMITS[spec.bucket].limit)
    const next = spec.statement(f, 1)
    const error = await expectRejection(
      () => db.asUser(user, next.sql, next.params), /rate_limit_exceeded/,
    )
    expect(error).toMatchObject({ code: 'P0001', hint: 'rate_limit_exceeded' })
    expect(await hits(user, spec.bucket)).toBe(RATE_LIMITS[spec.bucket].limit)
  })

  it('cannot reset a reaction budget by deleting/reinserting or bypass with a trusted GUC', async () => {
    const user = await actor()
    const f = await fixture(user)
    await setHits(user, 'reaction:write', RATE_LIMITS['reaction:write'].limit - 1)
    await db.asUser(user, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [f.posts[0], user])
    await db.asUser(user, `delete from public.post_likes where post_id = $1 and profile_id = $2`, [f.posts[0], user])
    await expectRejection(
      () => db.asUser(user,
        `with marked as (select set_config('app.trusted_write', 'on', true))
         insert into public.post_likes (post_id, profile_id) select $1, $2 from marked`,
        [f.posts[0], user]),
      /rate_limit_exceeded/,
    )
    expect(await hits(user, 'reaction:write')).toBe(RATE_LIMITS['reaction:write'].limit)
    expect(await hits(user, 'post:write')).toBe(0) // derived like counter is not a post edit
  })

  it('rolls back a whole multirow write and its counters when it exceeds the remaining budget', async () => {
    const user = await actor()
    await setHits(user, 'post:write', RATE_LIMITS['post:write'].limit - 1)
    await expectRejection(
      () => db.asUser(user, `insert into public.posts (body) values ('Batch fixture one'), ('Batch fixture two')`),
      /rate_limit_exceeded/,
    )
    expect(await db.asUser(user, `select id from public.posts where author_id = $1`, [user])).toHaveLength(0)
    expect(await hits(user, 'post:write')).toBe(RATE_LIMITS['post:write'].limit - 1)
    expect((await db.asUser<{ post_count: number }>(user, `select post_count from public.profiles where id = $1`, [user]))[0]!.post_count).toBe(0)
  })

  it('does not spend on a rejected constraint, invisible target, or conflict DO NOTHING', async () => {
    const user = await actor()
    const f = await fixture(user)
    await expectRejection(() => db.asUser(user, `insert into public.bug_reports (title, body) values ('x', 'short')`), /check constraint/)
    expect(await hits(user, 'bug:file')).toBe(0)
    await db.asService(`update public.posts set visibility = 'private' where id = $1`, [f.posts[0]])
    await expectRejection(() => db.asUser(user, `insert into public.reports (kind, reason, post_id) values ('post', 'Spam fixture', $1)`, [f.posts[0]]), /only report something you can see/)
    expect(await hits(user, 'report:file')).toBe(0)
    await db.asUser(user, `insert into public.post_saves (post_id, profile_id) values ($1, $2)`, [f.posts[1], user])
    await setHits(user, 'save:write', RATE_LIMITS['save:write'].limit)
    await db.asUser(user, `insert into public.post_saves (post_id, profile_id) values ($1, $2) on conflict do nothing`, [f.posts[1], user])
    expect(await hits(user, 'save:write')).toBe(RATE_LIMITS['save:write'].limit)
  })

  it('isolates subjects and windows instead of resetting another active counter', async () => {
    const user = await actor()
    const other = await actor()
    await setHits(user, 'bug:file', RATE_LIMITS['bug:file'].limit)
    await db.asUser(other, `insert into public.bug_reports (title, body) values ('Other user fixture', 'Synthetic bug fixture description.')`)
    expect(await hits(other, 'bug:file')).toBe(1)
    await db.asService(
      `update app.rate_limit_windows set window_start = window_start - interval '2 hours' where subject = $1 and bucket = 'bug:file'`, [user],
    )
    await db.asUser(user, `insert into public.bug_reports (title, body) values ('Next window fixture', 'Synthetic bug fixture description.')`)
    expect((await preflight(user, 'bug:file'))[0]!.allowed).toBe(true)
  })
})

describe('semantic UPDATE and guarded RPC budgets', () => {
  it.each(MODERATION_TARGETS)('still denies direct $table moderation_status UPDATEs even to staff', async spec => {
    const admin = await actor(true)
    const f = await fixture(admin)
    const [target] = await spec.targets(f)
    const [privilege] = await db.asService<{ allowed: boolean }>(
      `select has_column_privilege('authenticated', $1, 'moderation_status', 'UPDATE') allowed`,
      [`public.${spec.table}`],
    )
    expect(privilege!.allowed).toBe(false)
    for (const caller of [peer, admin]) {
      const error = await expectRejection(
        () => db.asUser(caller,
          `with marked as (select set_config('app.trusted_write', 'on', true))
           update public.${spec.table} set moderation_status = 'hidden'
           from marked where id = $1`,
          [target]),
        REJECTS.permissionDenied,
      )
      expect(error).toMatchObject({ code: '42501' })
      expect(await hits(caller, spec.bucket)).toBe(0)
    }
  })

  it.each(MODERATION_TARGETS)('charges protected $table moderation once and rolls the effect back at the decision limit', async spec => {
    const admin = await actor(true)
    const reporter = await actor()
    const f = await fixture(reporter)
    const targets = await spec.targets(f)
    const reportIds: string[] = []
    for (const target of targets) {
      const [report] = await db.asUser<{ id: string }>(reporter,
        `insert into public.reports (kind, reason, ${spec.column}) values ($1, 'Spam fixture', $2) returning id`,
        [spec.kind, target],
      )
      reportIds.push(report!.id)
    }
    // Exhausting ordinary publishing must not prevent legitimate moderation.
    await setHits(admin, spec.bucket, RATE_LIMITS[spec.bucket].limit)
    await setHits(admin, 'moderation:decide', RATE_LIMITS['moderation:decide'].limit - 1)
    expect((await preflight(admin, 'moderation:decide'))[0]!.allowed).toBe(true)
    await db.asUser(admin, `select public.moderate_report($1, 'hide_content', 'Synthetic moderation reason')`, [reportIds[0]])
    expect(await hits(admin, spec.bucket)).toBe(RATE_LIMITS[spec.bucket].limit)
    expect(await hits(admin, 'moderation:decide')).toBe(RATE_LIMITS['moderation:decide'].limit)
    expect((await db.asUser<{ moderation_status: string }>(admin,
      `select moderation_status from public.${spec.table} where id = $1`, [targets[0]],
    ))[0]!.moderation_status).toBe('hidden')
    expect(await db.asUser(admin, `select id from public.moderation_actions where report_id = $1`, [reportIds[0]])).toHaveLength(1)
    const notifications = await db.asUser(reporter, `select id from public.notifications order by id`)
    await expectRejection(
      () => db.asUser(admin, `select public.moderate_report($1, 'hide_content', 'Synthetic denied moderation reason')`, [reportIds[1]]),
      /rate_limit_exceeded/,
    )
    expect((await db.asUser<{ moderation_status: string }>(admin,
      `select moderation_status from public.${spec.table} where id = $1`, [targets[1]],
    ))[0]!.moderation_status).toBe('active')
    expect((await db.asUser<{ status: string }>(admin, `select status from public.reports where id = $1`, [reportIds[1]]))[0]!.status).toBe('open')
    expect(await db.asUser(admin, `select id from public.moderation_actions where report_id = $1`, [reportIds[1]])).toHaveLength(0)
    expect(await db.asUser(reporter, `select id from public.notifications order by id`)).toEqual(notifications)
    expect(await hits(admin, 'moderation:decide')).toBe(RATE_LIMITS['moderation:decide'].limit)
  })

  it.each([
    {
      table: 'comments', bucket: 'comment:write',
      create: (f: Fixture) => ({ sql: `insert into public.comments (post_id, body) values ($1, 'Update fixture') returning id`, params: [f.posts[0]] }),
      update: `update public.comments set body = $2 where id = $1 returning 1`,
    },
    {
      table: 'idea_comments', bucket: 'comment:write',
      create: (f: Fixture) => ({ sql: `insert into public.idea_comments (idea_id, body) values ($1, 'Update fixture') returning id`, params: [f.ideas[0]] }),
      update: `update public.idea_comments set body = $2 where id = $1 returning 1`,
    },
    {
      table: 'projects', bucket: 'project:write',
      create: () => ({ sql: `insert into public.projects (title) values ('Update project fixture') returning id`, params: [] }),
      update: `update public.projects set title = $2 where id = $1 returning 1`,
    },
    {
      table: 'ideas', bucket: 'idea:write',
      create: () => ({ sql: `insert into public.ideas (title, description) values ('Update idea fixture', 'Synthetic description for an update test.') returning id`, params: [] }),
      update: `update public.ideas set title = $2 where id = $1 returning 1`,
    },
    {
      table: 'opportunities', bucket: 'opportunity:write',
      create: () => ({ sql: `insert into public.opportunities (title, organisation, description, type, apply_email) values ('Update opening fixture', 'Fixture', 'Synthetic description for an update test.', 'internship', 'fixture@example.test') returning id`, params: [] }),
      update: `update public.opportunities set title = $2 where id = $1 returning 1`,
    },
    {
      table: 'events', bucket: 'event:write',
      create: () => ({ sql: `insert into public.events (title, starts_at) values ('Update event fixture', now() + interval '1 day') returning id`, params: [] }),
      update: `update public.events set title = $2 where id = $1 returning 1`,
    },
    {
      table: 'opportunity_saves', bucket: 'save:write',
      create: (f: Fixture) => ({ sql: `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2) returning opportunity_id as id`, params: [f.opportunities[0], f.user] }),
      update: `update public.opportunity_saves set note = $2 where opportunity_id = $1 returning 1`,
    },
  ] as const)('gates direct $table edits at the same server-owned $bucket budget', async spec => {
    const user = await actor()
    const f = await fixture(user)
    const create = spec.create(f)
    const [row] = await db.asUser<{ id: string }>(user, create.sql, create.params)
    await setHits(user, spec.bucket, RATE_LIMITS[spec.bucket].limit - 1)
    expect(await db.asUser(user, spec.update, [row!.id, 'Accepted update fixture'])).toHaveLength(1)
    expect(await hits(user, spec.bucket)).toBe(RATE_LIMITS[spec.bucket].limit)
    await expectRejection(
      () => db.asUser(user, spec.update, [row!.id, 'Denied update fixture']), /rate_limit_exceeded/,
    )
    expect(await hits(user, spec.bucket)).toBe(RATE_LIMITS[spec.bucket].limit)
  })

  it('gates RSVP UPDATEs without charging the derived event counters', async () => {
    const user = await actor()
    const f = await fixture(user)
    await db.asUser(user, `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`, [f.events[0], user])
    await setHits(user, 'event:rsvp', RATE_LIMITS['event:rsvp'].limit - 1)
    await db.asUser(user, `update public.event_attendees set status = 'interested' where event_id = $1 and profile_id = $2`, [f.events[0], user])
    expect(await hits(user, 'event:rsvp')).toBe(RATE_LIMITS['event:rsvp'].limit)
    await expectRejection(() => db.asUser(user, `update public.event_attendees set status = 'going' where event_id = $1 and profile_id = $2`, [f.events[0], user]), /rate_limit_exceeded/)
    expect(await hits(user, 'event:write')).toBe(0)
    expect((await db.asUser<{ attendee_count: number; interested_count: number }>(user, `select attendee_count, interested_count from public.events where id = $1`, [f.events[0]]))[0]).toEqual({ attendee_count: 0, interested_count: 1 })
  })

  it('gates edits, permits no-ops, and counts an upsert UPDATE once', async () => {
    const user = await actor()
    const f = await fixture(user)
    await setHits(user, 'post:write', RATE_LIMITS['post:write'].limit - 1)
    await db.asUser(user, `update public.posts set body = 'Changed fixture' where id = $1`, [f.ownPost])
    expect(await hits(user, 'post:write')).toBe(RATE_LIMITS['post:write'].limit)
    await db.asUser(user, `update public.posts set body = body, updated_at = now() where id = $1`, [f.ownPost])
    await expectRejection(
      () => db.asUser(user, `update public.posts set body = 'Refused next edit' where id = $1`, [f.ownPost]), /rate_limit_exceeded/,
    )
    expect((await db.asUser<{ body: string }>(user, `select body from public.posts where id = $1`, [f.ownPost]))[0]!.body).toBe('Changed fixture')
    await setHits(user, 'post:write', RATE_LIMITS['post:write'].limit - 1)
    await db.asUser(user,
      `insert into public.posts (id, body) values ($1, 'Upsert edit fixture')
       on conflict (id) do update set body = excluded.body`, [f.ownPost],
    )
    expect(await hits(user, 'post:write')).toBe(RATE_LIMITS['post:write'].limit)
  })

  it('gates message edits but rolls back conversation summary/unread side effects on denied sends', async () => {
    const user = await actor()
    const f = await fixture(user)
    const [message] = await db.asUser<{ id: string }>(user, `insert into public.messages (conversation_id, body) values ($1, 'Accepted message') returning id`, [f.conversation])
    await setHits(user, 'message:write', RATE_LIMITS['message:write'].limit)
    const [before] = await db.asUser(peer, `select last_message_preview, last_message_id from public.conversations where id = $1`, [f.conversation])
    const [unread] = await db.asUser(peer, `select unread_count from public.conversation_participants where conversation_id = $1 and profile_id = $2`, [f.conversation, peer])
    await expectRejection(() => db.asUser(user, `update public.messages set body = 'Denied edit' where id = $1`, [message!.id]), /rate_limit_exceeded/)
    await expectRejection(() => db.asUser(user, `insert into public.messages (conversation_id, body) values ($1, 'Denied send')`, [f.conversation]), /rate_limit_exceeded/)
    expect((await db.asUser(peer, `select last_message_preview, last_message_id from public.conversations where id = $1`, [f.conversation]))[0]).toEqual(before)
    expect((await db.asUser(peer, `select unread_count from public.conversation_participants where conversation_id = $1 and profile_id = $2`, [f.conversation, peer]))[0]).toEqual(unread)
  })

  it('gates admin triage to the actor budget without spending the reporter budget', async () => {
    const admin = await actor(true)
    const [bug] = await db.asUser<{ id: string }>(peer, `insert into public.bug_reports (title, body) values ('Triage fixture', 'Synthetic bug fixture description.') returning id`)
    await setHits(admin, 'bug:triage', RATE_LIMITS['bug:triage'].limit - 1)
    expect((await preflight(admin, 'bug:triage'))[0]!.allowed).toBe(true)
    await db.asUser(admin, `update public.bug_reports set status = 'reviewed' where id = $1`, [bug!.id])
    expect(await hits(admin, 'bug:triage')).toBe(RATE_LIMITS['bug:triage'].limit)
    await expectRejection(() => db.asUser(admin, `update public.bug_reports set status = 'fixed' where id = $1`, [bug!.id]), /rate_limit_exceeded/)
    expect(await hits(admin, 'bug:file')).toBe(0)
  })

  it('gates SECURITY DEFINER moderation and rolls back the audit/status on refusal', async () => {
    const admin = await actor(true)
    const reporter = await actor()
    const f = await fixture(reporter)
    const reportIds: string[] = []
    for (const post of f.posts) {
      const [report] = await db.asUser<{ id: string }>(reporter, `insert into public.reports (kind, reason, post_id) values ('post', 'Spam fixture', $1) returning id`, [post])
      reportIds.push(report!.id)
    }
    await setHits(admin, 'moderation:decide', RATE_LIMITS['moderation:decide'].limit - 1)
    expect((await preflight(admin, 'moderation:decide'))[0]!.allowed).toBe(true)
    await db.asUser(admin, `select public.moderate_report($1, 'dismiss_report', 'Synthetic decision reason')`, [reportIds[0]])
    expect(await hits(admin, 'moderation:decide')).toBe(RATE_LIMITS['moderation:decide'].limit)
    await expectRejection(() => db.asUser(admin, `select public.moderate_report($1, 'dismiss_report', 'Synthetic decision reason')`, [reportIds[1]]), /rate_limit_exceeded/)
    expect((await db.asUser<{ status: string }>(admin, `select status from public.reports where id = $1`, [reportIds[1]]))[0]!.status).toBe('open')
    expect(await db.asUser(admin, `select id from public.moderation_actions where report_id = $1`, [reportIds[1]])).toHaveLength(0)
    expect(await hits(admin, 'report:file')).toBe(0)
  })

  it('gates university correction/review and idea conversion even inside trusted RPCs', async () => {
    const admin = await actor(true)
    const submitter = await actor()
    const [university] = await db.asUser<{ id: string }>(submitter, `insert into public.universities (name) values ('Synthetic review university') returning id`)
    await setHits(submitter, 'university:request', RATE_LIMITS['university:request'].limit)
    await expectRejection(() => db.asUser(submitter, `update public.universities set city = 'Fixture city' where id = $1`, [university!.id]), /rate_limit_exceeded/)
    await setHits(admin, 'moderation:university', RATE_LIMITS['moderation:university'].limit)
    await expectRejection(() => db.asUser(admin, `select public.review_university_request($1, 'approve', 'Synthetic review reason')`, [university!.id]), /rate_limit_exceeded/)
    expect((await db.asUser<{ status: string }>(admin, `select status from public.universities where id = $1`, [university!.id]))[0]!.status).toBe('pending')
    const [idea] = await db.asUser<{ id: string }>(submitter, `insert into public.ideas (title, description) values ('Synthetic conversion idea', 'Synthetic description for conversion acceptance.') returning id`)
    await setHits(submitter, 'project:write', RATE_LIMITS['project:write'].limit)
    await expectRejection(() => db.asUser(submitter, `select public.convert_idea_to_project($1)`, [idea!.id]), /rate_limit_exceeded/)
    expect((await db.asUser<{ status: string }>(submitter, `select status from public.ideas where id = $1`, [idea!.id]))[0]!.status).toBe('open')
    expect(await db.asUser(submitter, `select id from public.projects where owner_id = $1`, [submitter])).toHaveLength(0)
  })
})

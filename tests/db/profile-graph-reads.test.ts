/**
 * FINAL INTEGRATION PROPOSAL ONLY, 2026-11-02. Never run from D.
 * Intended repository path: tests/db/profile-graph-reads.test.ts.
 *
 * Main must first review/copy the matching forward migration and coordinate the
 * profile reader/DTO + exact schema inventory changes. createTestDb() applies the
 * REAL repository migrations; no D-drive SQL loader, fallback RPC or mock.
 * This source has not been executed, typechecked or linted.
 * The frozen original regressions are retained, with finite stored-edge and
 * offset/microsecond keyset regressions for the reviewed final SQL proposal.
 * Legacy arbitrary-pair helper grants are not claimed closed. Automatic award
 * privacy belongs to the separately frozen 0040 proposal, not this test file.
 *
 * All authorization assertions use anon/authenticated SQL roles. Privileged
 * calls only arrange or inspect isolated synthetic fixtures/catalog invariants.
 * The harness has ONE session: keep every role-changing call sequential.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb, expectRejection, type TestDb } from './harness'

type Visibility = 'public' | 'university' | 'connections' | 'private'
type Direction = 'followers' | 'following'
type FollowRow = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  headline: string | null
  created_at: string
}
type ConnectionRow = FollowRow & { connection_id: string }
type Counts = { followers: string; following: string; connections: string | null }
type Position = { at: string; id: string }
type Unavailable = typeof UNAVAILABLE[number]

const AT = '2026-11-02T06:00:00.123456Z'
const EARLIER = '2026-11-02T06:00:00.123455Z'
const LATER = '2026-11-02T06:00:00.123457Z'
const UNAVAILABLE = [
  'current suspension', 'profile ban', 'deactivation', 'profile deletion',
  'Auth deletion', 'provider disable', 'provider ban', 'pending deletion',
] as const
const PROFILE_COLUMNS = [
  'id', 'username', 'display_name', 'avatar_url', 'cover_url', 'headline', 'bio',
  'university_id', 'department_id', 'program_id', 'degree', 'semester', 'graduation_year',
  'location', 'website', 'github_username', 'linkedin_url', 'twitter_username',
  'visibility', 'allow_messages_from', 'allow_connection_requests', 'searchable',
  'onboarding_completed', 'onboarding_step',
  'status', 'suspended_until', 'suspension_reason', 'warning_count', 'username_changed_at',
  'post_count', 'project_count', 'last_active_at', 'created_at', 'updated_at', 'deleted_at',
] as const
const FOLLOW_KEYS = ['id', 'username', 'display_name', 'avatar_url', 'headline', 'created_at']
const DENIED = /permission denied/i

let db: TestDb
let subject: string
let viewer: string

beforeAll(async () => {
  db = await createTestDb()
  // Isolated harness-only provider fields. NOT production migration DDL.
  await db.asService(`alter table auth.users
    add column if not exists banned_until timestamptz,
    add column if not exists disabled_at timestamptz`)
}, 120_000)

beforeEach(async () => {
  subject = await db.createUser()
  viewer = await db.createUser()
})

afterAll(async () => { await db?.close() })

async function read<T>(actor: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return actor === null ? db.asAnon<T>(sql, params) : db.asUser<T>(actor, sql, params)
}

async function followPage(
  actor: string | null, target = subject, direction: Direction = 'followers',
  limit: number | null = 25, after: Position | null = null,
): Promise<FollowRow[]> {
  const rows = await read<{ row: FollowRow }>(actor, `
    select to_jsonb(g) || jsonb_build_object('created_at',
      to_char(g.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as row
      from public.profile_follow_page($1, $2, $3, $4, $5) g`,
  [target, direction, after?.at ?? null, after?.id ?? null, limit])
  return rows.map(result => result.row)
}

async function connectionPage(
  actor: string, limit: number | null = 25, after: Position | null = null,
): Promise<ConnectionRow[]> {
  const rows = await read<{ row: ConnectionRow }>(actor, `
    select to_jsonb(g) || jsonb_build_object('created_at',
      to_char(g.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as row
      from public.my_connection_page($1, $2, $3) g`,
  [after?.at ?? null, after?.id ?? null, limit])
  return rows.map(result => result.row)
}

async function counts(actor: string | null, target = subject): Promise<Counts[]> {
  return read<Counts>(actor, `select follower_count::text as followers,
    following_count::text as following, connection_count::text as connections
    from public.profile_graph_counts($1)`, [target])
}

async function readable(actor: string | null, target: string, peer: string | null = null) {
  return read<{ value: boolean }>(actor,
    'select app.profile_graph_readable($1, $2) as value', [target, peer])
}

async function fixtureFollow(follower: string, following: string, at = AT) {
  await db.asService(`insert into public.follows(follower_id, following_id, created_at)
    values ($1, $2, $3::timestamptz)`, [follower, following, at])
}

async function fixtureDirection(direction: Direction, target: string, peer: string, at = AT) {
  if (direction === 'followers') await fixtureFollow(peer, target, at)
  else await fixtureFollow(target, peer, at)
}

async function fixtureConnection(
  requester: string, addressee: string, status = 'accepted', at = AT, id = randomUUID(),
) {
  await db.asService(`insert into public.connections
    (id, requester_id, addressee_id, status, message, created_at)
    values ($1, $2, $3, $4, 'synthetic private request note', $5::timestamptz)`,
  [id, requester, addressee, status, at])
  return id
}

async function fixtureBoth(target: string, peer: string) {
  await fixtureFollow(peer, target)
  await fixtureFollow(target, peer)
  return fixtureConnection(target, peer)
}

async function fixtureBlock(blocker: string, blocked: string) {
  await db.asService(`insert into public.blocks(blocker_id, blocked_id, reason)
    values ($1, $2, 'synthetic private block note')`, [blocker, blocked])
}

async function university() {
  const rows = await db.asService<{ id: string }>(`insert into public.universities
    (name, city, country, status) values ($1, 'Synthetic City', 'PK', 'approved') returning id`,
  [`Graph fixture ${randomUUID()}`])
  return rows[0]!.id
}

async function setVisibility(id: string, visibility: Visibility) {
  await db.asService('update public.profiles set visibility=$2 where id=$1', [id, visibility])
}

async function setUnavailable(id: string, state: Unavailable) {
  switch (state) {
    case 'current suspension':
      await db.asService(`update public.profiles set status='suspended',
        suspended_until=now()+interval '1 hour' where id=$1`, [id])
      break
    case 'profile ban':
      await db.asService(`update public.profiles set status='banned',
        suspended_until=now()-interval '1 hour' where id=$1`, [id])
      break
    case 'deactivation':
      await db.asService(`update public.profiles set status='deactivated' where id=$1`, [id])
      break
    case 'profile deletion':
      await db.asService('update public.profiles set deleted_at=now() where id=$1', [id])
      break
    case 'Auth deletion':
      await db.asService('update auth.users set deleted_at=now() where id=$1', [id])
      break
    case 'provider disable':
      await db.asService('update auth.users set disabled_at=now() where id=$1', [id])
      break
    case 'provider ban':
      await db.asService(`update auth.users set banned_until=now()+interval '1 hour' where id=$1`, [id])
      break
    case 'pending deletion':
      await db.asService(`insert into public.account_deletion_jobs(subject_id, request_key)
        values ($1, $2)`, [id, randomUUID()])
      break
  }
}

async function syntheticSnapshot(ids: string[]) {
  return db.asService<{ state: unknown }>(`select jsonb_build_object(
    'profiles', (select jsonb_agg(to_jsonb(p) order by p.id)
      from public.profiles p where p.id=any($1::uuid[])),
    'provider', (select jsonb_agg(jsonb_build_object(
      'id', u.id, 'deleted_at', u.deleted_at,
      'disabled_at', u.disabled_at, 'banned_until', u.banned_until) order by u.id)
      from auth.users u where u.id=any($1::uuid[])),
    'budgets', (select coalesce(jsonb_agg(to_jsonb(w) order by w.bucket, w.subject, w.window_start), '[]'::jsonb)
      from app.rate_limit_windows w where w.subject=any($1::uuid[])),
    'deletions', (select count(*) from public.account_deletion_jobs j
      where j.subject_id=any($1::uuid[])),
    'readiness', public.bulla_image_upload_readiness()
  ) as state`, [ids])
}

async function isolatedCorruption<T>(ddl: string, work: () => Promise<T>): Promise<T> {
  // Deliberately simulate legacy corruption ONLY in this fresh harness and
  // always roll it back. No constraint/triggers are relaxed in the migration.
  await db.asService('begin')
  try {
    // asService('begin') cleared the role/JWT; exec supports this multi-DDL
    // fixture without sending multiple commands through the query protocol.
    await db.raw.exec(ddl)
    return await work()
  } finally {
    await db.raw.exec('rollback')
  }
}

describe.sequential('proposed profile graph SQL reads (not hosted acceptance)', () => {
  describe('exact grants and safe projection', () => {
    it('adds only the three invoker read RPCs with tight intended audiences', async () => {
      const rows = await db.asService<{
        name: string; args: string; result: string; definer: boolean; stable: string;
        config: string[]; anon: boolean; authenticated: boolean; service: boolean
      }>(`select p.proname as name, oidvectortypes(p.proargtypes) as args,
        pg_get_function_result(p.oid) as result, p.prosecdef as definer,
        p.provolatile as stable, p.proconfig as config,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and p.proname=any($1::text[]) order by p.proname`,
      [['profile_follow_page', 'my_connection_page', 'profile_graph_counts']])
      expect(rows).toHaveLength(3) // Non-vacuity and no alternate overload.
      expect(rows.map(row => [row.name, row.args, row.anon])).toEqual([
        ['my_connection_page', 'timestamp with time zone, uuid, integer', false],
        ['profile_follow_page', 'uuid, text, timestamp with time zone, uuid, integer', true],
        ['profile_graph_counts', 'uuid', true],
      ])
      for (const row of rows) {
        expect(row).toMatchObject({
          definer: false, stable: 's', authenticated: true, service: false,
        })
        expect(row.config.some(value => value === 'search_path=' || value === 'search_path=""'))
          .toBe(true)
      }
      expect(rows[0]!.result).toBe(
        'TABLE(connection_id uuid, id uuid, username text, display_name text, avatar_url text, headline text, created_at timestamp with time zone)',
      )
      expect(rows[1]!.result).toBe(
        'TABLE(id uuid, username text, display_name text, avatar_url text, headline text, created_at timestamp with time zone)',
      )
      expect(rows[2]!.result).toBe(
        'TABLE(follower_count bigint, following_count bigint, connection_count bigint)',
      )
    })

    it('grants only the policy helper, never the private availability predicate', async () => {
      const rows = await db.asService<{
        signature: string; definer: boolean; config: string[];
        anon: boolean; authenticated: boolean; service: boolean
      }>(`select p.oid::regprocedure::text as signature, p.prosecdef as definer,
        p.proconfig as config,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='app' and p.proname=any($1::text[]) order by p.proname`,
      [['bulla_image_account_active', 'profile_graph_readable']])
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ anon: false, authenticated: false, service: false })
      expect(rows[1]).toMatchObject({ definer: true, anon: true, authenticated: true, service: false })
      expect(rows[1]!.config.some(value => value === 'search_path=' || value === 'search_path=""'))
        .toBe(true)
      expect(await db.asService<{ refs: number }>(`select count(*)::int as refs
        from pg_policy where polrelid='public.follows'::regclass
        and position('profile_graph_readable(' in pg_get_expr(polqual,polrelid))>0`))
        .toEqual([{ refs: 1 }])
      for (const actor of [null, viewer]) {
        await expectRejection(() => read(actor,
          'select app.bulla_image_account_active($1)', [subject]), DENIED)
      }
      await expectRejection(() => db.asAnon('select * from public.my_connection_page()'), DENIED)
    })

    it('regrants exactly compatible non-counter profile columns, not table SELECT', async () => {
      const rows = await db.asService<{
        role: string; table_select: boolean; columns: string[]
      }>(`select r.role,
        has_table_privilege(r.role,'public.profiles','SELECT') as table_select,
        array(select a.attname::text from pg_attribute a
          where a.attrelid='public.profiles'::regclass and a.attnum>0 and not a.attisdropped
          and has_column_privilege(r.role,a.attrelid,a.attnum,'SELECT') order by a.attname) as columns
        from unnest(array['anon','authenticated']) r(role) order by r.role`)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.table_select).toBe(false)
        expect(row.columns).toEqual([...PROFILE_COLUMNS].sort())
      }
      for (const actor of [null, subject]) {
        expect(await read(actor, `select ${PROFILE_COLUMNS.join(',')} from public.profiles where id=$1`,
          [subject])).toHaveLength(1)
        await expectRejection(() => read(actor,
          'select * from public.profiles where id=$1', [subject]), DENIED)
      }
    })

    it.each(['follower_count', 'following_count', 'connection_count'])(
      'refuses raw %s in projections, filters and JSON even for owner/staff', async column => {
        const staff = await db.createUser({ role: 'moderator' })
        for (const actor of [null, subject, staff]) {
          await expectRejection(() => read(actor,
            `select ${column} from public.profiles where id=$1`, [subject]), DENIED)
          await expectRejection(() => read(actor,
            `select id from public.profiles where id=$1 and ${column}>0`, [subject]), DENIED)
          await expectRejection(() => read(actor,
            'select to_jsonb(p) from public.profiles p where p.id=$1', [subject]), DENIED)
        }
      },
    )

    it('returns exactly minimal visible fields, with an own connection key but no private note', async () => {
      const peer = await db.createUser()
      const edge = await fixtureBoth(subject, peer)
      const follows = await followPage(null)
      const connections = await connectionPage(subject)
      expect(follows).toHaveLength(1)
      expect(connections).toHaveLength(1)
      expect(Object.keys(follows[0]!).sort()).toEqual([...FOLLOW_KEYS].sort())
      expect(Object.keys(connections[0]!).sort()).toEqual([...FOLLOW_KEYS, 'connection_id'].sort())
      expect(connections[0]).toMatchObject({ id: peer, connection_id: edge, created_at: AT })
      for (const row of [...follows, ...connections]) {
        expect(JSON.stringify(row)).not.toMatch(/synthetic private|message|reason|status|banned|suspended/)
      }
    })

    it('does not turn a real private or public third-party connection into a new boolean oracle', async () => {
      const a = await db.createUser()
      const b = await db.createUser()
      await fixtureConnection(a, b) // No follows: an unrelated accepted pair.
      for (const actor of [null, viewer]) {
        expect(await readable(actor, a, b)).toEqual([{ value: false }])
        expect(await readable(actor, a)).toEqual([{ value: true }])
      }
      await setVisibility(a, 'private')
      await setVisibility(b, 'private')
      const staff = await db.createUser({ role: 'moderator' })
      for (const actor of [null, viewer, staff]) {
        expect(await readable(actor, a, b)).toEqual([{ value: false }])
        expect(await readable(actor, a)).toEqual([{ value: false }])
      }
      // The OLD pair helper grants are intentionally not claimed closed.
      // Their group/invitation policy consumers need a separate reviewed fix.
      const legacy = await db.asService<{ connected: boolean; blocked: boolean }>(`select
        has_function_privilege('authenticated','app.are_connected(uuid,uuid)','EXECUTE') as connected,
        has_function_privilege('authenticated','app.is_blocked_either_way(uuid,uuid)','EXECUTE') as blocked`)
      expect(legacy).toEqual([{ connected: true, blocked: true }])
    })
  })

  describe('ordinary owner/public subject and peer cohorts', () => {
    it('permits a private owner but gives everyone else the same unavailable result', async () => {
      await setVisibility(subject, 'private')
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      expect((await followPage(subject)).map(row => row.id)).toEqual([peer])
      expect((await followPage(subject, subject, 'following')).map(row => row.id)).toEqual([peer])
      expect((await connectionPage(subject)).map(row => row.id)).toEqual([peer])
      expect(await counts(subject)).toEqual([{ followers: '1', following: '1', connections: '1' }])
      const staff = await db.createUser({ role: 'moderator' })
      for (const actor of [null, viewer, staff]) {
        expect(await followPage(actor)).toEqual([])
        expect(await followPage(actor, subject, 'following')).toEqual([])
        expect(await counts(actor)).toEqual([])
        expect(await counts(actor, randomUUID())).toEqual([])
      }
    })

    it.each(['university', 'connections'] as const)(
      'a viewer-readable %s subject is still not a public graph subject', async visibility => {
        const campus = await university()
        await db.asService(`update public.profiles set university_id=$3
          where id in ($1,$2)`, [subject, viewer, campus])
        await fixtureConnection(subject, viewer)
        await setVisibility(subject, visibility)
        const peer = await db.createUser()
        await fixtureBoth(subject, peer)
        expect(await db.asUser(viewer, 'select id from public.profiles where id=$1', [subject]))
          .toHaveLength(1) // Entitled to profile does not imply a public graph.
        expect(await followPage(viewer)).toEqual([])
        expect(await counts(viewer)).toEqual([])
        expect(await followPage(subject)).toHaveLength(1)
      },
    )

    it('qualifies peers by the actual viewer, never the subject or staff role', async () => {
      const campus = await university()
      const otherCampus = await university()
      await db.asService('update public.profiles set university_id=$2 where id=$1', [viewer, campus])
      const publicPeer = await db.createUser()
      const campusPeer = await db.createUser({ visibility: 'university', universityId: campus })
      const foreignPeer = await db.createUser({ visibility: 'university', universityId: otherCampus })
      const connectedPeer = await db.createUser({ visibility: 'connections' })
      const pendingPeer = await db.createUser({ visibility: 'connections' })
      const privatePeer = await db.createUser({ visibility: 'private' })
      await fixtureConnection(viewer, connectedPeer)
      await fixtureConnection(viewer, pendingPeer, 'pending')
      const peers = [publicPeer, campusPeer, foreignPeer, connectedPeer, pendingPeer, privatePeer, viewer]
      for (const peer of peers) {
        await fixtureFollow(peer, subject)
        await fixtureFollow(subject, peer)
      }
      await setVisibility(viewer, 'private') // The private self-peer must be omitted.
      const expected = [publicPeer, campusPeer, connectedPeer].sort()
      for (const direction of ['followers', 'following'] as const) {
        expect((await followPage(viewer, subject, direction)).map(row => row.id).sort()).toEqual(expected)
        expect((await followPage(null, subject, direction)).map(row => row.id)).toEqual([publicPeer])
      }
      expect(await counts(viewer)).toEqual([{ followers: '3', following: '3', connections: null }])
      expect(await counts(null)).toEqual([{ followers: '1', following: '1', connections: null }])
      const staff = await db.createUser({ role: 'moderator', universityId: otherCampus })
      expect(await db.asUser<{ value: boolean }>(staff, 'select app.is_moderator() as value'))
        .toEqual([{ value: true }]) // Genuine assured staff positive control.
      for (const direction of ['followers', 'following'] as const) {
        expect((await followPage(staff, subject, direction)).map(row => row.id).sort())
          .toEqual([publicPeer, foreignPeer].sort())
      }
      expect(await counts(staff)).toEqual([{ followers: '2', following: '2', connections: null }])
      await setVisibility(viewer, 'university')
      expect((await followPage(viewer)).map(row => row.id).sort()).toEqual([...expected, viewer].sort())
    })

    it('does not add discovery or request/message consent to existing graph reads', async () => {
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      await db.asService(`update public.profiles set searchable=false,
        allow_connection_requests=false, allow_messages_from='nobody'
        where id in ($1,$2)`, [subject, peer])
      expect((await followPage(null)).map(row => row.id)).toEqual([peer])
      expect((await connectionPage(subject)).map(row => row.id)).toEqual([peer])
      expect(await counts(null)).toEqual([{ followers: '1', following: '1', connections: null }])
    })

    it('never exposes another subject connection ID/message/aggregate or another blocker reason to staff', async () => {
      const peer = await db.createUser()
      const edge = await fixtureBoth(subject, peer)
      const blocked = await db.createUser()
      await fixtureBlock(subject, blocked)
      const staff = await db.createUser({ role: 'moderator' })
      expect(await db.asUser<{ value: boolean }>(staff, 'select app.is_moderator() as value'))
        .toEqual([{ value: true }])
      for (const actor of [viewer, staff]) {
        expect(await db.asUser(actor,
          'select id, message from public.connections where id=$1', [edge])).toEqual([])
        expect(await db.asUser(actor,
          'select blocker_id, blocked_id, reason from public.blocks where blocker_id=$1', [subject]))
          .toEqual([])
        expect(await connectionPage(actor)).toEqual([])
        expect(await counts(actor)).toEqual([{ followers: '1', following: '1', connections: null }])
      }
      expect(await db.asUser(subject,
        'select id, message from public.connections where id=$1', [edge])).toHaveLength(1)
      expect(await db.asUser(subject,
        'select reason from public.blocks where blocker_id=$1 and blocked_id=$2', [subject, blocked]))
        .toEqual([{ reason: 'synthetic private block note' }])
    })

    it.each(['viewer-peer', 'peer-viewer', 'viewer-subject', 'subject-viewer'] as const)(
      'enforces bilateral %s blocks without hiding unrelated public peers from anon', async pairing => {
        const peer = await db.createUser()
        await fixtureBoth(subject, peer)
        const pair = pairing === 'viewer-peer' ? [viewer, peer]
          : pairing === 'peer-viewer' ? [peer, viewer]
            : pairing === 'viewer-subject' ? [viewer, subject] : [subject, viewer]
        await fixtureBlock(pair[0]!, pair[1]!)
        expect(await followPage(viewer)).toEqual([])
        expect(await followPage(viewer, subject, 'following')).toEqual([])
        expect(await counts(viewer)).toEqual(
          pairing.includes('subject') ? [] : [{ followers: '0', following: '0', connections: null }],
        )
        expect((await followPage(null)).map(row => row.id)).toEqual([peer])
      },
    )

    it.each(['subject-peer', 'peer-subject'] as const)(
      'filters stale %s follow rows before projection, including for anon/staff', async direction => {
        const peer = await db.createUser()
        await fixtureBoth(subject, peer)
        await fixtureBlock(direction === 'subject-peer' ? subject : peer,
          direction === 'subject-peer' ? peer : subject)
        // The real block trigger severs rows. Reinsert only synthetic stale
        // follows as the privileged fixture owner to exercise read filtering.
        await fixtureFollow(peer, subject)
        await fixtureFollow(subject, peer)
        expect(await db.asService(`select follower_id from public.follows
          where follower_id=$1 and following_id=$2`, [peer, subject])).toHaveLength(1)
        const staff = await db.createUser({ role: 'moderator' })
        for (const actor of [null, viewer, subject, staff]) {
          expect(await followPage(actor)).toEqual([])
          expect(await followPage(actor, subject, 'following')).toEqual([])
          expect(await counts(actor)).toEqual([{
            followers: '0', following: '0', connections: actor === subject ? '0' : null,
          }])
        }
      },
    )

    it.each(UNAVAILABLE)('rejects a %s subject, not a fabricated empty subject count', async state => {
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      await setUnavailable(subject, state)
      const staff = await db.createUser({ role: 'moderator' })
      for (const actor of [null, viewer, subject, staff]) {
        expect(await followPage(actor)).toEqual([])
        expect(await counts(actor)).toEqual([])
      }
      expect(await connectionPage(subject)).toEqual([])
    })

    it.each(UNAVAILABLE)('omits a %s peer consistently from lists/counts', async state => {
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      await setUnavailable(peer, state)
      const staff = await db.createUser({ role: 'moderator' })
      for (const actor of [null, viewer, subject, staff]) {
        expect(await followPage(actor)).toEqual([])
        expect(await followPage(actor, subject, 'following')).toEqual([])
        expect(await counts(actor)).toEqual([{
          followers: '0', following: '0', connections: actor === subject ? '0' : null,
        }])
      }
      expect(await connectionPage(subject)).toEqual([])
    })

    it.each(UNAVAILABLE)('rejects a %s viewer without upgrading that viewer to anonymous access', async state => {
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      await fixtureConnection(viewer, peer)
      await setUnavailable(viewer, state)
      expect(await followPage(viewer)).toEqual([])
      expect(await counts(viewer)).toEqual([])
      expect(await connectionPage(viewer)).toEqual([])
      expect((await followPage(null)).map(row => row.id)).toEqual([peer])
    })

    it('permits expired temporary suspension/provider bans without rewriting account or counters', async () => {
      const peer = await db.createUser()
      await fixtureBoth(subject, peer)
      await db.asService(`update public.profiles set status='suspended',
        suspended_until=now()-interval '1 hour' where id in ($1,$2,$3)`, [subject, peer, viewer])
      await db.asService(`update auth.users set banned_until=now()-interval '1 hour'
        where id in ($1,$2,$3)`, [subject, peer, viewer])
      const before = await syntheticSnapshot([subject, peer, viewer])
      expect((await followPage(viewer)).map(row => row.id)).toEqual([peer])
      expect((await followPage(null)).map(row => row.id)).toEqual([peer])
      expect((await connectionPage(subject)).map(row => row.id)).toEqual([peer])
      expect(await counts(subject)).toEqual([{ followers: '1', following: '1', connections: '1' }])
      expect(await syntheticSnapshot([subject, peer, viewer])).toEqual(before)
      expect(await db.asService<{ value: { enabled: boolean; code: string } }>(
        'select public.bulla_image_upload_readiness() as value'))
        .toEqual([{ value: { version: 1, enabled: false, code: 'hosted_image_uploads_disabled' } }])
    })

    it('handles missing subjects and a replayed missing Auth identity without a success fallback', async () => {
      const missing = randomUUID()
      expect(await counts(null, missing)).toEqual([])
      expect(await followPage(null, missing)).toEqual([])
      expect(await followPage(missing)).toEqual([])
      expect(await counts(missing)).toEqual([])
      expect(await connectionPage(missing)).toEqual([])
      expect(await read(null, 'select * from public.profile_graph_counts(null)')).toEqual([])
    })
  })

  describe('filter/dedup before limit and eligible lookahead', () => {
    it('omits nonfinite stored edge times without repairing raw rows or changing counter maintenance', async () => {
      const peer = await db.createUser()
      const positiveInfinity = await db.createUser()
      const negativeInfinity = await db.createUser()
      const ownEdge = await fixtureBoth(subject, peer)
      const infiniteEdges: string[] = []
      for (const [other, at] of [
        [positiveInfinity, 'infinity'], [negativeInfinity, '-infinity'],
      ] as const) {
        await fixtureFollow(other, subject, at)
        // The current INSERT grant really permits created_at; no relaxed
        // constraint or service-role substitute is needed for this own write.
        expect(await db.asUser(subject, `insert into public.follows
          (follower_id,following_id,created_at) values ($1,$2,$3::timestamptz)
          returning following_id`, [subject, other, at])).toEqual([{ following_id: other }])
        infiniteEdges.push(await fixtureConnection(subject, other, 'accepted', at))
      }
      const staff = await db.createUser({ role: 'moderator' })
      const before = await syntheticSnapshot([subject, peer, positiveInfinity, negativeInfinity])
      for (const actor of [null, viewer, subject, staff]) {
        for (const direction of ['followers', 'following'] as const) {
          const page = await followPage(actor, subject, direction, 1)
          expect(page.map(row => [row.id, row.created_at])).toEqual([[peer, AT]])
          expect(page).toHaveLength(1) // Invalid raw rows are not lookahead.
        }
        expect(await counts(actor)).toEqual([{
          followers: '1', following: '1', connections: actor === subject ? '1' : null,
        }])
      }
      const connections = await connectionPage(subject, 1)
      expect(connections.map(row => [row.connection_id, row.id, row.created_at]))
        .toEqual([[ownEdge, peer, AT]])
      // Owner-management rows still exist and can be inspected/removed by the
      // actual owner. A read filter is not an owner-data repair or new mutation.
      expect(await db.asUser<{ n: string }>(subject, `select count(*)::text as n
        from public.follows where follower_id=$1 and not pg_catalog.isfinite(created_at)`,
      [subject])).toEqual([{ n: '2' }])
      expect(await db.asUser(subject, `select id from public.connections
        where id=any($1::uuid[]) and not pg_catalog.isfinite(created_at)`,
      [infiniteEdges])).toHaveLength(2)
      expect(await db.asService<{ followers: number; following: number; connections: number }>(
        `select follower_count as followers,following_count as following,connection_count as connections
         from public.profiles where id=$1`, [subject]))
        .toEqual([{ followers: 3, following: 3, connections: 3 }])
      expect(await syntheticSnapshot([subject, peer, positiveInfinity, negativeInfinity])).toEqual(before)
    })

    it.each(['followers', 'following'] as const)(
      'pages 31 %s with zero opposite edges and hidden rows ahead of the first page', async direction => {
        const visible: string[] = []
        for (let index = 0; index < 31; index += 1) {
          const peer = await db.createUser()
          visible.push(peer)
          await fixtureDirection(direction, subject, peer)
        }
        for (let index = 0; index < 28; index += 1) {
          const hidden = await db.createUser({ visibility: 'private' })
          await fixtureDirection(direction, subject, hidden, LATER)
        }
        const ordered = visible.sort().reverse()
        const first = await followPage(null, subject, direction)
        expect(first.map(row => row.id)).toEqual(ordered.slice(0, 26))
        expect(first.every(row => row.created_at === AT)).toBe(true)
        const lastVisible = first[24]!
        const second = await followPage(null, subject, direction, 25,
          { at: lastVisible.created_at, id: lastVisible.id })
        expect(second.map(row => row.id)).toEqual(ordered.slice(25))
        expect(second).toHaveLength(6) // No extra eligible lookahead on final page.
        expect(new Set([...first.slice(0, 25), ...second].map(row => row.id)).size).toBe(31)
        const opposite = direction === 'followers' ? 'following' : 'followers'
        expect(await followPage(null, subject, opposite)).toEqual([])
        expect(await counts(null)).toEqual([{
          followers: direction === 'followers' ? '31' : '0',
          following: direction === 'following' ? '31' : '0', connections: null,
        }])
      },
    )

    it.each(['followers', 'following'] as const)(
      'normalizes offset %s times without collapsing microseconds or equal-time UUID boundaries',
      async direction => {
        const peers = [await db.createUser(), await db.createUser()].sort().reverse()
        const newest = await db.createUser()
        await fixtureDirection(direction, subject, peers[0]!, '2026-11-02T11:00:00.123456+05:00')
        await fixtureDirection(direction, subject, peers[1]!, '2026-11-02T02:00:00.123456-04:00')
        await fixtureDirection(direction, subject, newest, LATER)
        const first = await followPage(viewer, subject, direction, 1)
        expect(first.map(row => [row.id, row.created_at])).toEqual([[newest, LATER], [peers[0], AT]])
        const second = await followPage(viewer, subject, direction, 1,
          { at: '2026-11-02T11:00:00.123457+05:00', id: newest })
        expect(second.map(row => [row.id, row.created_at])).toEqual([[peers[0], AT], [peers[1], AT]])
        const last = await followPage(viewer, subject, direction, 1,
          { at: '2026-11-02T02:00:00.123456-04:00', id: peers[0]! })
        expect(last.map(row => [row.id, row.created_at])).toEqual([[peers[1], AT]])
      },
    )

    it.each(['followers', 'following'] as const)(
      'preserves %s microseconds and continues after a removed boundary/new writes', async direction => {
        const peers = [await db.createUser(), await db.createUser(), await db.createUser()].sort()
        // Deliberately oppose UUID order: timestamp must dominate, and .123456
        // must remain distinct from .123455 rather than passing through Date.
        await fixtureDirection(direction, subject, peers[0]!, LATER)
        await fixtureDirection(direction, subject, peers[1]!, AT)
        await fixtureDirection(direction, subject, peers[2]!, EARLIER)
        const first = await followPage(viewer, subject, direction, 1)
        expect(first.map(row => [row.id, row.created_at])).toEqual([
          [peers[0], LATER], [peers[1], AT],
        ])
        const cursor = { at: first[0]!.created_at, id: first[0]!.id }
        const removed = direction === 'followers'
          ? [peers[0]!, subject] : [subject, peers[0]!]
        await db.asService(`delete from public.follows
          where follower_id=$1 and following_id=$2`, removed)
        const newer = await db.createUser()
        const older = await db.createUser()
        await fixtureDirection(direction, subject, newer, '2026-11-02T06:00:01.000000Z')
        await fixtureDirection(direction, subject, older, '2026-11-02T05:59:59.999999Z')
        await setVisibility(peers[1]!, 'private')
        const rest = await followPage(viewer, subject, direction, 25, cursor)
        expect(rest.map(row => row.id)).toEqual([peers[2], older])
        expect(rest[0]!.created_at).toBe(EARLIER)
        expect(rest.some(row => row.id === newer || row.id === peers[1])).toBe(false)
      },
    )

    it('clamps null/default/zero/negative/huge sizes consistently for both page RPCs', async () => {
      const peers: string[] = []
      for (let index = 0; index < 53; index += 1) {
        const peer = await db.createUser()
        peers.push(peer)
        await fixtureFollow(peer, subject)
        await fixtureConnection(index % 2 === 0 ? subject : peer,
          index % 2 === 0 ? peer : subject)
      }
      for (const [limit, length] of [
        [null, 26], [0, 2], [-99, 2], [1, 2], [50, 51], [2_147_483_647, 51],
      ] as const) {
        expect(await followPage(subject, subject, 'followers', limit)).toHaveLength(length)
        expect(await connectionPage(subject, limit)).toHaveLength(length)
      }
      expect(await db.asAnon('select id from public.profile_follow_page($1,$2)',
        [subject, 'followers'])).toHaveLength(26)
      expect(await db.asUser(subject, 'select id from public.my_connection_page()')).toHaveLength(26)
      expect(await counts(subject)).toEqual([{ followers: '53', following: '0', connections: '53' }])
      expect(new Set(peers).size).toBe(53)
    })

    it('returns no lookahead for an exact-full page whose remaining raw edges are hidden', async () => {
      const peers = [await db.createUser(), await db.createUser()]
      for (const peer of peers) await fixtureBoth(subject, peer)
      const hidden = await db.createUser({ visibility: 'private' })
      await fixtureBoth(subject, hidden)
      expect(await followPage(subject, subject, 'followers', 2)).toHaveLength(2)
      expect(await connectionPage(subject, 2)).toHaveLength(2)
      expect(await counts(subject)).toEqual([{ followers: '2', following: '2', connections: '2' }])
    })

    it('uses connection ID, not peer ID, as the equal-time continuation key in both directions', async () => {
      const peers: string[] = []
      for (let index = 0; index < 7; index += 1) peers.push(await db.createUser())
      peers.sort()
      const edgeIds = peers.map(() => randomUUID()).sort().reverse()
      for (let index = 0; index < peers.length; index += 1) {
        await fixtureConnection(index % 2 === 0 ? subject : peers[index]!,
          index % 2 === 0 ? peers[index]! : subject, 'accepted', AT, edgeIds[index]!)
      }
      const pending = await db.createUser()
      const rejected = await db.createUser()
      const hidden = await db.createUser({ visibility: 'private' })
      await fixtureConnection(subject, pending, 'pending', LATER)
      await fixtureConnection(rejected, subject, 'rejected', LATER)
      await fixtureConnection(subject, hidden, 'accepted', LATER)
      const first = await connectionPage(subject, 3)
      expect(first.map(row => row.connection_id)).toEqual(edgeIds.slice(0, 4))
      expect(first.map(row => row.id)).toEqual(peers.slice(0, 4)) // Opposite peer DESC.
      const boundary = first[2]!
      const second = await connectionPage(subject, 3,
        { at: boundary.created_at, id: boundary.connection_id })
      expect(second.map(row => row.connection_id)).toEqual(edgeIds.slice(3))
      const last = second[2]!
      const third = await connectionPage(subject, 3,
        { at: last.created_at, id: last.connection_id })
      expect(third.map(row => row.connection_id)).toEqual(edgeIds.slice(6))
      expect(await counts(subject)).toEqual([{ followers: '0', following: '0', connections: '7' }])
      expect(await counts(viewer)).toEqual([{ followers: '0', following: '0', connections: null }])
    })

    it('normalizes connection offset timestamps while preserving the real equal-time connection key', async () => {
      const peers = [await db.createUser(), await db.createUser()]
      const edgeIds = [randomUUID(), randomUUID()].sort().reverse()
      await fixtureConnection(subject, peers[0]!, 'accepted',
        '2026-11-02T11:00:00.123456+05:00', edgeIds[0]!)
      await fixtureConnection(peers[1]!, subject, 'accepted',
        '2026-11-02T02:00:00.123456-04:00', edgeIds[1]!)
      const first = await connectionPage(subject, 1)
      expect(first.map(row => [row.connection_id, row.created_at]))
        .toEqual([[edgeIds[0], AT], [edgeIds[1], AT]])
      const last = await connectionPage(subject, 1,
        { at: '2026-11-02T11:00:00.123456+05:00', id: edgeIds[0]! })
      expect(last.map(row => [row.connection_id, row.created_at])).toEqual([[edgeIds[1], AT]])
    })

    it('preserves connection microseconds and continues after deleting the prior boundary', async () => {
      const peers = [await db.createUser(), await db.createUser(), await db.createUser()]
      const newest = await fixtureConnection(subject, peers[0]!, 'accepted', LATER)
      const middle = await fixtureConnection(peers[1]!, subject, 'accepted', AT)
      const oldest = await fixtureConnection(subject, peers[2]!, 'accepted', EARLIER)
      const first = await connectionPage(subject, 1)
      expect(first.map(row => [row.connection_id, row.created_at])).toEqual([
        [newest, LATER], [middle, AT],
      ])
      await db.asUser(subject, 'delete from public.connections where id=$1 returning id', [newest])
      const rest = await connectionPage(subject, 25, { at: LATER, id: newest })
      expect(rest.map(row => [row.connection_id, row.created_at])).toEqual([
        [middle, AT], [oldest, EARLIER],
      ])
    })

    it.each(['followers', 'following'] as const)(
      'canonicalizes duplicate/self/orphan %s before continuation/limit in a rolled-back corruption fixture',
      async direction => {
        const peers = [await db.createUser(), await db.createUser(), await db.createUser()]
        const orphan = await db.createUser()
        for (const peer of [...peers, orphan]) await fixtureDirection(direction, subject, peer)
        await isolatedCorruption(`alter table public.follows drop constraint follows_pkey;
          alter table public.follows drop constraint follows_no_self;
          alter table public.profiles drop constraint profiles_id_fkey`, async () => {
          await db.asService('delete from auth.users where id=$1', [orphan])
          // Profile and real graph edge still exist: missing Auth backing is
          // genuinely filtered, not just removed through an FK cascade.
          expect(await db.asService('select id from public.profiles where id=$1', [orphan]))
            .toHaveLength(1)
          for (let index = 0; index < 4; index += 1) {
            await fixtureDirection(direction, subject, peers[0]!, LATER)
          }
          // An invalid newer duplicate must not mask the valid finite edge.
          await fixtureDirection(direction, subject, peers[0]!, 'infinity')
          await fixtureDirection(direction, subject, peers[0]!, '-infinity')
          await fixtureFollow(subject, subject, LATER)
          const first = await followPage(subject, subject, direction, 1)
          expect(first).toHaveLength(2)
          expect(first[0]).toMatchObject({ id: peers[0], created_at: LATER })
          const rest = await followPage(subject, subject, direction, 25,
            { at: first[0]!.created_at, id: first[0]!.id })
          expect(rest.map(row => row.id).sort()).toEqual(peers.slice(1).sort())
          expect(await counts(subject)).toEqual([{
            followers: direction === 'followers' ? '3' : '0',
            following: direction === 'following' ? '3' : '0', connections: '0',
          }])
          expect(await followPage(orphan)).toEqual([])
          expect(await counts(orphan)).toEqual([])
        })
      },
    )

    it('canonicalizes duplicate/self/orphan accepted connections before the eligible lookahead', async () => {
      const peers = [await db.createUser(), await db.createUser(), await db.createUser()]
      const orphan = await db.createUser()
      for (const peer of [...peers, orphan]) await fixtureConnection(subject, peer)
      await isolatedCorruption(`alter table public.connections drop constraint connections_pair_unique;
        alter table public.connections drop constraint connections_no_self;
        alter table public.profiles drop constraint profiles_id_fkey`, async () => {
        await db.asService('delete from auth.users where id=$1', [orphan])
        const duplicateIds: string[] = []
        for (let index = 0; index < 4; index += 1) {
          duplicateIds.push(await fixtureConnection(peers[0]!, subject, 'accepted', LATER))
        }
        await fixtureConnection(subject, peers[0]!, 'accepted', 'infinity')
        await fixtureConnection(subject, peers[0]!, 'accepted', '-infinity')
        await fixtureConnection(subject, subject, 'accepted', LATER)
        const first = await connectionPage(subject, 1)
        expect(first).toHaveLength(2)
        expect(first[0]).toMatchObject({
          id: peers[0], connection_id: duplicateIds.sort().reverse()[0], created_at: LATER,
        })
        const rest = await connectionPage(subject, 25,
          { at: first[0]!.created_at, id: first[0]!.connection_id })
        expect(rest.map(row => row.id).sort()).toEqual(peers.slice(1).sort())
        expect(await counts(subject)).toEqual([{ followers: '0', following: '0', connections: '3' }])
        expect(await connectionPage(orphan)).toEqual([])
      })
    })
  })

  describe('input refusal and unchanged owner mutations/security', () => {
    it.each([null, '', 'connections', 'requests', 'blocks', 'Followers', "following'; select 1;--"])(
      'rejects invalid direction %s as input, not a new graph mode', async direction => {
        await expectRejection(() => db.asAnon(`select id from public.profile_follow_page($1,$2)`,
          [subject, direction]), /Invalid graph direction/i)
      },
    )

    it.each([[AT, null], [null, randomUUID()], ['infinity', randomUUID()], ['-infinity', randomUUID()]] as const)(
      'refuses partial/nonfinite cursor %s/%s for both RPCs', async (at, id) => {
        await expectRejection(() => db.asAnon(
          'select id from public.profile_follow_page($1,$2,$3,$4)', [subject, 'followers', at, id]),
        /Invalid graph cursor/i)
        await expectRejection(() => db.asUser(subject,
          'select id from public.my_connection_page($1,$2)', [at, id]), /Invalid graph cursor/i)
      },
    )

    it('rejects malformed/fractional/overflow typed inputs rather than interpolating SQL', async () => {
      await expectRejection(() => db.asAnon(`select id from public.profile_follow_page($1,$2)`,
        ["x'); select 1;--", 'followers']), /invalid input syntax for type uuid/i)
      await expectRejection(() => db.asAnon(`select id from public.profile_follow_page($1,$2,$3,$4)`,
        [subject, 'followers', "x'); select 1;--", viewer]), /invalid input syntax for type timestamp/i)
      for (const limit of ['1.5', 'NaN', '2147483648']) {
        await expectRejection(() => db.asAnon(
          'select id from public.profile_follow_page($1,$2,null,null,$3)',
          [subject, 'followers', limit]), /invalid input syntax for type integer|out of range/i)
        await expectRejection(() => db.asUser(subject,
          'select id from public.my_connection_page(null,null,$1)', [limit]),
        /invalid input syntax for type integer|out of range/i)
      }
    })

    it('preserves real follow, request/accept/remove, counters and protected-column refusal', async () => {
      expect(await db.asUser(viewer, `insert into public.follows(follower_id,following_id)
        values ($1,$2) returning follower_id,following_id`, [viewer, subject]))
        .toEqual([{ follower_id: viewer, following_id: subject }])
      const request = await db.asUser<{ id: string; status: string; requester_id: string }>(viewer,
        `insert into public.connections(requester_id,addressee_id,status,message)
         values ($1,$2,'accepted','synthetic actual request') returning id,status,requester_id`,
        [viewer, subject])
      expect(request[0]).toMatchObject({ status: 'pending', requester_id: viewer })
      const id = request[0]!.id
      expect(await db.asUser(viewer, `update public.connections set status='accepted'
        where id=$1 returning id`, [id])).toEqual([])
      expect(await db.asUser(subject, `update public.connections set status='accepted'
        where id=$1 returning id,status`, [id])).toEqual([{ id, status: 'accepted' }])
      expect((await connectionPage(subject)).map(row => row.connection_id)).toEqual([id])
      expect(await counts(subject)).toEqual([{ followers: '1', following: '0', connections: '1' }])
      const raw = await db.asService<{ followers: number; connections: number }>(
        `select follower_count as followers,connection_count as connections from public.profiles where id=$1`,
        [subject])
      expect(raw).toEqual([{ followers: 1, connections: 1 }]) // Internal counters still maintained.
      await expectRejection(() => db.asUser(subject,
        'update public.profiles set connection_count=999 where id=$1', [subject]), DENIED)
      await expectRejection(() => db.asUser(subject,
        'update public.connections set requester_id=$2 where id=$1', [id, subject]), DENIED)
      expect(await db.asUser(subject, 'delete from public.connections where id=$1 returning id', [id]))
        .toEqual([{ id }])
      expect(await db.asUser(viewer, `delete from public.follows
        where follower_id=$1 and following_id=$2 returning following_id`, [viewer, subject]))
        .toEqual([{ following_id: subject }])
      expect(await counts(subject)).toEqual([{ followers: '0', following: '0', connections: '0' }])
    })

    it('preserves decline/re-request/withdraw using existing participant SELECT and mutation policies', async () => {
      const id = (await db.asUser<{ id: string }>(viewer,
        'insert into public.connections(addressee_id) values ($1) returning id', [subject]))[0]!.id
      expect(await db.asUser(subject, `update public.connections set status='rejected'
        where id=$1 returning id,status`, [id])).toEqual([{ id, status: 'rejected' }])
      expect(await db.asUser(viewer,
        `delete from public.connections where id=$1 and status='rejected' returning id`, [id]))
        .toEqual([{ id }])
      const retry = (await db.asUser<{ id: string }>(viewer,
        'insert into public.connections(addressee_id) values ($1) returning id', [subject]))[0]!.id
      expect(await db.asUser(viewer, 'delete from public.connections where id=$1 returning id', [retry]))
        .toEqual([{ id: retry }])
      expect(await connectionPage(subject)).toEqual([])
    })

    it('keeps own raw management rows removable after a peer becomes private/unavailable', async () => {
      const id = await fixtureBoth(subject, viewer)
      await setVisibility(viewer, 'private')
      await setUnavailable(viewer, 'current suspension')
      expect(await followPage(subject, subject, 'following')).toEqual([])
      expect(await connectionPage(subject)).toEqual([])
      expect(await counts(subject)).toEqual([{ followers: '0', following: '0', connections: '0' }])
      expect(await db.asUser(subject, `delete from public.follows
        where follower_id=$1 and following_id=$2 returning following_id`, [subject, viewer]))
        .toEqual([{ following_id: viewer }])
      expect(await db.asUser(subject, 'delete from public.connections where id=$1 returning id', [id]))
        .toEqual([{ id }])
    })

    it('keeps block stamping/severing, own reason access and real unblock intact', async () => {
      await fixtureBoth(subject, viewer)
      const blocked = await db.asUser<{ blocker_id: string; blocked_id: string }>(subject,
        `insert into public.blocks(blocker_id,blocked_id,reason)
         values ($1,$2,'synthetic own block') returning blocker_id,blocked_id`, [viewer, viewer])
      expect(blocked).toEqual([{ blocker_id: subject, blocked_id: viewer }])
      expect(await db.asService(`select id from public.connections
        where pair_low=least($1::uuid,$2::uuid) and pair_high=greatest($1::uuid,$2::uuid)`,
      [subject, viewer])).toEqual([])
      expect(await db.asService(`select follower_id from public.follows
        where (follower_id=$1 and following_id=$2) or (follower_id=$2 and following_id=$1)`,
      [subject, viewer])).toEqual([])
      expect(await db.asUser(viewer, 'select reason from public.blocks where blocker_id=$1', [subject]))
        .toEqual([])
      expect(await db.asUser(subject, `delete from public.blocks
        where blocker_id=$1 and blocked_id=$2 returning blocked_id`, [subject, viewer]))
        .toEqual([{ blocked_id: viewer }])
    })

    it('keeps account-lifecycle restrictive policies, existing triggers, and staff gates installed', async () => {
      const guard = await db.asService<{ table_name: string; restrictive: boolean }>(`select
        c.relname as table_name, not p.polpermissive as restrictive
        from pg_policy p join pg_class c on c.oid=p.polrelid
        where p.polname='account_lifecycle_access_guard'
          and p.polrelid=any(array['public.profiles'::regclass,'public.follows'::regclass,
            'public.connections'::regclass,'public.blocks'::regclass]) order by c.relname`)
      expect(guard).toEqual([
        { table_name: 'blocks', restrictive: true },
        { table_name: 'connections', restrictive: true },
        { table_name: 'follows', restrictive: true },
        { table_name: 'profiles', restrictive: true },
      ])
      const triggers = await db.asService<{ name: string }>(`select tgname as name
        from pg_trigger where not tgisinternal
        and (tgrelid,tgname) in (
          ('public.profiles'::regclass,'profiles_protect_columns'),
          ('public.connections'::regclass,'connections_before_write'),
          ('public.connections'::regclass,'connections_sync_counts'),
          ('public.follows'::regclass,'follows_sync_counts'),
          ('public.blocks'::regclass,'blocks_before_insert'),
          ('public.blocks'::regclass,'blocks_sever_relationships'),
          ('public.posts'::regclass,'mandatory_abuse_budget')
        ) order by tgname`)
      expect(triggers.map(row => row.name)).toEqual([
        'blocks_before_insert', 'blocks_sever_relationships', 'connections_before_write',
        'connections_sync_counts', 'follows_sync_counts', 'mandatory_abuse_budget',
        'profiles_protect_columns',
      ])
      // No global redefinition of staff social/content/profile predicates.
      const staff = await db.createUser({ role: 'moderator' })
      expect(await db.asUser<{ value: boolean }>(staff, 'select app.is_moderator() as value'))
        .toEqual([{ value: true }])
      await setVisibility(subject, 'private')
      expect(await db.asUser(staff, 'select id from public.profiles where id=$1', [subject]))
        .toHaveLength(1) // Legacy staff content/profile access stays unchanged.
      expect(await counts(staff)).toEqual([]) // Ordinary graph still has no override.
    })
  })
})

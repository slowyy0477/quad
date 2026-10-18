/**
 * Feed permission tests: posts, comments, likes, saves and the two lenses.
 *
 * The feed is the busiest surface in the application and, until this file, its
 * tables were the least tested in `tests/db/`. TESTING.md named posts and comments
 * as the largest gap.
 *
 * The shape of every test here is the same, and it is the shape that makes a
 * permission test worth writing:
 *
 *   1. the owner can do it;
 *   2. an unrelated user cannot;
 *   3. an unrelated user cannot *by substituting an id* — the same statement with
 *      someone else's row id, which is what a hostile caller actually sends.
 *
 * A test that only checks (2) passes against a policy that leaks by primary key.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb
let universityId: string
/** Posts, and shares a university with `classmate`. */
let owner: string
let classmate: string
/** No university at all, so university-scoped rows are invisible to them. */
let stranger: string
/** A third account, used to prove counts come from distinct rows. */
let other: string

beforeAll(async () => {
  db = await createTestDb()

  const uni = await db.asService<{ id: string }>(
    `insert into public.universities (slug, name, status)
     values ('feed-uni', 'Feed Test University', 'approved') returning id`,
  )
  universityId = uni[0]!.id

  owner = await db.createUser({ username: 'feedowner', universityId })
  classmate = await db.createUser({ username: 'feedclassmate', universityId })
  stranger = await db.createUser({ username: 'feedstranger' })
  other = await db.createUser({ username: 'feedother', universityId })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** A post written by the given user, through the normal client path. */
async function createPost(
  userId: string,
  overrides: Partial<{ body: string; visibility: string }> = {},
) {
  const rows = await db.asUser<{ id: string }>(
    userId,
    `insert into public.posts (body, visibility) values ($1, $2) returning id`,
    [overrides.body ?? 'A post body long enough to pass the not-empty check.', overrides.visibility ?? 'public'],
  )
  return rows[0]!.id
}

describe('post authorship', () => {
  it('overwrites a forged author_id with the caller', async () => {
    // The column defaults to auth.uid() and `posts_before_write` assigns it on
    // every non-privileged insert, so the author is the session, not the payload.
    const rows = await db.asUser<{ id: string }>(
      owner,
      `insert into public.posts (body, visibility, author_id)
       values ('Written by me, attributed to someone else.', 'public', $1)
       returning id`,
      [stranger],
    )

    const stored = await db.asService<{ author_id: string }>(
      `select author_id from public.posts where id = $1`,
      [rows[0]!.id],
    )
    expect(stored[0]!.author_id).toBe(owner)
  })

  it('zeroes the counters whatever the client sends', async () => {
    const rows = await db.asUser<{ id: string }>(
      owner,
      `insert into public.posts (body, visibility, like_count, comment_count, save_count)
       values ('Inflated numbers sent from a browser.', 'public', 9999, 9999, 9999)
       returning id`,
    )

    const stored = await db.asService<{
      like_count: number
      comment_count: number
      save_count: number
    }>(
      `select like_count, comment_count, save_count from public.posts where id = $1`,
      [rows[0]!.id],
    )
    expect(stored[0]!.like_count).toBe(0)
    expect(stored[0]!.comment_count).toBe(0)
    expect(stored[0]!.save_count).toBe(0)
  })

  it('denormalises the author university onto the post', async () => {
    const postId = await createPost(owner)

    const rows = await db.asService<{ university_id: string | null }>(
      `select university_id from public.posts where id = $1`,
      [postId],
    )
    expect(rows[0]!.university_id).toBe(universityId)
  })
})

describe('post visibility', () => {
  it('hides a private post from everyone but its author', async () => {
    const postId = await createPost(owner, { visibility: 'private' })

    const asAuthor = await db.asUser(owner, `select id from public.posts where id = $1`, [postId])
    expect(asAuthor).toHaveLength(1)

    const asStranger = await db.asUser(stranger, `select id from public.posts where id = $1`, [
      postId,
    ])
    expect(asStranger).toEqual([])

    const asClassmate = await db.asUser(classmate, `select id from public.posts where id = $1`, [
      postId,
    ])
    expect(asClassmate).toEqual([])
  })

  it('shows a university post only inside that university, including by id substitution', async () => {
    const postId = await createPost(owner, { visibility: 'university' })

    const asClassmate = await db.asUser(
      classmate,
      `select id from public.posts where id = $1`,
      [postId],
    )
    expect(asClassmate).toHaveLength(1)

    // The same statement with the same id and a different caller. This is the
    // direction a policy that leaks by primary key would fail.
    const asStranger = await db.asUser(stranger, `select id from public.posts where id = $1`, [
      postId,
    ])
    expect(asStranger).toEqual([])
  })

  it('shows an anonymous visitor public posts and nothing else', async () => {
    const open = await createPost(owner, { visibility: 'public' })
    const scoped = await createPost(owner, { visibility: 'university' })
    const hidden = await createPost(owner, { visibility: 'private' })

    const rows = await db.asAnon<{ id: string }>(
      `select id from public.posts where id = any($1::uuid[])`,
      [[open, scoped, hidden]],
    )
    expect(rows.map((row) => row.id)).toEqual([open])
  })

  it('clamps a post to its author profile visibility', async () => {
    // A public post by somebody whose profile is connections-only would leak the
    // person through the post; the clamp in `app.clamp_visibility` is the ceiling.
    const shy = await db.createUser({ username: 'feedshy', visibility: 'connections' })

    const rows = await db.asUser<{ id: string }>(
      shy,
      `insert into public.posts (body, visibility)
       values ('Public, or so I thought.', 'public') returning id`,
    )

    const stored = await db.asService<{ visibility: string }>(
      `select visibility from public.posts where id = $1`,
      [rows[0]!.id],
    )
    expect(stored[0]!.visibility).toBe('connections')
  })

  it('does not let an anonymous visitor write a post', async () => {
    await expectRejection(
      () => db.asAnon(`insert into public.posts (body) values ('Anonymous post')`),
      REJECTS.permissionDenied,
    )
  })

  it('does not let one author edit another author post', async () => {
    const postId = await createPost(owner, { body: 'Original text.' })

    // No error: the UPDATE policy filters the row out, so nothing is updated.
    await db.asUser(stranger, `update public.posts set body = 'Hijacked' where id = $1`, [postId])

    const stored = await db.asService<{ body: string }>(
      `select body from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.body).toBe('Original text.')
  })
})

describe('post counters', () => {
  it('refuses a client write to like_count at the GRANT level', async () => {
    // Not a policy: `like_count` is absent from the column-level UPDATE grant, so
    // the statement fails with "permission denied" before any policy is consulted.
    // The counter can only move by inserting a row into post_likes.
    const postId = await createPost(owner)

    const rejection = await expectRejection(
      () => db.asUser(owner, `update public.posts set like_count = 999 where id = $1`, [postId]),
      REJECTS.permissionDenied,
    )
    expect(rejection.message).toMatch(/like_count|posts/i)

    const stored = await db.asService<{ like_count: number }>(
      `select like_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.like_count).toBe(0)
  })

  it('moves like_count from the rows, and refuses a forged like', async () => {
    const postId = await createPost(owner)

    await db.asUser(
      classmate,
      `insert into public.post_likes (post_id, profile_id) values ($1, $2)`,
      [postId, classmate],
    )

    let stored = await db.asService<{ like_count: number }>(
      `select like_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.like_count).toBe(1)

    // A like attributed to someone else: profile_id must equal auth.uid().
    await expectRejection(
      () =>
        db.asUser(
          stranger,
          `insert into public.post_likes (post_id, profile_id) values ($1, $2)`,
          [postId, owner],
        ),
      REJECTS.rlsViolation,
    )

    stored = await db.asService<{ like_count: number }>(
      `select like_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.like_count).toBe(1)
  })

  it('refuses a second like from the same person', async () => {
    // The primary key is (post_id, profile_id), so a double tap is a collision --
    // which the Server Action reads as "already liked", not as a second like.
    const postId = await createPost(owner)
    const like = () =>
      db.asUser(classmate, `insert into public.post_likes (post_id, profile_id) values ($1, $2)`, [
        postId,
        classmate,
      ])

    await like()
    await expectRejection(like, REJECTS.uniqueViolation)

    const stored = await db.asService<{ like_count: number }>(
      `select like_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.like_count).toBe(1)
  })

  it('refuses a like on a post the caller cannot see', async () => {
    const postId = await createPost(owner, { visibility: 'private' })

    await expectRejection(
      () =>
        db.asUser(
          stranger,
          `insert into public.post_likes (post_id, profile_id) values ($1, $2)`,
          [postId, stranger],
        ),
      REJECTS.rlsViolation,
    )
  })
})

describe('saves are private to the saver', () => {
  it('writes a real row and shows it to nobody else', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    await db.asUser(
      classmate,
      `insert into public.post_saves (post_id, profile_id) values ($1, $2)`,
      [postId, classmate],
    )

    // The row exists: read with full privileges, where RLS does not apply.
    const asService = await db.asService<{ profile_id: string }>(
      `select profile_id from public.post_saves where post_id = $1`,
      [postId],
    )
    expect(asService).toHaveLength(1)
    expect(asService[0]!.profile_id).toBe(classmate)

    // The saver can read it back.
    const asSaver = await db.asUser(
      classmate,
      `select post_id from public.post_saves where post_id = $1`,
      [postId],
    )
    expect(asSaver).toHaveLength(1)

    // Nobody else can, not even the post's author, and not by id substitution.
    const asAuthor = await db.asUser(
      owner,
      `select post_id from public.post_saves where post_id = $1`,
      [postId],
    )
    expect(asAuthor).toEqual([])

    const asStranger = await db.asUser(
      stranger,
      `select post_id from public.post_saves where post_id = $1`,
      [postId],
    )
    expect(asStranger).toEqual([])
  })

  it('refuses a save attributed to someone else', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    await expectRejection(
      () =>
        db.asUser(
          stranger,
          `insert into public.post_saves (post_id, profile_id) values ($1, $2)`,
          [postId, classmate],
        ),
      REJECTS.rlsViolation,
    )
  })

  it('moves save_count from the row without exposing who saved it', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    await db.asUser(
      classmate,
      `insert into public.post_saves (post_id, profile_id) values ($1, $2)`,
      [postId, classmate],
    )

    const stored = await db.asService<{ save_count: number }>(
      `select save_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.save_count).toBe(1)
  })
})

describe('comments inherit the post visibility', () => {
  it('lets a reader comment on a post they can see and counts it', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    await db.asUser(classmate, `insert into public.comments (post_id, body) values ($1, $2)`, [
      postId,
      'A comment from a classmate.',
    ])

    const stored = await db.asService<{ comment_count: number }>(
      `select comment_count from public.posts where id = $1`,
      [postId],
    )
    expect(stored[0]!.comment_count).toBe(1)

    const comments = await db.asUser(
      stranger,
      `select body from public.comments where post_id = $1`,
      [postId],
    )
    expect(comments).toHaveLength(1)
  })

  it('hides the comments of a private post from a stranger, by id substitution', async () => {
    const postId = await createPost(owner, { visibility: 'private' })

    await db.asUser(owner, `insert into public.comments (post_id, body) values ($1, $2)`, [
      postId,
      'Only I should read this.',
    ])

    const asAuthor = await db.asUser(
      owner,
      `select body from public.comments where post_id = $1`,
      [postId],
    )
    expect(asAuthor).toHaveLength(1)

    const asStranger = await db.asUser(
      stranger,
      `select body from public.comments where post_id = $1`,
      [postId],
    )
    expect(asStranger).toEqual([])
  })

  it('refuses a comment on a post the caller cannot see', async () => {
    // The id substitution a hostile caller sends: a real post id, from the wrong
    // account. `comments_insert_own` requires `app.can_view_post(post_id)`.
    const postId = await createPost(owner, { visibility: 'private' })

    await expectRejection(
      () =>
        db.asUser(stranger, `insert into public.comments (post_id, body) values ($1, $2)`, [
          postId,
          'Commenting on something I cannot read.',
        ]),
      REJECTS.rlsViolation,
    )
  })

  it('forces the comment author to the caller', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    const rows = await db.asUser<{ id: string }>(
      stranger,
      `insert into public.comments (post_id, body, author_id) values ($1, $2, $3) returning id`,
      [postId, 'Attributed to the wrong person.', owner],
    )

    const stored = await db.asService<{ author_id: string }>(
      `select author_id from public.comments where id = $1`,
      [rows[0]!.id],
    )
    expect(stored[0]!.author_id).toBe(stranger)
  })

  it('refuses a reply nested more than one level deep', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    const parent = await db.asUser<{ id: string }>(
      classmate,
      `insert into public.comments (post_id, body) values ($1, $2) returning id`,
      [postId, 'A top-level comment.'],
    )

    const reply = await db.asUser<{ id: string }>(
      stranger,
      `insert into public.comments (post_id, body, parent_id) values ($1, $2, $3) returning id`,
      [postId, 'A reply.', parent[0]!.id],
    )

    await expectRejection(
      () =>
        db.asUser(
          other,
          `insert into public.comments (post_id, body, parent_id) values ($1, $2, $3)`,
          [postId, 'A reply to a reply.', reply[0]!.id],
        ),
      /max_depth|nested|23514/i,
    )
  })

  it('moves the reply count on the parent', async () => {
    const postId = await createPost(owner, { visibility: 'public' })

    const parent = await db.asUser<{ id: string }>(
      classmate,
      `insert into public.comments (post_id, body) values ($1, $2) returning id`,
      [postId, 'Asked a question.'],
    )

    await db.asUser(
      stranger,
      `insert into public.comments (post_id, body, parent_id) values ($1, $2, $3)`,
      [postId, 'Answered it.', parent[0]!.id],
    )

    // `comments` counts its replies; it has no count of its own children's children
    // because depth is capped at one.
    const stored = await db.asService<{ reply_count: number }>(
      `select reply_count from public.comments where id = $1`,
      [parent[0]!.id],
    )
    expect(stored[0]!.reply_count).toBe(1)

    // The post counts the whole thread, parents and replies alike.
    const post = await db.asService<{ comment_count: number }>(
      `select comment_count from public.posts where id = $1`,
      [postId],
    )
    expect(post[0]!.comment_count).toBe(2)
  })
})

describe('the feed lenses (migration 0018)', () => {
  it('ranks as documented, so a weight change is a visible diff', async () => {
    // Each expectation pins one weight, with arithmetic that can be checked by
    // reading the migration. If a weight moves, one of these stops being true.
    const rows = await db.asService<{ label: string; score: string }>(`
      select 'recency half-life 24h' as label,
             app.rank_feed(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-02 00:00+00',
                           0, 0, 0, null, null)::text as score
      union all
      select 'same university bonus',
             app.rank_feed(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-01 00:00+00',
                           0, 0, 0, '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000aa')::text
      union all
      select 'one like',
             app.rank_feed(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-01 00:00+00',
                           1, 0, 0, null, null)::text
      union all
      select 'one comment',
             app.rank_feed(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-01 00:00+00',
                           0, 1, 0, null, null)::text
      union all
      select 'one save',
             app.rank_feed(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-01 00:00+00',
                           0, 0, 1, null, null)::text
    `)

    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.score]))
    // 0.5 ^ (24/24) = 0.5 exactly.
    expect(byLabel['recency half-life 24h']).toBe('0.500000')
    // 0.5 ^ 0 = 1, plus the university bonus.
    expect(byLabel['same university bonus']).toBe('1.500000')
    // 1 + ln(2).
    expect(byLabel['one like']).toBe('1.693147')
    // 1 + 2*ln(2).
    expect(byLabel['one comment']).toBe('2.386294')
    // 1 + 3*ln(2).
    expect(byLabel['one save']).toBe('3.079442')
  })

  it('is deterministic across two identical calls', async () => {
    const call = () =>
      db.asService<{ interval: string; score: string }>(`
        select 'a' as interval, app.rank_feed(
          timestamptz '2026-03-01 09:30+00', timestamptz '2026-03-02 21:00+00',
          17, 4, 2, '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111'
        )::text as score
      `)

    const [first, second] = await Promise.all([call(), call()])
    expect(first[0]!.score).toBe(second[0]!.score)

    // And the same answer on a third call with the arguments in a fresh statement,
    // so this is the function and not a cached plan.
    const third = await call()
    expect(third[0]!.score).toBe(first[0]!.score)
  })

  it('exposes the ranking to authenticated readers and to nobody else', async () => {
    // The declared audience from 0018. `anon` has no feed to rank, and the revoke
    // names it because `revoke ... from public` does not remove a direct grant.
    const asUser = await db.asUser<{ score: string }>(owner, `
      select app.rank_feed(now(), now(), 1, 1, 1, null, null)::text as score
    `)
    expect(asUser).toHaveLength(1)

    await expectRejection(
      () => db.asAnon(`select app.rank_feed(now(), now(), 1, 1, 1, null, null)`),
      REJECTS.permissionDenied,
    )
  })

  it('does not grant the lens views to an anonymous visitor', async () => {
    await expectRejection(
      () => db.asAnon(`select id from public.ranked_feed limit 1`),
      REJECTS.permissionDenied,
    )
    await expectRejection(
      () => db.asAnon(`select id from public.following_feed limit 1`),
      REJECTS.permissionDenied,
    )
  })

  it('keeps the lens views under RLS rather than running them as their owner', async () => {
    // `security_invoker = true` is the whole reason these views are safe. Without
    // it the view would run as its owner and hand every caller every post.
    const hidden = await createPost(owner, { visibility: 'private' })
    const open = await createPost(owner, { visibility: 'public' })

    const asStranger = await db.asUser<{ id: string }>(
      stranger,
      `select id from public.ranked_feed where id = any($1::uuid[])`,
      [[hidden, open]],
    )
    expect(asStranger.map((row) => row.id)).toEqual([open])

    const asAuthor = await db.asUser<{ id: string }>(
      owner,
      `select id from public.ranked_feed where id = any($1::uuid[])`,
      [[hidden, open]],
    )
    expect(asAuthor.map((row) => row.id).sort()).toEqual([hidden, open].sort())
  })

  it('orders a fixed fixture the way the migration documents, and paginates without looping', async () => {
    // A fixture with three deliberately separated ages, inserted with full
    // privileges so created_at and the counters are exactly what is asserted.
    await db.asService(`
      with author as (select id from public.profiles where id = '${owner}')
      insert into public.posts (author_id, body, visibility, created_at, like_count, comment_count, save_count)
      select author.id, 'Fresh but quiet.', 'public', now() - interval '1 hour', 0, 0, 0 from author
      union all
      select author.id, 'Old but loved.', 'public', now() - interval '25 hours', 20, 5, 2 from author
      union all
      select author.id, 'Older still and empty.', 'public', now() - interval '30 hours', 0, 0, 0 from author
      union all
      -- Identical to "Old but loved." in every input: a tie the id must break.
      select author.id, 'Old but loved (tie).', 'public', now() - interval '25 hours', 20, 5, 2 from author
    `)

    const fixture = await db.asService<{ id: string; body: string }>(
      `select id, body from public.posts
        where author_id = $1
          and body in ('Fresh but quiet.', 'Old but loved.', 'Older still and empty.', 'Old but loved (tie).')`,
      [owner],
    )
    expect(fixture).toHaveLength(4)

    const idOf = (body: string) => fixture.find((row) => row.body === body)!.id

    // The boundary score, read back exactly as `getFeedPosts` reads it: the ranked
    // lens is ordered by `feed_score` first, so a `(created_at, id)` boundary alone
    // would ask the wrong question and drop a quiet recent post between pages.
    const boundaryScore = async (id: string) => {
      const rows = await db.asUser<{ feed_score: string }>(
        classmate,
        `select feed_score::text as feed_score from public.ranked_feed where id = $1`,
        [id],
      )
      return rows.length > 0 ? rows[0]!.feed_score : null
    }

    const page = async (cursor: { created_at: string; id: string } | null, limit = 2) => {
      const score = cursor ? await boundaryScore(cursor.id) : null
      const boundary = score
        ? `(feed_score < $5::numeric
            or (feed_score = $5::numeric and created_at < $1::timestamptz)
            or (feed_score = $5::numeric and created_at = $1::timestamptz and id < $2::uuid))`
        : `(created_at < $1::timestamptz
            or (created_at = $1::timestamptz and id < $2::uuid))`

      // `pg` refuses a parameter the statement does not reference, so the score is
      // only bound when the boundary uses it.
      const params: unknown[] = [
        cursor?.created_at ?? null,
        cursor?.id ?? null,
        limit,
        fixture.map((row) => row.id),
      ]
      if (score) params.push(score)

      const rows = await db.asUser<{ id: string; created_at: string; feed_score: string }>(
        classmate,
        `select id, created_at, feed_score::text as feed_score from public.ranked_feed
          where id = any($4::uuid[])
            and ($1::timestamptz is null or ${boundary})
          order by feed_score desc, created_at desc, id desc
          limit $3`,
        params,
      )
      return rows
    }

    const first = await page(null)
    expect(first).toHaveLength(2)

    // Determinism: the same call, twice, is the same order. Without the
    // (created_at, id) tiebreak this is where a tied pair would swap.
    const firstAgain = await page(null)
    expect(firstAgain.map((row) => row.id)).toEqual(first.map((row) => row.id))

    const last = first.at(-1)!

    // The score must not move between the two statements. This is the property the
    // day-floored clock in 0018 exists to give: with a clock at the exact instant,
    // this row scored 10.909642 when read back and 10.909641 in the page it came
    // from one second later, which put the boundary below rows already shown.
    expect(await boundaryScore(last.id)).toBe(last.feed_score)

    const second = await page({ created_at: last.created_at, id: last.id })

    const ordered = [...first, ...second].map((row) => row.id)
    // No id twice, and every fixture row exactly once. Note which row makes this
    // fail if the boundary is only `(created_at, id)`: "Fresh but quiet." is the
    // newest fixture row and ranks third, so it is *newer* than the cursor and is
    // dropped between pages by a chronological boundary. That is the bug this test
    // was written against.
    expect(new Set(ordered).size).toBe(ordered.length)
    expect([...ordered].sort()).toEqual(fixture.map((row) => row.id).sort())
    expect(ordered).toContain(idOf('Fresh but quiet.'))

    // The heavily engaged posts outrank both quiet ones, whatever their ages --
    // which is the whole difference between this ordering and plain recency.
    const engaged = [idOf('Old but loved.'), idOf('Old but loved (tie).')]
    expect(ordered.slice(0, 2).sort()).toEqual([...engaged].sort())
    expect(ordered.slice(2).sort()).toEqual(
      [idOf('Fresh but quiet.'), idOf('Older still and empty.')].sort(),
    )

    // And the score itself moves with the engagement, not only with the clock.
    const scores = await db.asUser<{ id: string; feed_score: string }>(
      classmate,
      `select id, feed_score::text from public.ranked_feed where id = any($1::uuid[])`,
      [fixture.map((row) => row.id)],
    )
    const byId = Object.fromEntries(scores.map((row) => [row.id, Number(row.feed_score)]))
    expect(byId[idOf('Old but loved.')]!).toBeGreaterThan(byId[idOf('Fresh but quiet.')]!)
    expect(byId[idOf('Old but loved (tie).')]!).toBe(byId[idOf('Old but loved.')]!)
  })
})

describe('the Following lens', () => {
  it('returns only followed accounts, even when the query is called directly', async () => {
    const follower = await db.createUser({ username: 'feedfollower', universityId })

    const followed = await createPost(owner, { body: 'From someone I follow.' })
    const unfollowed = await createPost(other, { body: 'From someone I do not follow.' })

    await db.asUser(
      follower,
      `insert into public.follows (follower_id, following_id) values ($1, $2)`,
      [follower, owner],
    )

    const rows = await db.asUser<{ id: string; author_id: string }>(
      follower,
      `select id, author_id from public.following_feed where id = any($1::uuid[])`,
      [[followed, unfollowed]],
    )

    expect(rows.map((row) => row.id)).toEqual([followed])
    expect(rows.every((row) => row.author_id === owner)).toBe(true)
  })

  it('is empty for an account that follows nobody', async () => {
    const loner = await db.createUser({ username: 'feedloner', universityId })
    await createPost(other, { body: 'Something for the loner to not see.' })

    const rows = await db.asUser(
      loner,
      `select id from public.following_feed limit 5`,
    )
    expect(rows).toEqual([])
  })

  it('drops the posts again when the follow is removed', async () => {
    const flicker = await db.createUser({ username: 'feedflicker', universityId })
    const postId = await createPost(other, { body: 'Followed, then not.' })

    await db.asUser(
      flicker,
      `insert into public.follows (follower_id, following_id) values ($1, $2)`,
      [flicker, other],
    )
    let rows = await db.asUser(flicker, `select id from public.following_feed where id = $1`, [
      postId,
    ])
    expect(rows).toHaveLength(1)

    await db.asUser(
      flicker,
      `delete from public.follows where follower_id = $1 and following_id = $2`,
      [flicker, other],
    )
    rows = await db.asUser(flicker, `select id from public.following_feed where id = $1`, [postId])
    expect(rows).toEqual([])
  })

  it('still refuses a private post from an account you follow', async () => {
    // Following is not a grant. A private post stays private to its author.
    const watcher = await db.createUser({ username: 'feedwatcher', universityId })
    const privatePost = await createPost(owner, { visibility: 'private' })

    await db.asUser(
      watcher,
      `insert into public.follows (follower_id, following_id) values ($1, $2)`,
      [watcher, owner],
    )

    const rows = await db.asUser(
      watcher,
      `select id from public.following_feed where id = $1`,
      [privatePost],
    )
    expect(rows).toEqual([])
  })
})

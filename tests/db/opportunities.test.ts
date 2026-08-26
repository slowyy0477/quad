/**
 * Opportunities and events.
 *
 * Two shared boards, so the interesting questions are about reach: who sees a
 * listing, who sees an attendee list, and what a student can learn about other
 * people by looking. Three specific things this file pins down:
 *
 *   1. A private bookmark is private *from the poster too*. An employer-side
 *      view of "who saved this job" would be a list of students considering
 *      leaving, and the poster has no business having it.
 *   2. An event attached to a private project must not leak that the project
 *      exists.
 *   3. Capacity is enforced in the database. A "full" badge computed in the
 *      browser is a suggestion.
 *
 * And one that is about provenance rather than permissions: `source` is
 * constrained to 'user_submitted', so the schema itself refuses a row that came
 * from a scraper. That is tested here because a comment cannot fail.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createTestDb, expectRejection, REJECTS, type TestDb } from './harness'

let db: TestDb

let uniA: string
let uniB: string
/** Poster and reader at the same university. */
let poster: string
let peer: string
/** Different university. */
let outsider: string
/** No university at all. */
let unaffiliated: string
let moderator: string

beforeAll(async () => {
  db = await createTestDb()

  // The slug is derived by trigger from the name, so it is not usable as a key
  // here -- match on the name instead.
  const unis = await db.asService<{ id: string; name: string }>(
    `insert into public.universities (name, country, status) values
       ('Board University', 'DE', 'approved'),
       ('Other University', 'DE', 'approved')
     returning id, name`,
  )
  uniA = unis.find((u) => u.name === 'Board University')!.id
  uniB = unis.find((u) => u.name === 'Other University')!.id

  poster = await db.createUser({ username: 'board_poster', universityId: uniA })
  peer = await db.createUser({ username: 'board_peer', universityId: uniA })
  outsider = await db.createUser({ username: 'board_outsider', universityId: uniB })
  unaffiliated = await db.createUser({ username: 'board_nowhere' })
  moderator = await db.createUser({ username: 'board_mod', universityId: uniB, role: 'moderator' })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

let seq = 0
function uniqueTitle(prefix: string) {
  seq += 1
  return `${prefix} ${seq}`
}

async function newOpportunity(
  as: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const fields: Record<string, unknown> = {
    title: uniqueTitle('Backend Internship'),
    organisation: 'Kleinbetrieb GmbH',
    description: 'Six months building an ingest pipeline. Rust or Go.',
    type: 'internship',
    apply_url: 'https://example.test/apply',
    ...overrides,
  }
  const cols = Object.keys(fields)
  const placeholders = cols.map((_, i) => `$${i + 1}`)
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.opportunities (${cols.join(', ')})
     values (${placeholders.join(', ')}) returning id`,
    Object.values(fields),
  )
  return rows[0]!.id
}

async function newEvent(as: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const fields: Record<string, unknown> = {
    title: uniqueTitle('Rust Workshop'),
    type: 'workshop',
    starts_at: new Date('2030-06-01T12:00:00Z').toISOString(),
    ...overrides,
  }
  const cols = Object.keys(fields)
  const placeholders = cols.map((_, i) => `$${i + 1}`)
  const rows = await db.asUser<{ id: string }>(
    as,
    `insert into public.events (${cols.join(', ')})
     values (${placeholders.join(', ')}) returning id`,
    Object.values(fields),
  )
  return rows[0]!.id
}

// =============================================================================

describe('opportunity provenance', () => {
  it('refuses any source other than a member submission', async () => {
    // The constraint is the record of the decision not to scrape. If a future
    // migration widens it, that migration has to say why.
    await expectRejection(
      () =>
        db.asService(
          `insert into public.opportunities
             (posted_by, title, organisation, description, type, apply_url, source)
           values ($1, 'Scraped Listing', 'SomeCorp',
                   'Imported from a job board we do not have a licence for.',
                   'internship', 'https://example.test/x', 'scraped')`,
          [poster],
        ),
      REJECTS.checkViolation,
    )
  })

  it('overwrites a forged source on a client insert', async () => {
    const id = await newOpportunity(poster, { source: 'user_submitted' })
    const rows = await db.asService<{ source: string }>(
      `select source from public.opportunities where id = $1`,
      [id],
    )
    expect(rows[0]!.source).toBe('user_submitted')

    await expectRejection(
      () =>
        db.asUser(poster, `update public.opportunities set source = 'scraped' where id = $1`, [id]),
      /permission denied|cannot be modified/i,
    )
  })

  it('insists a listing says how to apply', async () => {
    await expectRejection(
      () =>
        db.asUser(
          poster,
          `insert into public.opportunities
             (posted_by, title, organisation, description, type)
           values ($1, 'Mystery Role', 'Anon Ltd',
                   'A great opportunity with no way to pursue it.', 'internship')`,
          [poster],
        ),
      REJECTS.checkViolation,
    )
  })

  it('refuses a deadline after the start date', async () => {
    await expectRejection(
      () =>
        newOpportunity(poster, { deadline: '2030-09-01', starts_on: '2030-06-01' }),
      REJECTS.checkViolation,
    )
  })
})

// =============================================================================

describe('who sees an opportunity', () => {
  it('shows a public listing to an anonymous visitor', async () => {
    const id = await newOpportunity(poster)

    const rows = await db.asAnon<{ id: string }>(
      `select id from public.opportunities where id = $1`,
      [id],
    )
    expect(rows.map((r) => r.id)).toEqual([id])
  })

  it('keeps a university listing inside the university', async () => {
    const id = await newOpportunity(poster, { visibility: 'university' })

    expect(await db.asUser(peer, `select id from public.opportunities where id = $1`, [id]))
      .toHaveLength(1)
    expect(await db.asUser(outsider, `select id from public.opportunities where id = $1`, [id]))
      .toEqual([])
    expect(await db.asUser(unaffiliated, `select id from public.opportunities where id = $1`, [id]))
      .toEqual([])
    expect(await db.asAnon(`select id from public.opportunities where id = $1`, [id])).toEqual([])
  })

  it('falls back to the open board when the poster has no university', async () => {
    // A university-scoped listing on a profile with no university would be
    // invisible to everyone, its author included, which reads as data loss.
    const id = await newOpportunity(unaffiliated, { visibility: 'university' })

    const rows = await db.asService<{ visibility: string; university_id: string | null }>(
      `select visibility, university_id from public.opportunities where id = $1`,
      [id],
    )
    expect(rows[0]!.visibility).toBe('public')
    expect(rows[0]!.university_id).toBeNull()

    expect(await db.asAnon(`select id from public.opportunities where id = $1`, [id]))
      .toHaveLength(1)
  })

  it('does not clamp a listing to a private poster profile', async () => {
    // Deliberately different from posts. A student who keeps their own profile
    // private may still want the department to hear about an internship; the
    // listing is about the employer, not about them.
    const shy = await db.createUser({
      username: 'board_shy',
      universityId: uniA,
      visibility: 'private',
    })
    const id = await newOpportunity(shy)

    expect(await db.asAnon(`select id from public.opportunities where id = $1`, [id]))
      .toHaveLength(1)
  })

  it('hides a listing from a blocked user in both directions', async () => {
    const blocker = await db.createUser({ username: 'board_blocker', universityId: uniA })
    const blocked = await db.createUser({ username: 'board_blocked', universityId: uniA })

    const id = await newOpportunity(blocker)
    await db.asUser(
      blocked,
      `insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`,
      [blocked, blocker],
    )

    expect(await db.asUser(blocked, `select id from public.opportunities where id = $1`, [id]))
      .toEqual([])
  })

  it('hides a removed listing from readers but not from its poster or a moderator', async () => {
    const id = await newOpportunity(poster)
    await db.asUser(
      moderator,
      `update public.opportunities set moderation_status = 'removed' where id = $1`,
      [id],
    )

    expect(await db.asUser(peer, `select id from public.opportunities where id = $1`, [id]))
      .toEqual([])
    // The poster keeps sight of it so an appeal is possible.
    expect(await db.asUser(poster, `select id from public.opportunities where id = $1`, [id]))
      .toHaveLength(1)
    expect(await db.asUser(moderator, `select id from public.opportunities where id = $1`, [id]))
      .toHaveLength(1)
  })

  it('does not let a reader edit or delete someone else’s listing', async () => {
    const id = await newOpportunity(poster)

    await db.asUser(peer, `update public.opportunities set title = 'Hijacked' where id = $1`, [id])
    await db.asUser(peer, `delete from public.opportunities where id = $1`, [id])

    const rows = await db.asService<{ title: string }>(
      `select title from public.opportunities where id = $1`,
      [id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).not.toBe('Hijacked')
  })
})

// =============================================================================

describe('saving an opportunity', () => {
  it('counts saves exactly and lets the count fall again', async () => {
    const id = await newOpportunity(poster)

    await db.asUser(
      peer,
      `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
      [id, peer],
    )
    await db.asUser(
      outsider,
      `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
      [id, outsider],
    )

    let rows = await db.asService<{ save_count: number }>(
      `select save_count from public.opportunities where id = $1`,
      [id],
    )
    expect(rows[0]!.save_count).toBe(2)

    await db.asUser(peer, `delete from public.opportunity_saves where opportunity_id = $1`, [id])

    rows = await db.asService<{ save_count: number }>(
      `select save_count from public.opportunities where id = $1`,
      [id],
    )
    expect(rows[0]!.save_count).toBe(1)
  })

  it('hides who saved a listing from the poster', async () => {
    const id = await newOpportunity(poster)
    await db.asUser(
      peer,
      `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
      [id, peer],
    )

    // The count is public; the identities are not. A poster who could read this
    // table would have a list of students considering applying.
    const asPoster = await db.asUser(
      poster,
      `select profile_id from public.opportunity_saves where opportunity_id = $1`,
      [id],
    )
    expect(asPoster).toEqual([])

    const asSaver = await db.asUser(
      peer,
      `select profile_id from public.opportunity_saves where opportunity_id = $1`,
      [id],
    )
    expect(asSaver).toHaveLength(1)
  })

  it('rewrites a forged saver to the caller rather than rejecting it', async () => {
    const id = await newOpportunity(poster)

    // The before-insert trigger overwrites profile_id with auth.uid(), so naming
    // somebody else does not fail -- it just saves the listing for yourself. The
    // forged value is inert, which is the pattern used throughout this schema:
    // a rejection would tell an attacker their guess was well-formed.
    await db.asUser(
      peer,
      `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
      [id, outsider],
    )

    const rows = await db.asService<{ profile_id: string }>(
      `select profile_id from public.opportunity_saves where opportunity_id = $1`,
      [id],
    )
    expect(rows.map((r) => r.profile_id)).toEqual([peer])
  })

  it('refuses a save on a listing the saver cannot see', async () => {
    const hidden = await newOpportunity(poster, { visibility: 'university' })

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.opportunity_saves (opportunity_id, profile_id) values ($1, $2)`,
          [hidden, outsider],
        ),
      /Opportunity not found/i,
    )
  })

  it('keeps a private note private', async () => {
    const id = await newOpportunity(poster)
    await db.asUser(
      peer,
      `insert into public.opportunity_saves (opportunity_id, profile_id, note)
       values ($1, $2, 'ask Dr Weber for a reference')`,
      [id, peer],
    )

    const rows = await db.asUser<{ note: string }>(
      peer,
      `select note from public.opportunity_saves where opportunity_id = $1`,
      [id],
    )
    expect(rows[0]!.note).toBe('ask Dr Weber for a reference')

    expect(
      await db.asUser(poster, `select note from public.opportunity_saves where opportunity_id = $1`, [
        id,
      ]),
    ).toEqual([])
  })
})

// =============================================================================

describe('events', () => {
  it('refuses a time zone Postgres cannot resolve', async () => {
    // An unknown zone would silently render as UTC, so the event would show the
    // wrong hour to everyone including the organiser.
    await expectRejection(
      () => newEvent(poster, { time_zone: 'Europe/Atlantis' }),
      /unknown_time_zone|Unknown time zone/i,
    )

    const ok = await newEvent(poster, { time_zone: 'Europe/Berlin' })
    expect(ok).toBeTruthy()
  })

  it('refuses an end before the start', async () => {
    await expectRejection(
      () =>
        newEvent(poster, {
          starts_at: new Date('2030-06-01T12:00:00Z').toISOString(),
          ends_at: new Date('2030-06-01T09:00:00Z').toISOString(),
        }),
      REJECTS.checkViolation,
    )
  })

  it('insists an online event says where to join', async () => {
    await expectRejection(
      () => newEvent(poster, { attendance_mode: 'online' }),
      REJECTS.checkViolation,
    )

    const ok = await newEvent(poster, {
      attendance_mode: 'online',
      join_url: 'https://meet.example.test/rust',
    })
    expect(ok).toBeTruthy()
  })

  it('clamps an event to the creator’s profile visibility', async () => {
    const shy = await db.createUser({
      username: 'event_shy',
      universityId: uniA,
      visibility: 'connections',
    })
    const id = await newEvent(shy, { visibility: 'public' })

    const rows = await db.asService<{ visibility: string }>(
      `select visibility from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.visibility).toBe('connections')
  })

  it('lets a connection see a connections-only event', async () => {
    const host = await db.createUser({ username: 'event_host_c', universityId: uniA })
    const friend = await db.createUser({ username: 'event_friend_c', universityId: uniA })
    const stranger = await db.createUser({ username: 'event_stranger_c', universityId: uniA })

    const conn = await db.asUser<{ id: string }>(
      host,
      `insert into public.connections (requester_id, addressee_id) values ($1, $2) returning id`,
      [host, friend],
    )
    await db.asUser(friend, `update public.connections set status = 'accepted' where id = $1`, [
      conn[0]!.id,
    ])

    const id = await newEvent(host, { visibility: 'connections' })

    expect(await db.asUser(friend, `select id from public.events where id = $1`, [id]))
      .toHaveLength(1)
    expect(await db.asUser(stranger, `select id from public.events where id = $1`, [id]))
      .toEqual([])
  })
})

// =============================================================================

describe('project events', () => {
  it('refuses an event on a project the creator is not part of', async () => {
    const project = await db.asUser<{ id: string }>(
      poster,
      `insert into public.projects (owner_id, title, slug)
       values ($1, 'Orbit', 'orbit-events') returning id`,
      [poster],
    )

    await expectRejection(
      () => newEvent(peer, { project_id: project[0]!.id }),
      /not a member of that project/i,
    )
  })

  it('does not leak a private project’s schedule', async () => {
    const project = await db.asUser<{ id: string }>(
      poster,
      `insert into public.projects (owner_id, title, slug, visibility)
       values ($1, 'Secret Thesis', 'secret-thesis', 'private') returning id`,
      [poster],
    )
    const member = await db.createUser({ username: 'event_pm', universityId: uniA })
    await db.asUser(
      poster,
      `insert into public.project_members (project_id, profile_id, role) values ($1, $2, 'member')`,
      [project[0]!.id, member],
    )

    // Asking for 'public' cannot widen it past the project.
    const id = await newEvent(poster, { project_id: project[0]!.id, visibility: 'public' })

    const stored = await db.asService<{ visibility: string }>(
      `select visibility from public.events where id = $1`,
      [id],
    )
    expect(stored[0]!.visibility).toBe('private')

    // The team sees its own schedule; nobody else does, and an anonymous visitor
    // must not even learn the event exists.
    expect(await db.asUser(member, `select id from public.events where id = $1`, [id]))
      .toHaveLength(1)
    expect(await db.asUser(peer, `select id from public.events where id = $1`, [id])).toEqual([])
    expect(await db.asAnon(`select id from public.events where id = $1`, [id])).toEqual([])
  })
})

// =============================================================================

describe('RSVPs', () => {
  it('counts going and interested separately and keeps them exact', async () => {
    const id = await newEvent(poster)

    await db.asUser(
      peer,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`,
      [id, peer],
    )
    await db.asUser(
      outsider,
      `insert into public.event_attendees (event_id, profile_id, status)
       values ($1, $2, 'interested')`,
      [id, outsider],
    )

    let rows = await db.asService<{ attendee_count: number; interested_count: number }>(
      `select attendee_count, interested_count from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.attendee_count).toBe(1)
    expect(rows[0]!.interested_count).toBe(1)

    // Switching sides must move both counts, which an increment-per-event
    // implementation gets wrong in at least one of the three transitions.
    await db.asUser(
      peer,
      `update public.event_attendees set status = 'interested' where event_id = $1`,
      [id],
    )

    rows = await db.asService<{ attendee_count: number; interested_count: number }>(
      `select attendee_count, interested_count from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.attendee_count).toBe(0)
    expect(rows[0]!.interested_count).toBe(2)

    await db.asUser(peer, `delete from public.event_attendees where event_id = $1`, [id])

    rows = await db.asService<{ attendee_count: number; interested_count: number }>(
      `select attendee_count, interested_count from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.interested_count).toBe(1)
  })

  it('refuses an RSVP once the event is full', async () => {
    // Enforced under a row lock on the event, so two simultaneous RSVPs cannot
    // both take the last place. This test only covers the sequential path --
    // PGlite is a single connection, so the concurrent case is a code-reading
    // argument (see the note above app.event_attendees_before_write) rather than
    // something asserted here.
    const id = await newEvent(poster, { capacity: 1 })

    await db.asUser(
      peer,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`,
      [id, peer],
    )

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.event_attendees (event_id, profile_id, status)
           values ($1, $2, 'going')`,
          [id, outsider],
        ),
      /event_full|is full/i,
    )

    // 'interested' does not consume a place.
    await db.asUser(
      outsider,
      `insert into public.event_attendees (event_id, profile_id, status)
       values ($1, $2, 'interested')`,
      [id, outsider],
    )
    const rows = await db.asService<{ attendee_count: number }>(
      `select attendee_count from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.attendee_count).toBe(1)
  })

  it('lets an existing attendee re-confirm without consuming a second place', async () => {
    const id = await newEvent(poster, { capacity: 1 })
    await db.asUser(
      peer,
      `insert into public.event_attendees (event_id, profile_id, status) values ($1, $2, 'going')`,
      [id, peer],
    )

    await db.asUser(
      peer,
      `update public.event_attendees set status = 'not_going' where event_id = $1`,
      [id],
    )
    // Back to going: the capacity count excludes this attendee's own row, so the
    // single place is still theirs.
    await db.asUser(peer, `update public.event_attendees set status = 'going' where event_id = $1`, [
      id,
    ])

    const rows = await db.asService<{ attendee_count: number }>(
      `select attendee_count from public.events where id = $1`,
      [id],
    )
    expect(rows[0]!.attendee_count).toBe(1)
  })

  it('refuses an RSVP to a cancelled event', async () => {
    const id = await newEvent(poster)
    await db.asUser(poster, `update public.events set status = 'cancelled' where id = $1`, [id])

    await expectRejection(
      () =>
        db.asUser(
          peer,
          `insert into public.event_attendees (event_id, profile_id, status)
           values ($1, $2, 'going')`,
          [id, peer],
        ),
      /event_cancelled|has been cancelled/i,
    )
  })

  it('refuses an RSVP to an event the user cannot see', async () => {
    // The ID-manipulation case: guessing an event id must not get you onto its
    // attendee list, which would also confirm the event exists.
    const hidden = await newEvent(poster, { visibility: 'university' })

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.event_attendees (event_id, profile_id, status)
           values ($1, $2, 'going')`,
          [hidden, outsider],
        ),
      /Event not found/i,
    )
  })

  it('rewrites a forged attendee to the caller rather than rejecting it', async () => {
    const id = await newEvent(poster)

    // Same pattern as opportunity_saves: you cannot RSVP on somebody else's
    // behalf, and trying puts your own name on the list instead.
    await db.asUser(
      peer,
      `insert into public.event_attendees (event_id, profile_id) values ($1, $2)`,
      [id, outsider],
    )

    const rows = await db.asService<{ profile_id: string }>(
      `select profile_id from public.event_attendees where event_id = $1`,
      [id],
    )
    expect(rows.map((r) => r.profile_id)).toEqual([peer])
  })

  it('lets the organiser remove an attendee but not a bystander', async () => {
    const id = await newEvent(poster)
    await db.asUser(
      peer,
      `insert into public.event_attendees (event_id, profile_id) values ($1, $2)`,
      [id, peer],
    )

    // A bystander's delete matches no row under the policy: a silent no-op.
    await db.asUser(outsider, `delete from public.event_attendees where event_id = $1`, [id])
    expect(
      await db.asService(`select 1 from public.event_attendees where event_id = $1`, [id]),
    ).toHaveLength(1)

    await db.asUser(poster, `delete from public.event_attendees where event_id = $1`, [id])
    expect(
      await db.asService(`select 1 from public.event_attendees where event_id = $1`, [id]),
    ).toEqual([])
  })
})

// =============================================================================

describe('posts anchored to an opportunity', () => {
  it('lets anyone who can see a listing share it', async () => {
    // Unlike a goal or an achievement, sharing an opportunity is not a claim
    // about the sharer, so it is not restricted to the poster.
    const id = await newOpportunity(poster)

    const rows = await db.asUser<{ opportunity_id: string }>(
      peer,
      `insert into public.posts (author_id, type, body, opportunity_id)
       values ($1, 'opportunity', 'Worth a look', $2) returning opportunity_id`,
      [peer, id],
    )
    expect(rows[0]!.opportunity_id).toBe(id)
  })

  it('refuses a post about a listing the author cannot see', async () => {
    const hidden = await newOpportunity(poster, { visibility: 'university' })

    await expectRejection(
      () =>
        db.asUser(
          outsider,
          `insert into public.posts (author_id, type, body, opportunity_id)
           values ($1, 'opportunity', 'Found this somehow', $2)`,
          [outsider, hidden],
        ),
      /Opportunity not found/i,
    )
  })

  it('clamps the post to the listing’s visibility', async () => {
    const scoped = await newOpportunity(poster, { visibility: 'university' })

    const rows = await db.asUser<{ visibility: string }>(
      peer,
      `insert into public.posts (author_id, type, body, opportunity_id, visibility)
       values ($1, 'opportunity', 'For us only', $2, 'public') returning visibility`,
      [peer, scoped],
    )
    expect(rows[0]!.visibility).toBe('university')
  })

  it('nulls the anchor rather than deleting the post when a listing goes away', async () => {
    const id = await newOpportunity(poster)
    const post = await db.asUser<{ id: string }>(
      peer,
      `insert into public.posts (author_id, type, body, opportunity_id)
       values ($1, 'opportunity', 'Applied to this', $2) returning id`,
      [peer, id],
    )

    await db.asUser(poster, `delete from public.opportunities where id = $1`, [id])

    const rows = await db.asService<{ opportunity_id: string | null; body: string }>(
      `select opportunity_id, body from public.posts where id = $1`,
      [post[0]!.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.opportunity_id).toBeNull()
    expect(rows[0]!.body).toBe('Applied to this')
  })
})

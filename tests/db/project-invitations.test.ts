import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './harness'

let db: TestDb
let owner: string
let recipient: string
let other: string
beforeAll(async () => {
  db = await createTestDb()
  owner = await db.createUser({ username: 'inviteowner' })
  recipient = await db.createUser({ username: 'inviterecipient' })
  other = await db.createUser({ username: 'inviteother' })
}, 120_000)
beforeEach(async () => {
  // Isolated synthetic scenario setup, not a production budget reset.
  await db.asService('delete from app.rate_limit_windows')
  await db.asService('delete from public.blocks')
  await db.asService(`update public.profiles set visibility = 'public', allow_connection_requests = true
    where id = any($1::uuid[])`, [[owner, recipient, other]])
})
afterAll(async () => { await db?.close() })

async function project(target: number | null = 3, visibility = 'public') {
  const rows = await db.asUser<{ id: string; slug: string }>(owner, `
    insert into public.projects(title, description, category, visibility, team_size_target)
    values ('Invitation project', 'Private project description must not enter an invitation.', 'web', $1, $2)
    returning id, slug`, [visibility, target])
  return rows[0]!
}
async function invite(projectId: string, invitee = recipient, inviter = owner) {
  const rows = await db.asUser<{ id: string }>(inviter, `
    insert into public.project_invites(project_id, invitee_id, message, proposed_role)
    values ($1, $2, 'Recipient-only note.', 'Design') returning id`, [projectId, invitee])
  return rows[0]!.id
}
async function seedBudget(subject: string, hits: number) {
  await db.asService(`insert into app.rate_limit_windows(bucket, subject, window_start, hits)
    values ('project:write', $1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600), $2)
    on conflict (bucket, subject, window_start) do update set hits = excluded.hits`, [subject, hits])
}
async function idea() {
  const rows = await db.asUser<{ id: string }>(owner, `
    insert into public.ideas(title, description, category, visibility)
    values ('Idea with real outcomes', 'An original description long enough to be useful.', 'web', 'public')
    returning id`)
  return rows[0]!.id
}

describe('0036 project invitation database boundaries', () => {
  it('exposes only the three exact authenticated RPCs and keeps mutation RPCs invoker-bound', async () => {
    const rows = await db.asService<{ proname: string; prosecdef: boolean; anonymous: boolean; authenticated: boolean; service: boolean }>(`
      select p.proname, p.prosecdef,
        has_function_privilege('anon', p.oid, 'execute') as anonymous,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`,
    [['project_invitation_inbox', 'respond_to_project_invite', 'convert_idea_to_project_with_invites']])
    expect(rows).toEqual([
      { proname: 'convert_idea_to_project_with_invites', prosecdef: false, anonymous: false, authenticated: true, service: false },
      { proname: 'project_invitation_inbox', prosecdef: true, anonymous: false, authenticated: true, service: false },
      { proname: 'respond_to_project_invite', prosecdef: false, anonymous: false, authenticated: true, service: false },
    ])
    await expect(db.asAnon('select * from public.project_invitation_inbox()')).rejects.toMatchObject({ code: '42501' })
    await expect(db.asUser(recipient, 'select app.project_invitation_available($1, $2, $3)', [owner, owner, recipient]))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('reveals only an intentional private invitation, not full private content, to its recipient', async () => {
    await db.asUser(owner, `update public.profiles set visibility = 'private' where id = $1`, [owner])
    const p = await project(3, 'private')
    const inviteId = await invite(p.id)
    expect(await db.asUser(recipient, 'select id from public.projects where id = $1', [p.id])).toEqual([])
    const rows = await db.asUser<Record<string, unknown>>(recipient, `
      select * from public.project_invitation_inbox($1, 31, null, null)`, [p.slug])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ invite_id: inviteId, message: 'Recipient-only note.', project_title: 'Invitation project', can_accept: true })
    for (const field of ['description', 'owner_id', 'inviter_id', 'invitee_id']) expect(rows[0]).not.toHaveProperty(field)
    expect(await db.asUser(other, 'select * from public.project_invitation_inbox($1, 31, null, null)', [p.slug])).toEqual([])
    await db.asService(`insert into public.project_members(project_id, profile_id, role) values ($1, $2, 'member')`, [p.id, other])
    expect(await db.asUser(other, 'select id, message from public.project_invites where id = $1', [inviteId])).toEqual([])
  })

  it('recipient acceptance atomically creates a member and bodyless activity, and replay cannot change the answer', async () => {
    const p = await project()
    const inviteId = await invite(p.id)
    const accepted = await db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [inviteId, 'accepted'])
    expect(accepted).toEqual([{ project_id: p.id, project_slug: p.slug, status: 'accepted' }])
    expect(await db.asService('select role from public.project_members where project_id = $1 and profile_id = $2', [p.id, recipient]))
      .toEqual([{ role: 'member' }])
    expect(await db.asService('select member_count from public.projects where id = $1', [p.id])).toEqual([{ member_count: 2 }])
    const activity = await db.asService<{ type: string; body: string | null }>(`
      select type, body from public.notifications where project_id = $1`, [p.id])
    expect(activity.some(row => row.type === 'project_invite_accepted')).toBe(true)
    expect(activity.every(row => row.body === null)).toBe(true)
    await expect(db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [inviteId, 'declined']))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('refuses another account or manager accepting for the recipient', async () => {
    const p = await project()
    const inviteId = await invite(p.id)
    for (const userId of [owner, other]) {
      await expect(db.asUser(userId, 'select * from public.respond_to_project_invite($1, $2)', [inviteId, 'accepted']))
        .rejects.toMatchObject({ code: '42501' })
    }
    expect(await db.asService('select status from public.project_invites where id = $1', [inviteId])).toEqual([{ status: 'pending' }])
  })

  it('permits decline when full without joining, but makes accepted membership capacity authoritative', async () => {
    const p = await project(2)
    const first = await invite(p.id)
    const second = await invite(p.id, other)
    await db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [first, 'accepted'])
    // Serial last-slot regression. Independent hosted concurrency is still required.
    await expect(db.asUser(other, 'select * from public.respond_to_project_invite($1, $2)', [second, 'accepted']))
      .rejects.toMatchObject({ code: '23514' })
    expect(await db.asUser(other, 'select * from public.respond_to_project_invite($1, $2)', [second, 'declined']))
      .toEqual([{ project_id: p.id, project_slug: p.slug, status: 'declined' }])
    expect(await db.asService('select member_count from public.projects where id = $1', [p.id])).toEqual([{ member_count: 2 }])
  })

  it('hides blocked invitation notes and refuses acceptance after a block is added', async () => {
    const p = await project()
    const inviteId = await invite(p.id)
    await db.asService('insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [recipient, owner])
    expect(await db.asUser(recipient, 'select message from public.project_invites where id = $1', [inviteId])).toEqual([])
    expect(await db.asUser(recipient, 'select * from public.project_invitation_inbox($1, 31, null, null)', [p.slug])).toEqual([])
    await expect(db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [inviteId, 'accepted']))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('also refuses direct accepted-status writes when another current member is blocked', async () => {
    const p = await project(3)
    const inviteId = await invite(p.id)
    await db.asService(`insert into public.project_members(project_id, profile_id, role) values ($1, $2, 'member')`, [p.id, other])
    await db.asService('insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [recipient, other])
    await expect(db.asUser(recipient, `update public.project_invites set status = 'accepted' where id = $1`, [inviteId]))
      .rejects.toMatchObject({ code: '42501' })
    expect(await db.asService('select status from public.project_invites where id = $1', [inviteId])).toEqual([{ status: 'pending' }])
  })

  it('rejects an already-member accept and a lost-manager invitation without changing pending outcomes', async () => {
    const p = await project(4)
    const existing = await invite(p.id)
    await db.asUser(owner, `insert into public.project_members(project_id, profile_id, role) values ($1, $2, 'member')`, [p.id, recipient])
    await expect(db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [existing, 'accepted']))
      .rejects.toMatchObject({ code: '23514' })
    await db.asUser(owner, `insert into public.project_members(project_id, profile_id, role) values ($1, $2, 'maintainer')`, [p.id, other])
    const fresh = await db.createUser()
    const stale = await invite(p.id, fresh, other)
    await db.asUser(owner, `update public.project_members set role = 'member' where project_id = $1 and profile_id = $2`, [p.id, other])
    await expect(db.asUser(fresh, 'select * from public.respond_to_project_invite($1, $2)', [stale, 'accepted']))
      .rejects.toMatchObject({ code: '42501' })
    expect(await db.asService('select status from public.project_invites where id = $1', [stale])).toEqual([{ status: 'pending' }])
  })

  it('rolls back status, membership and accepted notification when the recipient budget refuses', async () => {
    const p = await project()
    const inviteId = await invite(p.id)
    await seedBudget(recipient, 30)
    await expect(db.asUser(recipient, 'select * from public.respond_to_project_invite($1, $2)', [inviteId, 'accepted']))
      .rejects.toMatchObject({ code: 'P0001', hint: 'rate_limit_exceeded' })
    expect(await db.asService('select status from public.project_invites where id = $1', [inviteId])).toEqual([{ status: 'pending' }])
    expect(await db.asService('select profile_id from public.project_members where project_id = $1 and profile_id = $2', [p.id, recipient])).toEqual([])
    expect(await db.asService(`select id from public.notifications where project_id = $1 and type = 'project_invite_accepted'`, [p.id])).toEqual([])
  })

  it('creates invitations only for current eligible interest and copies required skills in the conversion transaction', async () => {
    const privatePerson = await db.createUser()
    const declinedPreference = await db.createUser()
    const ideaId = await idea()
    for (const userId of [recipient, other, privatePerson, declinedPreference]) {
      await db.asUser(userId, `insert into public.idea_interest(idea_id, message) values ($1, 'Private interest note, not invitation content.')`, [ideaId])
    }
    const skill = await db.asService<{ id: string }>(`insert into public.skills(name, slug, is_approved) values ('Invite skill', 'invite-skill', true) returning id`)
    await db.asUser(owner, 'insert into public.idea_skills(idea_id, skill_id) values ($1, $2)', [ideaId, skill[0]!.id])
    await db.asService('insert into public.blocks(blocker_id, blocked_id) values ($1, $2)', [owner, other])
    await db.asUser(privatePerson, `update public.profiles set visibility = 'private' where id = $1`, [privatePerson])
    await db.asUser(declinedPreference, `update public.profiles set allow_connection_requests = false where id = $1`, [declinedPreference])
    const rows = await db.asUser<{ project_id: string; invited_count: number }>(owner, 'select * from public.convert_idea_to_project_with_invites($1)', [ideaId])
    expect(rows[0]?.invited_count).toBe(1)
    const projectId = rows[0]!.project_id
    expect(await db.asService('select invitee_id, status from public.project_invites where project_id = $1', [projectId]))
      .toEqual([{ invitee_id: recipient, status: 'pending' }])
    expect(await db.asService('select skill_id, is_required from public.project_skills where project_id = $1', [projectId]))
      .toEqual([{ skill_id: skill[0]!.id, is_required: true }])
    expect(await db.asService('select profile_id from public.project_members where project_id = $1', [projectId])).toEqual([{ profile_id: owner }])
    await expect(db.asUser(owner, 'select public.convert_idea_to_project($1)', [ideaId])).rejects.toMatchObject({ code: '23505' })
  })

  it('keeps a valid conversion but records zero optional invites when only the base budget slot remains', async () => {
    const ideaId = await idea()
    await db.asUser(recipient, 'insert into public.idea_interest(idea_id) values ($1)', [ideaId])
    await seedBudget(owner, 29)
    const rows = await db.asUser<{ project_id: string; invited_count: number }>(owner, 'select * from public.convert_idea_to_project_with_invites($1)', [ideaId])
    expect(rows[0]?.invited_count).toBe(0)
    expect(await db.asService('select status, converted_project_id from public.ideas where id = $1', [ideaId]))
      .toEqual([{ status: 'converted', converted_project_id: rows[0]!.project_id }])
    expect(await db.asService('select id from public.project_invites where project_id = $1', [rows[0]!.project_id])).toEqual([])
  })

  it('rolls back the entire conversion when the base budget is full and rejects non-author conversion', async () => {
    const ideaId = await idea()
    await expect(db.asUser(other, 'select * from public.convert_idea_to_project_with_invites($1)', [ideaId]))
      .rejects.toMatchObject({ code: '42501' })
    await seedBudget(owner, 30)
    await expect(db.asUser(owner, 'select * from public.convert_idea_to_project_with_invites($1)', [ideaId]))
      .rejects.toMatchObject({ code: 'P0001', hint: 'rate_limit_exceeded' })
    expect(await db.asService('select status, converted_project_id from public.ideas where id = $1', [ideaId]))
      .toEqual([{ status: 'open', converted_project_id: null }])
  })
})

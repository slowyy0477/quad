import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({ userId: 'usr_bob' as string | null, cookie: true }))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => name === 'quad_local_session' && auth.userId && auth.cookie
    ? { value: auth.userId.padEnd(43, 'x') } : undefined,
}) }))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => auth.userId ? { id: auth.userId } : null,
  createClient: () => { throw new Error('A local invitation must not call Supabase') },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { readStore, resetLocalCache, type Tables } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { listMyProjectInvitations } from '@/features/projects/invitations'
import { respondToProjectInviteAction } from '@/features/projects/invite-actions'
import { convertIdeaToProjectAction } from '@/features/ideas/actions'

const timestamp = '2026-10-20T00:00:00.000Z'
const clock = Date.parse('2026-10-31T18:15:00.000Z')
let fixture: TempWorkspace | undefined
let dataFile: string
function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}
function profile(name: string, visibility: 'private' | 'public' = 'public') {
  return {
    id: `prf_${name}`, user_id: `usr_${name}`, username: name, display_name: name,
    bio: null, avatar_url: null, university_id: null, department: null, programme: null,
    semester: null, website: null, github: null, visibility, searchable: visibility === 'public',
    allow_connection_requests: true, created_at: timestamp,
  }
}
async function arrange(change: (db: Tables) => void) {
  // Synthetic fixture setup only; never an application maintenance bypass.
  const db = await readStore()
  change(db)
  await fs.writeFile(dataFile, JSON.stringify(db))
}
function spentProjectBudget(db: Tables, userId: string, hits: number) {
  const start = Math.floor(clock / 3_600_000) * 3_600_000
  db.mutation_limit_windows = [{
    id: `project:write:${userId}:${start}`, bucket: 'project:write',
    subject: userId, window_start_ms: start, hits,
  }]
}

beforeEach(async () => {
  fixture = await createTempWorkspace('project-invitations')
  dataFile = path.join(fixture.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', dataFile)
  vi.spyOn(Date, 'now').mockReturnValue(clock)
  auth.userId = 'usr_bob'
  auth.cookie = true
  await fs.writeFile(dataFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: ['owner', 'bob', 'carol'].map(name => ({
      id: `usr_${name}`, email: `${name}@example.test`, password_hash: '', created_at: timestamp,
    })),
    profiles: [profile('owner', 'private'), profile('bob'), profile('carol')],
    sessions: ['owner', 'bob', 'carol'].map(name => ({
      id: `ses_${name}`, user_id: `usr_${name}`,
      token_hash: createHash('sha256').update(`usr_${name}`.padEnd(43, 'x')).digest('hex'),
      created_at: timestamp, expires_at: '2099-01-01T00:00:00.000Z',
    })),
    projects: [{
      id: 'prj_private', owner_id: 'prf_owner', slug: 'private-project', title: 'Private project',
      purpose: '', description: 'Do not disclose this private project description.',
      category: 'web', status: 'planning', visibility: 'private', is_seeking_members: false,
      team_size_target: 2, member_count: 1, created_at: timestamp, deleted_at: null,
    }],
    project_members: [{ id: 'mem_owner', project_id: 'prj_private', profile_id: 'prf_owner', role: 'owner', created_at: timestamp }],
    project_invites: [{
      id: 'pin_bob', project_id: 'prj_private', invitee_id: 'prf_bob', inviter_id: 'prf_owner',
      message: 'A note only for Bob.', proposed_role: 'Design', status: 'pending',
      responded_at: null, created_at: timestamp, updated_at: timestamp,
    }],
  }))
  resetLocalCache()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const owned = fixture
  fixture = undefined
  await owned?.cleanup()
})

describe('recipient-bound local project invitations', () => {
  it('projects a private invitation only to its recipient, not a manager, outsider or signed-out reader', async () => {
    const result = await listMyProjectInvitations()
    expect(result.invitations).toHaveLength(1)
    expect(result.invitations[0]).toMatchObject({ id: 'pin_bob', projectTitle: 'Private project', message: 'A note only for Bob.' })
    expect(JSON.stringify(result)).not.toMatch(/description|prf_owner|invitee_id|inviter_id|password_hash/)
    for (const userId of ['usr_owner', 'usr_carol', null]) {
      auth.userId = userId
      expect((await listMyProjectInvitations()).invitations).toEqual([])
    }
  })

  it('ignores posted identity/project/time/role and atomically records member, response, notifications and one budget hit', async () => {
    const result = await respondToProjectInviteAction({ status: 'idle' }, form({
      inviteId: 'pin_bob', response: 'accepted', inviteeId: 'prf_carol',
      userId: 'usr_owner', projectId: 'prj_forged', role: 'owner', respondedAt: '2099-01-01',
    }))
    expect(result).toMatchObject({ status: 'success', response: 'accepted', projectPath: '/projects/private-project' })
    const db = await readStore()
    expect(db.project_invites[0]).toMatchObject({ status: 'accepted', invitee_id: 'prf_bob', inviter_id: 'prf_owner' })
    expect(db.project_invites[0]?.responded_at).not.toBe('2099-01-01')
    expect(db.project_members.filter(row => row.profile_id === 'prf_bob')).toMatchObject([{ project_id: 'prj_private', role: 'member' }])
    expect(db.projects[0]?.member_count).toBe(2)
    expect(db.notifications.map(row => row.type).sort()).toEqual(['project_invite_accepted', 'project_member_joined'])
    expect(db.notifications.every(row => row.body === null)).toBe(true)
    expect(db.mutation_limit_windows).toMatchObject([{ subject: 'usr_bob', bucket: 'project:write', hits: 1 }])
  })

  it('refuses a forged recipient from another verified account without changing state', async () => {
    auth.userId = 'usr_carol'
    const before = await readStore()
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({
      inviteId: 'pin_bob', response: 'accepted', inviteeId: 'prf_bob',
    }))).status).toBe('error')
    expect(await readStore()).toEqual(before)
  })

  it('requires the actual locked snapshot session even when an earlier getUser returned an identity', async () => {
    auth.cookie = false
    const before = await readStore()
    await expect(respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' })))
      .rejects.toThrow(/verified session/)
    expect(await readStore()).toEqual(before)
  })

  it('allows decline when full and never creates membership or copies the private note into activity', async () => {
    await arrange(db => { db.projects[0]!.team_size_target = 1 })
    expect((await listMyProjectInvitations()).invitations[0]).toMatchObject({ canAccept: false, refusalReason: 'full' })
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' }))).status).toBe('error')
    expect((await readStore()).project_invites[0]?.status).toBe('pending')
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'declined' }))).response).toBe('declined')
    const db = await readStore()
    expect(db.project_members).toHaveLength(1)
    expect(db.notifications).toMatchObject([{ type: 'project_invite_declined', body: null, recipient_id: 'prf_owner' }])
  })

  it.each(['block', 'disabled', 'deleted-project', 'moderated', 'lost-manager'] as const)('rechecks %s before responding', async condition => {
    await arrange(db => {
      if (condition === 'block') db.blocks.push({ id: 'blk_ownerbob', blocker_id: 'prf_owner', blocked_id: 'prf_bob', reason: null, created_at: timestamp })
      if (condition === 'disabled') db.users[0]!.disabled_at = timestamp
      if (condition === 'deleted-project') db.projects[0]!.deleted_at = timestamp
      if (condition === 'moderated') db.content_moderation.push({ id: 'mod_project', kind: 'project', target_id: 'prj_private', status: 'hidden' })
      if (condition === 'lost-manager') {
        db.project_invites[0]!.inviter_id = 'prf_carol'
      }
    })
    const before = await readStore()
    expect((await listMyProjectInvitations()).invitations).toEqual([])
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' }))).status).toBe('error')
    expect(await readStore()).toEqual(before)
  })

  it('does not accept a block with another current team member, but permits declining', async () => {
    await arrange(db => {
      db.projects[0]!.team_size_target = null
      db.project_members.push({ id: 'mem_carol', project_id: 'prj_private', profile_id: 'prf_carol', role: 'member', created_at: timestamp })
      db.blocks.push({ id: 'blk_bobcarol', blocker_id: 'prf_bob', blocked_id: 'prf_carol', reason: null, created_at: timestamp })
    })
    expect((await listMyProjectInvitations()).invitations[0]?.canAccept).toBe(false)
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' }))).status).toBe('error')
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'declined' }))).status).toBe('success')
  })

  it('records only one outcome for simultaneous same-invite submissions and refuses replay', async () => {
    const responses = await Promise.all([1, 2].map(() =>
      respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' }))))
    expect(responses.map(row => row.status).sort()).toEqual(['error', 'success'])
    const before = await readStore()
    expect(before.project_members).toHaveLength(2)
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'declined' }))).status).toBe('error')
    expect(await readStore()).toEqual(before)
  })

  it('rolls back the complete acceptance when its mandatory project budget is exhausted', async () => {
    await arrange(db => spentProjectBudget(db, 'usr_bob', 30))
    const before = await readStore()
    expect((await respondToProjectInviteAction({ status: 'idle' }, form({ inviteId: 'pin_bob', response: 'accepted' }))).message).toMatch(/Nothing from this attempt was saved/)
    expect(await readStore()).toEqual(before)
  })
})

async function arrangeIdea() {
  auth.userId = 'usr_owner'
  await arrange(db => {
    db.ideas.push({
      id: 'dea_convert', author_id: 'prf_owner', title: 'An idea becomes work', description: 'Original idea description.',
      category: 'web', status: 'open', visibility: 'public', upvote_count: 0, interest_count: 2,
      converted_project_id: null, created_at: timestamp, deleted_at: null,
    })
    db.idea_interest.push(...['bob', 'carol'].map(name => ({
      id: `int_${name}`, idea_id: 'dea_convert', profile_id: `prf_${name}`,
      message: `Private interest note from ${name}.`, offering: 'Private offer.', created_at: timestamp,
    })))
    db.profiles.find(row => row.id === 'prf_carol')!.visibility = 'private'
    db.skills.push({ id: 'skl_web', name: 'Web', slug: 'web', category: 'technical', is_approved: true, usage_count: 0, created_by: null, created_at: timestamp })
    db.idea_skills.push({ id: 'isk_web', idea_id: 'dea_convert', skill_id: 'skl_web', created_at: timestamp })
  })
}

describe('atomic local idea conversion and eligible invitations', () => {
  it('copies required skills, preserves private ownership and invites only eligible interests without enrolling anyone', async () => {
    await arrangeIdea()
    await expect(convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId: 'dea_convert' }))).rejects.toThrow(/converted=1&invited=1/)
    const db = await readStore()
    const projectId = db.ideas[0]!.converted_project_id
    expect(db.projects.find(row => row.id === projectId)).toMatchObject({ visibility: 'private', member_count: 1 })
    expect(db.project_skills.filter(row => row.project_id === projectId)).toMatchObject([{ skill_id: 'skl_web', is_required: true }])
    expect(db.project_invites.filter(row => row.project_id === projectId)).toMatchObject([{ invitee_id: 'prf_bob', status: 'pending' }])
    expect(db.project_members.filter(row => row.project_id === projectId)).toMatchObject([{ profile_id: 'prf_owner', role: 'owner' }])
    expect(JSON.stringify(db.notifications)).not.toContain('Private interest note')
    expect(db.profiles[0]?.visibility).toBe('private')
  })

  it('commits a valid conversion with zero optional invitations when only its base project slot remains', async () => {
    await arrangeIdea()
    await arrange(db => spentProjectBudget(db, 'usr_owner', 29))
    await expect(convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId: 'dea_convert' }))).rejects.toThrow(/invited=0/)
    const db = await readStore()
    expect(db.ideas[0]?.status).toBe('converted')
    expect(db.project_invites.filter(row => row.project_id === db.ideas[0]?.converted_project_id)).toEqual([])
    expect(db.mutation_limit_windows.find(row => row.subject === 'usr_owner' && row.bucket === 'project:write')?.hits).toBe(30)
  })

  it('does not create a project, skills, invitations or a converted marker when the base conversion is refused', async () => {
    await arrangeIdea()
    await arrange(db => spentProjectBudget(db, 'usr_owner', 30))
    const before = await readStore()
    expect((await convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId: 'dea_convert' }))).status).toBe('error')
    expect(await readStore()).toEqual(before)
  })
})

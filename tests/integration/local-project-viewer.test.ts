import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'quad_local_session' && auth.token
      ? { value: auth.token } : undefined,
  }),
}))
vi.mock('@/lib/supabase/server', async () => {
  const { getLocalUser } = await import('@/lib/local/session')
  return {
    getUser: getLocalUser,
    createClient: () => { throw new Error('A local project viewer read reached Supabase.') },
  }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`) },
}))

import { mutate, readStore, resetLocalCache } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { getProjectViewerState } from '@/features/projects/queries'
import { requestToJoinAction, withdrawApplicationAction } from '@/features/projects/actions'

const timestamp = '2026-10-20T00:00:00.000Z'
const denied = {
  userId: null, canManage: false, isMember: false, role: null,
  hasPendingApplication: false, hasPendingInvite: false,
}
let fixture: TempWorkspace | undefined
let fixtureFile: string
let aliceToken: string
let bobToken: string

function applicationForm() {
  const form = new FormData()
  form.set('projectId', 'prj_team')
  form.set('slug', 'team')
  form.set('message', 'Synthetic application note')
  form.set('desiredRole', 'Frontend')
  return form
}

beforeEach(async () => {
  fixture = await createTempWorkspace('project-viewer')
  fixtureFile = path.join(fixture.directory, 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_PATH', fixtureFile)
  vi.stubEnv('LOCAL_DATA_FILE', fixtureFile)
  vi.stubEnv('LOCAL_DATA_DIR', fixture.directory)
  aliceToken = randomBytes(32).toString('base64url')
  bobToken = randomBytes(32).toString('base64url')
  await fs.writeFile(fixtureFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    users: ['alice', 'bob'].map(name => ({
      id: `usr_${name}`, email: `${name}@synthetic.example.test`,
      password_hash: '', created_at: timestamp,
    })),
    profiles: ['alice', 'bob'].map(name => ({
      id: `prf_${name}`, user_id: `usr_${name}`, username: name,
      display_name: name, bio: null, avatar_url: null, university_id: null,
      department: null, programme: null, semester: null, website: null,
      github: null, visibility: 'public', searchable: true,
      onboarding_completed: true, created_at: timestamp,
    })),
    sessions: ['alice', 'bob'].map((name, index) => ({
      id: `ses_${name}`, user_id: `usr_${name}`,
      token_hash: createHash('sha256').update(index ? bobToken : aliceToken).digest('hex'),
      created_at: timestamp, expires_at: '2099-01-01T00:00:00.000Z',
    })),
    projects: [{
      id: 'prj_team', owner_id: 'prf_bob', slug: 'team', title: 'Team',
      purpose: 'Build', description: null, category: 'other', status: 'active',
      visibility: 'public', is_seeking_members: true, team_size_target: 3,
      member_count: 1, created_at: timestamp, deleted_at: null,
    }],
    project_members: [{
      id: 'mem_owner', project_id: 'prj_team', profile_id: 'prf_bob',
      role: 'owner', created_at: timestamp,
    }],
  }), { mode: 0o600 })
  resetLocalCache()
  auth.token = aliceToken
})

afterEach(async () => {
  auth.token = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('local project viewer state from the verified session', () => {
  it('keeps an accepted application visible after a fresh store read, then clears it after withdrawal', async () => {
    expect((await requestToJoinAction({ status: 'idle' }, applicationForm())).status).toBe('success')
    resetLocalCache()
    expect(await getProjectViewerState('prj_team')).toEqual({
      userId: 'usr_alice', canManage: false, isMember: false, role: null,
      hasPendingApplication: true, hasPendingInvite: false,
    })
    expect((await readStore()).project_applications[0]).toMatchObject({
      applicant_id: 'prf_alice', status: 'pending',
    })
    expect((await withdrawApplicationAction({ status: 'idle' }, applicationForm())).status).toBe('success')
    resetLocalCache()
    expect((await getProjectViewerState('prj_team')).hasPendingApplication).toBe(false)
  })

  it('does not mistake another account’s application or invitation for the reader’s', async () => {
    await mutate(db => {
      db.project_applications.push({
        id: 'app_bob', project_id: 'prj_team', applicant_id: 'prf_bob',
        message: null, desired_role: null, status: 'pending', reviewed_by: null,
        reviewed_at: null, created_at: timestamp,
      })
      db.project_invites.push({
        id: 'pin_bob', project_id: 'prj_team', invitee_id: 'prf_bob',
        inviter_id: 'prf_bob', message: null, proposed_role: null,
        status: 'pending', responded_at: null, created_at: timestamp, updated_at: timestamp,
      })
    })
    expect(await getProjectViewerState('prj_team')).toMatchObject({
      hasPendingApplication: false, hasPendingInvite: false,
    })
  })

  it('reports only pending own outcomes, not already answered rows', async () => {
    await mutate(db => {
      db.project_applications.push({
        id: 'app_alice', project_id: 'prj_team', applicant_id: 'prf_alice',
        message: null, desired_role: null, status: 'rejected', reviewed_by: 'prf_bob',
        reviewed_at: timestamp, created_at: timestamp,
      })
      db.project_invites.push({
        id: 'pin_alice', project_id: 'prj_team', invitee_id: 'prf_alice',
        inviter_id: 'prf_bob', message: null, proposed_role: null,
        status: 'pending', responded_at: null, created_at: timestamp, updated_at: timestamp,
      })
    })
    expect(await getProjectViewerState('prj_team')).toMatchObject({
      hasPendingApplication: false, hasPendingInvite: true,
    })
    await mutate(db => { db.project_invites[0].status = 'declined' })
    expect((await getProjectViewerState('prj_team')).hasPendingInvite).toBe(false)
  })

  it('derives management from the own membership and does not elevate a plain member', async () => {
    auth.token = bobToken
    expect(await getProjectViewerState('prj_team')).toMatchObject({
      userId: 'usr_bob', canManage: true, isMember: true, role: 'owner',
    })
    auth.token = aliceToken
    await mutate(db => {
      db.project_members.push({
        id: 'mem_alice', project_id: 'prj_team', profile_id: 'prf_alice',
        role: 'member', created_at: timestamp,
      })
    })
    expect(await getProjectViewerState('prj_team')).toMatchObject({
      canManage: false, isMember: true, role: 'member',
    })
  })

  it('denies unknown sessions, signed-out reads and unavailable accounts', async () => {
    for (const token of [undefined, randomBytes(32).toString('base64url')]) {
      auth.token = token
      expect(await getProjectViewerState('prj_team')).toEqual(denied)
    }
    auth.token = aliceToken
    await mutate(db => { db.users.find(row => row.id === 'usr_alice')!.disabled_at = timestamp })
    expect(await getProjectViewerState('prj_team')).toEqual(denied)
  })

  it('does not disclose pending state or roles on missing, private, hidden or blocked projects', async () => {
    expect(await getProjectViewerState('prj_missing')).toEqual(denied)
    await mutate(db => { db.projects[0].visibility = 'private' })
    expect(await getProjectViewerState('prj_team')).toEqual(denied)
    await mutate(db => {
      db.projects[0].visibility = 'public'
      db.content_moderation.push({
        id: 'mod_project', kind: 'project', target_id: 'prj_team',
        status: 'hidden',
      })
    })
    expect(await getProjectViewerState('prj_team')).toEqual(denied)
    await mutate(db => {
      db.content_moderation = []
      db.blocks.push({
        id: 'blk_owner', blocker_id: 'prf_bob', blocked_id: 'prf_alice',
        reason: null, created_at: timestamp,
      })
    })
    expect(await getProjectViewerState('prj_team')).toEqual(denied)
  })
})

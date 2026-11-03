import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const auth = vi.hoisted(() => ({ userId: 'usr_alice' as string | null }))
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'quad_local_session' && auth.userId
      ? { value: auth.userId.padEnd(43, 'x') } : undefined,
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: async () => auth.userId ? { id: auth.userId } : null,
  createClient: () => { throw new Error('Local domain reached Supabase') },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { readStore, resetLocalCache } from '@/lib/local/db'
import { EMPTY_DOMAIN_TABLES } from '@/lib/local/domain-tables'
import { setFollowAction, sendConnectionRequestAction, acceptConnectionAction, blockAction, unblockAction } from '@/features/connections/actions'
import { getProfileByUsername } from '@/features/profiles/queries'
import { getFeedPosts, getPostDetail, getSavedPosts } from '@/features/feed/queries'
import { mutate } from '@/lib/local/db'
import { proposeSkillAction, attachSkillAction, updateProfileSkillAction, removeSkillAction, proposeInterestAction, removeInterestAction } from '@/features/skills/actions'
import { listProfileSkills, listProfileInterests, listSkillCatalogue } from '@/features/skills/queries'
import { toggleStarAction, requestToJoinAction, reviewApplicationAction, postUpdateAction } from '@/features/projects/actions'
import { hasStarred, listPendingApplications, getProjectBySlug, listProjectUpdates } from '@/features/projects/queries'
import { voteIdeaAction, expressInterestAction, withdrawInterestAction } from '@/features/ideas/actions'
import { getIdeaById, listIdeaInterests, getIdeaViewerState } from '@/features/ideas/queries'
import { sendMessageAction, setConversationMutedAction } from '@/features/messages/actions'
import { getConversationPane, listThreadMessages, getTotalUnreadMessages, getMessagingPermission } from '@/features/messages/queries'
import { submitReportAction, decideReportAction } from '@/features/moderation/actions'
import { getOpenReports, getModerationActions } from '@/features/moderation/queries'
import { getViewerConnection, listConnections, listRequests, listFollows, listBlocked, listUniversitySuggestions } from '@/features/connections/queries'
import { searchAll } from '@/features/search/queries'
import { getPostComments, getCommentReplies, listUniversityPeers } from '@/features/feed/queries'
import { submitBugReportAction, triageBugReportAction } from '@/features/bugs/actions'
import { getOwnBugReports, getBugReports, countOpenBugReports } from '@/features/bugs/queries'
import { requestUniversityAction, claimUniversityAction, leaveUniversityAction } from '@/features/universities/actions'
import { listMyPendingSubmissions, getMyUniversityId, searchUniversities } from '@/features/universities/queries'
import { reviewUniversityAction } from '@/features/moderation/actions'
import { getPendingUniversities } from '@/features/moderation/queries'
import { listConversations } from '@/features/messages/queries'
import { listMyAchievements } from '@/features/learning/queries'
import { closeIdeaAction, convertIdeaToProjectAction } from '@/features/ideas/actions'
import { changeMemberRoleAction, saveSeekingAction } from '@/features/projects/actions'
import { listProjectSkillsWithFilled } from '@/features/projects/queries'
import { listOpenProjects, listProjectMembers } from '@/features/projects/queries'
import { getEventBySlug, canViewEvent } from '@/features/events/queries'
import { getOpportunityBySlug, canViewOpportunity } from '@/features/opportunities/queries'
import { getNotifications, getTargetIndex, getUnreadNotificationCount } from '@/features/notifications/queries'
import { markOneReadAction } from '@/features/notifications/actions'
import { getStaffRole } from '@/features/admin/queries'
import { updatePrivacyAction } from '@/features/settings/actions'
import { getOwnSettings } from '@/features/settings/queries'

let fixture: TempWorkspace | undefined
let fixtureDir: string
const timestamp = '2026-10-20T00:00:00.000Z'
function profile(name: string, visibility = 'public') {
  return { id: `prf_${name}`, user_id: `usr_${name}`, username: name, display_name: name,
    bio: null, avatar_url: null, university_id: 'uni_one', department: null, programme: null,
    semester: null, website: null, github: null, visibility, searchable: true, created_at: timestamp }
}
export function form(values: Record<string, string>): FormData {
  const result = new FormData()
  for (const [key, value] of Object.entries(values)) result.set(key, value)
  return result
}
beforeEach(async () => {
  fixture = undefined
  fixture = await createTempWorkspace('domain')
  fixtureDir = fixture.directory
  const dataFile = path.join(fixtureDir, 'data', 'local.json')
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'local')
  vi.stubEnv('LOCAL_DATA_DIR', fixtureDir)
  vi.stubEnv('LOCAL_DATA_FILE', dataFile)
  vi.stubEnv('LOCAL_DATA_PATH', dataFile)
  vi.spyOn(process, 'cwd').mockReturnValue(fixtureDir)
  await fs.mkdir(path.join(fixtureDir, 'data'), { recursive: true })
  await fs.writeFile(dataFile, JSON.stringify({
    ...structuredClone(EMPTY_DOMAIN_TABLES),
    profiles: [profile('alice'), profile('bob'), profile('carol')],
    users: ['alice', 'bob', 'carol'].map(name => ({ id: `usr_${name}`, email: `${name}@example.test`, password_hash: '', created_at: timestamp })),
    sessions: ['alice', 'bob', 'carol'].map(name => ({
      id: `ses_${name}`, user_id: `usr_${name}`,
      token_hash: createHash('sha256').update(`usr_${name}`.padEnd(43, 'x')).digest('hex'),
      created_at: timestamp, expires_at: '2099-01-01T00:00:00.000Z',
    })),
  }))
  resetLocalCache()
  auth.userId = 'usr_alice'
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetLocalCache()
  const ownedFixture = fixture
  fixture = undefined
  await ownedFixture?.cleanup()
})

describe('local domain real actions', () => {
  it('paginates only the reader’s currently readable saved posts without repeating boundaries', async () => {
    await mutate(db => {
      for (let index = 0; index < 5; index++) {
        const key = String(index)
        db.posts.push({
          id: `pst_saved${key}`, author_id: 'prf_bob', body: `Saved fixture ${key}`,
          visibility: index === 0 ? 'private' : 'public', project_id: null, goal_id: null,
          moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp,
          deleted_at: null,
        })
        db.post_saves.push({ id: `sav_saved${key}`, post_id: `pst_saved${key}`, profile_id: 'prf_alice', created_at: timestamp })
      }
      db.post_saves.push({ id: 'sav_bob', post_id: 'pst_saved4', profile_id: 'prf_bob', created_at: timestamp })
    })
    const first = await getSavedPosts({ limit: 2 })
    expect(first.posts?.map(row => row.id)).toEqual(['pst_saved4', 'pst_saved3'])
    expect(first.posts?.every(row => row.viewer_has_saved)).toBe(true)
    expect(first.nextCursor).toBeTruthy()
    const second = await getSavedPosts({ limit: 2, cursor: first.nextCursor! })
    expect(second.posts?.map(row => row.id)).toEqual(['pst_saved2', 'pst_saved1'])
    expect(second.nextCursor).toBeNull()
    await mutate(db => db.blocks.push({ id: 'blk_saved', blocker_id: 'prf_bob', blocked_id: 'prf_alice', reason: null, created_at: timestamp }))
    expect((await getSavedPosts()).posts).toEqual([])
    auth.userId = 'usr_carol'
    expect((await getSavedPosts({ cursor: first.nextCursor! })).posts).toEqual([])
    auth.userId = null
    expect((await getSavedPosts()).posts).toEqual([])
  })

  it('does not leak private notification actors or targets and only marks the recipient row', async () => {
    await mutate(db => {
      db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'private'
      db.posts.push({ id: 'pst_alice', author_id: 'prf_alice', body: 'Public post', visibility: 'public', project_id: null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
      db.projects.push({ id: 'prj_bob', owner_id: 'prf_bob', slug: 'private-slug', title: 'Project', purpose: 'Build', description: null, category: 'other', status: 'active', visibility: 'private', is_seeking_members: false, team_size_target: 3, member_count: 1, created_at: timestamp, deleted_at: null })
      db.notifications.push({ id: 'ntf_alice', recipient_id: 'prf_alice', actor_id: 'prf_bob', type: 'follow', body: 'Follow notification', is_read: false, created_at: timestamp, post_id: 'pst_alice', comment_id: null, project_id: 'prj_bob', idea_id: null, event_id: null, opportunity_id: null, conversation_id: null })
    })
    const rows = (await getNotifications()).notifications!
    expect(rows[0].actor).toBeNull()
    expect((await getTargetIndex(rows)).index.projects.size).toBe(0)
    expect((await getTargetIndex(rows)).index.posts.size).toBe(1)
    auth.userId = 'usr_carol'; await markOneReadAction(form({ id: 'ntf_alice' }))
    expect((await readStore()).notifications[0].is_read).toBe(false)
    auth.userId = 'usr_alice'; await markOneReadAction(form({ id: 'ntf_alice' }))
    expect((await readStore()).notifications[0].is_read).toBe(true)
    await mutate(db => { db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'public'; db.notifications[0].is_read = false })
    expect((await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob' }))).status).toBe('success')
    expect((await getNotifications()).notifications).toHaveLength(0)
    expect(await getUnreadNotificationCount()).toBe(0)
  })
  it('keeps staff and privacy settings session-scoped and rejects disabled accounts', async () => {
    await mutate(db => { db.user_roles.push({ id: 'rol_admin', user_id: 'usr_alice', role: 'admin', created_at: timestamp }); db.users.find(row => row.id === 'usr_alice')!.disabled_at = timestamp })
    expect(await getStaffRole()).toBeNull()
    expect((await getOwnSettings()).profile).toBeNull()
    const privacy = form({ visibility: 'private', allow_messages_from: 'nobody', profileId: 'prf_bob' })
    expect((await updatePrivacyAction({ status: 'idle' }, privacy)).status).toBe('error')
    await mutate(db => { db.users.find(row => row.id === 'usr_alice')!.disabled_at = null })
    expect((await updatePrivacyAction({ status: 'idle' }, privacy)).status).toBe('saved')
    expect((await getOwnSettings()).profile?.visibility).toBe('private')
    expect((await readStore()).profiles.find(row => row.id === 'prf_bob')?.visibility).toBe('public')
  })
  it('applies blocks, private embeds and deletion checks to events and opportunities too', async () => {
    await mutate(db => {
      db.events.push({ id: 'evt_bob', created_by: 'prf_bob', title: 'needle event', description: 'description', location: null, starts_at: '2026-11-20T00:00:00.000Z', ends_at: null, timezone: 'Asia/Karachi', capacity: null, attendee_count: 0, visibility: 'public', status: 'scheduled', created_at: timestamp, deleted_at: null })
      db.opportunities.push({ id: 'opp_bob', posted_by: 'prf_bob', title: 'needle opportunity', organisation: 'Team', description: 'description', type: 'internship', work_mode: 'remote', visibility: 'public', compensation: null, location: null, apply_url: null, apply_email: null, deadline: null, starts_on: null, status: 'open', created_at: timestamp, deleted_at: null })
      db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'private'
    })
    expect((await getEventBySlug('needle-event'))?.host).toBeNull()
    expect((await getOpportunityBySlug('needle-opportunity'))?.poster).toBeNull()
    await mutate(db => { db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'public' })
    await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob' }))
    expect(await getEventBySlug('needle-event')).toBeNull()
    expect(await getOpportunityBySlug('needle-opportunity')).toBeNull()
    for (const kind of ['event','opportunity'] as const) expect((await searchAll({ query: 'needle', kind })).results).toHaveLength(0)
    await mutate(db => { db.events[0].deleted_at = timestamp; db.opportunities[0].deleted_at = timestamp })
    const db = await readStore(); const owner = db.profiles.find(row => row.id === 'prf_bob')!
    expect(canViewEvent(db, db.events[0], owner)).toBe(false)
    expect(canViewOpportunity(db, db.opportunities[0], owner)).toBe(false)
  })
  it('keeps private profile embeds out of public project/idea reads and uses real star/skill rows', async () => {
    await mutate(db => {
      db.profiles.find(row => row.id === 'prf_bob')!.visibility = 'private'
      db.projects.push({ id: 'prj_one', owner_id: 'prf_bob', slug: 'one', title: 'Project', purpose: 'Build', description: null, category: 'other', status: 'active', visibility: 'public', is_seeking_members: true, team_size_target: 3, member_count: 1, created_at: timestamp, deleted_at: null })
      db.project_members.push({ id: 'mem_bob', project_id: 'prj_one', profile_id: 'prf_bob', role: 'owner', created_at: timestamp })
      db.ideas.push({ id: 'ida_one', author_id: 'prf_bob', title: 'Idea', description: 'description', category: 'other', status: 'open', visibility: 'public', upvote_count: 0, interest_count: 0, converted_project_id: null, created_at: timestamp, deleted_at: null })
      db.skills.push({ id: 'skl_code', name: 'Coding', slug: 'coding', category: 'other', is_approved: true, usage_count: 0, created_by: null, created_at: timestamp })
      db.project_skills.push({ id: 'psk_code', project_id: 'prj_one', skill_id: 'skl_code', is_required: true, created_at: timestamp })
    })
    expect((await getProjectBySlug('one'))?.owner).toBeNull()
    expect((await listProjectMembers('prj_one'))[0].profile).toBeNull()
    expect((await getIdeaById('ida_one'))?.author).toBeNull()
    await toggleStarAction({ status: 'idle' }, form({ projectId: 'prj_one', slug: 'one', starred: 'false' }))
    expect((await getProjectBySlug('one'))?.star_count).toBe(1)
    expect((await listOpenProjects({ skillId: 'skl_code' })).projects).toHaveLength(1)
  })
  it('rejects hidden-content management and persists authorized project skill requirements', async () => {
    await mutate(db => {
      db.ideas.push({ id: 'ida_one', author_id: 'prf_alice', title: 'Hidden idea', description: 'description', category: 'other', status: 'open', visibility: 'public', upvote_count: 0, interest_count: 0, converted_project_id: null, created_at: timestamp, deleted_at: null })
      db.content_moderation.push({ id: 'mod_one', kind: 'idea', target_id: 'ida_one', status: 'hidden' })
      db.projects.push({ id: 'prj_one', owner_id: 'prf_alice', slug: 'one', title: 'Project', purpose: 'Build', description: null, category: 'other', status: 'active', visibility: 'public', is_seeking_members: true, team_size_target: 3, member_count: 1, created_at: timestamp, deleted_at: null })
      db.project_members.push({ id: 'mem_bob', project_id: 'prj_one', profile_id: 'prf_bob', role: 'member', created_at: timestamp })
      db.skills.push({ id: 'skl_code', name: 'Coding', slug: 'coding', category: 'other', is_approved: true, usage_count: 0, created_by: null, created_at: timestamp })
    })
    expect((await closeIdeaAction({ status: 'idle' }, form({ ideaId: 'ida_one' }))).status).toBe('error')
    expect((await convertIdeaToProjectAction({ status: 'idle' }, form({ ideaId: 'ida_one' }))).status).toBe('error')
    expect((await changeMemberRoleAction({ status: 'idle' }, form({ projectId: 'prj_one', profileId: 'prf_bob', slug: 'wrong-slug', role: 'maintainer' }))).status).toBe('error')
    expect((await saveSeekingAction({ status: 'idle' }, form({ slug: 'one', isSeekingMembers: 'true', teamSizeTarget: '3', lookingFor: 'A teammate', skillIds: 'skl_code' }))).status).toBe('success')
    expect((await listProjectSkillsWithFilled('prj_one')).all.map(row => row.skill_id)).toEqual(['skl_code'])
    auth.userId = 'usr_carol'
    expect((await saveSeekingAction({ status: 'idle' }, form({ slug: 'one', isSeekingMembers: 'true', skillIds: 'skl_code' }))).status).toBe('error')
  })
  it('awards a connection achievement only from accepted relationships and keeps awards session-scoped', async () => {
    expect((await listMyAchievements()).achievements).toEqual([])
    await sendConnectionRequestAction({ status: 'idle' }, form({ profileId: 'prf_bob' }))
    expect((await listMyAchievements()).achievements).toEqual([])
    auth.userId = 'usr_bob'
    await acceptConnectionAction({ status: 'idle' }, form({ connectionId: (await readStore()).connections[0].id }))
    expect((await listMyAchievements()).achievements?.some(row => row.key === 'first_connection')).toBe(true)
    expect((await readStore()).profile_achievements.some(row => row.profile_id === 'prf_bob')).toBe(true)
    await listMyAchievements()
    expect((await readStore()).profile_achievements.filter(row => row.profile_id === 'prf_bob' && row.achievement_key === 'first_connection')).toHaveLength(1)
    auth.userId = 'usr_carol'
    expect((await listMyAchievements()).achievements).toEqual([])
  })
  it('lets moderators see only a reported message and suppresses hidden message previews', async () => {
    await mutate(db => {
      db.conversations.push({ id: 'cnv_one', type: 'direct', title: null, last_message_at: timestamp, last_message_preview: 'reported-message-secret', created_at: timestamp })
      for (const name of ['alice','bob']) db.conversation_participants.push({ id: `par_${name}`, conversation_id: 'cnv_one', profile_id: `prf_${name}`, last_read_at: null })
      db.messages.push({ id: 'msg_report', conversation_id: 'cnv_one', author_id: 'prf_bob', body: 'reported-message-secret', created_at: timestamp }, { id: 'msg_other', conversation_id: 'cnv_one', author_id: 'prf_bob', body: 'unreported-sibling-secret', created_at: '2026-10-19T00:00:00.000Z' })
      db.user_roles.push({ id: 'rol_carol', user_id: 'usr_carol', role: 'moderator', created_at: timestamp })
    })
    expect((await submitReportAction({ status: 'idle' }, form({ kind: 'message', targetId: 'msg_report', reason: 'Harassment or bullying' }))).status).toBe('success')
    auth.userId = 'usr_carol'
    const queue = await getOpenReports()
    expect(JSON.stringify(queue)).toContain('reported-message-secret')
    expect(JSON.stringify(queue)).not.toContain('unreported-sibling-secret')
    expect(await getConversationPane('cnv_one', 'usr_carol')).toBeNull()
    expect((await decideReportAction({ status: 'idle' }, form({ reportId: queue.rows![0].id, action: 'hide_content', reason: 'Valid decision' }))).status).toBe('success')
    auth.userId = 'usr_alice'
    expect(JSON.stringify(await listThreadMessages({ conversationId: 'cnv_one' }))).not.toContain('reported-message-secret')
    expect(JSON.stringify(await listConversations({ meId: 'usr_alice' }))).not.toContain('reported-message-secret')
  })
  it('keeps university requests private until an independent moderator approves them', async () => {
    expect((await requestUniversityAction({ status: 'idle' }, form({ name: 'Needle University', city: 'Lahore', country: 'Pakistan', status: 'approved', submitted_by: 'prf_carol' }))).status).toBe('success')
    const request = (await listMyPendingSubmissions())[0]
    expect(request.name).toBe('Needle University')
    expect((await readStore()).university_requests[0].submitted_by).toBe('prf_alice')
    expect((await claimUniversityAction({ status: 'idle' }, form({ universityId: request.id }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect(await listMyPendingSubmissions()).toHaveLength(0)
    expect((await getPendingUniversities()).rows).toEqual([])
    expect(JSON.stringify(await searchUniversities({ q: 'Needle' }))).not.toContain('Needle University')
    await mutate(db => db.user_roles.push({ id: 'rol_carol', user_id: 'usr_carol', role: 'moderator', created_at: timestamp }))
    auth.userId = 'usr_carol'
    expect((await getPendingUniversities()).total).toBe(1)
    expect((await reviewUniversityAction({ status: 'idle' }, form({ universityId: request.id, decision: 'approve', reason: 'Valid institution' }))).status).toBe('success')
    auth.userId = 'usr_alice'
    expect(await listMyPendingSubmissions()).toHaveLength(0)
    expect((await claimUniversityAction({ status: 'idle' }, form({ universityId: request.id, profileId: 'prf_bob' }))).status).toBe('success')
    expect(await getMyUniversityId()).toBe(request.id)
    expect((await readStore()).profiles.find(row => row.id === 'prf_bob')?.university_id).toBe('uni_one')
    expect((await leaveUniversityAction({ status: 'idle' }, form({ name: 'Needle University' }))).status).toBe('success')
    expect(await getMyUniversityId()).toBeNull()
  })
  it('files private bug reports and only lets administrators triage them', async () => {
    expect((await submitBugReportAction({ status: 'idle' }, form({ title: 'Broken control', body: 'confidential-bug-details', pageUrl: 'https://quad.test/feed?token=secret', reporter_id: 'prf_carol' }))).status).toBe('success')
    const mine = (await getOwnBugReports()).rows![0]
    expect(mine.body).toBe('confidential-bug-details')
    expect(mine.reporter?.id).toBe('prf_alice')
    expect(mine.pageUrl).not.toContain('token=secret')
    auth.userId = 'usr_bob'
    expect((await getOwnBugReports()).rows).toEqual([])
    expect((await getBugReports()).rows).toEqual([])
    expect((await triageBugReportAction({ status: 'idle' }, form({ bugId: mine.id, status: 'fixed' }))).status).toBe('error')
    await mutate(db => db.user_roles.push({ id: 'rol_carol', user_id: 'usr_carol', role: 'admin', created_at: timestamp }))
    auth.userId = 'usr_carol'
    expect(await countOpenBugReports()).toBe(1)
    expect((await getBugReports()).rows).toHaveLength(1)
    expect((await triageBugReportAction({ status: 'idle' }, form({ bugId: mine.id, status: 'fixed', reporter_id: 'prf_carol' }))).status).toBe('success')
    expect((await readStore()).bug_reports[0]).toMatchObject({ status: 'fixed', reporter_id: 'prf_alice' })
    expect(await countOpenBugReports()).toBe(0)
  })
  it('does not expose blocked search results, comments, peers or hidden project attachments', async () => {
    await mutate(db => {
      db.projects.push({ id: 'prj_bob', owner_id: 'prf_bob', slug: 'secret', title: 'needle-project', purpose: 'private-attachment', description: null, category: 'other', status: 'active', visibility: 'public', is_seeking_members: false, team_size_target: null, member_count: 1, created_at: timestamp, deleted_at: null })
      db.ideas.push({ id: 'ida_bob', author_id: 'prf_bob', title: 'needle-idea', description: 'secret-idea', category: 'other', status: 'open', visibility: 'public', upvote_count: 0, interest_count: 0, converted_project_id: null, created_at: timestamp, deleted_at: null })
      for (const name of ['bob','carol']) db.posts.push({ id: `pst_${name}`, author_id: `prf_${name}`, body: 'needle-post', visibility: 'public', project_id: name === 'carol' ? 'prj_bob' : null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
      db.comments.push({ id: 'cmt_bob', author_id: 'prf_bob', post_id: 'pst_carol', body: 'blocked-comment', parent_id: null, created_at: timestamp, deleted_at: null })
      db.comments.push({ id: 'cmt_reply', author_id: 'prf_carol', post_id: 'pst_carol', body: 'reply-to-blocked-comment', parent_id: 'cmt_bob', created_at: timestamp, deleted_at: null })
    })
    await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob' }))
    for (const kind of ['post','project','idea'] as const) expect((await searchAll({ query: 'needle', kind })).results?.some(row => row.id.endsWith('bob'))).toBe(false)
    expect(JSON.stringify(await getPostComments('pst_carol'))).not.toContain('blocked-comment')
    expect(await getCommentReplies(['cmt_bob'])).toHaveLength(0)
    expect(JSON.stringify(await listUniversityPeers())).not.toContain('prf_bob')
    expect((await getPostDetail('pst_carol'))?.project).toBeNull()
  })
  it('reads real graph state without disclosing someone else\'s block note', async () => {
    await setFollowAction({ status: 'idle' }, form({ profileId: 'prf_bob', follow: 'true' }))
    expect((await listFollows({ direction: 'following' })).items.map(row => row.id)).toEqual(['prf_bob'])
    await sendConnectionRequestAction({ status: 'idle' }, form({ profileId: 'prf_bob', message: 'hello' }))
    expect((await getViewerConnection('prf_bob'))?.state).toBe('outgoing')
    expect((await listRequests()).outgoing).toHaveLength(1)
    auth.userId = 'usr_bob'
    const request = (await listRequests()).incoming[0]
    expect(request.message).toBe('hello')
    await acceptConnectionAction({ status: 'idle' }, form({ connectionId: request.id }))
    expect((await listConnections()).items).toHaveLength(1)
    expect((await getViewerConnection('prf_alice'))?.state).toBe('connected')
    auth.userId = 'usr_alice'
    await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob', reason: 'confidential-block-note' }))
    expect((await listBlocked()).items[0].reason).toBe('confidential-block-note')
    expect((await listConnections()).items).toHaveLength(0)
    expect(JSON.stringify(await listUniversitySuggestions())).not.toContain('prf_bob')
    auth.userId = 'usr_carol'
    expect(JSON.stringify(await listBlocked())).not.toContain('confidential-block-note')
  })
  it('authorizes moderation, keeps its audit private, hides content and revokes suspended accounts', async () => {
    await mutate(db => {
      db.posts.push({ id: 'pst_report', author_id: 'prf_bob', body: 'reported-content', visibility: 'public', project_id: null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
      db.user_roles.push({ id: 'rol_bob', user_id: 'usr_bob', role: 'moderator', created_at: timestamp }, { id: 'rol_carol', user_id: 'usr_carol', role: 'admin', created_at: timestamp })
    })
    expect((await submitReportAction({ status: 'idle' }, form({ kind: 'post', targetId: 'pst_report', reason: 'Spam or advertising' }))).status).toBe('success')
    const reportId = (await readStore()).reports[0].id
    expect((await getOpenReports()).rows).toEqual([])
    expect((await decideReportAction({ status: 'idle' }, form({ reportId, action: 'hide_content', reason: 'valid-reason' }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect((await decideReportAction({ status: 'idle' }, form({ reportId, action: 'hide_content', reason: 'valid-reason' }))).status).toBe('error')
    auth.userId = 'usr_carol'
    expect((await getOpenReports()).total).toBe(1)
    expect((await decideReportAction({ status: 'idle' }, form({ reportId, action: 'hide_content', reason: 'valid-reason' }))).status).toBe('success')
    expect(await getPostDetail('pst_report')).toBeNull()
    expect((await getModerationActions()).total).toBe(1)
    expect(JSON.stringify(await getModerationActions())).not.toContain('reported-content')
    auth.userId = 'usr_alice'
    expect((await getModerationActions()).rows).toEqual([])
    expect((await submitReportAction({ status: 'idle' }, form({ kind: 'profile', targetId: 'prf_bob', reason: 'Harassment or bullying' }))).status).toBe('success')
    const suspension = (await readStore()).reports.find(row => row.reported_profile_id === 'prf_bob')!
    auth.userId = 'usr_carol'
    expect((await decideReportAction({ status: 'idle' }, form({ reportId: suspension.id, action: 'suspend_user', reason: 'valid-reason', days: '7' }))).status).toBe('success')
    const suspendedStore = await readStore()
    expect(suspendedStore.users.find(row => row.id === 'usr_bob')?.disabled_at ?? null).toBeNull()
    expect(suspendedStore.profile_account_states.find(row => row.profile_id === 'prf_bob'))
      .toMatchObject({ status: 'suspended', suspended_until: expect.any(String) })
    expect(suspendedStore.sessions.filter(row => row.user_id === 'usr_bob')).toEqual([])
    auth.userId = 'usr_bob'
    expect((await setFollowAction({ status: 'idle' }, form({ profileId: 'prf_alice', follow: 'true' }))).status).toBe('error')
  })
  it('keeps hidden connected posts hidden and filters the following lens to real follows', async () => {
    await mutate(db => {
      db.connections.push({ id: 'con_one', requester_id: 'prf_alice', addressee_id: 'prf_bob', status: 'accepted', message: null, responded_at: timestamp, created_at: timestamp })
      db.posts.push({ id: 'pst_hidden', author_id: 'prf_bob', body: 'hidden-secret', visibility: 'connections', project_id: null, goal_id: null, moderation_status: 'hidden', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
      for (const name of ['bob','carol']) db.posts.push({ id: `pst_${name}`, author_id: `prf_${name}`, body: `${name}-public`, visibility: 'public', project_id: null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
    })
    expect(await getPostDetail('pst_hidden')).toBeNull()
    await setFollowAction({ status: 'idle' }, form({ profileId: 'prf_bob', follow: 'true' }))
    const following = JSON.stringify(await getFeedPosts({ lens: 'following' }))
    expect(following).toContain('bob-public')
    expect(following).not.toContain('carol-public')
    expect(following).not.toContain('hidden-secret')
    await mutate(db => db.profile_account_states.push({ id: 'sta_bob', profile_id: 'prf_bob', status: 'suspended', suspended_until: '2099-01-01T00:00:00.000Z', warning_count: 0 }))
    expect(await getPostDetail('pst_bob')).toBeNull()
  })
  it('persists muting and refuses conversation reader substitution and blocked sends/history', async () => {
    await mutate(db => {
      db.conversations.push({ id: 'cnv_one', type: 'direct', title: null, last_message_at: timestamp, last_message_preview: 'message-secret', created_at: timestamp })
      for (const name of ['alice', 'bob']) db.conversation_participants.push({ id: `par_${name}`, conversation_id: 'cnv_one', profile_id: `prf_${name}`, last_read_at: null })
      db.messages.push({ id: 'msg_one', conversation_id: 'cnv_one', author_id: 'prf_bob', body: 'message-secret', created_at: timestamp })
    })
    expect(await getTotalUnreadMessages()).toBe(1)
    expect((await setConversationMutedAction('cnv_one', true)).ok).toBe(true)
    expect((await getConversationPane('cnv_one', 'usr_alice'))?.is_muted).toBe(true)
    expect(await getTotalUnreadMessages()).toBe(0)
    auth.userId = 'usr_carol'
    expect(await getConversationPane('cnv_one', 'usr_alice')).toBeNull()
    expect((await setConversationMutedAction('cnv_one', false)).ok).toBe(false)
    auth.userId = 'usr_alice'
    await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob' }))
    expect((await getMessagingPermission('usr_alice', 'prf_bob')).state).toBe('refused')
    expect((await sendMessageAction({ status: 'idle' }, form({ conversationId: 'cnv_one', body: 'blocked-send' }))).status).toBe('error')
    expect(JSON.stringify(await listThreadMessages({ conversationId: 'cnv_one' }))).not.toContain('message-secret')
    expect(await getConversationPane('cnv_one', 'usr_alice')).toBeNull()
  })
  it('stores one vote per actor and keeps collaboration pitches between sender and idea owner', async () => {
    await mutate(db => db.ideas.push({ id: 'ida_one', author_id: 'prf_bob', title: 'Idea', description: 'description', category: 'other', status: 'open', visibility: 'public', upvote_count: 0, interest_count: 0, converted_project_id: null, created_at: timestamp, deleted_at: null }))
    const vote = form({ ideaId: 'ida_one', voted: 'false' })
    expect((await voteIdeaAction({ status: 'idle' }, vote)).status).toBe('success')
    expect((await voteIdeaAction({ status: 'idle' }, vote)).status).toBe('success')
    expect((await readStore()).idea_votes).toHaveLength(1)
    const idea = await getIdeaById('ida_one')
    expect(idea?.upvote_count).toBe(1)
    expect((await getIdeaViewerState(idea!)).hasVoted).toBe(true)
    expect((await expressInterestAction({ status: 'idle' }, form({ ideaId: 'ida_one', message: 'secret-pitch', offering: 'code' }))).status).toBe('success')
    auth.userId = 'usr_carol'
    expect(await listIdeaInterests('ida_one')).toHaveLength(0)
    expect((await withdrawInterestAction({ status: 'idle' }, form({ ideaId: 'ida_one' }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect(JSON.stringify(await listIdeaInterests('ida_one'))).toContain('secret-pitch')
    await mutate(db => { db.ideas[0].visibility = 'private' })
    auth.userId = 'usr_alice'
    expect(await getIdeaById('ida_one')).toBeNull()
    expect((await voteIdeaAction({ status: 'idle' }, vote)).status).toBe('error')
  })
  it('records project stars and join requests, refuses ID-substituted reviews, and links accepted members to team updates', async () => {
    await mutate(db => {
      db.projects.push({ id: 'prj_team', owner_id: 'prf_bob', slug: 'team', title: 'Team', purpose: 'Build', description: null, category: 'other', status: 'active', visibility: 'public', is_seeking_members: true, team_size_target: 3, member_count: 1, created_at: timestamp, deleted_at: null })
      db.project_members.push({ id: 'mem_owner', project_id: 'prj_team', profile_id: 'prf_bob', role: 'owner', created_at: timestamp })
    })
    expect((await toggleStarAction({ status: 'idle' }, form({ projectId: 'prj_team', slug: 'team', starred: 'false' }))).status).toBe('success')
    expect(await hasStarred('prj_team')).toBe(true)
    expect((await requestToJoinAction({ status: 'idle' }, form({ projectId: 'prj_team', slug: 'team', message: 'private-pitch' }))).status).toBe('success')
    const application = (await readStore()).project_applications[0]
    auth.userId = 'usr_carol'
    expect(await listPendingApplications('prj_team')).toHaveLength(0)
    expect((await reviewApplicationAction({ status: 'idle' }, form({ applicationId: application.id, slug: 'team', decision: 'accepted' }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect(await listPendingApplications('prj_team')).toHaveLength(1)
    expect((await reviewApplicationAction({ status: 'idle' }, form({ applicationId: application.id, slug: 'team', decision: 'accepted' }))).status).toBe('success')
    await mutate(db => { db.projects[0].visibility = 'private' })
    auth.userId = 'usr_alice'
    expect(await getProjectBySlug('team')).not.toBeNull()
    expect((await postUpdateAction({ status: 'idle' }, form({ slug: 'team', body: 'team-secret' }))).status).toBe('success')
    auth.userId = 'usr_bob'
    expect(JSON.stringify(await listProjectUpdates({ projectId: 'prj_team' }))).toContain('team-secret')
    auth.userId = 'usr_carol'
    expect(await getProjectBySlug('team')).toBeNull()
    expect((await toggleStarAction({ status: 'idle' }, form({ projectId: 'prj_team', slug: 'team', starred: 'false' }))).status).toBe('error')
  })
  it('persists skill/interest claims, protects pending proposals, and scopes updates to the session', async () => {
    expect((await proposeSkillAction({ status: 'idle' }, form({ name: 'TypeScript', category: 'language' }))).status).toBe('success')
    const skillId = (await readStore()).skills[0].id
    expect(await listProfileSkills('prf_alice')).toHaveLength(1)
    auth.userId = 'usr_bob'
    expect(await listProfileSkills('prf_alice')).toHaveLength(0)
    expect(await listSkillCatalogue()).toHaveLength(0)
    expect((await attachSkillAction({ status: 'idle' }, form({ skillId, level: 'learning' }))).status).toBe('error')
    expect((await updateProfileSkillAction({ status: 'idle' }, form({ skillId, level: 'advanced', profile_id: 'prf_alice' }))).status).toBe('error')
    auth.userId = 'usr_alice'
    expect((await updateProfileSkillAction({ status: 'idle' }, form({ skillId, level: 'advanced' }))).status).toBe('success')
    expect((await listProfileSkills('prf_alice'))[0].level).toBe('advanced')
    expect((await proposeInterestAction({ status: 'idle' }, form({ name: 'Robotics', category: 'technology' }))).status).toBe('success')
    const interestId = (await readStore()).interests[0].id
    expect(await listProfileInterests('prf_alice')).toHaveLength(1)
    expect((await removeInterestAction({ status: 'idle' }, form({ interestId }))).status).toBe('success')
    expect((await removeSkillAction({ status: 'idle' }, form({ skillId }))).status).toBe('success')
    expect(await listProfileSkills('prf_alice')).toHaveLength(0)
  })
  it('only lets the addressee accept a request and unlocks connection-only reads', async () => {
    expect((await sendConnectionRequestAction({ status: 'idle' }, form({ profileId: 'prf_bob', message: 'hello' }))).status).toBe('success')
    const request = (await readStore()).connections[0]
    expect((await acceptConnectionAction({ status: 'idle' }, form({ connectionId: request.id }))).status).toBe('error')
    auth.userId = 'usr_carol'
    expect((await acceptConnectionAction({ status: 'idle' }, form({ connectionId: request.id }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect((await acceptConnectionAction({ status: 'idle' }, form({ connectionId: request.id }))).status).toBe('success')
    await mutate(db => { db.profiles.find(row => row.id === 'prf_alice')!.visibility = 'connections' })
    expect(await getProfileByUsername('alice')).not.toBeNull()
  })
  it('blocking severs both graph directions and denies profile/post reads and re-follow', async () => {
    await mutate(db => {
      db.posts.push({ id: 'pst_secret', author_id: 'prf_bob', body: 'blocked-secret', visibility: 'public', project_id: null, goal_id: null, moderation_status: 'active', like_count: 0, comment_count: 0, created_at: timestamp, deleted_at: null })
      db.follows.push({ id: 'fol_reverse', follower_id: 'prf_bob', following_id: 'prf_alice', created_at: timestamp })
    })
    await setFollowAction({ status: 'idle' }, form({ profileId: 'prf_bob', follow: 'true' }))
    expect((await blockAction({ status: 'idle' }, form({ profileId: 'prf_bob', reason: 'private-note' }))).status).toBe('success')
    expect((await readStore()).follows).toHaveLength(0)
    expect(await getProfileByUsername('bob')).toBeNull()
    expect(await getPostDetail('pst_secret')).toBeNull()
    expect(JSON.stringify(await getFeedPosts({ lens: 'for-you' }))).not.toContain('blocked-secret')
    expect((await setFollowAction({ status: 'idle' }, form({ profileId: 'prf_bob', follow: 'true' }))).status).toBe('error')
    auth.userId = 'usr_bob'
    expect(await getProfileByUsername('alice')).toBeNull()
    expect((await unblockAction({ status: 'idle' }, form({ profileId: 'prf_alice' }))).status).toBe('error')
    expect((await readStore()).blocks).toHaveLength(1)
  })
  it('persists an idempotent follow using the session profile, not a forged actor', async () => {
    const input = form({ profileId: 'prf_bob', follow: 'true', follower_id: 'prf_carol' })
    expect((await setFollowAction({ status: 'idle' }, input)).status).toBe('success')
    expect((await setFollowAction({ status: 'idle' }, input)).status).toBe('success')
    const db = await readStore()
    expect(db.follows).toHaveLength(1)
    expect(db.follows[0]).toMatchObject({ follower_id: 'prf_alice', following_id: 'prf_bob' })
    const persisted = JSON.parse(await fs.readFile(path.join(fixtureDir, 'data', 'local.json'), 'utf8'))
    expect(persisted.follows).toHaveLength(1)
  })
})

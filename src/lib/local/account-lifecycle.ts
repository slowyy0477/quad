import 'server-only'

import { randomUUID } from 'node:crypto'
import { readStore, mutate, now, type Tables } from './db'
import type { LocalAccountDeletionJob } from './domain-tables'
import { getLocalUserFromSnapshot, LOCAL_SESSION_COOKIE } from './session'
import { cookies } from 'next/headers'
import { withLocalPasswordReauthentication, type LocalPasswordFailure } from './password'
import { ACCOUNT_POLICY_VERSION, MODERATION_RETENTION_DAYS } from '@/features/account/policy'
import { deletionRequestSchema, exportOptionsSchema, receiptRequestSchema } from '@/features/account/schemas'
import { buildLocalAccountExport, ExportSizeError } from '@/features/account/export'
import type { AccountExport, DeletionReceipt, ExportOptions, LifecycleErrorCode, LifecycleResult, OwnershipBlockers } from '@/features/account/types'
import { cleanupLocalAccountImages, localMediaOwnershipBlocked, withLocalAccountMediaSnapshot } from '@/features/account/local-media'

const RETENTION_MS = MODERATION_RETENTION_DAYS * 86_400_000
const LEASE_MS = 60_000
const MAX_ATTEMPTS = 5
const AUDIT_OUTCOMES = new Set([
  'open', 'actioned', 'dismissed', 'hide_content', 'remove_content',
  'restore_content', 'warn_user', 'suspend_user', 'dismiss_report',
  'approve_university', 'reject_university',
])

function passwordFailure<T>(failure: LocalPasswordFailure): LifecycleResult<T> {
  return { ok: false, code: failure.reason, retryAfterSeconds: failure.retryAfterSeconds }
}

function receipt(job: LocalAccountDeletionJob): DeletionReceipt {
  // No account IDs, request keys, hashes, worker leases or raw errors cross this DTO.
  return { id: job.id, state: job.state, phase: job.phase }
}

export function localDeletionBlockers(db: Tables, userId: string, profileId: string): OwnershipBlockers {
  const owned = db.projects.filter(project => project.owner_id === profileId)
  const shared = owned.filter(project =>
    db.project_members.some(member => member.project_id === project.id && member.profile_id !== profileId),
  )
  const inconsistentOwnerRole = owned.some(project =>
    !db.project_members.some(member => member.project_id === project.id && member.profile_id === profileId && member.role === 'owner'),
  ) || db.project_members.some(member =>
    member.profile_id === profileId && member.role === 'owner' &&
    !db.projects.some(project => project.id === member.project_id && project.owner_id === profileId),
  )
  const administrator = db.user_roles.some(role => role.user_id === userId && role.role === 'admin')
  const anotherActiveAdministrator = db.user_roles.some(role => {
    if (role.role !== 'admin' || role.user_id === userId) return false
    const user = db.users.find(candidate => candidate.id === role.user_id)
    const profile = db.profiles.find(candidate => candidate.user_id === role.user_id)
    if (!user || user.disabled_at != null || !profile) return false
    if (db.account_deletion_jobs.some(job => job.user_id === user.id && job.state !== 'completed')) return false
    const state = db.profile_account_states.find(candidate => candidate.profile_id === profile.id)
    if (state?.status !== 'suspended') return true
    const deadline = state.suspended_until ? Date.parse(state.suspended_until) : NaN
    return Number.isFinite(deadline) && deadline <= Date.now()
  })
  return {
    projects: shared.slice(0, 50).map(project => ({
      id: project.id, slug: project.slug, title: project.title, deleted: project.deleted_at !== null,
    })),
    moreProjects: shared.length > 50,
    inconsistentOwnerRole,
    lastAdministrator: administrator && !anotherActiveAdministrator,
    // The separately locked private-image index supplies this media check.
    sharedMedia: false,
    ownedStorageBucket: false,
  }
}

function blockerCode(blockers: OwnershipBlockers): LifecycleErrorCode | null {
  if (blockers.projects.length || blockers.moreProjects) return 'ownership_transfer_required'
  if (blockers.inconsistentOwnerRole) return 'owner_role_inconsistent'
  if (blockers.lastAdministrator) return 'last_administrator'
  return null
}

export async function getLocalAccountBlockers(expectedUserId: string): Promise<LifecycleResult<OwnershipBlockers>> {
  return withLocalAccountMediaSnapshot(async records => {
    const db = await readStore()
    const actor = getLocalUserFromSnapshot(db, (await cookies()).get(LOCAL_SESSION_COOKIE)?.value)
    if (!actor) return { ok: false, code: 'signed_out' }
    if (actor.id !== expectedUserId) return { ok: false, code: 'identity_mismatch' }
    if (!actor.profile) return { ok: false, code: 'account_unavailable' }
    const blockers = localDeletionBlockers(db, actor.id, actor.profile.id)
    blockers.sharedMedia = localMediaOwnershipBlocked(records, db, actor.profile.id)
    return { ok: true, value: blockers }
  })
}

export async function exportLocalAccount(
  expectedUserId: string,
  currentPassword: string,
  options: ExportOptions = {},
): Promise<LifecycleResult<AccountExport>> {
  const parsed = exportOptionsSchema.safeParse(options)
  if (!parsed.success) return { ok: false, code: 'invalid_request' }
  const verified = await withLocalPasswordReauthentication({ expectedUserId, currentPassword }, (db, identity) => {
    if (!identity.profileId) return { ok: false as const, code: 'account_unavailable' as const }
    try {
      return {
        ok: true as const,
        value: buildLocalAccountExport(db, { userId: identity.userId, profileId: identity.profileId }, parsed.data as ExportOptions),
      }
    } catch (error) {
      if (error instanceof ExportSizeError) return { ok: false as const, code: 'export_too_large' as const }
      throw error
    }
  })
  return verified.ok ? verified.value : passwordFailure(verified)
}

export async function requestLocalAccountDeletion(
  expectedUserId: string,
  input: { password: string; confirmation: string; acknowledge: boolean; idempotencyKey: string },
): Promise<LifecycleResult<DeletionReceipt>> {
  const parsed = deletionRequestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: 'confirmation_required' }
  const verified = await withLocalAccountMediaSnapshot(async records => withLocalPasswordReauthentication({
    expectedUserId, currentPassword: parsed.data.password,
  }, (db, identity): LifecycleResult<DeletionReceipt> => {
    if (!identity.profileId) return { ok: false, code: 'account_unavailable' }
    const block = blockerCode(localDeletionBlockers(db, identity.userId, identity.profileId))
    if (block) return { ok: false, code: block }
    if (localMediaOwnershipBlocked(records, db, identity.profileId)) return { ok: false, code: 'shared_media_ownership' }
    if (db.account_deletion_jobs.some(job => job.user_id === identity.userId)) {
      return { ok: false, code: 'account_unavailable' }
    }
    const timestamp = now()
    const job: LocalAccountDeletionJob = {
      id: randomUUID(),
      user_id: identity.userId,
      profile_id: identity.profileId,
      idempotency_key: parsed.data.idempotencyKey,
      policy_version: ACCOUNT_POLICY_VERSION,
      state: 'queued',
      phase: 'media',
      attempts: 0,
      created_at: timestamp,
      updated_at: timestamp,
      next_attempt_at: timestamp,
      lease_expires_at: null,
      lease_token: null,
      error_code: null,
      completed_at: null,
    }
    // The locked snapshot couples intent, restriction and ALL-session revocation.
    db.users.find(user => user.id === identity.userId)!.disabled_at = timestamp
    db.sessions = db.sessions.filter(session => session.user_id !== identity.userId)
    db.account_deletion_jobs.push(job)
    return { ok: true, value: receipt(job) }
  }))
  return verified.ok ? verified.value : passwordFailure(verified)
}

function removePersonalContent(db: Tables, job: LocalAccountDeletionJob) {
  const profileId = job.profile_id!
  const userId = job.user_id!
  const ids = <T extends { id: string }>(rows: T[]) => new Set(rows.map(row => row.id))
  const posts = ids(db.posts.filter(row => row.author_id === profileId))
  const projects = ids(db.projects.filter(row => row.owner_id === profileId))
  const ideas = ids(db.ideas.filter(row => row.author_id === profileId))
  const goals = ids(db.goals.filter(row => row.profile_id === profileId))
  const semesters = ids(db.semesters.filter(row => row.profile_id === profileId))
  const courses = ids(db.courses.filter(row => row.profile_id === profileId))
  const opportunities = ids(db.opportunities.filter(row => row.posted_by === profileId))
  const events = ids(db.events.filter(row => row.created_by === profileId))
  const comments = ids(db.comments.filter(row => row.author_id === profileId || posts.has(row.post_id)))
  const messages = ids(db.messages.filter(row => row.author_id === profileId))
  const targets = new Set([profileId, ...posts, ...projects, ...ideas, ...comments, ...messages, ...goals, ...events, ...opportunities])
  const affectedReports = db.reports.filter(row =>
    row.reporter_id === profileId || row.reported_profile_id === profileId ||
    [row.post_id, row.comment_id, row.project_id, row.idea_id, row.message_id, row.event_id, row.opportunity_id]
      .some(target => target && targets.has(target)),
  )
  const reportIds = ids(affectedReports)
  const affectedActions = db.moderation_actions.filter(row =>
    row.actor_id === profileId || row.target_profile_id === profileId ||
    Boolean(row.report_id && reportIds.has(row.report_id)) || Boolean(row.target_id && targets.has(row.target_id)),
  )
  const actionIds = ids(affectedActions)
  const expires = new Date(Date.now() + RETENTION_MS).toISOString()
  for (const [category, rows] of [['report', affectedReports], ['action', affectedActions]] as const) {
    for (const row of rows) {
      const outcome = 'action' in row ? row.action : row.status
      if (!AUDIT_OUTCOMES.has(outcome)) continue
      const occurred = /^\d{4}-\d{2}-\d{2}T/.test(row.created_at) ? row.created_at.slice(0, 10) : now().slice(0, 10)
      db.account_retained_moderation.push({
        id: randomUUID(), deletion_job_id: job.id, category, outcome,
        occurred_on: occurred, expires_at: expires,
      })
    }
  }
  db.reports = db.reports.filter(row => !reportIds.has(row.id))
  db.moderation_actions = db.moderation_actions.filter(row => !actionIds.has(row.id))
  for (const row of db.moderation_actions) {
    const legacy = row as unknown as Record<string, unknown>
    if (typeof legacy.supersedes_id === 'string' && actionIds.has(legacy.supersedes_id)) legacy.supersedes_id = null
  }

  // Repair links in others' independent content before removing its parent/owner.
  const affectedPosts = new Set(db.post_likes.filter(row => row.profile_id === profileId).map(row => row.post_id))
  for (const row of db.comments) {
    if (comments.has(row.id)) affectedPosts.add(row.post_id)
    else if (row.parent_id && comments.has(row.parent_id)) row.parent_id = null
  }
  for (const row of db.posts) {
    if (row.project_id && projects.has(row.project_id)) row.project_id = null
    if (row.goal_id && goals.has(row.goal_id)) row.goal_id = null
  }
  for (const row of db.ideas) {
    if (row.converted_project_id && projects.has(row.converted_project_id)) row.converted_project_id = null
  }
  const touchedConversations = new Set(db.messages.filter(row => messages.has(row.id)).map(row => row.conversation_id))
  db.messages = db.messages.filter(row => !messages.has(row.id))
  for (const row of db.messages) {
    const legacy = row as unknown as Record<string, unknown>
    if (typeof legacy.reply_to_id === 'string' && messages.has(legacy.reply_to_id)) legacy.reply_to_id = null
  }
  for (const conversation of db.conversations) {
    const legacy = conversation as unknown as Record<string, unknown>
    if (legacy.created_by === profileId) legacy.created_by = null
    if (legacy.pair_low === profileId || legacy.pair_high === profileId) {
      const remaining = legacy.pair_low === profileId ? String(legacy.pair_high) : String(legacy.pair_low)
      const anonymous = randomUUID()
      ;[legacy.pair_low, legacy.pair_high] = [remaining, anonymous].sort()
    }
    if (touchedConversations.has(conversation.id)) {
      const remaining = db.messages.filter(row => row.conversation_id === conversation.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
      // Never retain the deleted sender's denormalised message body.
      conversation.last_message_preview = null
      conversation.last_message_at = remaining[0]?.created_at ?? null
      if ('last_message_id' in legacy) legacy.last_message_id = remaining[0]?.id ?? null
    }
  }

  db.posts = db.posts.filter(row => !posts.has(row.id))
  db.comments = db.comments.filter(row => !comments.has(row.id))
  db.post_likes = db.post_likes.filter(row => row.profile_id !== profileId && !posts.has(row.post_id))
  db.post_saves = db.post_saves.filter(row => row.profile_id !== profileId && !posts.has(row.post_id))
  for (const post of db.posts.filter(row => affectedPosts.has(row.id))) {
    post.like_count = db.post_likes.filter(row => row.post_id === post.id).length
    post.comment_count = db.comments.filter(row => row.post_id === post.id && !row.deleted_at).length
  }
  const affectedProjects = new Set(db.project_members.filter(row => row.profile_id === profileId).map(row => row.project_id))
  db.projects = db.projects.filter(row => !projects.has(row.id))
  db.project_members = db.project_members.filter(row => row.profile_id !== profileId && !projects.has(row.project_id))
  db.project_applications = db.project_applications.filter(row => row.applicant_id !== profileId && !projects.has(row.project_id))
  for (const application of db.project_applications) if (application.reviewed_by === profileId) application.reviewed_by = null
  // Mirror the hosted inviter/invitee/project ON DELETE CASCADE contract.
  // Delete complete private invitation rows, including resolved history; do not
  // rewrite another account's note/status or retain notes as audit evidence.
  // Deletes need no post-revocation session or mandatory-budget exemption.
  db.project_invites = db.project_invites.filter(row =>
    row.inviter_id !== profileId && row.invitee_id !== profileId && !projects.has(row.project_id),
  )
  db.project_stars = db.project_stars.filter(row => row.profile_id !== profileId && !projects.has(row.project_id))
  db.project_skills = db.project_skills.filter(row => !projects.has(row.project_id))
  for (const project of db.projects.filter(row => affectedProjects.has(row.id))) {
    project.member_count = db.project_members.filter(row => row.project_id === project.id).length
  }
  db.ideas = db.ideas.filter(row => !ideas.has(row.id))
  const affectedIdeas = new Set([
    ...db.idea_votes.filter(row => row.profile_id === profileId).map(row => row.idea_id),
    ...db.idea_interest.filter(row => row.profile_id === profileId).map(row => row.idea_id),
  ])
  db.idea_votes = db.idea_votes.filter(row => row.profile_id !== profileId && !ideas.has(row.idea_id))
  db.idea_interest = db.idea_interest.filter(row => row.profile_id !== profileId && !ideas.has(row.idea_id))
  db.idea_skills = db.idea_skills.filter(row => !ideas.has(row.idea_id))
  // These local counters have no triggers; update only objects touched by deletion.
  for (const idea of db.ideas.filter(row => affectedIdeas.has(row.id))) {
    if (db.idea_votes.some(row => row.idea_id === idea.id) || idea.upvote_count) idea.upvote_count = db.idea_votes.filter(row => row.idea_id === idea.id).length
    if (db.idea_interest.some(row => row.idea_id === idea.id) || idea.interest_count) idea.interest_count = db.idea_interest.filter(row => row.idea_id === idea.id).length
  }
  db.connections = db.connections.filter(row => row.requester_id !== profileId && row.addressee_id !== profileId)
  db.follows = db.follows.filter(row => row.follower_id !== profileId && row.following_id !== profileId)
  db.blocks = db.blocks.filter(row => row.blocker_id !== profileId && row.blocked_id !== profileId)
  const skillIds = new Set(db.profile_skills.filter(row => row.profile_id === profileId).map(row => row.skill_id))
  const interestIds = new Set(db.profile_interests.filter(row => row.profile_id === profileId).map(row => row.interest_id))
  db.profile_skills = db.profile_skills.filter(row => row.profile_id !== profileId)
  db.profile_interests = db.profile_interests.filter(row => row.profile_id !== profileId)
  db.profile_skill_endorsements = db.profile_skill_endorsements.filter(row => row.profile_id !== profileId && row.endorser_id !== profileId)
  for (const skill of db.skills) {
    if (skill.created_by === profileId) skill.created_by = null
    if (skillIds.has(skill.id)) skill.usage_count = db.profile_skills.filter(row => row.skill_id === skill.id).length
  }
  for (const interest of db.interests) {
    if (interest.created_by === profileId) interest.created_by = null
    if (interestIds.has(interest.id)) interest.usage_count = db.profile_interests.filter(row => row.interest_id === interest.id).length
  }
  db.profile_achievements = db.profile_achievements.filter(row => row.profile_id !== profileId)
  db.semesters = db.semesters.filter(row => !semesters.has(row.id))
  db.courses = db.courses.filter(row => row.profile_id !== profileId && !semesters.has(row.semester_id))
  db.goals = db.goals.filter(row => !goals.has(row.id))
  for (const goal of db.goals) {
    if (goal.semester_id && semesters.has(goal.semester_id)) goal.semester_id = null
    if (goal.course_id && courses.has(goal.course_id)) goal.course_id = null
  }
  db.goal_milestones = db.goal_milestones.filter(row => !goals.has(row.goal_id))
  db.daily_logs = db.daily_logs.filter(row => row.profile_id !== profileId)
  db.opportunities = db.opportunities.filter(row => !opportunities.has(row.id))
  db.opportunity_saves = db.opportunity_saves.filter(row => {
    const key = (row as unknown as { opportunity_id?: string }).opportunity_id ?? row.post_id
    return row.profile_id !== profileId && !opportunities.has(key)
  })
  const affectedEvents = new Set(db.event_attendees.filter(row => row.profile_id === profileId).map(row => row.event_id))
  db.events = db.events.filter(row => !events.has(row.id))
  db.event_attendees = db.event_attendees.filter(row => row.profile_id !== profileId && !events.has(row.event_id))
  for (const event of db.events.filter(row => affectedEvents.has(row.id))) {
    event.attendee_count = db.event_attendees.filter(row => row.event_id === event.id && row.status === 'going').length
  }
  db.notifications = db.notifications.filter(row =>
    row.recipient_id !== profileId && row.actor_id !== profileId &&
    ![row.post_id, row.comment_id, row.project_id, row.idea_id, row.event_id, row.opportunity_id].some(target => target && targets.has(target)),
  )
  db.conversation_participants = db.conversation_participants.filter(row => row.profile_id !== profileId)
  db.participant_preferences = db.participant_preferences.filter(row => row.profile_id !== profileId)
  db.profile_account_states = db.profile_account_states.filter(row => row.profile_id !== profileId)
  db.content_moderation = db.content_moderation.filter(row => !targets.has(row.target_id))
  db.bug_reports = db.bug_reports.filter(row => row.reporter_id !== profileId)
  db.university_requests = db.university_requests.filter(row => row.submitted_by !== profileId)
  for (const row of db.university_requests) if (row.reviewed_by === profileId) row.reviewed_by = null
  db.user_roles = db.user_roles.filter(row => row.user_id !== userId)
  db.sessions = db.sessions.filter(row => row.user_id !== userId)
  const profile = db.profiles.find(row => row.id === profileId)
  if (profile?.university_id) {
    const university = db.universities.find(row => row.id === profile.university_id)
    if (university) university.student_count = Math.max(0, university.student_count - 1)
  }
  db.profiles = db.profiles.filter(row => row.id !== profileId)
  db.users = db.users.filter(row => row.id !== userId)
}

/** Bounded, server-worker-only pruning; receipt reads never trigger cleanup. */
function pruneLifecycleRows(db: Tables, timestamp: number) {
  const expiredEvidence = new Set(db.account_retained_moderation
    .filter(row => Date.parse(row.expires_at) <= timestamp)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at))
    .slice(0, 250).map(row => row.id))
  const expiredJobs = new Set(db.account_deletion_jobs
    .filter(job => job.state === 'completed' && job.completed_at !== null &&
      Date.parse(job.completed_at) + RETENTION_MS <= timestamp)
    .sort((a, b) => a.completed_at!.localeCompare(b.completed_at!))
    .slice(0, 250).map(job => job.id))
  db.account_retained_moderation = db.account_retained_moderation.filter(row =>
    !expiredEvidence.has(row.id) && !expiredJobs.has(row.deletion_job_id))
  db.account_deletion_media = db.account_deletion_media.filter(row => !expiredJobs.has(row.deletion_job_id))
  db.account_deletion_jobs = db.account_deletion_jobs.filter(job => !expiredJobs.has(job.id))
}

/** Status-only random receipt. Possession grants no profile/content access. */
export async function getLocalDeletionReceipt(id: string): Promise<DeletionReceipt | null> {
  if (!receiptRequestSchema.safeParse({ receipt: id }).success) return null
  const job = (await readStore()).account_deletion_jobs.find(candidate => candidate.id === id)
  if (!job || (job.completed_at && Date.parse(job.completed_at) + RETENTION_MS <= Date.now())) return null
  return receipt(job)
}

/**
 * Server-only local worker. Claim and completion are separate durable commits.
 * Indexed owned images are retired/removed before the final row transaction.
 * A crashed claim can be retried after its lease. Call only for a user-requested
 * job; tests must set isolated DB/media paths.
 */
export async function runLocalAccountDeletionJob(id: string): Promise<DeletionReceipt | null> {
  const claimed = await mutate(db => {
    const timestamp = Date.now()
    pruneLifecycleRows(db, timestamp)
    const job = db.account_deletion_jobs.find(candidate => candidate.id === id)
    if (!job || job.state === 'completed' || job.state === 'blocked' || job.state === 'failed') return null
    if (job.state === 'processing' && job.lease_expires_at && Date.parse(job.lease_expires_at) > timestamp) return null
    if (job.state !== 'processing' && Date.parse(job.next_attempt_at) > timestamp) return null
    if (job.attempts >= MAX_ATTEMPTS) {
      job.state = 'failed'
      job.error_code = 'cleanup_failed'
      job.lease_token = job.lease_expires_at = null
      job.updated_at = now()
      return null
    }
    job.state = 'processing'
    job.attempts += 1
    job.lease_token = randomUUID()
    job.lease_expires_at = new Date(timestamp + LEASE_MS).toISOString()
    job.updated_at = now()
    return { id: job.id, token: job.lease_token }
  })
  if (!claimed) return getLocalDeletionReceipt(id)
  try {
    const media = await cleanupLocalAccountImages(claimed.id, claimed.token, (db, job) =>
      blockerCode(localDeletionBlockers(db, job.user_id!, job.profile_id!)) as LocalAccountDeletionJob['error_code'])
    if (media === 'blocked') {
      // The media helper persisted the ownership blocker before touching bytes.
      return getLocalDeletionReceipt(id)
    }
    await mutate(db => {
      const job = db.account_deletion_jobs.find(candidate => candidate.id === claimed.id)
      if (!job || job.state !== 'processing' || job.lease_token !== claimed.token ||
          !job.lease_expires_at || Date.parse(job.lease_expires_at) <= Date.now()) return
      if (!job.user_id || !job.profile_id) throw new Error('Local deletion job has no subject')
      const block = blockerCode(localDeletionBlockers(db, job.user_id, job.profile_id))
      if (block) {
        job.state = 'blocked'
        job.error_code = block as 'ownership_transfer_required' | 'owner_role_inconsistent' | 'last_administrator'
      } else {
        removePersonalContent(db, job)
        job.state = 'completed'
        job.phase = 'complete'
        job.completed_at = now()
        job.user_id = job.profile_id = job.idempotency_key = null
        job.error_code = null
        db.account_deletion_media = db.account_deletion_media.filter(row => row.deletion_job_id !== job.id)
      }
      job.lease_token = job.lease_expires_at = null
      job.updated_at = now()
      db.account_retained_moderation = db.account_retained_moderation.filter(row => Date.parse(row.expires_at) > Date.now())
    })
  } catch {
    // Fixed error codes only: never persist an exception containing user data.
    await mutate(db => {
      const job = db.account_deletion_jobs.find(candidate => candidate.id === claimed.id)
      if (!job || job.state !== 'processing' || job.lease_token !== claimed.token) return
      job.state = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry'
      job.error_code = 'cleanup_failed'
      job.next_attempt_at = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1))).toISOString()
      job.lease_token = job.lease_expires_at = null
      job.updated_at = now()
    })
  }
  return getLocalDeletionReceipt(id)
}

/** Operator hook, not an HTTP action. A retry never bypasses ownership checks. */
export async function retryLocalAccountDeletionJob(id: string): Promise<boolean> {
  return mutate(db => {
    const job = db.account_deletion_jobs.find(candidate => candidate.id === id)
    if (!job || !['blocked', 'failed'].includes(job.state)) return false
    job.state = 'retry'
    job.attempts = 0
    job.error_code = null
    job.next_attempt_at = now()
    job.updated_at = now()
    return true
  })
}

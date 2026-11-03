import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { id, mutate, now, readStore, type LocalProfile, type LocalProject, type Tables } from '@/lib/local/db'
import type { LocalProjectInvite } from '@/lib/local/domain-tables'
import { blockedPair, canManageLocalProject, canReadProfile, contentActive, localActor, profileActive, validLocalId } from '@/lib/local/access'
import { encodeCursor } from '@/lib/cursor'
import type { FormState } from '@/lib/form-state'

/** The recipient's intentional invitation, not the project's private content or a profile export. */
export type ProjectInvitation = {
  id: string
  projectId: string
  projectSlug: string
  projectTitle: string
  projectVisibility: LocalProject['visibility']
  message: string | null
  proposedRole: string | null
  createdAt: string
  canAccept: boolean
  refusalReason: 'already_member' | 'full' | 'unavailable' | null
}

export type InviteResponseState = FormState & {
  response?: 'accepted' | 'declined'
  projectPath?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VISIBILITIES = ['public', 'university', 'connections', 'private'] as const
const NOT_AVAILABLE: InviteResponseState = { status: 'error', message: 'That invitation is not available to this account.' }
const MAX_CANDIDATES = 100

export function validProjectInvitationId(value: string, local = isLocalMode()): boolean {
  return local ? validLocalId(value) : UUID.test(value)
}

function validSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && SLUG.test(value)
}

/** Never reflect provider messages, SQL details, private notes or identifiers in logs/errors. */
export function projectInvitationFailure(error: { code?: string; hint?: string | null }): FormState {
  if (error.code === 'PGRST202' || error.code === '42883') {
    return { status: 'error', message: 'Project invitations are unavailable until the invitation database update is installed.' }
  }
  if (error.hint === 'rate_limit_exceeded') {
    return { status: 'error', message: 'You are making project changes too quickly. Try again later. Nothing from this attempt was saved.' }
  }
  if (error.hint === 'project_full') {
    return { status: 'error', message: 'This project has reached its team size. You can decline or try accepting later.' }
  }
  if (error.hint === 'already_member') {
    return { status: 'error', message: 'You are already a member of this project. You can decline the outstanding invitation.' }
  }
  if (error.hint === 'already_converted' || error.code === '23505') {
    return { status: 'error', message: 'This idea has already become a project.' }
  }
  if (error.code === '42501' || error.code === 'P0002' || error.code === '23503') return NOT_AVAILABLE
  return { status: 'error', message: 'That change could not be saved. Please try again.' }
}

function accountAvailable(db: Tables, profile: LocalProfile | undefined): profile is LocalProfile {
  return Boolean(profile && db.users.some(user => user.id === profile.user_id) &&
    profileActive(db, profile.id) &&
    !db.account_deletion_jobs.some(job => job.profile_id === profile.id && job.state !== 'completed'))
}

function projectAvailable(db: Tables, project: LocalProject | undefined): project is LocalProject {
  return Boolean(project && !project.deleted_at && contentActive(db, 'project', project.id) &&
    !['completed', 'archived', 'abandoned'].includes(project.status) &&
    accountAvailable(db, db.profiles.find(profile => profile.id === project.owner_id)))
}

function blockedFromTeam(db: Tables, project: LocalProject, inviteeId: string, inviterId: string): boolean {
  return blockedPair(db, inviteeId, project.owner_id) || blockedPair(db, inviteeId, inviterId) ||
    db.project_members.some(member => member.project_id === project.id && blockedPair(db, inviteeId, member.profile_id))
}

function invitationAvailable(db: Tables, invite: LocalProjectInvite, viewer: LocalProfile): LocalProject | null {
  const project = db.projects.find(row => row.id === invite.project_id)
  const inviter = db.profiles.find(row => row.id === invite.inviter_id)
  if (invite.status !== 'pending' || invite.invitee_id !== viewer.id ||
      !accountAvailable(db, viewer) || !accountAvailable(db, inviter) || !projectAvailable(db, project) ||
      !canManageLocalProject(db, project.id, inviter) ||
      blockedPair(db, viewer.id, inviter.id) || blockedPair(db, viewer.id, project.owner_id)) return null
  return project
}

function acceptanceRefusal(db: Tables, project: LocalProject, invite: LocalProjectInvite, viewer: LocalProfile): ProjectInvitation['refusalReason'] {
  if (db.project_members.some(row => row.project_id === project.id && row.profile_id === viewer.id)) return 'already_member'
  if (viewer.allow_connection_requests === false || blockedFromTeam(db, project, viewer.id, invite.inviter_id)) return 'unavailable'
  const target = project.team_size_target
  if (target !== null && (!Number.isInteger(target) || target < 1 || target > 50 ||
      db.project_members.filter(row => row.project_id === project.id).length >= target)) return 'full'
  return null
}

/** Bodyless and deduplicated, inside the same store transaction as the accepted outcome. */
function notifyLocal(db: Tables, type: string, recipientId: string, actorId: string, projectId: string, createdAt: string) {
  if (recipientId === actorId || blockedPair(db, recipientId, actorId) ||
      !accountAvailable(db, db.profiles.find(row => row.id === recipientId)) ||
      db.notifications.some(row => row.type === type && row.recipient_id === recipientId &&
        row.actor_id === actorId && row.project_id === projectId)) return
  db.notifications.push({
    id: id('ntf'), type, recipient_id: recipientId, actor_id: actorId, body: null,
    is_read: false, created_at: createdAt, project_id: projectId,
    post_id: null, comment_id: null, idea_id: null, event_id: null,
    opportunity_id: null, conversation_id: null,
  })
}

/**
 * Conversion-only helper. The caller MUST hold mutate's lock, bind the inviter
 * from its verified user, and supply remaining mandatory project-write slots.
 * Profile privacy is not overridden by staff status. No interest note is copied.
 */
export function inviteIdeaParticipantsLocal(
  db: Tables, ideaId: string, project: LocalProject, inviter: LocalProfile,
  remainingSlots: number, createdAt: string,
): number {
  if (!accountAvailable(db, inviter) || !projectAvailable(db, project) ||
      !canManageLocalProject(db, project.id, inviter) ||
      !Number.isSafeInteger(remainingSlots) || remainingSlots < 0) return 0
  if (project.team_size_target !== null &&
      (!Number.isInteger(project.team_size_target) || project.team_size_target < 1 ||
        project.team_size_target > 50 ||
        db.project_members.filter(row => row.project_id === project.id).length >= project.team_size_target)) return 0
  let invited = 0
  const candidates = db.idea_interest.filter(row => row.idea_id === ideaId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.profile_id.localeCompare(b.profile_id))
    .slice(0, MAX_CANDIDATES)
  for (const candidate of candidates) {
    if (invited >= remainingSlots) break
    const recipient = db.profiles.find(row => row.id === candidate.profile_id)
    if (!accountAvailable(db, recipient) || recipient.id === inviter.id ||
        !canReadProfile(db, recipient, inviter) || recipient.allow_connection_requests === false ||
        blockedFromTeam(db, project, recipient.id, inviter.id) ||
        db.project_members.some(row => row.project_id === project.id && row.profile_id === recipient.id) ||
        db.project_invites.some(row => row.project_id === project.id && row.invitee_id === recipient.id)) continue
    db.project_invites.push({
      id: id('pin'), project_id: project.id, invitee_id: recipient.id, inviter_id: inviter.id,
      message: 'You said you would help build this. It is a project now.',
      proposed_role: null, status: 'pending', responded_at: null,
      created_at: createdAt, updated_at: createdAt,
    })
    notifyLocal(db, 'project_invite', recipient.id, inviter.id, project.id, createdAt)
    invited += 1
  }
  return invited
}

/** Server-only identity argument, never a posted recipient/profile ID. */
export async function respondToProjectInvitationLocal(
  userId: string, inviteId: string, response: 'accepted' | 'declined',
): Promise<InviteResponseState> {
  if (!validProjectInvitationId(inviteId, true) || (response !== 'accepted' && response !== 'declined')) return NOT_AVAILABLE
  return mutate<InviteResponseState>(db => {
    const viewer = localActor(db, userId)
    const invite = db.project_invites.find(row => row.id === inviteId && row.invitee_id === viewer?.id)
    if (!viewer || !invite) return NOT_AVAILABLE
    const project = invitationAvailable(db, invite, viewer)
    if (!project) return NOT_AVAILABLE
    if (response === 'accepted') {
      const refusal = acceptanceRefusal(db, project, invite, viewer)
      if (refusal) return refusal === 'unavailable' ? NOT_AVAILABLE :
        projectInvitationFailure({ hint: refusal === 'full' ? 'project_full' : 'already_member' })
    }
    const createdAt = now()
    if (response === 'accepted') {
      const previousMembers = db.project_members.filter(row => row.project_id === project.id)
      db.project_members.push({ id: id('mem'), project_id: project.id, profile_id: viewer.id, role: 'member', created_at: createdAt })
      project.member_count = db.project_members.filter(row => row.project_id === project.id).length
      for (const member of previousMembers) notifyLocal(db, 'project_member_joined', member.profile_id, viewer.id, project.id, createdAt)
    }
    invite.status = response
    invite.responded_at = createdAt
    invite.updated_at = createdAt
    notifyLocal(db, `project_invite_${response}`, invite.inviter_id, viewer.id, project.id, createdAt)
    return {
      status: 'success', response,
      message: response === 'accepted' ? 'Invitation accepted. You are now a project member.' : 'Invitation declined. You have not joined the project.',
      ...(response === 'accepted' ? { projectPath: `/projects/${project.slug}` } : {}),
    }
  })
}

function decodeInvitationCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value || value.length > 512) return null
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const split = decoded.lastIndexOf('|')
    const createdAt = decoded.slice(0, split)
    const cursorId = decoded.slice(split + 1)
    return split > 0 && Number.isFinite(Date.parse(createdAt)) && validProjectInvitationId(cursorId)
      ? { createdAt, id: cursorId } : null
  } catch { return null }
}

function projectInvitationDTO(raw: unknown): ProjectInvitation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (typeof row.invite_id !== 'string' || !validProjectInvitationId(row.invite_id) ||
      typeof row.project_id !== 'string' || !validProjectInvitationId(row.project_id) ||
      !validSlug(row.project_slug) || typeof row.project_title !== 'string' ||
      row.project_title.length < 3 || row.project_title.length > 120 ||
      !VISIBILITIES.includes(row.project_visibility as LocalProject['visibility']) ||
      !(row.message === null || (typeof row.message === 'string' && row.message.length <= 1000)) ||
      !(row.proposed_role === null || (typeof row.proposed_role === 'string' && row.proposed_role.length <= 80)) ||
      typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)) ||
      typeof row.can_accept !== 'boolean' ||
      ![null, 'already_member', 'full', 'unavailable'].includes(row.refusal_reason as null | string) ||
      row.can_accept !== (row.refusal_reason === null)) return null
  return {
    id: row.invite_id, projectId: row.project_id, projectSlug: row.project_slug,
    projectTitle: row.project_title, projectVisibility: row.project_visibility as LocalProject['visibility'],
    message: row.message as string | null, proposedRole: row.proposed_role as string | null,
    createdAt: row.created_at, canAccept: row.can_accept,
    refusalReason: row.refusal_reason as ProjectInvitation['refusalReason'],
  }
}

export async function listMyProjectInvitations({
  projectSlug, limit = 30, cursor,
}: { projectSlug?: string; limit?: number; cursor?: string } = {}): Promise<{
  invitations: ProjectInvitation[]; nextCursor: string | null; error: string | null
}> {
  const empty = { invitations: [] as ProjectInvitation[], nextCursor: null, error: null }
  if (projectSlug !== undefined && !validSlug(projectSlug)) return { ...empty, error: 'That project could not be identified.' }
  const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(30, limit)) : 30
  const before = decodeInvitationCursor(cursor)
  if (cursor && !before) return { ...empty, error: 'That invitation page could not be identified.' }
  if (!isLocalMode() && !isSupabaseConfigured()) return { ...empty, error: 'Project invitations need a configured hosted service.' }
  const user = await getUser()
  if (!user) return empty
  let rows: ProjectInvitation[]
  if (isLocalMode()) {
    const db = await readStore()
    const viewer = localActor(db, user.id)
    if (!viewer) return empty
    rows = db.project_invites.flatMap(invite => {
      const project = invitationAvailable(db, invite, viewer)
      if (!project || (projectSlug !== undefined && project.slug !== projectSlug)) return []
      const refusalReason = acceptanceRefusal(db, project, invite, viewer)
      return [{
        id: invite.id, projectId: project.id, projectSlug: project.slug, projectTitle: project.title,
        projectVisibility: project.visibility, message: invite.message, proposedRole: invite.proposed_role,
        createdAt: invite.created_at, canAccept: refusalReason === null, refusalReason,
      }]
    }).filter(row => !before || row.createdAt < before.createdAt ||
      (row.createdAt === before.createdAt && row.id < before.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, pageSize + 1)
  } else {
    try {
      const supabase = await createClient()
      const { data, error } = await supabase.rpc('project_invitation_inbox', {
        p_project_slug: projectSlug ?? null, p_limit: pageSize + 1,
        p_before_at: before?.createdAt ?? null, p_before_id: before?.id ?? null,
      })
      if (error) return { ...empty, error: projectInvitationFailure(error).message! }
      if (!Array.isArray(data)) return { ...empty, error: 'Your invitations could not be loaded.' }
      const projected = data.map(projectInvitationDTO)
      if (projected.some(row => row === null)) return { ...empty, error: 'Your invitations could not be loaded.' }
      rows = projected as ProjectInvitation[]
    } catch { return { ...empty, error: 'Your invitations could not be loaded.' } }
  }
  const invitations = rows.slice(0, pageSize)
  const last = invitations.at(-1)
  return { invitations, nextCursor: rows.length > pageSize && last
    ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null, error: null }
}

/** Can be read before getProjectBySlug: an invite does not expose a private project page. */
export async function getMyProjectInvitation(projectSlug: string): Promise<{
  invitation: ProjectInvitation | null; error: string | null
}> {
  const result = await listMyProjectInvitations({ projectSlug, limit: 1 })
  return { invitation: result.invitations[0] ?? null, error: result.error }
}

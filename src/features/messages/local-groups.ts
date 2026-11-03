import 'server-only'

import { cookies } from 'next/headers'
import { id, mutate, now, type LocalParticipant, type LocalProfile, type Tables } from '@/lib/local/db'
import { blockedPair, canMessageLocal, canReadProfile, connectedPair, validLocalId } from '@/lib/local/access'
import { getLocalUserFromSnapshot, LOCAL_SESSION_COOKIE } from '@/lib/local/session'
import {
  activeMessageMembershipLocal,
  canReadConversationHistoryLocal,
  leaveMessageMembershipLocal,
  registerMessageMembershipLocal,
  rejoinMessageMembershipLocal,
} from './local-access'
import {
  FINAL_GROUP_ADMIN_COPY,
  GROUP_ACTIVE_LIMIT,
  GROUP_HANDLE_LIMIT,
  GROUP_RECORDED_LIMIT,
  GROUP_UNAVAILABLE_COPY,
} from './group-contract'
import type { GroupChangeOutcome, GroupManagementPane, GroupMember } from './types'

type AdditionResult =
  | { ok: true; conversationId: string; added: number; skipped: number }
  | { ok: false; message: string }

function participant(db: Tables, conversationId: string, profileId: string) {
  return db.conversation_participants.find(row =>
    row.conversation_id === conversationId && row.profile_id === profileId)
}

/** Missing legacy roles grant no management authority. */
export function isGroupAdminLocal(db: Tables, conversationId: string, viewer: LocalProfile) {
  return db.conversations.some(row => row.id === conversationId && row.type === 'group') &&
    participant(db, conversationId, viewer.id)?.role === 'admin' &&
    activeMessageMembershipLocal(db, conversationId, viewer.id)
}

function accountAvailable(db: Tables, profileId: string) {
  const profile = db.profiles.find(row => row.id === profileId)
  const user = profile && db.users.find(row => row.id === profile.user_id)
  if (!profile || !user || user.disabled_at != null ||
      db.account_deletion_jobs.some(job => job.user_id === user.id && job.state !== 'completed')) return false
  const state = db.profile_account_states.find(row => row.profile_id === profileId)
  if (state?.status !== 'suspended') return true
  // Match the session contract: a malformed deadline is not an expired ban.
  const deadline = state.suspended_until ? Date.parse(state.suspended_until) : NaN
  return Number.isFinite(deadline) && deadline <= Date.now()
}

export function finalGroupAdminLocal(db: Tables, conversationId: string, viewer: LocalProfile) {
  return isGroupAdminLocal(db, conversationId, viewer) &&
    !db.conversation_participants.some(row =>
      row.conversation_id === conversationId && row.profile_id !== viewer.id &&
      row.role === 'admin' && activeMessageMembershipLocal(db, conversationId, row.profile_id) &&
      accountAvailable(db, row.profile_id))
}

function canManage(db: Tables, conversationId: string, viewer: LocalProfile) {
  return accountAvailable(db, viewer.id) && isGroupAdminLocal(db, conversationId, viewer) &&
    canReadConversationHistoryLocal(db, conversationId, viewer)
}

/** Current reachability, not a guessed invitation/consent record. */
export function canAddGroupMemberLocal(
  db: Tables,
  conversationId: string | null,
  viewer: LocalProfile,
  targetId: string,
) {
  return accountAvailable(db, targetId) &&
    connectedPair(db, viewer.id, targetId) &&
    canMessageLocal(db, viewer, targetId) &&
    !db.conversation_participants.some(row =>
      row.conversation_id === conversationId && blockedPair(db, row.profile_id, targetId))
}

/** Resolve the real bearer against THIS locked snapshot, not a getUser mock/preflight. */
function lockedActor(db: Tables, cookie: string | undefined) {
  const session = getLocalUserFromSnapshot(db, cookie)
  return session?.profile && accountAvailable(db, session.profile.id) ? session.profile : null
}

function validHandles(handles: string[]) {
  return handles.length > 0 && handles.length <= GROUP_HANDLE_LIMIT &&
    handles.every(handle => /^[a-z0-9_.]{3,30}$/.test(handle))
}

function appendMember(db: Tables, conversationId: string, profileId: string, role: 'admin' | 'member', at: string) {
  const row: LocalParticipant & { joined_at: string } = {
    id: id('par'), conversation_id: conversationId, profile_id: profileId,
    role, joined_at: at, last_read_at: at,
  }
  db.conversation_participants.push(row)
  registerMessageMembershipLocal(db, conversationId, profileId, at)
}

export async function createGroupLocal(title: string, handles: string[]): Promise<AdditionResult> {
  if (!title.trim() || title.trim().length > 120 || !validHandles(handles)) {
    return { ok: false, message: 'Check the group name and handles.' }
  }
  const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  return mutate(db => {
    const me = lockedActor(db, cookie)
    if (!me) return { ok: false, message: 'Please sign in to do that.' }
    const targets: string[] = []
    let skipped = 0
    for (const handle of new Set(handles)) {
      const target = db.profiles.find(row => row.username.toLowerCase() === handle)
      if (!target || !canAddGroupMemberLocal(db, null, me, target.id) ||
          targets.some(profileId => blockedPair(db, profileId, target.id))) {
        skipped += 1
      } else {
        targets.push(target.id)
      }
    }
    if (!targets.length) return {
      ok: false, message: 'No one was added, so no group was created. Choose a reachable accepted connection.',
    }
    const conversationId = id('cnv')
    const joinedAt = now()
    db.conversations.push({
      id: conversationId, type: 'group', title: title.trim(), created_at: joinedAt,
      last_message_at: null, last_message_preview: null,
    })
    appendMember(db, conversationId, me.id, 'admin', joinedAt)
    for (const profileId of targets) appendMember(db, conversationId, profileId, 'member', joinedAt)
    return { ok: true, conversationId, added: targets.length, skipped }
  })
}

export async function addGroupMembersLocal(conversationId: string, handles: string[]): Promise<AdditionResult> {
  if (!validLocalId(conversationId) || !validHandles(handles)) {
    return { ok: false, message: 'Check the group and handles.' }
  }
  const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  return mutate(db => {
    const me = lockedActor(db, cookie)
    if (!me || !canManage(db, conversationId, me)) return { ok: false, message: GROUP_UNAVAILABLE_COPY }
    let added = 0
    let skipped = 0
    for (const handle of new Set(handles)) {
      const target = db.profiles.find(row => row.username.toLowerCase() === handle)
      const rows = db.conversation_participants.filter(row => row.conversation_id === conversationId)
      if (!target || !canAddGroupMemberLocal(db, conversationId, me, target.id) ||
          activeMessageMembershipLocal(db, conversationId, target.id) ||
          rows.filter(row => activeMessageMembershipLocal(db, conversationId, row.profile_id)).length >= GROUP_ACTIVE_LIMIT) {
        skipped += 1
        continue
      }
      const existing = participant(db, conversationId, target.id)
      const joinedAt = now()
      if (existing) {
        if (!rejoinMessageMembershipLocal(db, conversationId, target.id, joinedAt)) {
          skipped += 1
          continue
        }
        // A departed admin never silently regains that authority.
        existing.role = 'member'
      } else {
        if (rows.length >= GROUP_RECORDED_LIMIT) {
          skipped += 1
          continue
        }
        appendMember(db, conversationId, target.id, 'member', joinedAt)
      }
      added += 1
    }
    return { ok: true, conversationId, added, skipped }
  })
}

export async function setGroupRoleLocal(
  conversationId: string,
  profileId: string,
  role: 'admin' | 'member',
): Promise<GroupChangeOutcome> {
  if (!validLocalId(conversationId) || !validLocalId(profileId) ||
      !['admin', 'member'].includes(role)) return { ok: false, message: GROUP_UNAVAILABLE_COPY }
  const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  return mutate(db => {
    const me = lockedActor(db, cookie)
    const target = participant(db, conversationId, profileId)
    if (!me || !canManage(db, conversationId, me) || !target ||
        !activeMessageMembershipLocal(db, conversationId, profileId) || !accountAvailable(db, profileId)) {
      return { ok: false, message: GROUP_UNAVAILABLE_COPY }
    }
    const targetProfile = db.profiles.find(row => row.id === profileId)!
    if (role === 'member' && target.role === 'admin' && finalGroupAdminLocal(db, conversationId, targetProfile)) {
      return { ok: false, message: FINAL_GROUP_ADMIN_COPY }
    }
    target.role = role
    return { ok: true, message: 'Member role saved.' }
  })
}

export async function removeGroupMemberLocal(conversationId: string, profileId: string): Promise<GroupChangeOutcome> {
  if (!validLocalId(conversationId) || !validLocalId(profileId)) return { ok: false, message: GROUP_UNAVAILABLE_COPY }
  const cookie = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  return mutate(db => {
    const me = lockedActor(db, cookie)
    const target = db.profiles.find(row => row.id === profileId)
    if (!me || !canManage(db, conversationId, me) || !target ||
        !activeMessageMembershipLocal(db, conversationId, profileId)) {
      return { ok: false, message: GROUP_UNAVAILABLE_COPY }
    }
    if (finalGroupAdminLocal(db, conversationId, target)) return { ok: false, message: FINAL_GROUP_ADMIN_COPY }
    if (!leaveMessageMembershipLocal(db, conversationId, profileId, now())) {
      return { ok: false, message: GROUP_UNAVAILABLE_COPY }
    }
    return { ok: true, message: 'Member removed. Their permitted history remains readable.' }
  })
}

export function groupManagementPaneLocal(
  db: Tables,
  conversationId: string,
  viewer: LocalProfile,
): GroupManagementPane | null {
  if (!db.conversations.some(row => row.id === conversationId && row.type === 'group') ||
      !accountAvailable(db, viewer.id) ||
      !activeMessageMembershipLocal(db, conversationId, viewer.id) ||
      !canReadConversationHistoryLocal(db, conversationId, viewer)) return null
  const rows = db.conversation_participants.filter(row => row.conversation_id === conversationId)
  const members: GroupMember[] = rows.map((row): GroupMember => {
    const profile = db.profiles.find(candidate => candidate.id === row.profile_id)
    const left = !activeMessageMembershipLocal(db, conversationId, row.profile_id)
    return {
      profile_id: row.profile_id,
      role: row.role === 'admin' ? 'admin' : 'member',
      left,
      available: accountAvailable(db, row.profile_id),
      profile: profile && canReadProfile(db, profile, viewer) ? {
        id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url,
      } : null,
    }
  }).sort((a, b) => Number(a.left) - Number(b.left) ||
    Number(b.role === 'admin') - Number(a.role === 'admin') ||
    a.profile_id.localeCompare(b.profile_id))
  return {
    role: participant(db, conversationId, viewer.id)?.role === 'admin' ? 'admin' : 'member',
    active_count: members.filter(row => !row.left).length,
    admin_count: members.filter(row => !row.left && row.role === 'admin' && row.available).length,
    recorded_count: rows.length,
    has_more: members.length > GROUP_RECORDED_LIMIT,
    members: members.slice(0, GROUP_RECORDED_LIMIT),
  }
}

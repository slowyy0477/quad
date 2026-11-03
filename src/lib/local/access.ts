import type { LocalProfile, Tables } from '@/lib/local/db'

export function localActor(db: Tables, userId: string | null): LocalProfile | null {
  if (!userId) return null
  const profile = db.profiles.find(row => row.user_id === userId) ?? null
  if (profile && !profileActive(db, profile.id)) return null
  const state = profile && db.profile_account_states?.find(row => row.profile_id === profile.id)
  if (state?.status === 'suspended' && (!state.suspended_until || state.suspended_until > new Date().toISOString())) return null
  return profile
}
export function profileActive(db: Tables, profileId: string): boolean {
  const profile = db.profiles.find(row => row.id === profileId)
  if (!profile) return false
  const account = db.users.find(row => row.id === profile.user_id) as { disabled_at?: string | null } | undefined
  if (account?.disabled_at) return false
  const state = db.profile_account_states.find(row => row.profile_id === profileId)
  return !(state?.status === 'suspended' && (!state.suspended_until || state.suspended_until > new Date().toISOString()))
}
export function validLocalId(value: string): boolean {
  return /^[a-z0-9]+_[a-z0-9]{1,64}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
export function localStaff(db: Tables, viewer: LocalProfile | null, role: 'admin' | 'moderator' = 'moderator'): boolean {
  return Boolean(viewer && localActor(db, viewer.user_id) && db.user_roles.some(row => row.user_id === viewer.user_id && (row.role === 'admin' || (role === 'moderator' && row.role === 'moderator'))))
}
export function blockedPair(db: Tables, a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && db.blocks?.some(row => (row.blocker_id === a && row.blocked_id === b) || (row.blocker_id === b && row.blocked_id === a)))
}
export function connectedPair(db: Tables, a: string | null | undefined, b: string): boolean {
  return Boolean(a && !blockedPair(db, a, b) && db.connections?.some(row => row.status === 'accepted' && ((row.requester_id === a && row.addressee_id === b) || (row.requester_id === b && row.addressee_id === a))))
}
export function canReadConversation(db: Tables, conversationId: string, viewer: LocalProfile | null): boolean {
  if (!viewer || !db.conversations.some(row => row.id === conversationId)) return false
  const mine = db.conversation_participants.find(row => row.conversation_id === conversationId && row.profile_id === viewer.id)
  if (!mine || db.participant_preferences.some(row => row.conversation_id === conversationId && row.profile_id === viewer.id && row.left_at)) return false
  return !db.conversation_participants.some(row => row.conversation_id === conversationId && blockedPair(db, row.profile_id, viewer.id))
}
export function canMessageLocal(db: Tables, viewer: LocalProfile | null, targetId: string): boolean {
  const target = db.profiles.find(row => row.id === targetId)
  if (!viewer || !target || viewer.id === target.id || !canReadProfile(db, target, viewer)) return false
  switch (target.allow_messages_from ?? 'everyone') {
    case 'everyone': return true
    case 'university': return Boolean(viewer.university_id && viewer.university_id === target.university_id)
    case 'connections': return connectedPair(db, viewer.id, target.id)
    default: return false
  }
}

export function contentActive(db: Tables, kind: string, targetId: string): boolean {
  return !db.content_moderation?.some(row => row.kind === kind && row.target_id === targetId && row.status !== 'active')
}
export function canReadContent(db: Tables, row: { id: string; visibility: string; deleted_at?: string | null }, ownerId: string, viewer: LocalProfile | null, kind: string): boolean {
  if (row.deleted_at || !contentActive(db, kind, row.id) || !profileActive(db, ownerId) || blockedPair(db, ownerId, viewer?.id)) return false
  const owner = db.profiles.find(profile => profile.id === ownerId)
  if (!owner) return false
  if (viewer?.id === ownerId) return true
  if (kind === 'project' && viewer && db.project_members.some(member => member.project_id === row.id && member.profile_id === viewer.id)) return true
  if (row.visibility === 'public') return true
  if (row.visibility === 'university') return Boolean(viewer?.university_id && viewer.university_id === owner.university_id)
  if (row.visibility === 'connections') return connectedPair(db, viewer?.id, ownerId)
  return false
}
export function canManageLocalProject(db: Tables, projectId: string, viewer: LocalProfile | null): boolean {
  const project = db.projects.find(row => row.id === projectId)
  if (!project || !viewer || !canReadContent(db, project, project.owner_id, viewer, 'project')) return false
  return project.owner_id === viewer.id || db.project_members.some(row => row.project_id === project.id && row.profile_id === viewer.id && row.role === 'maintainer')
}

export function canReadProfile(db: Tables, target: LocalProfile | undefined | null, viewer: LocalProfile | null): boolean {
  if (!target || !profileActive(db, target.id) || blockedPair(db, target.id, viewer?.id)) return false
  if (viewer?.id === target.id) return true
  const state = db.profile_account_states?.find(row => row.profile_id === target.id)
  if (state?.status === 'suspended' && (!state.suspended_until || state.suspended_until > new Date().toISOString())) return false
  if (target.visibility === 'public') return true
  if (target.visibility === 'university') return Boolean(viewer?.university_id && viewer.university_id === target.university_id)
  if (target.visibility === 'connections') return connectedPair(db, viewer?.id, target.id)
  return false
}

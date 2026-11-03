import {
  blockedPair,
  canMessageLocal,
  contentActive,
  profileActive,
} from '@/lib/local/access'
import type { LocalMessage, LocalParticipant, LocalProfile, Tables } from '@/lib/local/db'

/** Messaging-only sidecar. readStore/mutate preserve additional array tables. */
export type MessageMembership = {
  conversation_id: string
  profile_id: string
  joined_at: string
  left_at: string | null
}

type MessagingTables = Tables & { message_memberships?: MessageMembership[] }
type TimedParticipant = LocalParticipant & { joined_at?: string }
type RetriableMessage = LocalMessage & {
  client_nonce?: string
  edited_at?: string | null
  deleted_at?: string | null
}

function preference(db: Tables, conversationId: string, profileId: string) {
  return db.participant_preferences.find(
    row => row.conversation_id === conversationId && row.profile_id === profileId,
  )
}

export function messageMembershipsLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
): MessageMembership[] {
  const conversation = db.conversations.find(row => row.id === conversationId)
  const participant = db.conversation_participants.find(
    row => row.conversation_id === conversationId && row.profile_id === profileId,
  ) as TimedParticipant | undefined
  if (!conversation || !participant) return []

  const saved = (db as MessagingTables).message_memberships?.filter(
    row => row.conversation_id === conversationId && row.profile_id === profileId,
  )
  const leftAt = preference(db, conversationId, profileId)?.left_at ?? null
  // Old JSON had no join timestamp. Conversation creation is the only recorded
  // lower bound; new memberships always have an explicit, durable interval.
  const intervals = saved?.length ? saved : [{
    conversation_id: conversationId,
    profile_id: profileId,
    joined_at: participant.joined_at ?? conversation.created_at,
    left_at: leftAt,
  }]

  // A legacy caller setting left_at can narrow an active interval, never widen
  // a saved closed one by clearing that preference later.
  return intervals.map(row => ({
    ...row,
    left_at: row.left_at ?? leftAt,
  }))
}

export function activeMessageMembershipLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
): boolean {
  return messageMembershipsLocal(db, conversationId, profileId).some(row =>
    row.left_at === null && Number.isFinite(Date.parse(row.joined_at)) &&
    Date.parse(row.joined_at) <= Date.now(),
  )
}

export function canReadConversationHistoryLocal(
  db: Tables,
  conversationId: string,
  viewer: LocalProfile | null,
): boolean {
  return Boolean(
    viewer &&
    profileActive(db, viewer.id) &&
    messageMembershipsLocal(db, conversationId, viewer.id).length &&
    !db.conversation_participants.some(
      row => row.conversation_id === conversationId && blockedPair(db, viewer.id, row.profile_id),
    ),
  )
}

function inInterval(timestamp: string, interval: MessageMembership): boolean {
  const value = Date.parse(timestamp)
  const joined = Date.parse(interval.joined_at)
  const left = interval.left_at === null ? Infinity : Date.parse(interval.left_at)
  return Number.isFinite(value) && Number.isFinite(joined) &&
    (interval.left_at === null || Number.isFinite(left)) &&
    value >= joined && value <= left
}

/** Bodyless activity still must fall inside an actual readable membership. */
export function canReadConversationActivityLocal(
  db: Tables,
  conversationId: string,
  timestamp: string,
  viewer: LocalProfile | null,
): boolean {
  return Boolean(viewer && canReadConversationHistoryLocal(db, conversationId, viewer) &&
    messageMembershipsLocal(db, conversationId, viewer.id).some(interval =>
      inInterval(timestamp, interval),
    ))
}

/** Use this predicate for threads, previews, unread and local report eligibility. */
export function canReadMessageLocal(
  db: Tables,
  message: LocalMessage,
  viewer: LocalProfile | null,
): boolean {
  if (!viewer || !canReadConversationHistoryLocal(db, message.conversation_id, viewer)) return false
  const row = message as RetriableMessage
  if (row.deleted_at || !contentActive(db, 'message', row.id)) return false
  const intervals = messageMembershipsLocal(db, message.conversation_id, viewer.id)
  return intervals.some(interval => inInterval(row.created_at, interval)) &&
    (!row.edited_at || intervals.some(interval => inInterval(row.edited_at!, interval)))
}

/** Message-specific, minimal target lookup for the main moderation integration. */
export function messageReportTargetLocal(db: Tables, targetId: string, viewer: LocalProfile | null) {
  const message = db.messages.find(row => row.id === targetId)
  if (!message || !canReadMessageLocal(db, message, viewer)) return null
  return {
    kind: 'message' as const,
    id: message.id,
    body: message.body,
    createdAt: message.created_at,
    moderationStatus: 'active',
  }
}

export function canStartDirectMessageLocal(db: Tables, viewer: LocalProfile | null, targetId: string) {
  return canMessageLocal(db, viewer, targetId)
}

export function messageSendRefusalLocal(
  db: Tables,
  conversationId: string,
  viewer: LocalProfile,
): 'not_participant' | 'blocked' | 'messaging_not_permitted' | null {
  const conversation = db.conversations.find(row => row.id === conversationId)
  if (!conversation || !activeMessageMembershipLocal(db, conversationId, viewer.id)) {
    return 'not_participant'
  }
  const others = db.conversation_participants.filter(
    row => row.conversation_id === conversationId && row.profile_id !== viewer.id,
  )
  if (others.some(row => blockedPair(db, viewer.id, row.profile_id))) return 'blocked'
  if (conversation.type !== 'direct') return null
  if (others.length !== 1 || !activeMessageMembershipLocal(db, conversationId, others[0].profile_id)) {
    return 'messaging_not_permitted'
  }
  const target = db.profiles.find(row => row.id === others[0].profile_id)
  if (!target || !profileActive(db, target.id)) return 'messaging_not_permitted'
  // Existing membership, not profile publication, authorizes this send. A
  // private profile must not disable a previously consented, otherwise valid DM.
  switch (target.allow_messages_from ?? 'everyone') {
    case 'everyone': return null
    case 'university':
      return viewer.university_id && viewer.university_id === target.university_id
        ? null : 'messaging_not_permitted'
    case 'connections':
      return db.connections.some(row => row.status === 'accepted' &&
        ((row.requester_id === viewer.id && row.addressee_id === target.id) ||
         (row.requester_id === target.id && row.addressee_id === viewer.id)))
        ? null : 'messaging_not_permitted'
    default: return 'messaging_not_permitted'
  }
}

function persistedMemberships(db: Tables): MessageMembership[] {
  return (db as MessagingTables).message_memberships ??= []
}

export function registerMessageMembershipLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
  joinedAt: string,
) {
  persistedMemberships(db).push({
    conversation_id: conversationId, profile_id: profileId, joined_at: joinedAt, left_at: null,
  })
}

/** Caller authentication/authorization belongs to the action owning this mutation. */
export function leaveMessageMembershipLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
  leftAt: string,
): boolean {
  if (!activeMessageMembershipLocal(db, conversationId, profileId)) return false
  const current = messageMembershipsLocal(db, conversationId, profileId)
  if (current.some(row => row.left_at === null && !inInterval(leftAt, row))) return false
  const saved = persistedMemberships(db)
  if (!saved.some(row => row.conversation_id === conversationId && row.profile_id === profileId)) {
    saved.push(...current)
  }
  for (const row of saved) {
    if (row.conversation_id === conversationId && row.profile_id === profileId && row.left_at === null) {
      row.left_at = leftAt
    }
  }
  const existing = preference(db, conversationId, profileId)
  if (existing) existing.left_at = leftAt
  else db.participant_preferences.push({
    id: `pref_${profileId}`, conversation_id: conversationId, profile_id: profileId,
    is_muted: false, left_at: leftAt,
  })
  return true
}

/** Authorization belongs to the owning action; every rejoin is a new interval. */
export function rejoinMessageMembershipLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
  joinedAt: string,
) {
  const conversation = db.conversations.find(row => row.id === conversationId)
  const participant = db.conversation_participants.find(
    row => row.conversation_id === conversationId && row.profile_id === profileId,
  )
  if (!conversation || !participant) return false
  if (activeMessageMembershipLocal(db, conversationId, profileId)) return true
  const old = messageMembershipsLocal(db, conversationId, profileId)
  if (!old.length) return false
  const joined = Date.parse(joinedAt)
  if (!Number.isFinite(joined) || old.some(row =>
    row.left_at === null || !Number.isFinite(Date.parse(row.left_at)) ||
    !inInterval(row.left_at, row) || Date.parse(row.left_at) > joined,
  )) return false
  const saved = persistedMemberships(db)
  if (!saved.some(row => row.conversation_id === conversationId && row.profile_id === profileId)) {
    saved.push(...old)
  }
  // A legacy leave may exist only in preferences while an older sidecar row is
  // still open. Persist that effective cutoff BEFORE clearing the preference.
  for (const row of saved) {
    if (row.conversation_id !== conversationId || row.profile_id !== profileId || row.left_at !== null) continue
    const closed = old.find(interval => interval.joined_at === row.joined_at)
    if (closed?.left_at) row.left_at = closed.left_at
  }
  registerMessageMembershipLocal(db, conversationId, profileId, joinedAt)
  const existing = preference(db, conversationId, profileId)
  if (existing) existing.left_at = null
  participant.last_read_at = joinedAt
  return true
}

/** Explicit direct rejoin affects the caller only, never the other participant. */
export function rejoinDirectMessageMembershipLocal(
  db: Tables,
  conversationId: string,
  profileId: string,
  joinedAt: string,
) {
  if (db.conversations.find(row => row.id === conversationId)?.type !== 'direct') return false
  return rejoinMessageMembershipLocal(db, conversationId, profileId, joinedAt)
}

export function retriableMessageLocal(message: LocalMessage): RetriableMessage {
  return message
}

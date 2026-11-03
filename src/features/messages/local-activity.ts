import 'server-only'

import { blockedPair, localActor, profileActive } from '@/lib/local/access'
import { id, type LocalMessage, type LocalNotification, type Tables } from '@/lib/local/db'
import {
  activeMessageMembershipLocal,
  canReadConversationActivityLocal,
  messageSendRefusalLocal,
} from './local-access'

/** Optional legacy/hosted-shaped sidecar; a missing preference means enabled. */
type ActivityTables = Tables & {
  notification_preferences?: {
    profile_id: string
    category: string
    in_app_enabled: boolean
  }[]
}
type ActivityNotification = LocalNotification & {
  skill_id?: string | null
  achievement_key?: string | null
  read_at?: string | null
}

function sameActivity(row: ActivityNotification, recipientId: string, message: LocalMessage) {
  // Match the cloud NULLS NOT DISTINCT key, not merely a conversation ID. A
  // notification about another target must never be repurposed or resurfaced.
  return row.type === 'message' && row.recipient_id === recipientId &&
    row.actor_id === message.author_id && row.conversation_id === message.conversation_id &&
    row.post_id == null && row.comment_id == null && row.project_id == null &&
    row.idea_id == null && row.event_id == null && row.opportunity_id == null &&
    row.skill_id == null && row.achievement_key == null
}

/**
 * app.notify_message / app.create_notification, inside the accepted-send lock.
 *
 * Only call for a NEW message, never an acknowledged nonce replay. The message,
 * bodyless recipient-owned activity row and mandatory budget commit together.
 * A new send resurfaces the same sender/conversation row; muting or opting out
 * suppresses future notifications, not readable messages or their unread count.
 * DM consent is rechecked; group membership remains separate from DM settings.
 */
export function notifyMessageLocal(db: Tables, message: LocalMessage): void {
  const author = db.profiles.find(row => row.id === message.author_id)
  const sender = localActor(db, author?.user_id ?? null)
  if (!sender || messageSendRefusalLocal(db, message.conversation_id, sender)) return

  const recipientIds = new Set(db.conversation_participants
    .filter(row => row.conversation_id === message.conversation_id && row.profile_id !== sender.id)
    .map(row => row.profile_id))

  for (const recipientId of recipientIds) {
    const recipient = db.profiles.find(row => row.id === recipientId)
    if (!recipient || !db.users.some(row => row.id === recipient.user_id) ||
        !profileActive(db, recipientId) || blockedPair(db, sender.id, recipientId) ||
        !activeMessageMembershipLocal(db, message.conversation_id, recipientId) ||
        !canReadConversationActivityLocal(db, message.conversation_id, message.created_at, recipient)) continue
    if (db.participant_preferences.some(row => row.conversation_id === message.conversation_id &&
        row.profile_id === recipientId && row.is_muted)) continue
    if ((db as ActivityTables).notification_preferences?.some(row =>
      row.profile_id === recipientId && row.category === 'messages' && row.in_app_enabled === false,
    )) continue

    const existing = db.notifications.find(row =>
      sameActivity(row, recipientId, message),
    ) as ActivityNotification | undefined
    if (existing) {
      existing.created_at = message.created_at
      existing.is_read = false
      existing.body = null
      if ('read_at' in existing) existing.read_at = null
    } else {
      db.notifications.push({
        id: id('ntf'), recipient_id: recipientId, actor_id: sender.id,
        type: 'message', body: null, is_read: false, created_at: message.created_at,
        post_id: null, comment_id: null, project_id: null, idea_id: null,
        event_id: null, opportunity_id: null, conversation_id: message.conversation_id,
      })
    }
  }
}

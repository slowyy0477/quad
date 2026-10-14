import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { decodeCursor, type Cursor } from '@/lib/cursor'

/**
 * Notification reads.
 *
 * The writes are not here and must not be: notifications are created in the database by
 * triggers through `app.create_notification`, de-duplicated by a unique constraint with
 * `nulls not distinct`, and 77 tests assert that a client cannot forge one. The reader's
 * job is to display them truthfully and to count them once.
 *
 * The unread count is a real `count` query rather than `rows.length` of a limited page.
 * A badge that says "9" because that is how many fitted in the fetch is the exact kind of
 * invented number PRODUCT.md rule 1 forbids.
 */

export type NotificationRow = {
  id: string
  type: string
  body: string | null
  is_read: boolean
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
  actor: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  } | null
}

const NOTIFICATION_SELECT = `
  id, type, body, is_read, created_at,
  post_id, comment_id, project_id, idea_id, event_id, opportunity_id, conversation_id,
  actor:profiles!notifications_actor_id_fkey ( id, username, display_name, avatar_url )
`

export async function getUnreadNotificationCount(): Promise<number> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false)

  if (error) {
    // A missing badge is a cosmetic failure; a thrown error would take the whole page
    // down for it. The failure is logged and reported as zero.
    console.error('[notifications:unreadCount]', error.code, error.message)
    return 0
  }

  return count ?? 0
}

export async function getNotifications({
  limit = 30,
  cursor,
}: { limit?: number; cursor?: string | string[] } = {}): Promise<{
  notifications: NotificationRow[] | null
  nextCursor: Cursor | null
  error: string | null
}> {
  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('notifications')
    .select(NOTIFICATION_SELECT)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    // Keyset, not offset: the page boundary has to hold while rows are being written.
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<NotificationRow[]>()

  if (error) {
    console.error('[notifications:list]', error.code, error.message)
    return { notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)

  return {
    notifications: rows,
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

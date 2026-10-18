'use client'

import { useEffect } from 'react'
import { markConversationReadAction } from '@/features/messages/actions'

/**
 * Mark the conversation read, once, on open.
 *
 * Read state is stored: `mark_conversation_read` resets
 * `conversation_participants.unread_count` and stamps `last_read_at` together, in
 * one statement, scoped to the caller's row. There is no client-side "seen" flag
 * anywhere in this feature, and there is nothing here that could invent one —
 * `unread_count` is not even in the reader's UPDATE grant.
 *
 * It does not force a re-render afterwards, and that is a decision rather than an
 * omission: the unread divider on this page was drawn from the state when the page
 * was rendered, and pulling it away under the reader's eyes a moment later is
 * jankier than leaving it where it was. It is gone on the next visit, and the
 * stored timestamp is already correct.
 *
 * The effect is the right tool here and only here: it fires one request to an
 * external system when the reader opens a conversation. It calls no setState, so it
 * is not the pattern `react-hooks/set-state-in-effect` exists to refuse.
 */
export function MarkConversationRead({
  conversationId,
  unread,
}: {
  conversationId: string
  unread: number
}) {
  useEffect(() => {
    if (unread <= 0) return

    void markConversationReadAction(conversationId).catch(() => {
      // A failed mark-read is not worth interrupting someone who is only reading.
      // The count stays until the next visit, which is the honest fallback: the
      // interface never claims a read state the database did not accept.
    })
  }, [conversationId, unread])

  return null
}

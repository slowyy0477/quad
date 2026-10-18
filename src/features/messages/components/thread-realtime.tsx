'use client'

import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { markConversationReadAction } from '@/features/messages/actions'
import { ConnectionState } from './connection-state'
import { scopedFilter, useCoalescedRefresh, useRowSubscription } from './channel'

/**
 * The thread's subscription, and the honest state of it.
 *
 * Subscribes to `messages` inserts scoped to this conversation. An arriving row is
 * treated as a **signal**, not as content: the handler marks the conversation read
 * (the reader is looking at it, so the definition of read is at least "now") and
 * asks the server to re-render. The row itself never gets rendered from the socket
 * payload, which means the picture on screen always comes from a normal,
 * RLS-checked read — the socket can only say "look again".
 *
 * That choice costs a round trip per burst and buys two things worth more: there is
 * only one code path that decides what a message looks like, and a bug in Realtime's
 * row filtering cannot put text on the screen that a `select` would have refused.
 * ARCHITECTURE §4's stronger claim — that RLS applies to the socket — is *unproven
 * here*; see the header of `channel.ts`.
 *
 * The refresh coalesces (one request per burst) and the state is reported as one of
 * four words, with a manual refresh beside it whenever the socket is not live.
 */
export function ThreadRealtime({ conversationId }: { conversationId: string }) {
  const router = useRouter()
  // Throws rather than subscribing unscoped if the id is not a uuid.
  const filter = scopedFilter('conversation_id', conversationId)
  const schedule = useCoalescedRefresh(() => router.refresh())

  const onEvent = useCallback(() => {
    // Read by definition: the message is on screen. A refusal here is ignored on
    // purpose — the reader is reading, not asking for anything to be saved.
    void markConversationReadAction(conversationId).catch(() => {})
    schedule()
  }, [conversationId, schedule])

  const status = useRowSubscription({
    channelName: `messages:${conversationId}`,
    table: 'messages',
    filter,
    events: 'INSERT',
    onEvent,
  })

  return (
    <ConnectionState
      status={status}
      onRefresh={() => router.refresh()}
      className="ml-auto shrink-0"
    />
  )
}

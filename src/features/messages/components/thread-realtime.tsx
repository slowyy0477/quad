'use client'

import { useRouter } from 'next/navigation'
import { ConnectionState } from './connection-state'
import { scopedFilter, useCoalescedRefresh, useDurableReconcile, useRowSubscription, type ChannelStatus } from './channel'

const MESSAGE_EVENTS = ['INSERT', 'UPDATE'] as const

function combinedStatus(message: ChannelStatus, membership: ChannelStatus, active: boolean): ChannelStatus {
  const states = active ? [message, membership] : [membership]
  if (states.includes('offline')) return 'offline'
  if (states.includes('reconnecting')) return 'reconnecting'
  if (states.includes('connecting')) return 'connecting'
  return 'live'
}

/**
 * The thread's subscription, and the honest state of it.
 *
 * Subscribes to `messages` inserts scoped to this conversation. An arriving row is
 * treated as a **signal**, not as content: the handler asks the server to
 * re-render. Read state is stamped only after a newest-page render, never from a
 * payload that has not appeared on screen. The row never gets rendered from the socket
 * payload, which means the picture on screen always comes from a normal,
 * RLS-checked read — the socket can only say "look again".
 *
 * That choice costs a round trip per burst and buys two things worth more: there is
 * only one code path that decides what a message looks like, and a bug in Realtime's
 * row filtering cannot put text on the screen that a `select` would have refused.
 * ARCHITECTURE §4's stronger claim — that RLS applies to the socket — is *unproven
 * here*; see the header of `channel.ts`.
 *
 * The refresh coalesces (one request per burst), including a durable history
 * refresh on reconnect. The state has four words and a manual refresh when offline.
 */
export function ThreadRealtime({
  conversationId, readerProfileId, active = true,
}: { conversationId: string; readerProfileId: string; active?: boolean }) {
  const router = useRouter()
  // Throws rather than subscribing unscoped if the id is not a uuid.
  const filter = scopedFilter('conversation_id', conversationId)
  const schedule = useCoalescedRefresh(() => router.refresh())

  const messageStatus = useRowSubscription({
    channelName: `messages:${conversationId}`,
    table: 'messages',
    filter,
    events: MESSAGE_EVENTS,
    enabled: active,
    onEvent: schedule,
    onLive: schedule,
  })
  // Own-row SELECT remains allowed after departure. Re-add/role/removal signals
  // reconcile the server tree without subscribing a departed user to messages.
  const membershipStatus = useRowSubscription({
    channelName: `message-membership:${readerProfileId}:${conversationId}`,
    table: 'conversation_participants',
    filter: scopedFilter('profile_id', readerProfileId),
    events: 'UPDATE',
    onEvent: schedule,
    onLive: schedule,
  })
  useDurableReconcile(schedule, conversationId)

  return (
    <ConnectionState
      status={combinedStatus(messageStatus, membershipStatus, active)}
      onRefresh={() => router.refresh()}
      className="ml-auto shrink-0"
    />
  )
}

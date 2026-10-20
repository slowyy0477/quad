'use client'

/**
 * Realtime subscriptions, and the one assertion that keeps them scoped.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM THIS FILE DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * ARCHITECTURE §4 says of Realtime: "RLS applies to Realtime too, so a
 * subscription cannot leak rows the user can't already read." That claim is
 * **unproven here**, and it cannot be proven from this repository: proving it
 * needs a live Supabase project, two real sessions, and an insert from one of
 * them that the other must not receive. Nothing in this codebase can stand in for
 * that. The whole RLS suite (700+ tests) runs against PostgreSQL in PGlite and
 * says nothing at all about the Realtime service, which is a separate program
 * with its own row filtering.
 *
 * What this file *can* do is make the weaker half of the promise structurally
 * true: a subscription here always carries a filter scoped to this reader — the
 * conversation id for messages, the recipient id for notifications — so a channel
 * that receives the whole table cannot be constructed by accident, by a copy-paste,
 * or by a future edit that forgets an argument. `scopedFilter` refuses anything
 * that is not `<column>=eq.<uuid>` and `subscribeToRows` re-checks before it
 * subscribes. The subject is also asserted again in the database layer's own
 * terms: `messages_select_participant` and `notifications_select` remain the only
 * thing that decides what a session may read, and the payloads this hook receives
 * are treated as *signals* (see `useRowSubscription`'s callers), not as data to
 * render unexamined.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE READER IS TOLD
 * ---------------------------------------------------------------------------
 * The connection state is reported honestly, as one of four words, and when it is
 * not `live` the interface offers a manual refresh rather than a spinner that
 * implies something is still working. A socket that has quietly died while the
 * page says "Live" is the failure mode worth designing against, not the one where
 * a message takes two seconds.
 *
 * ---------------------------------------------------------------------------
 * LOCAL MODE: NO SUBSCRIPTION, AND NO "LIVE"
 * ---------------------------------------------------------------------------
 * `data/local.json` has no websocket behind it, so there is nothing to subscribe to.
 * The choice here is to say so rather than to imitate it: in local mode no channel
 * is opened and no interval is started, and the status stays `offline`, which
 * `ConnectionState` renders as "Not connected" *with* the Refresh control beside it —
 * a real way to re-read the thread, and a truthful account of how messages arrive.
 *
 * Polling was the alternative and was rejected on purpose: an interval that called
 * `router.refresh()` would have to report itself as something, and "Live" from a
 * ten-second timer is the exact lie this file's four words exist to prevent. The
 * cost of the honest choice is that a message sent from another tab appears on
 * refresh rather than by itself — in a single-machine local deployment that is a
 * click, not a lost feature, and `docs/plan/LOCAL-MODE.md` already states that
 * realtime is polling-only and not wired.
 *
 * The id check also differs by mode, for the same reason the queries do: local ids
 * are `cnv_…` rather than uuids, and `scopedFilter` refuses anything it cannot
 * recognise as an id rather than subscribing unscoped.
 */

import { useEffect, useRef, useState } from 'react'
import { isLocalMode } from '@/lib/mode'
import { createClient } from '@/lib/supabase/client'

/** The four states a reader can be told about. There is no fifth. */
export type ChannelStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** The only two tables this application subscribes to. ARCHITECTURE §4. */
export type SubscribedTable = 'messages' | 'notifications'

declare const scoped: unique symbol

/**
 * A filter that is known to name a column and a real uuid.
 *
 * Branded so that `subscribeToRows` cannot be called with a bare string: the only
 * way to obtain one is `scopedFilter`, which validates first. This is the type
 * system's half of the "no unfiltered subscription" rule; the runtime check inside
 * `subscribeToRows` is the other half, because a cast can defeat a brand.
 */
export type ScopedFilter = string & { readonly [scoped]: true }

const SCOPED = /^[a-z_]+=eq\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The shape a local id has (`id('<prefix>')` in `@/lib/local/db`).
 *
 * A scoped filter in local mode is still a scoped filter — one conversation, named
 * exactly — it simply names a store id instead of a uuid. It is accepted only when
 * the build is in local mode, so a malformed uuid cannot slip through in the mode
 * where the filter really is handed to a socket.
 */
const LOCAL_SCOPED = /^[a-z_]+=eq\.[a-z]+_[a-z0-9]{1,64}$/

/**
 * Build the row filter for a subscription, or throw.
 *
 * A blank id, a placeholder, or a wrong shape is a bug in the caller, and the
 * loud answer is the right one: subscribing without a filter would open a channel
 * to every row of the table that the socket's own row filter allows, which is
 * precisely the thing that must not depend on a policy being configured correctly.
 */
export function scopedFilter(
  column: 'conversation_id' | 'recipient_id',
  id: string,
): ScopedFilter {
  const value = `${column}=eq.${id}`
  const valid = SCOPED.test(value) || (isLocalMode() && LOCAL_SCOPED.test(value))
  if (!valid) {
    throw new Error(
      `Refusing to subscribe with the filter "${value}": a realtime subscription must be ` +
        'scoped to one conversation or one recipient, by id.',
    )
  }
  return value as ScopedFilter
}

export function isScopedFilter(filter: string): boolean {
  return SCOPED.test(filter) || (isLocalMode() && LOCAL_SCOPED.test(filter))
}

/** Supabase's raw status strings, mapped. Unknown strings are "still connecting". */
export function toChannelStatus(raw: string): ChannelStatus {
  switch (raw) {
    case 'SUBSCRIBED':
      return 'live'
    case 'CHANNEL_ERROR':
    case 'TIMED_OUT':
      return 'reconnecting'
    case 'CLOSED':
      return 'offline'
    default:
      return 'connecting'
  }
}

export function statusLabel(status: ChannelStatus): string {
  switch (status) {
    case 'live':
      return 'Live'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'offline':
      return 'Not connected'
    default:
      return 'Connecting…'
  }
}

export type RowSubscription = {
  channelName: string
  table: SubscribedTable
  filter: ScopedFilter
  /** Which row events matter. Notifications resurface (an UPDATE), so they use '*'. */
  events?: 'INSERT' | 'UPDATE' | '*'
  /** Called for every matching row event. A signal, not something to render raw. */
  onEvent: (payload: unknown) => void
  onStatus: (status: ChannelStatus) => void
}

/**
 * Open one scoped channel and subscribe.
 *
 * Returns the channel's teardown rather than the channel itself: a caller that
 * could reach the channel could call `.on()` again without a filter, which is the
 * hole this function exists to close. A channel name that omits the scope is also
 * refused, so two readers' threads can never share a channel.
 */
export function subscribeToRows({
  channelName,
  table,
  filter,
  events = 'INSERT',
  onEvent,
  onStatus,
}: RowSubscription): { unsubscribe: () => void } {
  if (!isScopedFilter(filter)) {
    throw new Error(
      `Refusing to subscribe on "${table}" with an unscoped filter. Checked here as well as ` +
        'at the type level because a cast defeats a brand.',
    )
  }
  // The scope has to be in the channel *name* as well as the filter. Two readers
  // opening a channel with the same name would join one topic on the socket, and
  // the row filter of whichever subscribed last is the one that would apply.
  const scope = filter.slice(filter.indexOf('=eq.') + 4)
  if (!channelName.includes(scope)) {
    throw new Error(
      'Refusing to open a channel whose name does not carry its own scope: a shared channel ' +
        'would let the socket of another reader decide the filter for this one.',
    )
  }

  // Local mode has no websocket to open. Reporting `offline` here rather than
  // pretending to be `live` is the whole point: `ConnectionState` shows "Not
  // connected" and a working Refresh, and nothing claims a message will arrive by
  // itself when it cannot. See the header note on why this is preferred to polling.
  if (isLocalMode()) {
    onStatus('offline')
    return { unsubscribe: () => {} }
  }

  const supabase = createClient()

  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      { event: events, schema: 'public', table, filter },
      (payload: unknown) => {
        onEvent(payload)
      },
    )
    .subscribe((raw: string) => {
      onStatus(toChannelStatus(raw))
    })

  return {
    unsubscribe: () => {
      void supabase.removeChannel(channel)
      onStatus('offline')
    },
  }
}

/**
 * The hook form, for a Client Component.
 *
 * The `onEvent` callback lives in a ref so that a component passing an inline
 * arrow function — the normal case — does not tear the channel down and rebuild it
 * on every render. Reconnecting a socket per keystroke is the kind of bug that
 * shows up as "realtime is flaky", so it is designed out here rather than
 * documented as a requirement on callers.
 */
export function useRowSubscription({
  channelName,
  table,
  filter,
  events = 'INSERT',
  onEvent,
}: Omit<RowSubscription, 'onStatus'>): ChannelStatus {
  // Local mode starts — and stays — `offline`: there is no socket, and a spinner
  // for one that will never open is the failure this file is written against.
  const [status, setStatus] = useState<ChannelStatus>(isLocalMode() ? 'offline' : 'connecting')
  const handler = useRef(onEvent)

  // Not setState-in-an-effect: this assigns a ref to the newest callback after
  // every render, which is what the library needs and what the lint rule allows.
  useEffect(() => {
    handler.current = onEvent
  })

  useEffect(() => {
    // Local mode: nothing to connect to, and the status is already `offline`. Skipped
    // here as well as inside `subscribeToRows` so no client is constructed at all.
    if (isLocalMode()) return

    const subscription = subscribeToRows({
      channelName,
      table,
      filter,
      events,
      onEvent: (payload) => {
        handler.current(payload)
      },
      onStatus: setStatus,
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [channelName, table, filter, events])

  return status
}

/**
 * A refresh that coalesces.
 *
 * A burst of messages arrives as a burst of events, and one server render per
 * message would be a request storm for a conversation somebody is typing into.
 * The first event schedules a single refresh; everything inside the window rides
 * along with it, so no event is dropped — the refresh sees whatever the database
 * holds when it runs.
 */
export function useCoalescedRefresh(
  refresh: () => void,
  windowMs = 400,
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  return () => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      refresh()
    }, windowMs)
  }
}

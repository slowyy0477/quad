import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/ui/surface'
import { buildThreadRenderPlan } from '@/features/messages/thread-plan'
import type { ConversationPane, ThreadPage } from '@/features/messages/types'
import { ConversationActions } from './conversation-actions'
import { MarkConversationRead } from './mark-conversation-read'
import { DaySeparator, MessageBubble, ParticipantName, UnreadDivider } from './message-bubble'
import { MessageComposer } from './message-composer'
import { ThreadRealtime } from './thread-realtime'
import { BackToNewest, ThreadPagination } from './thread-pagination'

/**
 * One conversation: its header, its messages, and its composer.
 *
 * Everything here is decided by the server. The only client components are the
 * composer (state and keystrokes), the subscription (a browser API), the effect
 * that stamps the read state, and the two row actions — which is the whole budget
 * UX §7 allows a route without an argument.
 *
 * The layout answers the two sizes in the milestone brief:
 *
 *   * **768 px and up** — the pane is a fixed-height column inside the two-column
 *     grid the page lays out: header, a scroll region for the messages, composer at
 *     the foot of the pane. The pane scrolls, not the page, which is what keeps the
 *     conversation list still while the thread moves.
 *   * **360 px** — the thread is the whole view, the page scrolls it, and the
 *     composer is pinned clear of the bottom navigation bar rather than behind it.
 *     At `sm` the bottom bar is gone, so the pinning stops and the composer returns
 *     to normal flow. The back control to the conversation list is a link, and it
 *     says where it goes.
 *
 * The unread divider is drawn from the stored `last_read_at`; nothing on this page
 * invents a read state, and `MarkConversationRead` writes the real one.
 */
export function Thread({
  pane,
  page,
  meId,
  hasCursor,
  now,
}: {
  pane: ConversationPane
  page: ThreadPage
  meId: string
  /** True when the reader is looking at an older page rather than the newest. */
  hasCursor: boolean
  now: Date
}) {
  const messages = page.messages ?? []
  const rows = buildThreadRenderPlan({
    messages,
    meId,
    lastReadAt: pane.last_read_at,
    now,
  })

  const title = pane.type === 'group' ? (pane.title ?? 'Group conversation') : null

  return (
    <section
      aria-labelledby="thread-heading"
      className="flex min-h-0 flex-col md:h-[calc(100dvh-10rem)]"
    >
      <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <Link
          href="/messages"
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded pr-1 text-sm text-ink-muted md:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          All
        </Link>

        <Avatar
          name={title ?? pane.other?.display_name ?? 'A student'}
          src={pane.other?.avatar_url ?? null}
          size="sm"
        />

        <div className="min-w-0 flex-1">
          <h2 id="thread-heading" className="flex items-center gap-2 text-base">
            {title ? (
              <span className="truncate font-display text-base text-ink">{title}</span>
            ) : (
              <ParticipantName author={pane.other} />
            )}
          </h2>

          <p className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
            {pane.is_muted ? <Badge tone="outline">Muted</Badge> : null}
            {pane.i_blocked ? <Badge tone="danger">Blocked</Badge> : null}
            {pane.left ? <Badge tone="outline">You left</Badge> : null}
            {!pane.is_muted && !pane.i_blocked && !pane.left ? (
              <span>Messages are private to the people in this conversation.</span>
            ) : null}
          </p>
        </div>

        <ThreadRealtime conversationId={pane.id} />

        <ConversationActions
          conversationId={pane.id}
          isMuted={pane.is_muted}
          unreadCount={pane.unread_count}
        />
      </header>

      {page.error ? (
        <div className="px-3 py-3">
          <Alert tone="danger">{page.error}</Alert>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 md:flex-1">
        <div className="py-2">
          {hasCursor ? <BackToNewest conversationId={pane.id} /> : null}

          {messages.length > 0 ? (
            <ThreadPagination
              conversationId={pane.id}
              olderCursor={page.olderCursor}
              hasOlder={page.hasOlder}
            />
          ) : null}

          {messages.length === 0 ? (
            <div className="p-3">
              <EmptyState title="No messages here yet">
                <p>
                  The conversation exists but nothing has been sent in it. The first message is the
                  only hard one.
                </p>
              </EmptyState>
            </div>
          ) : (
            rows.map((row) => {
              if (row.kind === 'day') return <DaySeparator key={row.key} label={row.label} />
              if (row.kind === 'unread') return <UnreadDivider key={row.key} />
              return (
                <MessageBubble
                  key={row.key}
                  message={row.message}
                  mine={row.mine}
                  time={row.time}
                />
              )
            })
          )}
        </div>
      </ScrollArea>

      <MarkConversationRead conversationId={pane.id} unread={pane.unread_count} />

      <div className="sticky bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] z-10 border-t border-rule bg-paper p-3 sm:static sm:bottom-auto sm:p-4">
        <ComposerArea pane={pane} />
      </div>
    </section>
  )
}

/**
 * The composer, or the reason there isn't one.
 *
 * Every branch here is a refusal the database would make, said before the reader
 * spends a keystroke on it — which is requirement 5 of the milestone: an interface
 * must not offer an action that will be refused. The one refusal it cannot see is a
 * block against the reader, and that one is deliberately *not* guessed at: the
 * composer stays and the database's sentence appears if it fires.
 */
function ComposerArea({ pane }: { pane: ConversationPane }) {
  if (pane.left) {
    return (
      <Alert tone="info" title="You left this conversation">
        <p>
          Its history stays readable, and nothing new can be sent from here.{' '}
          {pane.type === 'direct' && pane.other ? (
            <>
              To talk again, open{' '}
              <Link href={`/u/${pane.other.username}`} className="text-accent-700 underline underline-offset-2">
                {pane.other.display_name}&rsquo;s profile
              </Link>
              .
            </>
          ) : (
            'Only an admin of the group can add you back.'
          )}
        </p>
      </Alert>
    )
  }

  if (pane.type === 'direct' && pane.i_blocked) {
    return (
      <Alert tone="warning" title="You blocked this person">
        <p>
          A blocked person cannot send you messages and you cannot send them any.{' '}
          <Link href="/connections/blocked" className="text-accent-700 underline underline-offset-2">
            Manage your blocked accounts
          </Link>{' '}
          if you want to change that.
        </p>
      </Alert>
    )
  }

  return <MessageComposer conversationId={pane.id} />
}

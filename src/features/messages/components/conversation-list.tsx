import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Ban, BellOff, LogOut } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { EndOfList, LoadMore } from '@/components/ui/pagination'
import { EmptyState } from '@/components/ui/surface'
import { cn } from '@/lib/utils'
import { describeParticipants } from '@/features/messages/thread-plan'
import type { ConversationSummary } from '@/features/messages/types'
import { ConversationActions } from './conversation-actions'
import { NewConversationForm } from './new-conversation'

/**
 * The conversation list, and the panel around it.
 *
 * Each row shows the things the database actually stores — the counterpart, the
 * last message's preview, its time, and the reader's own unread count from
 * `conversation_participants` — and nothing that has been derived in the browser.
 * The unread badge is that stored integer; it is not "how many of the fetched rows
 * look new", which is the number that goes wrong first.
 *
 * Badges say what is true about the conversation rather than decorating it: muted
 * means notifications are off, blocked means the reader has blocked this person (so
 * a direct thread will refuse a send), left means the history is readable and new
 * messages are not.
 *
 * The row is a link and the actions are a sibling of it, never nested inside: a
 * dropdown trigger inside an anchor is not operable with a keyboard, and the link
 * must keep working for a middle-click.
 */
export function ConversationList({
  conversations,
  selectedId,
  loadMoreHref,
}: {
  conversations: ConversationSummary[]
  selectedId: string | null
  loadMoreHref: string | null
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-hairline px-3 py-3">
        <h2 className="font-display text-lg text-ink">Conversations</h2>
        <details className="mt-2">
          <summary className="cursor-pointer rounded text-sm text-ink-muted hover:text-ink">
            New message
          </summary>
          <div className="mt-3">
            <NewConversationForm />
          </div>
        </details>
      </div>

      {conversations.length === 0 ? (
        <div className="p-3">
          <EmptyState title="No conversations yet">
            <p>
              A conversation starts from someone&rsquo;s profile or from the handle above. There is
              nothing to show here until one does — no sample threads, and no messages from people
              you have not spoken to.
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <ul className="min-h-0 flex-1 divide-y divide-hairline">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="flex items-stretch gap-1">
                <ConversationRow
                  conversation={conversation}
                  selected={conversation.id === selectedId}
                />
              </li>
            ))}
          </ul>

          {loadMoreHref ? (
            <LoadMore href={loadMoreHref} label="More conversations" className="py-3" />
          ) : (
            <EndOfList label="That is every conversation." className="py-3" />
          )}
        </>
      )}
    </div>
  )
}

function conversationName(conversation: ConversationSummary): string {
  if (conversation.type === 'group') return conversation.title ?? 'Group conversation'
  return conversation.other?.display_name ?? 'A student'
}

/** The other participants, as a subtitle. Empty for a direct conversation. */
function subtitleOf(conversation: ConversationSummary): string | null {
  if (conversation.type !== 'group') return null
  const names = conversation.others.map((author) => author.display_name)
  return names.length > 0 ? describeParticipants(names) : null
}

function ConversationRow({
  conversation,
  selected,
}: {
  conversation: ConversationSummary
  selected: boolean
}) {
  const name = conversationName(conversation)
  const subtitle = subtitleOf(conversation)
  const time = formatDistanceToNowStrict(new Date(conversation.last_activity_at), {
    addSuffix: true,
  })

  return (
    <>
      <Link
        href={`/messages?c=${conversation.id}`}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-3 px-3 py-3',
          selected ? 'bg-paper-sunken' : 'hover:bg-paper-sunken',
        )}
      >
        <Avatar
          name={name}
          src={conversation.other?.avatar_url ?? null}
          size="sm"
          className="mt-0.5"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                'truncate text-sm',
                conversation.unread_count > 0 ? 'font-semibold text-ink' : 'text-ink',
              )}
            >
              {name}
            </span>
            <time
              dateTime={conversation.last_activity_at}
              className="shrink-0 text-2xs text-ink-faint tabular"
            >
              {time}
            </time>
          </div>

          {subtitle ? <p className="truncate text-2xs text-ink-faint">{subtitle}</p> : null}

          <p className="mt-0.5 truncate text-xs text-ink-muted">
            {conversation.last_message_preview ?? 'No messages yet'}
          </p>

          {conversation.unread_count > 0 ||
          conversation.is_muted ||
          conversation.i_blocked ||
          conversation.left ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {conversation.unread_count > 0 ? (
                <Badge
                  tone="accent"
                  className="tabular"
                  aria-label={`${conversation.unread_count} unread`}
                >
                  {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
                  <span className="sr-only"> unread</span>
                </Badge>
              ) : null}
              {conversation.is_muted ? (
                <Badge tone="outline">
                  <BellOff className="size-3" aria-hidden="true" />
                  Muted
                </Badge>
              ) : null}
              {conversation.i_blocked ? (
                <Badge tone="danger">
                  <Ban className="size-3" aria-hidden="true" />
                  Blocked
                </Badge>
              ) : null}
              {conversation.left ? (
                <Badge tone="outline">
                  <LogOut className="size-3" aria-hidden="true" />
                  You left
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      </Link>

      <div className="flex items-center pr-1">
        <ConversationActions
          conversationId={conversation.id}
          isMuted={conversation.is_muted}
          unreadCount={conversation.unread_count}
        />
      </div>
    </>
  )
}

import Link from 'next/link'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ThreadMessage } from '@/features/messages/types'

/**
 * One message, and the two things that are not a message: a day separator and the
 * unread divider.
 *
 * The bubble reads correctly for the reader's own messages and for everyone
 * else's — and it does that with alignment and a rule, not with a new colour.
 * The reader's own messages sit right, on the accent tint that already means
 * "this is yours"; other people's sit left on the raised paper. Colour alone would
 * fail for a reader who cannot distinguish the two, so the author's name is on
 * every message that is not the reader's, and the whole row carries an accessible
 * description of who said it when.
 *
 * A soft-deleted message renders as a note in place. The row is still there on
 * purpose (the schema keeps it so the thread does not rewrite itself), so the
 * interface shows a withdrawn message rather than silently closing the gap.
 */
export function MessageBubble({ message, mine, time }: { message: ThreadMessage; mine: boolean; time: string }) {
  const deleted = message.deleted_at != null

  return (
    <div className={cn('flex gap-2 px-3 py-1', mine ? 'justify-end' : 'justify-start')}>
      {!mine ? (
        <Avatar
          name={message.author?.display_name ?? 'A student'}
          src={message.author?.avatar_url ?? null}
          size="sm"
          className="mt-auto"
        />
      ) : null}

      <div className={cn('max-w-[min(34rem,85%)] min-w-0', mine ? 'text-right' : 'text-left')}>
        <p className="mb-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-faint">
          <span className={cn(mine ? 'order-2' : undefined)}>
            {mine ? 'You' : (message.author?.display_name ?? 'A student')}
          </span>
          <time dateTime={message.created_at} className="tabular">
            {time}
          </time>
          {message.is_edited ? <span>edited</span> : null}
        </p>

        {deleted ? (
          <p
            className={cn(
              'inline-block rounded border border-dashed border-rule px-2.5 py-1.5 text-sm text-ink-faint italic',
            )}
          >
            This message was withdrawn.
          </p>
        ) : (
          <div
            className={cn(
              'rounded border px-2.5 py-1.5 text-left text-sm whitespace-pre-wrap text-ink',
              mine ? 'border-accent-200 bg-accent-50' : 'border-hairline bg-paper-raised',
            )}
          >
            {message.body ? <p>{message.body}</p> : null}
            {message.attachment_name ? (
              <p className="mt-1 text-xs text-ink-faint">
                Attachment: {message.attachment_name} — not downloadable yet, because file storage is
                not set up in this deployment.
              </p>
            ) : null}
            {!message.body && !message.attachment_name ? (
              <p className="text-xs text-ink-faint">An empty message.</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

/** A rule with the day on it. Not a bubble: it is a boundary, not a message. */
export function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
      <span className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
        {label}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
    </div>
  )
}

/**
 * Where the reader stopped reading.
 *
 * Drawn from `conversation_participants.last_read_at` and nothing else, so it
 * means exactly what it says. It is marked plainly rather than in an accent the
 * design language reserves for things you can click.
 */
export function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-3 py-2" role="separator" aria-label="Unread messages start here">
      <span aria-hidden="true" className="h-px flex-1 bg-highlight-400/45" />
      <span className="text-2xs font-semibold tracking-[0.12em] text-highlight-700 uppercase">
        Unread messages
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-highlight-400/45" />
    </div>
  )
}

/** The counterpart's name in a thread header, linked only when it can be opened. */
export function ParticipantName({ author }: { author: { display_name: string; username: string } | null }) {
  if (!author) {
    return (
      <span className="flex items-center gap-2">
        <span className="truncate font-display text-base text-ink">A student</span>
        <Badge tone="outline">Profile not visible</Badge>
      </span>
    )
  }

  return (
    <Link href={`/u/${author.username}`} className="truncate rounded font-display text-base text-ink hover:underline">
      {author.display_name}
    </Link>
  )
}

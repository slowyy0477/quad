import Link from 'next/link'
import { Avatar } from '@/components/ui/avatar'
import { notificationTime } from '@/features/notifications/plan'
import type { NotificationView } from '@/features/notifications/types'
import { markOneReadAction } from '@/features/notifications/actions'

/**
 * One notification.
 *
 * The sentence, the link and the "unavailable" line all come from the view model, which
 * is the only place allowed to work them out — this component decides layout and nothing
 * else, so a rule about what may be linked cannot drift between the list and the row.
 *
 * `linksResolved` is false when the target lookups failed. In that state the row shows
 * neither a link (which might 404) nor "no longer available" (which would be a claim we
 * cannot support) — only the sentence, which is still true.
 *
 * A server component: the mark-as-read control is a plain form posting a server action, so
 * the list works before hydration and without JavaScript.
 */
export function NotificationRow({
  view,
  linksResolved,
}: {
  view: NotificationView
  linksResolved: boolean
}) {
  const when = notificationTime(view.created_at)

  return (
    <li className="flex gap-3 py-3.5">
      {/* The unread mark is a shape in the margin, not a coloured row: a tinted background
          drags the eye to every unread item at once and makes the list read as a wall. */}
      <span
        aria-hidden
        className={
          view.is_read
            ? 'mt-3.5 size-1.5 shrink-0 rounded-full bg-transparent'
            : 'mt-3.5 size-1.5 shrink-0 rounded-full bg-highlight-400'
        }
      />

      <Avatar name={view.actorName ?? 'Quad'} src={view.actorAvatar} className="size-8 shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className={view.is_read ? 'text-sm text-ink-muted' : 'text-sm text-ink'}>
            {view.is_read ? null : <span className="sr-only">Unread. </span>}
            {view.text}
          </p>
          <time dateTime={view.created_at} className="shrink-0 text-2xs tabular-nums text-ink-faint">
            {when}
          </time>
        </div>

        {view.detail ? (
          <p className="mt-1.5 border-l-2 border-rule pl-2.5 text-sm text-ink-muted">{view.detail}</p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          {linksResolved && view.target ? (
            <Link
              href={view.target.href}
              className="text-xs font-medium text-accent-700 underline-offset-4 hover:underline"
            >
              {view.target.label}
            </Link>
          ) : null}

          {linksResolved && view.targetUnavailable ? (
            <span className="text-xs text-ink-faint">That is no longer available to you.</span>
          ) : null}

          {view.unknownType ? (
            <span className="text-xs text-ink-faint">
              This build cannot describe this notification type.
            </span>
          ) : null}

          {view.is_read ? null : (
            <form action={markOneReadAction}>
              <input type="hidden" name="id" value={view.id} />
              <button
                type="submit"
                className="text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline"
              >
                Mark as read
              </button>
            </form>
          )}
        </div>
      </div>
    </li>
  )
}

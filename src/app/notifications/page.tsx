import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState } from '@/components/ui/surface'
import { encodeCursor } from '@/lib/cursor'
import { getUser } from '@/lib/supabase/server'
import {
  getNotifications,
  getTargetIndex,
  getUnreadNotificationCount,
} from '@/features/notifications/queries'
import { groupNotificationsByDay, toNotificationView } from '@/features/notifications/plan'
import { NotificationList } from '@/features/notifications/components/notification-list'
import { MarkAllRead } from '@/features/notifications/components/mark-all-read'
import { InviteResponse } from '@/features/projects/components/invite-response'
import { listMyProjectInvitations } from '@/features/projects/invitations'

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'Replies, requests, decisions and the things that happened while you were away.',
}

type SearchParams = Record<string, string | string[] | undefined>

/**
 * /notifications
 *
 * The page composes four things that must not contradict each other:
 *
 *   * the rows, from `getNotifications` (keyset paginated, so a write mid-scroll cannot
 *     duplicate or skip a row);
 *   * the unread count, from its own `count` query — not from the rows on this page, which
 *     is limited to thirty and would under-report on a busy account;
 *   * the target index, which decides what may be linked;
 *   * the sentence and grouping rules in `plan.ts`, which are pure and tested.
 *
 * When the target lookups fail the list still renders, without links, and says so above
 * itself. The alternative — marking everything unavailable — would be a lie about the
 * reader's own data.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const user = await getUser()

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
        <h1 className="text-3xl">Notifications</h1>
        <p className="mt-2 max-w-prose text-ink-muted">
          Replies, connection requests and decisions about your posts land here.
        </p>
        <EmptyState
          className="mt-8"
          title="Sign in to see yours"
          action={
            <Button asChild variant="primary">
              <Link href="/login?next=/notifications">Sign in</Link>
            </Button>
          }
        >
          Notifications are private to the account they belong to, so there is nothing to show
          until you sign in.
        </EmptyState>
      </div>
    )
  }

  const [{ notifications, nextCursor, error }, unread, invitations] = await Promise.all([
    getNotifications({ cursor: params.cursor }),
    getUnreadNotificationCount(),
    listMyProjectInvitations({
      cursor: Array.isArray(params.inviteCursor) ? params.inviteCursor[0] : params.inviteCursor,
      limit: 5,
    }),
  ])

  const rows = notifications ?? []
  const { index, error: indexError } = await getTargetIndex(rows)
  const days = groupNotificationsByDay(
    rows.map((row) => {
      const view = toNotificationView(row, index)
      return indexError ? { ...view, target: null, targetUnavailable: false } : view
    }),
    // One clock for the whole page, so a page rendered across midnight cannot label two
    // rows from the same instant as different days.
    new Date(),
  )

  return (
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <header className="border-b border-rule pb-4">
        <h1 className="text-3xl">Notifications</h1>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          Replies, requests, decisions and the things that happened while you were away. Only
          the account they belong to can read them.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm tabular-nums text-ink-muted">
            {unread === null ? 'Unread count could not be loaded.' :
              unread === 0 ? 'Nothing unread.' : unread === 1 ? 'One unread.' : `${unread} unread.`}
          </p>
          {unread !== null ? <MarkAllRead unread={unread} /> : null}
        </div>
      </header>

      {error ? (
        <Alert className="mt-6" tone="danger" title="Notifications could not be loaded">{error}</Alert>
      ) : null}

      {invitations.error ? (
        <Alert className="mt-6" tone="warning" title="Project invitations could not be loaded">
          {invitations.error}
        </Alert>
      ) : invitations.invitations.length > 0 ? (
        <section className="mt-6" aria-labelledby="project-invitations-heading">
          <h2 id="project-invitations-heading" className="mb-3 text-lg font-semibold text-ink">Project invitations</h2>
          <div className="space-y-3">
            {invitations.invitations.map((invitation) => (
              <InviteResponse key={invitation.id} invitation={invitation} />
            ))}
          </div>
          {invitations.nextCursor ? (
            <p className="mt-3 text-sm">
              <Link href="/projects/invitations" className="inline-flex min-h-11 items-center text-accent-700 underline underline-offset-4">
                View all project invitations
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}

      {indexError ? (
        <Alert className="mt-6" tone="warning" title="Some links could not be checked">
          {indexError}
        </Alert>
      ) : null}

      {days.length === 0 && !error && !invitations.error && invitations.invitations.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Nothing has happened yet"
          action={
            <Button asChild variant="secondary">
              <Link href="/feed">Go to the feed</Link>
            </Button>
          }
        >
          When someone replies to you, asks to connect, or a moderator decides something about
          your content, it will appear here.
        </EmptyState>
      ) : days.length > 0 ? (
        <div className="mt-7">
          <NotificationList days={days} linksResolved={!indexError} />
        </div>
      ) : null}

      {nextCursor ? (
        <div className="mt-8">
          <LoadMore href={cursorHref('/notifications', params, encodeCursor(nextCursor))} />
        </div>
      ) : days.length > 0 ? (
        <EndOfList label="That is everything." />
      ) : null}
    </div>
  )
}

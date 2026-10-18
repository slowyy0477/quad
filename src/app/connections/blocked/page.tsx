import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { BlockControl } from '@/features/connections/components/connection-controls'
import { PersonRow } from '@/features/connections/components/person-row'
import { listBlocked } from '@/features/connections/queries'
import { encodeCursor, nextCursor, parseCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Blocked accounts' }

const LIMIT = 25

type SearchParams = { cursor?: string | string[] }

/**
 * The blocked list.
 *
 * The only control here is Unblock — no Connect, no Follow. Offering a connection
 * to someone the reader has blocked would be a control that cannot work, because
 * the same trigger that refuses a request between a blocked pair would refuse it
 * here.
 *
 * It is also the only place a reader can see who they have blocked, and that is
 * one-directional by design: `blocks_select_own` shows a blocker their own rows,
 * so nobody learns that *they* have been blocked. The copy says so, because it is
 * the part people get wrong — they expect the other person to know.
 */
export default async function BlockedPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Alert tone="warning" title="No database connected">
        <p>
          Blocks are rows in Postgres. Without Supabase credentials there is nothing to list.{' '}
          <Link href="/setup">Configuration steps</Link>.
        </p>
      </Alert>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections/blocked')

  const params = await searchParams
  const cursor = parseCursor(params.cursor)

  const { items, error } = await listBlocked({ before: cursor?.createdAt, limit: LIMIT })

  const last = nextCursor(items)
  const nextHref = last ? cursorHref('/connections/blocked', params, encodeCursor(last)) : null

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Accounts you have blocked"
        description="They cannot find your profile, follow you or send you a request, and you cannot see theirs. Blocking them told them nothing, and unblocking tells them nothing either."
        className="border-b border-hairline"
      />

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {items.length > 0 ? (
        <>
          <ul className="divide-y divide-hairline">
            {items.map((item) => (
              <PersonRow
                key={item.id}
                person={item.person}
                meta={
                  <>
                    <time dateTime={item.created_at}>
                      Blocked{' '}
                      {new Date(item.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </time>
                    {/* The note is the blocker's own private reason, stored on the row.
                        Only they can read it, which is why it is safe to show here and
                        why it is never called a message. */}
                    {item.reason ? <p className="mt-1 text-ink-muted">Your note: {item.reason}</p> : null}
                  </>
                }
              >
                {item.person ? (
                  <BlockControl
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    isBlockingThem
                    signedIn
                    size="sm"
                  />
                ) : null}
              </PersonRow>
            ))}
          </ul>
          <p className="text-xs text-ink-faint">
            A person whose account is not visible here has been deleted, or has hidden their profile
            from everyone. The block is still recorded against them and is lifted the same way.
          </p>
        </>
      ) : (
        <EmptyState title="You have not blocked anyone">
          <p>
            Blocking is available from any profile, under the person&rsquo;s name. It is for the case
            where you do not want to be found by someone — not for a disagreement, which removing a
            connection already handles.
          </p>
          <p className="mt-2">
            <Link href="/connections" className="text-accent-700 underline underline-offset-2">
              Back to your connections
            </Link>
          </p>
        </EmptyState>
      )}

      {nextHref ? (
        <LoadMore href={nextHref} label="Load more" />
      ) : items.length > 0 ? (
        <EndOfList label="That is everyone you have blocked." />
      ) : null}
    </div>
  )
}

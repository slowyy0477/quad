import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/surface'
import { cursorHref } from '@/components/ui/pagination'
import { encodeCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'
import { ConversationList } from '@/features/messages/components/conversation-list'
import { NewConversationForm } from '@/features/messages/components/new-conversation'
import { Thread } from '@/features/messages/components/thread'
import {
  findMessagingTarget,
  getConversationPane,
  getMessagingPermission,
  listConversations,
  listThreadMessages,
} from '@/features/messages/queries'
import type { MessagingPermission } from '@/features/messages/types'

export const metadata: Metadata = { title: 'Messages' }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * Messages.
 *
 * One route, three query parameters, each with a job:
 *
 *   `?c=<conversation>`   which thread. The layout follows it: at 768 px and up the
 *                         list (20 rem) sits beside the thread; at 360 px the list
 *                         is the view and the thread *becomes* the view, with a back
 *                         control, because a 20 rem column and a conversation
 *                         cannot share a phone.
 *   `?before=<cursor>`    how far back in that thread. Opaque, keyset, and only
 *                         meaningful inside its own conversation — which the links
 *                         guarantee by always carrying both halves together.
 *   `?cursor=<cursor>`    how far down the conversation list.
 *   `?to=<handle>`        the address a profile page's "Message" control should point
 *                         at: it opens the one control that can start a conversation,
 *                         or says why it cannot be started.
 *
 * The list and the thread are read in parallel. Access control is RLS throughout:
 * `getConversationPane` returns null for a conversation that does not exist *and* for
 * one that is not the reader's, and a null pane renders the list with a notice
 * instead of a 404, so a mismatched id is not a dead end.
 *
 * The thread's cursor is passed straight through — a `before` from another
 * conversation produces a legal, harmless page (the query is scoped to `?c`), and
 * every control this page renders keeps the pair together.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Messages</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Conversations are rows in Postgres. Without Supabase credentials there is nothing to
            read, and this page will not show invented ones.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/messages')

  const params = await searchParams
  const selectedId = first(params.c)
  const beforeCursor = first(params.before)
  const handle = first(params.to)

  const [list, pane] = await Promise.all([
    listConversations({ meId: user.id, cursor: params.cursor }),
    selectedId && UUID.test(selectedId)
      ? getConversationPane(selectedId, user.id)
      : Promise.resolve(null),
  ])

  const thread = pane
    ? await listThreadMessages({ conversationId: pane.id, cursor: params.before })
    : null

  const listHref = list.nextCursor
    ? cursorHref(
        '/messages',
        { ...params, c: selectedId ?? undefined, before: beforeCursor ?? undefined },
        encodeCursor(list.nextCursor),
      )
    : null

  const showStartPanel = handle !== null && pane === null
  const target = showStartPanel ? await findMessagingTarget(handle) : null
  const permission: MessagingPermission | null =
    target && showStartPanel ? await getMessagingPermission(user.id, target.id) : null

  return (
    <div className="mx-auto w-full max-w-6xl pb-16 sm:px-6 sm:pb-8">
      <div className="px-3 pt-6 pb-3 sm:px-0">
        <h1 className="font-display text-2xl text-ink">Messages</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Private conversations. Row level security decides what each side can read, so a
          conversation id on its own opens nothing.
        </p>
      </div>

      {showStartPanel ? (
        <div className="mx-3 mb-4 max-w-lg rounded border border-hairline bg-paper-raised p-4 sm:mx-0">
          {!target ? (
            <Alert tone="warning" title="No one here uses that handle">
              <p>Check the spelling, or find them from the feed. Handles are not case sensitive.</p>
            </Alert>
          ) : permission && permission.state === 'refused' ? (
            <Alert
              tone="warning"
              title={`You cannot start a conversation with ${target.display_name}`}
            >
              <p>
                {permission.reason}{' '}
                <Link
                  href={`/u/${target.username}`}
                  className="text-accent-700 underline underline-offset-2"
                >
                  Their profile
                </Link>{' '}
                is still readable.
              </p>
            </Alert>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-muted">
                Start a conversation with{' '}
                <Link
                  href={`/u/${target.username}`}
                  className="text-accent-700 underline underline-offset-2"
                >
                  {target.display_name}
                </Link>
                . Opening one twice returns the same conversation rather than a second thread.
              </p>
              <NewConversationForm defaultUsername={target.username} />
            </div>
          )}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-0 md:grid-cols-[20rem_minmax(0,1fr)] md:gap-6">
        <aside
          className={cn(
            'min-w-0 border-hairline md:border-r md:pr-4',
            pane ? 'hidden md:block' : 'block',
          )}
        >
          {list.error ? (
            <div className="px-3 py-3">
              <Alert tone="danger">{list.error}</Alert>
            </div>
          ) : null}

          <ConversationList
            conversations={list.conversations ?? []}
            selectedId={pane?.id ?? null}
            loadMoreHref={listHref}
          />
        </aside>

        <div className={cn('min-w-0 md:pl-4', pane ? 'block' : 'hidden md:block')}>
          {pane && thread ? (
            <Thread
              pane={pane}
              page={thread}
              meId={user.id}
              hasCursor={beforeCursor !== null}
              now={new Date()}
            />
          ) : selectedId && !pane ? (
            <div className="p-3 md:pt-6">
              <Alert tone="warning" title="That conversation is not available">
                <p>
                  It may have been removed, or it may not be yours. A conversation id is not a key:
                  nothing is readable without a participation row.{' '}
                  <Link href="/messages" className="text-accent-700 underline underline-offset-2">
                    Back to your conversations
                  </Link>
                  .
                </p>
              </Alert>
            </div>
          ) : (
            <div className="p-3 md:pt-6">
              <EmptyState title="No conversation open">
                <p>
                  Choose one from the list. On a phone the thread opens as its own view, with a way
                  back to this list.
                </p>
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

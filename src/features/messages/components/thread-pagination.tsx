import { EndOfList, LoadMore } from '@/components/ui/pagination'
import { encodeCursor, type Cursor } from '@/lib/cursor'

/**
 * The thread's pagination, as links.
 *
 * The cursor is the opaque `(created_at, id)` pair from `@/lib/cursor`, and
 * `before` is the parameter it travels in — a name that says which direction the
 * reader is moving, because "load more" on a conversation means "older", never
 * "newer".
 *
 * Three things this deliberately does not do:
 *
 *   * **It never reuses the cursor that is already in the URL.** `threadPageHref`
 *     is always built from the *current page's* oldest message, so pressing the
 *     control twice cannot re-request the page the reader is looking at. The cursor
 *     moves with every page because the server hands back a new one per page.
 *   * **It does not pretend there is more.** A short page is the end: the query
 *     cannot know there is nothing beyond a full page without counting the whole
 *     conversation, so a full page keeps the control and a short page ends the
 *     list. `EndOfList` says so instead of leaving an unresolved spinner.
 *   * **It does not carry the previous cursor forwards on its own.** "Newest"
 *     drops the parameter entirely; the link is the plain conversation URL.
 */

export function threadPageHref(conversationId: string, cursor: Cursor | null): string {
  const params = new URLSearchParams({ c: conversationId })
  if (cursor) params.set('before', encodeCursor(cursor))
  return `/messages?${params.toString()}`
}

export function ThreadPagination({
  conversationId,
  olderCursor,
  hasOlder,
  className,
}: {
  conversationId: string
  olderCursor: Cursor | null
  hasOlder: boolean
  className?: string
}) {
  if (hasOlder && olderCursor) {
    return (
      <div className={className}>
        <LoadMore href={threadPageHref(conversationId, olderCursor)} label="Load earlier messages" />
      </div>
    )
  }

  return <EndOfList className={className} label="You have reached the start of this conversation." />
}

/**
 * The way back to the newest messages, shown only when the reader has walked back
 * through older ones. Without it, a reader three pages into last term has no
 * one-click route home.
 */
export function BackToNewest({ conversationId, className }: { conversationId: string; className?: string }) {
  return (
    <div className={className}>
      <LoadMore href={threadPageHref(conversationId, null)} label="Back to the newest messages" />
    </div>
  )
}

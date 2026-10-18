import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Avatar } from '@/components/ui/avatar'
import { CommentComposer } from '@/features/feed/components/comment-composer'
import type { CommentPost } from '@/features/feed/queries'

/**
 * One comment, top level or a reply.
 *
 * The like count is the trigger-maintained `comments.like_count` rendered as a
 * fact, not a control: there is no comment-like action yet, and a heart that looks
 * tappable and is not is worse than a number that plainly does not. The reply form
 * is a `<details>`, so it works with JavaScript off and costs nothing until it is
 * opened.
 *
 * Depth is one by construction — `comments_before_write` raises on a nested reply —
 * so this component renders one level and never recurses.
 */
function CommentRow({
  comment,
  postId,
  signedIn,
  isReply = false,
}: {
  comment: CommentPost
  postId: string
  signedIn: boolean
  isReply?: boolean
}) {
  const author = comment.author
  const name = author?.display_name ?? 'Former member'

  // A `div`, not an `li`: the thread supplies the list items, so top-level comments
  // and their replies form a valid `ol > li` tree instead of a `div` inside a list.
  return (
    <div className={isReply ? 'border-l-2 border-rule pl-3' : undefined}>
      <div className="flex items-start gap-2.5">
        <Avatar name={name} src={author?.avatar_url} size={isReply ? 'xs' : 'sm'} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {author ? (
              <Link
                href={`/u/${author.username}`}
                className="text-sm font-medium text-ink underline-offset-2 hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span className="text-sm font-medium text-ink-muted">{name}</span>
            )}
            <time dateTime={comment.created_at} className="text-xs text-ink-faint tabular">
              {formatDistanceToNowStrict(new Date(comment.created_at), { addSuffix: true })}
            </time>
            {comment.is_edited ? <span className="text-xs text-ink-faint">edited</span> : null}
          </div>

          <p className="mt-1 text-sm whitespace-pre-wrap text-ink">{comment.body}</p>

          <p className="mt-1 text-xs text-ink-faint">
            <span className="tabular">{comment.like_count}</span>{' '}
            <span className="sr-only">likes. </span>
            {comment.like_count === 1 ? 'like' : 'likes'}
          </p>

          {signedIn && !isReply ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                Reply
              </summary>
              <div className="mt-2">
                <CommentComposer postId={postId} parentId={comment.id} placeholder={`Reply to ${name}`} />
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The comment thread.
 *
 * `replies` are keyed by their parent so a thread is one pass, not a query per
 * comment. Only the requested page of top-level comments is fetched; the replies
 * that belong to those comments come with it.
 */
export function CommentThread({
  postId,
  comments,
  replies,
  signedIn,
}: {
  postId: string
  comments: CommentPost[]
  replies: CommentPost[]
  signedIn: boolean
}) {
  const byParent = new Map<string, CommentPost[]>()
  for (const reply of replies) {
    if (!reply.parent_id) continue
    const list = byParent.get(reply.parent_id) ?? []
    list.push(reply)
    byParent.set(reply.parent_id, list)
  }

  return (
    <ol className="space-y-5">
      {comments.map((comment) => {
        const children = byParent.get(comment.id) ?? []
        return (
          <li key={comment.id} className="space-y-3">
            <CommentRow comment={comment} postId={postId} signedIn={signedIn} />
            {children.length > 0 ? (
              <ol className="ml-6 space-y-3">
                {children.map((reply) => (
                  <li key={reply.id}>
                    <CommentRow
                      comment={reply}
                      postId={postId}
                      signedIn={signedIn}
                      isReply
                    />
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

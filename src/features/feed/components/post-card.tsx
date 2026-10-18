import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Avatar } from '@/components/ui/avatar'
import { Surface } from '@/components/ui/surface'
import { AttachedObject } from '@/features/feed/components/attached-object'
import { PostActions } from '@/features/feed/components/post-actions'
import type { FeedPost } from '@/features/feed/queries'

/**
 * A post.
 *
 * The like and comment counts are read from the row, where they are maintained by
 * database triggers — they are real numbers, not placeholders — and the controls
 * that move them are `PostActions`, which owns the only optimistic state on this
 * page.
 *
 * The timestamp is rendered inside a `<time>` with the machine-readable value in
 * `dateTime`, so "3h ago" is still recoverable as an exact instant, and it doubles
 * as the permalink when the post has no title.
 */
export function PostCard({
  post,
  signedIn,
  permalink,
}: {
  post: FeedPost
  signedIn: boolean
  /** Show "Copy link"; the feed omits it because every post there is one click old. */
  permalink?: string
}) {
  const author = post.author
  const name = author?.display_name ?? 'Former member'
  const detailHref = `/post/${post.id}`

  return (
    <Surface as="article" className="p-4">
      <div className="flex items-start gap-3">
        <Avatar name={name} src={author?.avatar_url} size="default" />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {author ? (
              <Link
                href={`/u/${author.username}`}
                className="font-medium text-ink underline-offset-2 hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span className="font-medium text-ink-muted">{name}</span>
            )}

            {author?.headline ? (
              <span className="truncate text-xs text-ink-faint">{author.headline}</span>
            ) : null}

            <time
              dateTime={post.created_at}
              className="ml-auto shrink-0 text-xs text-ink-faint tabular"
            >
              {formatDistanceToNowStrict(new Date(post.created_at), { addSuffix: true })}
            </time>
          </div>

          {post.title ? (
            <h3 className="mt-2 text-lg">
              <Link href={detailHref} className="underline-offset-2 hover:underline">
                {post.title}
              </Link>
            </h3>
          ) : null}

          {post.body ? (
            <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink">{post.body}</p>
          ) : null}

          {post.link_url ? (
            <a
              href={post.link_url}
              // noreferrer as well as noopener: a student's link should not tell
              // the destination which page on Quad they came from.
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="mt-2 inline-block max-w-full truncate text-sm text-accent-700 underline underline-offset-2"
            >
              {post.link_url}
            </a>
          ) : null}

          <AttachedObject project={post.project} goal={post.goal} />

          <PostActions
            postId={post.id}
            likeCount={post.like_count}
            commentCount={post.comment_count}
            initiallyLiked={post.viewer_has_liked}
            initiallySaved={post.viewer_has_saved}
            signedIn={signedIn}
            commentHref={`${detailHref}#comments`}
            permalink={permalink}
          />

          {post.is_edited ? <p className="mt-1 text-xs text-ink-faint">edited</p> : null}
        </div>
      </div>
    </Surface>
  )
}

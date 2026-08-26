import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Heart, MessageSquare } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Surface } from '@/components/ui/surface'
import type { FeedPost } from '@/features/feed/queries'

/**
 * A post in the feed.
 *
 * The like and comment counts are read from the row, where they are maintained by
 * database triggers — they are real numbers, not placeholders. The controls are
 * not wired up yet, so they are rendered as static counts rather than as buttons
 * that look clickable and do nothing.
 *
 * The timestamp is rendered inside a `<time>` with the machine-readable value in
 * `dateTime`, so "3h ago" is still recoverable as an exact instant.
 */
export function PostCard({ post }: { post: FeedPost }) {
  const author = post.author
  const name = author?.display_name ?? 'Former member'

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

          {post.title ? <h3 className="mt-2 text-lg">{post.title}</h3> : null}

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

          <div className="mt-3 flex items-center gap-4 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <Heart className="size-3.5" aria-hidden="true" />
              <span className="tabular">{post.like_count}</span>
              <span className="sr-only">likes</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MessageSquare className="size-3.5" aria-hidden="true" />
              <span className="tabular">{post.comment_count}</span>
              <span className="sr-only">comments</span>
            </span>
            {post.is_edited ? <span>edited</span> : null}
          </div>
        </div>
      </div>
    </Surface>
  )
}

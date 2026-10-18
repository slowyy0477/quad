import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import type { ProjectUpdate } from '@/features/projects/queries'

/**
 * The project's update stream.
 *
 * These are the project's own `posts` rows, read through the same RLS as the feed, so
 * what a visitor sees here is exactly what they are allowed to see — a private update
 * never reaches anyone but its author, and a shared one is the post that also appears
 * in the feed.
 *
 * The counts are the stored `like_count` and `comment_count`. Nothing in this
 * component is an estimate.
 */
export function UpdateStream({ updates }: { updates: ProjectUpdate[] }) {
  if (updates.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No updates yet. The first one goes here and, if it is shared, into the feed as well.
      </p>
    )
  }

  return (
    <ul className="space-y-4">
      {updates.map((update) => {
        const name = update.author?.display_name ?? 'A former member'
        return (
          <Surface as="li" key={update.id} className="p-4">
            <div className="flex items-start gap-3">
              <Avatar name={name} src={update.author?.avatar_url ?? null} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {update.author ? (
                    <Link
                      href={`/u/${update.author.username}`}
                      className="text-sm font-medium text-ink underline-offset-2 hover:underline"
                    >
                      {name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-ink-muted">{name}</span>
                  )}
                  <time dateTime={update.created_at} className="text-xs text-ink-faint tabular">
                    {formatDistanceToNowStrict(new Date(update.created_at), { addSuffix: true })}
                  </time>
                  {update.visibility === 'private' ? (
                    <Badge tone="outline">Only you can see this</Badge>
                  ) : (
                    <Badge tone="neutral">Shared to the feed</Badge>
                  )}
                </div>

                {update.body ? (
                  <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink">{update.body}</p>
                ) : null}

                <div className="mt-2 flex items-center gap-4 text-xs text-ink-faint">
                  <span className="tabular">{update.like_count} likes</span>
                  <span className="tabular">{update.comment_count} comments</span>
                  {update.is_edited ? <span>edited</span> : null}
                </div>
              </div>
            </div>
          </Surface>
        )
      })}
    </ul>
  )
}

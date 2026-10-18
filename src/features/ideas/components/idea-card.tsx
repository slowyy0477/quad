import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { categoryLabel, ideaStatusLabel } from '@/features/projects/constants'
import type { IdeaListItem } from '@/features/ideas/queries'

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'outline'> = {
  open: 'outline',
  forming: 'accent',
  converted: 'success',
  closed: 'neutral',
}

/**
 * One idea.
 *
 * Every count is a stored column: `upvote_count`, `interest_count` and `comment_count`
 * are maintained by the triggers in 0009. A hidden idea is only ever rendered to its
 * author or a moderator — the `ideas_select` policy decides that, not this component —
 * and when it is, it says so, because an idea that silently vanished would be worse
 * than one flagged.
 */
export function IdeaCard({ idea }: { idea: IdeaListItem }) {
  const name = idea.author?.display_name ?? 'A former member'

  return (
    <Surface as="article" className="p-4 transition-colors hover:border-rule">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{categoryLabel(idea.category)}</Badge>
        <Badge tone={STATUS_TONE[idea.status] ?? 'neutral'}>{ideaStatusLabel(idea.status)}</Badge>
        {idea.moderation_status !== 'active' ? (
          <Badge tone="danger">Hidden from other people</Badge>
        ) : null}
      </div>

      <h3 className="mt-2 text-base leading-snug">
        <Link href={`/ideas/${idea.id}`} className="text-ink underline-offset-2 hover:underline">
          {idea.title}
        </Link>
      </h3>

      <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted">{idea.description}</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3 text-xs text-ink-faint">
        <span className="truncate">
          {idea.author ? (
            <Link href={`/u/${idea.author.username}`} className="hover:text-ink">
              {name}
            </Link>
          ) : (
            name
          )}
          {' · '}
          <time dateTime={idea.created_at}>
            {formatDistanceToNowStrict(new Date(idea.created_at), { addSuffix: true })}
          </time>
        </span>

        <span className="flex items-center gap-3 tabular">
          <span>
            {idea.upvote_count} <span className="sr-only">votes</span>
            <span aria-hidden="true"> ▲</span>
          </span>
          <span>
            {idea.interest_count} <span className="sr-only">interested</span>
            <span aria-hidden="true"> ☺</span>
          </span>
        </span>
      </div>
    </Surface>
  )
}

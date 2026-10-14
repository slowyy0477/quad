import Link from 'next/link'
import { Star, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { categoryLabel, projectStatusLabel } from '@/features/projects/constants'
import type { ProjectListItem } from '@/features/projects/queries'

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'outline'> = {
  planning: 'outline',
  active: 'accent',
  paused: 'neutral',
  completed: 'success',
  abandoned: 'neutral',
}

/**
 * One project in a list.
 *
 * The counts are trigger-maintained columns (`member_count`, `star_count`), not
 * numbers this component invents or estimates. A project with no members shows 1 —
 * its owner — because the membership trigger inserts the owner row on create.
 */
export function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Surface as="article" className="p-4 transition-colors hover:border-rule">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base leading-snug">
            <Link
              href={`/projects/${project.slug}`}
              className="text-ink underline-offset-2 hover:underline"
            >
              {project.title}
            </Link>
          </h3>
          {project.tagline ? (
            <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{project.tagline}</p>
          ) : null}
        </div>
        {project.is_seeking_members ? <Badge tone="highlight">Seeking members</Badge> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{categoryLabel(project.category)}</Badge>
        <Badge tone={STATUS_TONE[project.status] ?? 'neutral'}>
          {projectStatusLabel(project.status)}
        </Badge>
        {project.visibility !== 'public' ? (
          <Badge tone="outline">{project.visibility}</Badge>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-hairline pt-3">
        {project.owner ? (
          <Link
            href={`/u/${project.owner.username}`}
            className="flex min-w-0 items-center gap-2 text-xs text-ink-muted hover:text-ink"
          >
            <Avatar name={project.owner.display_name} src={project.owner.avatar_url} size="xs" />
            <span className="truncate">{project.owner.display_name}</span>
          </Link>
        ) : (
          <span className="text-xs text-ink-faint">Owner unavailable</span>
        )}

        <div className="flex shrink-0 items-center gap-3 text-xs text-ink-faint tabular-nums">
          <span className="flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" />
            {project.member_count}
            <span className="sr-only"> members</span>
          </span>
          <span className="flex items-center gap-1">
            <Star className="size-3.5" aria-hidden="true" />
            {project.star_count}
            <span className="sr-only"> stars</span>
          </span>
        </div>
      </div>
    </Surface>
  )
}

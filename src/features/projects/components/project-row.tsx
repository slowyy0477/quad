import Link from 'next/link'
import { Star, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { categoryLabel, projectStatusLabel } from '@/features/projects/constants'
import type { ProjectListRow } from '@/features/projects/queries'

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
 * Every number here is a stored value. `member_count` and `star_count` are triggers'
 * columns, the avatars are real membership rows, the required skills are
 * `project_skills` rows, and "N slots" is `team_size_target - member_count` — two
 * stored columns, subtracted, not an estimate. When the target is unset the badge
 * says "Seeking members" rather than inventing a number.
 */
export function ProjectRow({ project }: { project: ProjectListRow }) {
  const members = project.members ?? []
  const shown = members.slice(0, 5)
  const extra = Math.max(0, project.member_count - shown.length)

  const required = (project.skills ?? []).filter((row) => row.is_required && row.skill)
  const slots =
    project.team_size_target != null
      ? Math.max(0, project.team_size_target - project.member_count)
      : null

  const seekingLabel =
    slots == null
      ? 'Seeking members'
      : slots === 0
        ? 'Team full'
        : `Seeking ${slots} more`

  return (
    <Surface as="article" className="p-4 transition-colors hover:border-rule">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base leading-snug">
            <Link href={`/projects/${project.slug}`} className="text-ink underline-offset-2 hover:underline">
              {project.title}
            </Link>
          </h3>
          {project.tagline ? (
            <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{project.tagline}</p>
          ) : (
            <p className="mt-1 text-sm text-ink-faint">No one-line purpose written yet.</p>
          )}
        </div>
        {project.is_seeking_members ? (
          <Badge tone={slots === 0 ? 'neutral' : 'highlight'}>{seekingLabel}</Badge>
        ) : null}
      </div>

      {required.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">Needs</span>
          {required.slice(0, 4).map((row) => (
            <Badge key={row.skill_id} tone="outline">
              {row.skill!.name}
            </Badge>
          ))}
          {required.length > 4 ? <span className="text-xs text-ink-faint">+{required.length - 4}</span> : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{categoryLabel(project.category)}</Badge>
        <Badge tone={STATUS_TONE[project.status] ?? 'neutral'}>{projectStatusLabel(project.status)}</Badge>
        {project.visibility !== 'public' ? <Badge tone="outline">{project.visibility}</Badge> : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-hairline pt-3">
        <div className="flex min-w-0 items-center gap-2">
          {shown.length > 0 ? (
            <ul className="flex -space-x-2" aria-label="Members">
              {shown.map((member) => (
                <li key={member.profile_id}>
                  <Avatar
                    name={member.profile?.display_name ?? 'Member'}
                    src={member.profile?.avatar_url ?? null}
                    size="xs"
                    className="ring-2 ring-paper-raised"
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <span className="truncate text-xs text-ink-muted">
            <span className="tabular">{project.member_count}</span>{' '}
            {project.member_count === 1 ? 'member' : 'members'}
            {extra > 0 ? <span className="text-ink-faint"> (+{extra} more)</span> : null}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3 text-xs text-ink-faint tabular-nums">
          <span className="flex items-center gap-1">
            <Star className="size-3.5" aria-hidden="true" />
            {project.star_count}
            <span className="sr-only"> stars</span>
          </span>
          <span className="flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" />
            {project.member_count}
            <span className="sr-only"> members</span>
          </span>
        </div>
      </div>
    </Surface>
  )
}

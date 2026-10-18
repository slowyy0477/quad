import Link from 'next/link'
import { Avatar } from '@/components/ui/avatar'
import type { ProfileSummary } from '@/features/profiles/queries'

/**
 * One person in a list.
 *
 * A person whose row the reader is not allowed to see is rendered as an
 * unreachable one rather than dropped. That case is real: a profile set to
 * connection-only, or one that has been deleted since, leaves a membership row
 * behind that RLS will not join to a name. Silently removing it would make a list
 * quietly lose entries; naming the absence is the honest version.
 */
export function PersonRow({
  person,
  meta,
  children,
}: {
  person: ProfileSummary | null
  meta?: React.ReactNode
  children?: React.ReactNode
}) {
  if (!person) {
    return (
      <li className="flex items-center gap-3 py-4">
        <div className="size-10 shrink-0 rounded-full border border-hairline bg-paper-sunken" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-muted">This account is not visible to you</p>
          <p className="text-xs text-ink-faint">
            It was deleted, or its owner has chosen to be visible to connections only.
          </p>
        </div>
      </li>
    )
  }

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={person.display_name} src={person.avatar_url} size="default" />

        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <Link
              href={`/u/${person.username}`}
              className="font-medium text-ink underline-offset-2 hover:underline"
            >
              {person.display_name}
            </Link>
            <span className="font-mono text-xs text-ink-faint">@{person.username}</span>
          </p>
          {person.headline ? (
            <p className="mt-0.5 text-sm text-ink-muted">{person.headline}</p>
          ) : null}
          {meta ? <div className="mt-1 text-xs text-ink-faint">{meta}</div> : null}
        </div>
      </div>

      {children ? <div className="shrink-0">{children}</div> : null}
    </li>
  )
}

import Link from 'next/link'
import { Avatar } from '@/components/ui/avatar'
import { Surface } from '@/components/ui/surface'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import type { Suggestion } from '@/features/connections/queries'

/**
 * People from your university.
 *
 * Not a recommendation engine and it does not dress as one: it is the most
 * recently active students at the reader's own institution, which is a query over
 * stored rows. Each row carries the reader's real standing with that person, so the
 * control is the one that applies — a Connect button next to someone already
 * connected would be a button that cannot work.
 *
 * The empty case is decided by the caller, because there are two different reasons
 * for it (no university set, or nobody else there yet) and they need different
 * sentences.
 */
export function UniversitySuggestions({ suggestions }: { suggestions: Suggestion[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {suggestions.map(({ person, state, isFollowing }) => (
        <Surface as="li" key={person.id} className="flex flex-col gap-3 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <Avatar name={person.display_name} src={person.avatar_url} size="sm" />
            <div className="min-w-0">
              <Link
                href={`/u/${person.username}`}
                className="block truncate font-medium text-ink underline-offset-2 hover:underline"
              >
                {person.display_name}
              </Link>
              {person.headline ? (
                <p className="truncate text-xs text-ink-muted">{person.headline}</p>
              ) : (
                <p className="truncate font-mono text-xs text-ink-faint">@{person.username}</p>
              )}
            </div>
          </div>

          <div className="mt-auto">
            <ConnectionControls
              profileId={person.id}
              username={person.username}
              displayName={person.display_name}
              state={state}
              connectionId={null}
              isFollowing={isFollowing}
              isBlockingThem={false}
              signedIn
              size="sm"
            />
          </div>
        </Surface>
      ))}
    </ul>
  )
}

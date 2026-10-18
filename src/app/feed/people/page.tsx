import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Avatar } from '@/components/ui/avatar'
import { Alert } from '@/components/ui/alert'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { listUniversityPeers } from '@/features/feed/queries'

export const metadata: Metadata = { title: 'People at your university' }

/**
 * The destination the feed's empty states point at.
 *
 * A new account follows nobody, so "your feed is empty" is only half an answer;
 * this is the other half. It lists the profiles that share the reader's
 * `profiles.university_id` — the only stored affiliation there is, since
 * departments and programmes are not listed yet — and each row links to the
 * person's profile, where Connect and Follow live.
 *
 * It is deliberately not a directory and says so: there is no search here, no
 * pagination, and no claim of completeness. RLS decides who is visible, so a
 * blocked or private profile simply is not in the list.
 */
export default async function FeedPeoplePage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">People at your university</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            This list is rows in Postgres. Without Supabase credentials there is nobody to show, and
            this page will not invent people.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/feed/people')

  const { peers, universityId, error } = await listUniversityPeers()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <SectionHeading
        title="People at your university"
        description="Profiles that carry the same institution as yours. Open one to connect or follow."
      />

      <p className="mt-2 text-xs text-ink-faint">
        <Link href="/feed" className="text-accent-700 underline underline-offset-2">
          Back to the feed
        </Link>
      </p>

      {error ? (
        <Alert tone="danger" className="mt-6">
          {error}
        </Alert>
      ) : null}

      {!error && universityId === null ? (
        <EmptyState title="You have no university on your profile" className="mt-6">
          <p>
            People are grouped here by the institution on their profile, and yours is not set yet.
            Mark your institution in the directory and this list fills up.
          </p>
          <p className="mt-2">
            <Link href="/universities" className="text-accent-700 underline underline-offset-2">
              Open the institution directory
            </Link>
          </p>
        </EmptyState>
      ) : null}

      {!error && universityId !== null && peers && peers.length === 0 ? (
        <EmptyState title="Nobody else is listed yet" className="mt-6">
          <p>
            You are the only person from your institution here so far. The directory lists
            institutions people have asked for, so this grows as others join.
          </p>
        </EmptyState>
      ) : null}

      {peers && peers.length > 0 ? (
        <ul className="mt-6 divide-y divide-hairline border-t border-hairline">
          {peers.map((peer) => (
            <li key={peer.id}>
              <Surface as="div" className="border-0 bg-transparent p-0">
                <Link
                  href={`/u/${peer.username}`}
                  className="flex items-center gap-3 py-3 underline-offset-2 hover:underline"
                >
                  <Avatar name={peer.display_name} src={peer.avatar_url} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {peer.display_name}
                    </span>
                    {peer.headline ? (
                      <span className="block truncate text-xs text-ink-muted">{peer.headline}</span>
                    ) : (
                      <span className="block truncate text-xs text-ink-faint">
                        @{peer.username}
                      </span>
                    )}
                  </span>
                </Link>
              </Surface>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

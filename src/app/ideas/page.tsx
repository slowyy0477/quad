import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { IdeaCard } from '@/features/ideas/components/idea-card'
import { IdeaForm } from '@/features/ideas/components/idea-form'
import { listIdeas } from '@/features/ideas/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { encodeCursor } from '@/lib/cursor'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Ideas',
  description: 'Ideas students are floating, and the people who want to help build them.',
}

type SearchParams = Record<string, string | string[] | undefined>

/**
 * The idea vault.
 *
 * An idea is cheaper than a project: no members, no roles, no updates — a pitch and a
 * count of people who said they would help. That is what makes it worth having a second
 * list on the other side of the same site: the step before the team, for the thing that
 * is not ready to be a project yet.
 *
 * The list is newest-first rather than most-voted, so an idea with no votes is not
 * buried on the day it is posted. Every count comes from the stored trigger-maintained
 * columns; nothing here is estimated.
 */
export default async function IdeasPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12">
        <h1 className="text-2xl">Ideas</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Ideas live in Postgres. Without Supabase credentials there is nothing to show, and this page
            will not invent ideas in their place. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const user = await getUser()
  const page = await listIdeas({ cursor: params.cursor })

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <SectionHeading
        title="Ideas"
        description="A pitch, and the people who would help build it. Ideas become projects when someone is ready."
      />

      {user ? (
        <details className="mt-5 rounded-md border border-hairline bg-paper-raised">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">
            Post an idea
          </summary>
          <div className="border-t border-hairline p-4">
            <IdeaForm mode="create" />
          </div>
        </details>
      ) : (
        <div className="mt-5 rounded-md border border-hairline bg-paper-raised p-4">
          <p className="text-sm text-ink-muted">
            Anyone can read the vault.{' '}
            <Link href="/login?next=/ideas" className="text-accent-700 underline underline-offset-2">
              Sign in
            </Link>{' '}
            to post an idea, vote, or say you would help build one.
          </p>
        </div>
      )}

      <div className="mt-6">
        {page.error ? <Alert tone="danger">{page.error}</Alert> : null}

        {!page.error && page.ideas.length === 0 ? (
          <EmptyState
            title="No ideas yet"
            action={
              user ? null : (
                <Button asChild variant="primary">
                  <Link href="/login?next=/ideas">Sign in to post the first one</Link>
                </Button>
              )
            }
          >
            {user ? (
              <p>
                Nobody has posted an idea here yet. Use “Post an idea” above — a title and a pitch is the
                whole form, and the people who want to help will find it here.
              </p>
            ) : (
              <p>
                Nobody has posted an idea here yet, and posting one needs an account. Signing in is the
                way in.
              </p>
            )}
          </EmptyState>
        ) : (
          <>
            <ul className="space-y-4">
              {page.ideas.map((idea) => (
                <li key={idea.id}>
                  <IdeaCard idea={idea} />
                </li>
              ))}
            </ul>

            {page.nextCursor ? (
              <div className="mt-6">
                <LoadMore
                  href={cursorHref('/ideas', params, encodeCursor(page.nextCursor))}
                  label="Load more ideas"
                />
              </div>
            ) : (
              <div className="mt-6">
                <EndOfList label="That is every idea in the vault." />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { LensTabs } from '@/features/projects/components/lens-tabs'
import { ProjectFilters } from '@/features/projects/components/project-filters'
import { ProjectRow } from '@/features/projects/components/project-row'
import {
  listMyProjectRows,
  listOpenProjects,
  listSkillOptions,
  listUniversityOptions,
} from '@/features/projects/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { encodeCursor } from '@/lib/cursor'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Projects' }

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Projects: two lenses over the same rows.
 *
 * "My projects" is everything the reader owns or is a member of; "Open to join" is the
 * team-finder. Both are the same `ProjectRow`, so a project looks the same in either
 * list, and both are URL-addressable (`?lens=`) so a lens can be linked to.
 *
 * Four states, and none of them are faked. A project that leaves the open lens because
 * its slots filled is not an error — it is the list telling the truth about a team that
 * is complete.
 */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Projects</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Projects are read from Postgres. Without Supabase credentials there is nothing to read, and
            this page will not show made-up projects in their place. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const user = await getUser()

  const requested = first(params.lens)
  const lens = requested === 'mine' || requested === 'open' ? requested : user ? 'mine' : 'open'

  const skill = first(params.skill)
  const university = first(params.university)
  const cursor = params.cursor

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <SectionHeading
        title="Projects"
        description="What students at your university are building, and what they are looking for."
        action={
          user ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/projects/new">Create project</Link>
            </Button>
          ) : null
        }
      />

      {first(params.deleted) ? (
        <Alert tone="success" className="mt-4">
          The project was deleted. Its posts and memberships are kept for moderation.
        </Alert>
      ) : null}

      <div className="mt-5">
        <LensTabs
          lens={lens}
          tabs={[
            { value: 'mine', label: 'My projects' },
            { value: 'open', label: 'Open to join' },
          ]}
        />
      </div>

      {lens === 'mine' ? (
        <MineLens isSignedIn={Boolean(user)} />
      ) : (
        <OpenLens skill={skill} university={university} cursor={cursor} params={params} />
      )}
    </div>
  )
}

async function MineLens({ isSignedIn }: { isSignedIn: boolean }) {
  if (!isSignedIn) {
    return (
      <div className="mt-5">
        <EmptyState title="Sign in to see your projects" action={
          <Button asChild variant="primary">
            <Link href="/login?next=/projects?lens=mine">Sign in</Link>
          </Button>
        }>
          <p>
            Your projects are the ones you own and the ones you are a member of. Both need an account to
            list, so this tab is empty for a visitor.
          </p>
        </EmptyState>
      </div>
    )
  }

  const { projects, error } = await listMyProjectRows()

  if (error) {
    return (
      <div className="mt-5">
        <Alert tone="danger" title="Your projects could not be loaded">
          {error}
        </Alert>
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="mt-5">
        <EmptyState
          title="You are not on a project yet"
          action={
            <Button asChild variant="primary">
              <Link href="/projects/new">Create the first project</Link>
            </Button>
          }
        >
          <p>
            Joining one is the other way in — look through{' '}
            <Link href="/projects?lens=open" className="text-accent-700 underline underline-offset-2">
              open projects
            </Link>
            . Creating one adds you as its owner straight away.
          </p>
        </EmptyState>
      </div>
    )
  }

  return (
    <ul className="mt-5 space-y-4">
      {projects.map((project) => (
        <li key={project.id}>
          <ProjectRow project={project} />
        </li>
      ))}
    </ul>
  )
}

async function OpenLens({
  skill,
  university,
  cursor,
  params,
}: {
  skill?: string
  university?: string
  cursor: string | string[] | undefined
  params: SearchParams
}) {
  const [page, skills, universities] = await Promise.all([
    listOpenProjects({ skillId: skill, universityId: university, cursor }),
    listSkillOptions(),
    listUniversityOptions(),
  ])

  const filtered = Boolean(skill || university)

  return (
    <div className="mt-5 space-y-5">
      <ProjectFilters
        skills={skills}
        universities={universities}
        skill={skill}
        university={university}
        lens="open"
      />

      {page.error ? <Alert tone="danger">{page.error}</Alert> : null}

      {page.projects.length === 0 ? (
        filtered ? (
          <EmptyState
            title="Nothing matches those filters"
            action={
              <Button asChild variant="secondary">
                <Link href="/projects?lens=open">Clear the filters</Link>
              </Button>
            }
          >
            <p>
              No project looking for members matches that skill and university together. Widening the
              filters is the quickest way back to a list.
            </p>
          </EmptyState>
        ) : (
          <EmptyState
            title="No project is looking for members right now"
            action={
              <Button asChild variant="primary">
                <Link href="/projects/new">Create the first project</Link>
              </Button>
            }
          >
            <p>
              This lens shows projects whose owners have switched on “seeking members” and whose slots
              are not yet filled. Yours would be the first.
            </p>
          </EmptyState>
        )
      ) : (
        <>
          <ul className="space-y-4">
            {page.projects.map((project) => (
              <li key={project.id}>
                <ProjectRow project={project} />
              </li>
            ))}
          </ul>

          {page.nextCursor ? (
            <LoadMore
              href={cursorHref('/projects', params, encodeCursor(page.nextCursor))}
              label="Load more projects"
            />
          ) : (
            <EndOfList label="That is every project looking for members." />
          )}
        </>
      )}
    </div>
  )
}

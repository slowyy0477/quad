import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { Github, Users } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { ProgressMeter } from '@/components/ui/progress-meter'
import { StatRow } from '@/components/ui/stat-row'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { categoryLabel, projectStatusLabel, visibilityLabel } from '@/features/projects/constants'
import { ApplicationReview } from '@/features/projects/components/application-review'
import { JoinForm } from '@/features/projects/components/join-form'
import { MemberRow } from '@/features/projects/components/member-row'
import { SeekingForm } from '@/features/projects/components/seeking-form'
import { StarButton } from '@/features/projects/components/star-button'
import { UpdateComposer } from '@/features/projects/components/update-composer'
import { UpdateStream } from '@/features/projects/components/update-stream'
import {
  getProjectBySlug,
  getProjectViewerState,
  hasStarred,
  listPendingApplications,
  listProjectMembers,
  listProjectSkillsWithFilled,
  listProjectUpdates,
  listSkillOptions,
} from '@/features/projects/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { encodeCursor } from '@/lib/cursor'

type Params = { slug: string }
type SearchParams = Record<string, string | string[] | undefined>

function formatDate(value: string | null) {
  if (!value) return null
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The project page, and the metadata a shared link needs.
 *
 * Built from the real row: the title, and the tagline when there is one or the opening
 * of the description when there is not. Nothing is composed from a template that could
 * describe a project as something it is not.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Project' }

  const { slug } = await params
  const project = await getProjectBySlug(slug)
  if (!project) return { title: 'Project not found' }

  const description =
    project.tagline ?? (project.description ? project.description.slice(0, 155) : undefined)

  return {
    title: project.title,
    description,
    openGraph: {
      type: 'article',
      title: project.title,
      description,
      url: `/projects/${project.slug}`,
    },
  }
}

/**
 * The project page.
 *
 * Three things are deliberately not conditional on being signed in: the purpose, the
 * members and the update stream are the public record of a public project, which is
 * what lets a link to it work for someone who has never heard of Quad.
 *
 * What the signed-out variant does hide:
 *
 *  * **Member email addresses.** There is no email on `profiles` and none is fetched —
 *    the member query selects id, username, display name and avatar only — so a
 *    signed-out response cannot contain one by construction rather than by CSS.
 *  * **Private updates.** A `posts` row with `visibility = 'private'` is readable only
 *    by its author under the `posts_select` policy, so the stream a visitor receives
 *    from the database has already dropped them.
 *  * **The owner's controls.** Requests, team settings and the update composer render
 *    only for a manager or a member, and each write is refused by a policy again.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) notFound()

  const { slug } = await params
  const project = await getProjectBySlug(slug)
  if (!project) notFound()

  const query = await searchParams
  const cursor = query.cursor

  const [viewer, members, skills, updates, starred] = await Promise.all([
    getProjectViewerState(project.id),
    listProjectMembers(project.id),
    listProjectSkillsWithFilled(project.id),
    listProjectUpdates({ projectId: project.id, cursor }),
    hasStarred(project.id),
  ])

  // Only a manager may read the pending requests. A plain member or a visitor asking
  // would get zero rows back from the policy, but there is no reason to send a query
  // whose answer is known to be nothing.
  const [applications, allSkills] = viewer.canManage
    ? await Promise.all([listPendingApplications(project.id), listSkillOptions()])
    : [[], []]

  const canAdvertise = project.visibility !== 'private'
  const slots =
    project.team_size_target != null ? Math.max(0, project.team_size_target - project.member_count) : null

  const timeline = [
    { label: 'Started', value: formatDate(project.started_at ?? project.created_at) },
    { label: 'Last updated', value: formatDate(project.updated_at) },
    { label: 'Completed', value: formatDate(project.completed_at) },
  ].filter((entry) => entry.value)

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      {query.converted ? (
        <Alert tone="success" className="mb-5" title="The idea is a project now">
          {Number(query.invited ?? 0) > 0
            ? `${Number(query.invited)} ${Number(query.invited) === 1 ? 'person who' : 'people who'} said they would help ${Number(query.invited) === 1 ? 'has' : 'have'} been invited.`
            : 'It was created, and you are its owner.'}{' '}
          The interested people can accept from their notifications.
        </Alert>
      ) : null}

      {query.welcome ? (
        <Alert tone="info" className="mb-5" title="Your project exists">
          Write the first update below when you have something to say about it — sharing it also puts it
          in the feed.
        </Alert>
      ) : null}

      {query.clamped ? (
        <Alert tone="info" className="mb-5" title="This project is less visible than you asked">
          Your profile is not public, so the project was stored at the same visibility as your profile.
          That is the rule the database applies to every project, and it is what stops a private profile
          from publishing a public page that names them.
        </Alert>
      ) : null}

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{categoryLabel(project.category)}</Badge>
          <Badge tone="accent">{projectStatusLabel(project.status)}</Badge>
          <Badge tone="outline">{visibilityLabel(project.visibility)}</Badge>
          {project.is_seeking_members ? (
            <Badge tone="highlight">
              {slots == null ? 'Seeking members' : slots === 0 ? 'Team full' : `Seeking ${slots} more`}
            </Badge>
          ) : null}
        </div>

        <h1 className="text-3xl text-ink">{project.title}</h1>
        {project.tagline ? <p className="max-w-prose text-lg text-ink-muted">{project.tagline}</p> : null}

        <div className="flex flex-wrap items-center gap-4">
          {project.owner ? (
            <Link
              href={`/u/${project.owner.username}`}
              className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Owned by {project.owner.display_name}
            </Link>
          ) : null}
          <StarButton
            projectId={project.id}
            slug={project.slug}
            starred={starred}
            starCount={project.star_count}
          />
          {project.repo_url ? (
            <a
              href={project.repo_url}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="inline-flex items-center gap-1.5 text-sm text-accent-700 underline underline-offset-2"
            >
              <Github className="size-4" aria-hidden="true" />
              Repository
            </a>
          ) : null}
          {project.demo_url ? (
            <a
              href={project.demo_url}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="text-sm text-accent-700 underline underline-offset-2"
            >
              Demo
            </a>
          ) : null}
        </div>
      </header>

      <Surface className="mt-6 p-5">
        <StatRow
          stats={[
            { label: 'Members', value: project.member_count },
            { label: 'Updates', value: project.post_count },
            { label: 'Stars', value: project.star_count },
          ]}
        />
        {project.team_size_target != null ? (
          <ProgressMeter
            className="mt-5"
            label="Team size reached"
            value={project.member_count}
            total={project.team_size_target}
          />
        ) : null}
      </Surface>

      <section className="mt-8">
        <SectionHeading title="Purpose" />
        {project.description ? (
          <p className="mt-3 max-w-prose text-sm whitespace-pre-wrap text-ink">{project.description}</p>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            No longer description was written. The one-line purpose above is the whole of it so far.
          </p>
        )}

        {project.looking_for ? (
          <div className="mt-5 border-l-2 border-highlight-400 pl-4">
            <p className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
              What they are looking for
            </p>
            <p className="mt-1 text-sm text-ink">{project.looking_for}</p>
          </div>
        ) : null}
      </section>

      {timeline.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Timeline" />
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            {timeline.map((entry) => (
              <div key={entry.label}>
                <dt className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">{entry.label}</dt>
                <dd className="mt-0.5 text-sm text-ink tabular">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {skills.required.length > 0 ? (
        <section className="mt-8">
          <SectionHeading
            title="Skills needed"
            description="How many members already have each skill. These are the rows the team-finder matches on."
          />
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {skills.required.map((skill) => (
              <li key={skill.skillId} className="rounded border border-hairline p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink">{skill.name}</span>
                  <span className="text-xs text-ink-faint tabular">
                    {skill.filled} of {project.member_count}
                  </span>
                </div>
                <ProgressMeter
                  className="mt-2"
                  value={skill.filled}
                  total={Math.max(project.member_count, 1)}
                  label={`Members with ${skill.name}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <SectionHeading title="Team" description="Roles are permissions; the title beside a name is not." />
        <ul className="mt-2 divide-y divide-hairline">
          {members.map((member) => (
            <MemberRow
              key={member.profile?.id ?? member.role}
              member={member}
              projectId={project.id}
              projectTitle={project.title}
              slug={project.slug}
              viewerId={viewer.userId}
              viewerIsOwner={viewer.role === 'owner'}
              canManage={viewer.canManage}
            />
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <Tabs defaultValue="updates">
          <TabsList aria-label="Project detail">
            <TabsTrigger value="updates">Updates</TabsTrigger>
            {viewer.canManage ? <TabsTrigger value="requests">Requests</TabsTrigger> : null}
            {viewer.canManage ? <TabsTrigger value="settings">Seeking members</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="updates">
            <div className="space-y-5">
              {viewer.isMember ? (
                <UpdateComposer slug={project.slug} canShare={canAdvertise} />
              ) : null}

              {updates.error ? <Alert tone="danger">{updates.error}</Alert> : null}

              {updates.updates.length === 0 ? (
                <EmptyState title="Nothing has been posted yet">
                  <p>
                    Updates appear here, and a shared one appears in the feed as well. Only members of the
                    project can write one.
                  </p>
                </EmptyState>
              ) : (
                <>
                  <UpdateStream updates={updates.updates} />
                  {updates.nextCursor ? (
                    <LoadMore
                      href={cursorHref(`/projects/${project.slug}`, query, encodeCursor(updates.nextCursor))}
                      label="Load older updates"
                    />
                  ) : (
                    <EndOfList label="That is every update so far." />
                  )}
                </>
              )}
            </div>
          </TabsContent>

          {viewer.canManage ? (
            <TabsContent value="requests">
              <ApplicationReview applications={applications} slug={project.slug} />
            </TabsContent>
          ) : null}

          {viewer.canManage ? (
            <TabsContent value="settings">
              <SeekingForm
                slug={project.slug}
                isSeekingMembers={project.is_seeking_members}
                teamSizeTarget={project.team_size_target}
                lookingFor={project.looking_for}
                skills={allSkills}
                selectedSkillIds={skills.required.map((skill) => skill.skillId)}
                canAdvertise={canAdvertise}
              />
            </TabsContent>
          ) : null}
        </Tabs>
      </section>

      {!viewer.isMember ? (
        <section className="mt-8">
          <SectionHeading title="Ask to join" />
          <div className="mt-3 max-w-prose">
            {project.is_seeking_members ? (
              <JoinForm
                projectId={project.id}
                slug={project.slug}
                hasPendingApplication={viewer.hasPendingApplication}
                isSignedIn={Boolean(viewer.userId)}
              />
            ) : (
              <p className="text-sm text-ink-muted">
                This project is not looking for members, so there is no join request to make. When the
                owners switch “seeking members” back on, the request appears here.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <p className="mt-10 flex items-center gap-2 text-xs text-ink-faint">
        <Users className="size-3.5" aria-hidden="true" />
        Applications: <span className="tabular">{project.application_count}</span> awaiting an answer.
      </p>
    </div>
  )
}

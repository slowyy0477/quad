import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { formatDistanceToNowStrict } from 'date-fns'
import { Alert } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatRow } from '@/components/ui/stat-row'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { categoryLabel, ideaStatusLabel, visibilityLabel } from '@/features/projects/constants'
import { CloseIdeaButton } from '@/features/ideas/components/close-idea-button'
import { ConvertForm } from '@/features/ideas/components/convert-form'
import { IdeaForm } from '@/features/ideas/components/idea-form'
import { InterestForm } from '@/features/ideas/components/interest-form'
import { VoteButton } from '@/features/ideas/components/vote-button'
import {
  getConvertedProjectSlug,
  getIdeaById,
  getIdeaViewerState,
  listIdeaInterests,
  listIdeaSkills,
} from '@/features/ideas/queries'
import { isSupabaseConfigured } from '@/lib/env'

type Params = { id: string }

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Idea' }

  const { id } = await params
  const idea = await getIdeaById(id)
  if (!idea) return { title: 'Idea not found' }

  // A hidden idea's title is not put into metadata: a link preview would leak to
  // everyone what the author can be shown alone.
  if (idea.moderation_status !== 'active') {
    return { title: 'Idea', robots: { index: false, follow: false } }
  }

  return {
    title: idea.title,
    description: idea.description.slice(0, 155),
    openGraph: { type: 'article', title: idea.title, description: idea.description.slice(0, 155), url: `/ideas/${idea.id}` },
  }
}

/**
 * One idea.
 *
 * Everything on the page is a row: the pitch, the skills, the counts, and the list of
 * people who said they would help. The list is only ever the whole list for the idea's
 * author — RLS shows everyone else their own offer and nothing more — so the author's
 * view and a visitor's view are the same component reading different rows.
 *
 * The author's controls are hidden from everyone else and refused again by the policy;
 * a hidden idea is shown to its author with a note saying so rather than silently
 * disappearing, which is what makes moderation explicable.
 */
export default async function IdeaPage({ params }: { params: Promise<Params> }) {
  if (!isSupabaseConfigured()) notFound()

  const { id } = await params
  const idea = await getIdeaById(id)
  if (!idea) notFound()

  const [viewer, skills, interests] = await Promise.all([
    getIdeaViewerState(idea),
    listIdeaSkills(idea.id),
    listIdeaInterests(idea.id),
  ])

  const convertedSlug = idea.converted_project_id
    ? await getConvertedProjectSlug(idea.converted_project_id)
    : null

  const isConverted = idea.status === 'converted'
  const authorName = idea.author?.display_name ?? 'A former member'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{categoryLabel(idea.category)}</Badge>
        <Badge tone={isConverted ? 'success' : 'accent'}>{ideaStatusLabel(idea.status)}</Badge>
        <Badge tone="outline">{visibilityLabel(idea.visibility)}</Badge>
      </div>

      {idea.moderation_status !== 'active' ? (
        <Alert tone="danger" className="mt-4" title="This idea is hidden from other people">
          A moderator hid it, so it appears in your own list and nowhere else. Nothing has been deleted —
          if you think this is wrong, edit the pitch or get in touch.
        </Alert>
      ) : null}

      <h1 className="mt-3 text-3xl text-ink">{idea.title}</h1>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-muted">
        <span className="flex items-center gap-2">
          <Avatar name={authorName} src={idea.author?.avatar_url ?? null} size="xs" />
          {idea.author ? (
            <Link href={`/u/${idea.author.username}`} className="underline-offset-2 hover:text-ink hover:underline">
              {authorName}
            </Link>
          ) : (
            authorName
          )}
        </span>
        <span aria-hidden="true">·</span>
        <time dateTime={idea.created_at}>
          {formatDistanceToNowStrict(new Date(idea.created_at), { addSuffix: true })}
        </time>
      </div>

      <Surface className="mt-6 p-5">
        <StatRow
          stats={[
            { label: 'Votes', value: idea.upvote_count },
            { label: 'Would help', value: idea.interest_count },
            { label: 'Comments', value: idea.comment_count },
          ]}
        />
        <div className="mt-5">
          {viewer.userId ? (
            <VoteButton ideaId={idea.id} voted={viewer.hasVoted} count={idea.upvote_count} />
          ) : (
            <p className="text-sm text-ink-muted">
              <Link href={`/login?next=/ideas/${idea.id}`} className="text-accent-700 underline underline-offset-2">
                Sign in
              </Link>{' '}
              to vote for this idea.
            </p>
          )}
        </div>
      </Surface>

      <section className="mt-8">
        <SectionHeading title="The pitch" />
        <p className="mt-3 max-w-prose text-sm whitespace-pre-wrap text-ink">{idea.description}</p>

        {idea.looking_for ? (
          <div className="mt-5 border-l-2 border-highlight-400 pl-4">
            <p className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
              Who they are looking for
            </p>
            <p className="mt-1 text-sm text-ink">{idea.looking_for}</p>
          </div>
        ) : null}
      </section>

      {skills.length > 0 ? (
        <section className="mt-8">
          <SectionHeading
            title="Skills the idea asks for"
            description="These carry across into the project's required skills when the idea is converted."
          />
          <ul className="mt-3 flex flex-wrap gap-2">
            {skills.map((entry) => (
              <li key={entry.skill_id}>
                <Badge tone="neutral">{entry.skill?.name ?? 'Unknown skill'}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Who said they would help. The whole list for the author, one's own offer otherwise. */}
      <section className="mt-8">
        <SectionHeading
          title="Would help build this"
          description={
            viewer.isAuthor
              ? 'Everyone who offered. Converting the idea invites each of them.'
              : 'Only you and the author can see your offer.'
          }
        />

        {interests.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">
            {viewer.isAuthor
              ? 'Nobody has offered to help yet. Sharing the idea is the other way to find people.'
              : 'No one has offered yet.'}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {interests.map((entry) => (
              <li key={entry.profile_id} className="rounded border border-hairline p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Avatar name={entry.profile?.display_name ?? 'A member'} src={entry.profile?.avatar_url ?? null} size="xs" />
                  {entry.profile ? (
                    <Link href={`/u/${entry.profile.username}`} className="text-ink underline-offset-2 hover:underline">
                      {entry.profile.display_name}
                    </Link>
                  ) : (
                    <span className="text-ink-muted">A former member</span>
                  )}
                  <span className="text-xs text-ink-faint">
                    {formatDistanceToNowStrict(new Date(entry.created_at), { addSuffix: true })}
                  </span>
                </div>
                {entry.offering ? <p className="mt-1.5 text-sm text-ink">“{entry.offering}”</p> : null}
                {entry.message ? (
                  <p className="mt-1 text-sm whitespace-pre-wrap text-ink-muted">{entry.message}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The reader's own way in, when they are not the author. */}
      {!viewer.isAuthor ? (
        <section className="mt-8">
          <SectionHeading title={isConverted ? 'This idea is a project now' : 'Offer to help'} />
          <div className="mt-3">
            {isConverted ? (
              <p className="text-sm text-ink-muted">
                It is past the idea stage, so there is nothing to offer here.{' '}
                {convertedSlug ? (
                  <Link href={`/projects/${convertedSlug}`} className="text-accent-700 underline underline-offset-2">
                    See the project
                  </Link>
                ) : null}
              </p>
            ) : viewer.userId ? (
              <div className="max-w-prose">
                <InterestForm
                  ideaId={idea.id}
                  hasExpressedInterest={viewer.hasExpressedInterest}
                  ownInterest={viewer.ownInterest}
                />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                <Link href={`/login?next=/ideas/${idea.id}`} className="text-accent-700 underline underline-offset-2">
                  Sign in
                </Link>{' '}
                to tell the author you would help build this.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {/* The author's side. */}
      {viewer.isAuthor ? (
        <section className="mt-10 space-y-8 border-t border-hairline pt-6">
          <div>
            <SectionHeading
              title="Turn this into a project"
              description="Creates the project, carries the required skills across, and invites everyone who offered to help."
            />
            <div className="mt-3">
              <ConvertForm
                ideaId={idea.id}
                interestCount={idea.interest_count}
                requiredSkillCount={skills.length}
                status={idea.status}
                convertedProjectSlug={convertedSlug}
              />
            </div>
          </div>

          {!isConverted ? (
            <div>
              <SectionHeading title="Edit the idea" />
              <div className="mt-3">
                <IdeaForm
                  mode="edit"
                  idea={{
                    id: idea.id,
                    title: idea.title,
                    description: idea.description,
                    category: idea.category,
                    lookingFor: idea.looking_for,
                    status: idea.status,
                    visibility: idea.visibility,
                  }}
                />
              </div>
            </div>
          ) : null}

          {!isConverted && idea.status !== 'closed' ? (
            <CloseIdeaButton ideaId={idea.id} ideaTitle={idea.title} />
          ) : null}
        </section>
      ) : null}

      <div className="mt-10">
        <Button asChild variant="ghost">
          <Link href="/ideas">Back to the vault</Link>
        </Button>
      </div>
    </div>
  )
}

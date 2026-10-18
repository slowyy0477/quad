import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { CalendarDays, MessageSquare, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { Surface } from '@/components/ui/surface'
import { PersonRow } from '@/features/connections/components/person-row'
import { ProjectCard } from '@/features/projects/components/project-card'
import { categoryLabel, ideaStatusLabel } from '@/features/projects/constants'
import type {
  SearchEvent,
  SearchIdea,
  SearchOpportunity,
  SearchPost,
  SearchResult,
} from '@/features/search/queries'

/**
 * Search results, one row per kind.
 *
 * Two rows are drawn by the component that already draws them everywhere else —
 * `PersonRow` for people (the same row the connections list uses) and `ProjectCard`
 * for projects — because a search result should look like the thing it is a result
 * for. The rest are drawn here, and there are three honest reasons for that rather
 * than a preference:
 *
 *   * `PostCard` takes a `FeedPost`, which carries the *reader's* like and save
 *     state. Search does not fetch it, and passing `false` for both would render a
 *     like button that asserts something untrue about the reader. A compact post row
 *     with the same stored counts is the honest alternative.
 *   * `IdeaCard` takes an `IdeaListItem`, which carries `looking_for`,
 *     `converted_project_id`, `converted_at`, `moderation_status` and `updated_at`.
 *     Search returns none of them, and inventing values for five fields to satisfy a
 *     type is how a card ends up saying something the database never did.
 *   * Opportunities and events have no card component at all: 0013 created their
 *     tables, their routes are still `PlannedFeature` placeholders, and there is
 *     nothing to reuse.
 *
 * Every number rendered below is a column the function returned — which is to say a
 * stored column. `member_count`, `star_count`, `like_count`, `comment_count`,
 * `upvote_count` and `interest_count` are trigger-maintained and are never
 * incremented, computed or estimated anywhere in the browser.
 */

/** `posts.type` CHECK in 0008. The value is shown only when it is not plain text. */
const POST_TYPE_LABELS: Record<string, string> = {
  text: 'Post',
  image: 'Image',
  project_update: 'Project update',
  achievement: 'Achievement',
  question: 'Question',
  resource: 'Resource',
  looking_for_teammates: 'Looking for teammates',
  learning_update: 'Learning update',
  opportunity: 'Opportunity',
}

/** `opportunities.type` CHECK in 0013. */
const OPPORTUNITY_TYPE_LABELS: Record<string, string> = {
  internship: 'Internship',
  part_time: 'Part time',
  full_time: 'Full time',
  research: 'Research',
  thesis: 'Thesis',
  scholarship: 'Scholarship',
  competition: 'Competition',
  volunteer: 'Volunteering',
  other: 'Other',
}

/** `opportunities.status` CHECK in 0013. */
const OPPORTUNITY_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  filled: 'Filled',
}

/** `events.type` CHECK in 0013. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  workshop: 'Workshop',
  hackathon: 'Hackathon',
  meetup: 'Meetup',
  talk: 'Talk',
  competition: 'Competition',
  study_group: 'Study group',
  deadline: 'Deadline',
  social: 'Social',
  other: 'Other',
}

/**
 * A label from a fixed vocabulary, or the stored value itself.
 *
 * The fallback matters: these maps mirror CHECK constraints that a later migration
 * may widen, and a widened constraint should not make a result unrenderable — the
 * raw value is honest, if plainer.
 */
function labelFor(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value
}

function relative(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
}

function AuthorLine({ author, at }: { author: SearchPost['author']; at: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-ink-faint">
      {author ? (
        <Link
          href={`/u/${author.username}`}
          className="flex min-w-0 items-center gap-1.5 hover:text-ink"
        >
          <Avatar name={author.display_name} src={author.avatar_url} size="xs" />
          <span className="truncate">{author.display_name}</span>
        </Link>
      ) : (
        // The row is here; the person it belongs to is not visible to this reader.
        // Saying so is better than a card with no attribution at all.
        <span>Author not visible to you</span>
      )}
      <time dateTime={at}>{relative(at)}</time>
    </span>
  )
}

function PostRow({ post }: { post: SearchPost }) {
  const href = `/post/${post.id}`

  return (
    <Surface as="article" className="p-4">
      <div className="flex items-start gap-3">
        <Avatar
          name={post.author?.display_name ?? 'Former member'}
          src={post.author?.avatar_url ?? null}
          size="default"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <AuthorLine author={post.author} at={post.created_at} />
            {post.type !== 'text' ? (
              <Badge tone="neutral">{labelFor(POST_TYPE_LABELS, post.type)}</Badge>
            ) : null}
          </div>

          {post.title ? (
            <h3 className="mt-2 text-base leading-snug">
              <Link href={href} className="text-ink underline-offset-2 hover:underline">
                {post.title}
              </Link>
            </h3>
          ) : null}

          {post.excerpt ? (
            post.title ? (
              <p className="mt-1.5 line-clamp-3 text-sm whitespace-pre-wrap text-ink-muted">
                {post.excerpt}
              </p>
            ) : (
              <Link
                href={href}
                className="mt-2 block line-clamp-3 text-sm whitespace-pre-wrap text-ink underline-offset-2 hover:underline"
              >
                {post.excerpt}
              </Link>
            )
          ) : null}

          <div className="mt-3 flex items-center gap-3 text-xs text-ink-faint tabular-nums">
            <span className="flex items-center gap-1">
              <Star className="size-3.5" aria-hidden="true" />
              {post.like_count}
              <span className="sr-only"> likes</span>
            </span>
            <span className="flex items-center gap-1">
              <MessageSquare className="size-3.5" aria-hidden="true" />
              {post.comment_count}
              <span className="sr-only"> comments</span>
            </span>
          </div>
        </div>
      </div>
    </Surface>
  )
}

function IdeaRow({ idea }: { idea: SearchIdea }) {
  return (
    <Surface as="article" className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{categoryLabel(idea.category)}</Badge>
        <Badge tone="outline">{ideaStatusLabel(idea.status)}</Badge>
      </div>

      <h3 className="mt-2 text-base leading-snug">
        <Link href={`/ideas/${idea.id}`} className="text-ink underline-offset-2 hover:underline">
          {idea.title}
        </Link>
      </h3>

      {idea.excerpt ? (
        <p className="mt-1.5 line-clamp-3 text-sm text-ink-muted">{idea.excerpt}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <AuthorLine author={idea.author} at={idea.created_at} />
        <span className="flex items-center gap-3 text-xs text-ink-faint tabular">
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

/**
 * An opportunity or an event.
 *
 * The title is text, not a link, and that is the honest rendering of the current
 * state of the product: `0013` created these tables and the migrations behind them
 * are applied, but `/opportunities/[slug]` and `/events/[slug]` do not exist, and a
 * result that links to a 404 is a control that does nothing. The row therefore
 * shows what the row holds and says which parts are not built, rather than pointing
 * at a page that would apologise.
 */
function ListingRow({
  title,
  badges,
  meta,
  footer,
}: {
  title: string
  badges: React.ReactNode
  meta: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <Surface as="article" className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        {badges}
        <Badge tone="outline">Page planned</Badge>
      </div>

      <h3 className="mt-2 text-base leading-snug text-ink">{title}</h3>

      {meta ? <p className="mt-1.5 text-sm text-ink-muted">{meta}</p> : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        {footer}
      </div>
    </Surface>
  )
}

/**
 * One result.
 *
 * The people branch returns `PersonRow` itself, which is an `<li>`: the list below
 * has to contain list items and nothing else, so every branch here produces an `li`
 * rather than a wrapper around one. Project cards are wrapped because a card is an
 * article and an article is not a list item.
 */
function ResultItem({ result }: { result: SearchResult }) {
  switch (result.kind) {
    case 'person':
      return <PersonRow person={result.person} />

    case 'project':
      return (
        <li>
          <ProjectCard project={result.project} />
        </li>
      )

    case 'post':
      return (
        <li>
          <PostRow post={result.post} />
        </li>
      )

    case 'idea':
      return (
        <li>
          <IdeaRow idea={result.idea} />
        </li>
      )

    case 'opportunity':
      return (
        <li>
          <ListingRow
            title={result.opportunity.title}
            badges={
              <>
                <Badge tone="neutral">
                  {labelFor(OPPORTUNITY_TYPE_LABELS, result.opportunity.type)}
                </Badge>
                <Badge tone="outline">
                  {labelFor(OPPORTUNITY_STATUS_LABELS, result.opportunity.status ?? 'open')}
                </Badge>
              </>
            }
            meta={result.opportunity.organisation}
            footer={
              <>
                <span className="flex items-center gap-2 text-xs text-ink-faint">
                  <CalendarDays className="size-3.5" aria-hidden="true" />
                  {result.opportunity.deadline ? (
                    <>
                      Deadline <time dateTime={result.opportunity.deadline}>{result.opportunity.deadline}</time>
                    </>
                  ) : (
                    'No deadline given'
                  )}
                </span>
                <AuthorLine author={result.opportunity.author} at={result.opportunity.created_at} />
              </>
            }
          />
        </li>
      )

    case 'event':
      return (
        <li>
          <ListingRow
            title={result.event.title}
            badges={
              <Badge tone="neutral">{labelFor(EVENT_TYPE_LABELS, result.event.type)}</Badge>
            }
            meta={result.event.location}
            footer={
              <>
                <span className="flex items-center gap-2 text-xs text-ink-faint">
                  <CalendarDays className="size-3.5" aria-hidden="true" />
                  <time dateTime={result.event.starts_at}>{relative(result.event.starts_at)}</time>
                </span>
                <AuthorLine author={result.event.author} at={result.event.created_at} />
              </>
            }
          />
        </li>
      )
  }
}

export function SearchResults({ results }: { results: SearchResult[] }) {
  return (
    <ul className="space-y-3">
      {results.map((result) => (
        <ResultItem key={`${result.kind}:${result.id}`} result={result} />
      ))}
    </ul>
  )
}

/**
 * Counts, when a list needs one.
 *
 * Kept here rather than inline in the page because it is the one place the
 * kind-specific noun is needed, and it comes from the same spec table the tabs use.
 */
export function ResultSummary({
  count,
  singular,
  plural,
  query,
}: {
  count: number
  singular: string
  plural: string
  query: string
}) {
  return (
    <p className="text-xs text-ink-faint" role="status">
      <span className="tabular">{count}</span> {count === 1 ? singular : plural} for{' '}
      <span className="text-ink-muted">“{query}”</span>
    </p>
  )
}

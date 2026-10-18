import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ExternalLink, Mail } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatRow } from '@/components/ui/stat-row'
import { SectionHeading, Surface } from '@/components/ui/surface'
import {
  deadlineLabel,
  formatCalendarDate,
  formatInstantInPakistan,
  opportunityIsClosed,
  todayInPakistan,
} from '@/features/opportunities/board'
import { opportunityTypeLabel, workModeLabel } from '@/features/opportunities/constants'
import { SaveOpportunityButton } from '@/features/opportunities/components/save-button'
import { getOpportunityBySlug, getOpportunitySave } from '@/features/opportunities/queries'
import { isSupabaseConfigured } from '@/lib/env'

type Params = { slug: string }
type SearchParams = Record<string, string | string[] | undefined>

/**
 * The listing page, and the metadata a shared link needs.
 *
 * Built from the stored row: the title, the organisation, and the opening of the
 * description. Nothing is composed from a template that could describe a listing as
 * something it is not.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Opportunity' }

  const { slug } = await params
  const opportunity = await getOpportunityBySlug(slug)
  if (!opportunity) return { title: 'Opportunity not found' }

  return {
    title: opportunity.title,
    description: `${opportunity.organisation} — ${opportunity.description.slice(0, 140)}`,
    openGraph: {
      type: 'article',
      title: opportunity.title,
      description: opportunity.description.slice(0, 155),
      url: `/opportunities/${opportunity.slug}`,
    },
  }
}

/**
 * One listing.
 *
 * The page states plainly what it can and cannot do. Applying happens with the
 * organisation: this schema has no applications table, so there is no "apply" form here
 * to fill in, and nothing records that a reader applied. What Quad stores about a reader
 * and a listing is a private bookmark, so the control is labelled Save and says what it
 * is for.
 *
 * A passed deadline is shown as closed, in words, next to the apply route — which stays
 * visible because it points at the organisation, and their process may still be open.
 */
export default async function OpportunityPage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) notFound()

  const { slug } = await params
  const opportunity = await getOpportunityBySlug(slug)
  if (!opportunity) notFound()

  const query = await searchParams
  const today = todayInPakistan(new Date())
  const closed = opportunityIsClosed(opportunity, today)
  const save = await getOpportunitySave(opportunity.id)

  const required = opportunity.opportunity_skills.filter((row) => row.is_required && row.skill)
  const optional = opportunity.opportunity_skills.filter((row) => !row.is_required && row.skill)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      {query.created ? (
        <Alert tone="success" className="mb-5" title="The listing is live">
          It is on the board now, and it stays there after its closing date — it moves to the closed
          tab rather than disappearing.
        </Alert>
      ) : null}

      {query.skills === 'failed' ? (
        <Alert tone="warning" className="mb-5" title="The skills you chose were not saved">
          The listing itself was. Nothing else about it is affected, but it will not be matched on those
          skills until they are added.
        </Alert>
      ) : null}

      {query.clamped ? (
        <Alert tone="info" className="mb-5" title="This listing is more visible than you asked">
          Your profile has no university, so a university-only listing would have been invisible to
          everyone — including you. The database stores it as public instead, and says so here rather
          than leaving you to find out.
        </Alert>
      ) : null}

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{opportunityTypeLabel(opportunity.type)}</Badge>
          <Badge tone="outline">{workModeLabel(opportunity.work_mode)}</Badge>
          <Badge tone={closed ? 'neutral' : 'success'}>
            {closed
              ? opportunity.status === 'filled'
                ? 'Filled'
                : 'Closed'
              : 'Open'}
          </Badge>
          {opportunity.visibility !== 'public' ? <Badge tone="outline">University only</Badge> : null}
        </div>

        <h1 className="text-3xl text-ink">{opportunity.title}</h1>
        <p className="text-lg text-ink-muted">{opportunity.organisation}</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
          {opportunity.poster ? (
            <Link
              href={`/u/${opportunity.poster.username}`}
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              Posted by {opportunity.poster.display_name}
            </Link>
          ) : null}
          {opportunity.university ? (
            <span>
              {opportunity.university.short_name ?? opportunity.university.name}
            </span>
          ) : null}
          <span className="tabular">{formatInstantInPakistan(opportunity.created_at)}</span>
        </div>
      </header>

      <Surface className="mt-6 p-5">
        <StatRow
          stats={[
            {
              label: 'Saved',
              value: opportunity.save_count,
              hint: 'private bookmarks, counted by trigger',
            },
          ]}
        />

        <p className={`mt-4 text-sm ${closed ? 'text-ink-muted' : 'font-medium text-ink'}`}>
          {deadlineLabel(opportunity.deadline, today)}
          {opportunity.deadline ? (
            <span className="ml-2 font-normal text-ink-faint tabular">
              {formatCalendarDate(opportunity.deadline)}
            </span>
          ) : null}
        </p>

        {opportunity.starts_on ? (
          <p className="mt-1 text-sm text-ink-muted">
            Starts {formatCalendarDate(opportunity.starts_on)}
          </p>
        ) : null}

        {opportunity.location ? (
          <p className="mt-1 text-sm text-ink-muted">Location: {opportunity.location}</p>
        ) : null}

        {opportunity.compensation ? (
          <p className="mt-1 text-sm text-ink-muted">Compensation: {opportunity.compensation}</p>
        ) : null}
      </Surface>

      <section className="mt-8">
        <SectionHeading title="About this opportunity" />
        <p className="mt-3 max-w-prose text-sm whitespace-pre-wrap text-ink">{opportunity.description}</p>
      </section>

      <section className="mt-8">
        <SectionHeading
          title="Skills it asks for"
          description="Stored rows on this listing, so the board can match it against what students declare."
        />
        {required.length === 0 && optional.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">
            The person who posted this named no particular skills. That is not the same as none being
            needed — read the description above.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {required.map((row) => (
              <Badge key={row.skill_id} tone="highlight">
                {row.skill!.name}
                <span className="sr-only"> (required)</span>
              </Badge>
            ))}
            {optional.map((row) => (
              <Badge key={row.skill_id} tone="outline">
                {row.skill!.name}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <SectionHeading
          title="How to apply"
          description="Applications go to the organisation. Quad does not collect them and does not record who applied."
        />

        {closed ? (
          <Alert tone="warning" className="mt-3" title={`This listing is closed — ${deadlineLabel(opportunity.deadline, today).toLowerCase()}`}>
            The route below is the organisation’s own, so it may still be open on their side. Quad has no
            later information about it.
          </Alert>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {opportunity.apply_url ? (
            <Button asChild variant={closed ? 'secondary' : 'primary'} size="lg">
              <a href={opportunity.apply_url} target="_blank" rel="noopener noreferrer nofollow">
                <ExternalLink className="size-4" aria-hidden="true" />
                Apply on the organisation’s site
              </a>
            </Button>
          ) : null}

          {opportunity.apply_email ? (
            <a
              href={`mailto:${opportunity.apply_email}`}
              className="inline-flex min-h-11 items-center gap-2 text-sm text-accent-700 underline underline-offset-2"
            >
              <Mail className="size-4" aria-hidden="true" />
              {opportunity.apply_email}
            </a>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
          <SaveOpportunityButton
            opportunityId={opportunity.id}
            slug={opportunity.slug}
            saved={save.saved}
            saveCount={opportunity.save_count}
          />
          <p className="max-w-prose text-xs text-ink-muted">
            Saving is a private bookmark — the person who posted this cannot see who saved it. There is no
            “applied” state on Quad, because nothing here stores one.
          </p>
        </div>
      </section>

      <p className="mt-10 text-xs text-ink-faint">
        <Link href="/opportunities" className="text-accent-700 underline underline-offset-2">
          All opportunities
        </Link>
      </p>
    </div>
  )
}

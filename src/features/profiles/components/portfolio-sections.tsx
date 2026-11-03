import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/surface'
import { LoadMore } from '@/components/ui/pagination'
import { projectStatusLabel, ideaStatusLabel, visibilityLabel } from '@/features/projects/constants'
import { goalStatusLabel } from '@/features/learning/constants'
import type { PortfolioEntry, PortfolioSection, ProfilePortfolio } from '@/features/profiles/portfolio'

const LABELS = { projects: 'Projects', ideas: 'Ideas', goals: 'Goals', posts: 'Posts' } satisfies Record<PortfolioSection, string>
const SECTIONS = Object.keys(LABELS) as PortfolioSection[]
const CREATE_LINKS = {
  projects: { href: '/projects/new', label: 'Start a project' },
  ideas: { href: '/ideas', label: 'Share an idea' },
  goals: { href: '/goals', label: 'Manage your goals' },
  posts: { href: '/feed', label: 'Write a post' },
} as const

function statusLabel(section: PortfolioSection, value: string) {
  return section === 'projects' ? projectStatusLabel(value)
    : section === 'ideas' ? ideaStatusLabel(value)
    : section === 'goals' ? goalStatusLabel(value) : value
}

function Entry({ item, section }: { item: PortfolioEntry; section: PortfolioSection }) {
  return (
    <li className="min-w-0 border-b border-hairline py-4 last:border-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="min-w-0 break-words text-base text-ink">
          {item.href ? (
            <Link href={item.href} className="underline-offset-4 hover:underline">{item.title}</Link>
          ) : item.title}
        </h3>
        {item.status ? <Badge tone="outline">{statusLabel(section, item.status)}</Badge> : null}
        <Badge tone="neutral">{visibilityLabel(item.visibility)}</Badge>
      </div>
      {item.excerpt && item.excerpt !== item.title ? (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink-muted">
          {item.excerpt}
        </p>
      ) : null}
      {item.target_date ? (
        <p className="mt-2 text-xs text-ink-faint">
          Target date <time dateTime={item.target_date}>{item.target_date}</time>
        </p>
      ) : null}
    </li>
  )
}

function nextHref(portfolio: ProfilePortfolio, section: PortfolioSection, basePath: string): string {
  const params = new URLSearchParams()
  for (const candidate of SECTIONS) {
    const cursor = candidate === section ? portfolio[candidate].nextCursor : portfolio[candidate].cursor
    if (cursor) params.set(`portfolio_${candidate}`, cursor)
  }
  return `${basePath}?${params}#portfolio-${section}`
}

/**
 * Synchronous server component: main composes it below the profile view.
 * The DTO's isSelf comes from verified auth; visitors never get owner actions.
 */
export function PortfolioSections({
  portfolio, error, basePath,
}: {
  portfolio: ProfilePortfolio | null
  error?: string | null
  /** Normally /me or /u/<username>. Paging remains on the readable profile. */
  basePath?: string
}) {
  if (error) return <Alert tone="danger">{error}</Alert>
  if (!portfolio) return null
  const path = basePath ?? (portfolio.isSelf ? '/me' : `/u/${encodeURIComponent(portfolio.username)}`)

  return (
    <div className="space-y-8">
      <p className="text-xs text-ink-faint">
        Only work readable by you appears here. Private learning, totals and activity are not inferred.
        Projects are those this person owns; goals are self-declared, not measured mastery.
      </p>
      {SECTIONS.map((section) => {
        const page = portfolio[section]
        const create = CREATE_LINKS[section]
        return (
          <section key={section} id={`portfolio-${section}`} aria-labelledby={`portfolio-${section}-heading`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2">
              <h2 id={`portfolio-${section}-heading`} className="text-xl">{LABELS[section]}</h2>
              {portfolio.isSelf ? (
                <Link href={create.href} className="text-sm text-accent-700 underline underline-offset-4">
                  {create.label}
                </Link>
              ) : null}
            </div>
            {page.error ? <Alert tone="danger" className="mt-3">{page.error}</Alert>
              : page.items === null ? null
              : page.items.length === 0 ? (
                <EmptyState title={`No readable ${section} in this view`} className="mt-3">
                  {portfolio.isSelf
                    ? 'Add something from the link above. Each item keeps its own visibility setting.'
                    : 'Nothing is shared with you in this view. This does not describe private work or learning.'}
                </EmptyState>
              ) : (
                <>
                  <ul>{page.items.map((item) => <Entry key={item.id} item={item} section={section} />)}</ul>
                  {page.nextCursor ? (
                    <LoadMore href={nextHref(portfolio, section, path)} label={`Next ${section}`} />
                  ) : null}
                </>
              )}
          </section>
        )
      })}
    </div>
  )
}

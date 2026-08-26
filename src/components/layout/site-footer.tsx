import Link from 'next/link'
import { Logo } from '@/components/layout/logo'

/**
 * Footer.
 *
 * The legal links point at real pages that say plainly that the documents are
 * drafts pending review. The brief was explicit that legal text must not be
 * invented and must be marked as requiring human review before launch, so the
 * pages say so rather than presenting a confident fabricated policy.
 */
const columns = [
  {
    heading: 'Platform',
    links: [
      { href: '/about', label: 'About Quad' },
      { href: '/universities', label: 'Universities' },
      { href: '/status', label: 'Build status' },
    ],
  },
  {
    heading: 'Community',
    links: [
      { href: '/guidelines', label: 'Community guidelines' },
      { href: '/report-a-bug', label: 'Report a bug' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/terms', label: 'Terms of use' },
      { href: '/privacy', label: 'Privacy' },
    ],
  },
]

export function SiteFooter() {
  return (
    // No top margin: `main` is `flex-1` in the root layout, so on a short page the
    // footer is already pushed to the bottom of the viewport. A margin on top of
    // that would make every short page scroll by exactly the height of the margin.
    <footer className="border-t border-rule bg-paper-sunken">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm text-ink-muted">
            A network for university students: one profile for your studies, projects and
            collaborations.
          </p>
        </div>

        {columns.map((column) => (
          <nav key={column.heading} aria-labelledby={`footer-${column.heading}`}>
            <h2
              id={`footer-${column.heading}`}
              className="font-sans text-2xs font-semibold tracking-wide text-ink-faint uppercase"
            >
              {column.heading}
            </h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-hairline">
        <p className="mx-auto w-full max-w-6xl px-4 py-4 text-xs text-ink-faint sm:px-6">
          Quad is in development. Not affiliated with any university.
        </p>
      </div>
    </footer>
  )
}

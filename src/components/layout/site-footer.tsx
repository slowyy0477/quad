import Link from 'next/link'
import { Logo } from '@/components/layout/logo'
import { ThemeToggle } from '@/components/ui/theme-toggle'

/**
 * Footer.
 *
 * The legal links point at real pages that say plainly that the documents are
 * drafts pending review. The brief was explicit that legal text must not be
 * invented and must be marked as requiring human review before launch, so the
 * pages say so rather than presenting a confident fabricated policy.
 */
const links = [
  { href: '/about', label: 'About' },
  { href: '/guidelines', label: 'Guidelines' },
  { href: '/help', label: 'Help' },
  { href: '/report-a-bug', label: 'Report a bug' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/status', label: 'Build status' },
]

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    // No top margin: `main` is `flex-1` in the root layout, so on a short page the
    // footer is already pushed to the bottom of the viewport. A margin on top of
    // that would make every short page scroll by exactly the height of the margin.
    <footer className="border-t border-hairline">
      <div className={`mx-auto w-full max-w-[1440px] px-4 sm:px-6 ${compact ? 'py-4' : 'py-7'}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          {!compact ? <Logo /> : <p className="text-xs text-ink-faint">Bulla · Your campus, closer.</p>}
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5">
            {links.map(link => <Link key={link.href} href={link.href}
              className="inline-flex min-h-11 items-center text-xs text-ink-muted underline-offset-4 hover:text-ink hover:underline">{link.label}</Link>)}
          </nav>
          {!compact ? <ThemeToggle /> : null}
        </div>
        <p className="mt-3 text-xs text-ink-faint">Independent and in development. Not affiliated with any university.</p>
      </div>
    </footer>
  )
}

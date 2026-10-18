'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { StaffRole } from '@/features/admin/queries'

/**
 * The moderation navigation.
 *
 * A client component for one reason: `usePathname()`. The alternative — passing
 * `current` down from every page — puts the same string in four files and gets it
 * wrong the first time a page is copied.
 *
 * Counts come from the layout, which queries them once per request. They are
 * `count(*)` over stored rows (see features/moderation/queries.ts), never a
 * remembered figure.
 *
 * The bug reports tab is rendered only for an administrator, because that is who
 * can read or change a bug report: `bug_reports_select_admin` and
 * `grant update (status)` are administrator-only in 0020. A tab that opens onto
 * nothing is worse than no tab, and this one would open onto an empty list for
 * every moderator, who would reasonably conclude bug reporting was broken.
 */
export function AdminNav({
  role,
  openReports,
  pendingUniversities,
  openBugs,
}: {
  role: StaffRole
  openReports: number
  pendingUniversities: number
  openBugs: number
}) {
  const pathname = usePathname()

  const items: { href: string; label: string; count?: number }[] = [
    { href: '/admin', label: 'Reports', count: openReports },
    { href: '/admin/universities', label: 'University requests', count: pendingUniversities },
  ]

  if (role === 'admin') {
    items.push({ href: '/admin/bug-reports', label: 'Bug reports', count: openBugs })
  }

  items.push({ href: '/admin/audit', label: 'Audit log' })

  return (
    <nav aria-label="Moderation" className="border-b border-rule">
      <ul className="flex flex-wrap gap-x-1">
        {items.map((item) => {
          // Exact match for the queue, so /admin is not current on /admin/audit.
          const active =
            item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? '-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 border-accent-600 px-3 text-sm font-medium text-ink'
                    : '-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-ink-muted hover:text-ink'
                }
              >
                {item.label}
                {typeof item.count === 'number' ? (
                  <span className="tabular text-xs text-ink-faint">{item.count}</span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

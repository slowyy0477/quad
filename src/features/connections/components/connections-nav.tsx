'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * The section bar for the connections area.
 *
 * A navigation, not a tab widget. Each of these four is a different question about
 * different rows, each has its own URL and its own pagination cursor, and each one
 * can be linked to, bookmarked and opened in a new tab — which is what the
 * interface contract asks of a tabbed view and what a client-side tab strip
 * cannot do without JavaScript.
 *
 * It is a client component for one reason: `usePathname` is a browser API, and it
 * is what marks the current section without every page having to pass its own
 * name down. The links themselves work before any JavaScript arrives.
 */
const SECTIONS = [
  { href: '/connections', label: 'Connections' },
  { href: '/connections/requests', label: 'Requests' },
  { href: '/connections/followers', label: 'Followers' },
  { href: '/connections/blocked', label: 'Blocked' },
] as const

export function ConnectionsNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Connections sections" className="border-b border-rule">
      <ul className="-mb-px flex flex-wrap items-center gap-1">
        {SECTIONS.map((section) => {
          const current = pathname === section.href

          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-ink-muted',
                  'hover:text-ink',
                  'aria-[current=page]:border-accent-600 aria-[current=page]:text-ink',
                )}
              >
                {section.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

'use client'

import Link from 'next/link'
import { useId } from 'react'
import { usePathname } from 'next/navigation'
import { Bookmark, BookOpen, CalendarDays, ChevronDown, Compass, FolderKanban, GraduationCap, Home, Lightbulb, MessagesSquare, NotebookPen, Users, BriefcaseBusiness } from 'lucide-react'
import { cn } from '@/lib/utils'

const groups = [
  { title: 'Your workspace', links: [
    ['/feed', 'Feed', Home], ['/search', 'Discover', Compass], ['/projects', 'Projects', FolderKanban],
    ['/messages', 'Messages', MessagesSquare], ['/goals', 'Learning', BookOpen],
  ] },
  { title: 'Around campus', links: [
    ['/feed/people', 'People', Users], ['/ideas', 'Ideas', Lightbulb],
    ['/opportunities', 'Opportunities', BriefcaseBusiness], ['/events', 'Events', CalendarDays],
    ['/universities', 'Universities', GraduationCap],
  ] },
  { title: 'Personal', links: [
    ['/saved', 'Saved posts', Bookmark], ['/connections', 'Connections', Users], ['/log', 'Study log', NotebookPen],
  ] },
] as const

/** A shared map of real destinations, not a second source of feature-status claims. */
export function WorkspaceNav({ className, onNavigate, compact = false }: { className?: string; onNavigate?: () => void; compact?: boolean }) {
  const pathname = usePathname()
  const id = useId()
  function active(href: string) {
    return (pathname === href || pathname.startsWith(`${href}/`)) &&
      !(href === '/feed' && pathname.startsWith('/feed/people'))
  }
  return (
    <nav aria-label="Campus workspace" className={cn('space-y-6', className)}>
      {groups.map((group) => {
        const groupId = `${id}-${group.title.toLowerCase().replaceAll(' ', '-')}`
        const links = (
          <ul className="mt-2 space-y-0.5" aria-labelledby={groupId}>
            {group.links.map(([href, label, Icon]) => (
              <li key={href}>
                <Link href={href} onClick={onNavigate}
                  aria-current={active(href) ? 'page' : undefined}
                  className={cn('workspace-link flex min-h-11 items-center gap-3 rounded px-3 text-sm font-medium transition-colors',
                    active(href) ? 'bg-accent-50 text-accent-700' : 'text-ink-muted hover:bg-paper-sunken hover:text-ink')}>
                  <Icon className="size-[1.125rem] shrink-0" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        )
        if (compact && group.title === 'Around campus') {
          return (
            <details key={`${group.title}-${pathname}`} className="campus-nav-disclosure" open={group.links.some(([href]) => active(href))}>
              <summary id={groupId} className="flex min-h-11 items-center justify-between gap-2 rounded px-3 text-xs font-medium text-ink-muted hover:bg-paper-sunken">
                {group.title}<ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
              </summary>
              {links}
            </details>
          )
        }
        return (
          <section key={group.title} aria-labelledby={groupId}>
            <h2 id={groupId} className="px-3 text-xs font-medium text-ink-faint">{group.title}</h2>
            {links}
          </section>
        )
      })}
    </nav>
  )
}

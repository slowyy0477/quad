'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell, Compass, Home, Target, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

const items = [
  { href: '/feed', label: 'Feed', Icon: Home, matches: ['/feed', '/post'] },
  { href: '/search', label: 'Discover', Icon: Compass, matches: ['/search', '/projects', '/ideas', '/opportunities', '/events', '/universities', '/feed/people'] },
  { href: '/goals', label: 'Learn', Icon: Target, matches: ['/goals', '/log'] },
  { href: '/notifications', label: 'Alerts', Icon: Bell, matches: ['/notifications'] },
  { href: '/me', label: 'Profile', Icon: UserRound, matches: ['/me', '/settings'] },
] as const

/** A thumb-reachable primary map; the campus menu retains all secondary routes. */
export function MobileNav({ unreadNotifications = 0 }: { unreadNotifications?: number | null }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper-raised pb-[env(safe-area-inset-bottom)] sm:hidden">
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map(({ href, label, Icon, matches }) => {
          const active = matches.some((path) => pathname === path || pathname.startsWith(`${path}/`)) && !(href === '/feed' && pathname.startsWith('/feed/people'))
          return (
            <li key={href} className="min-w-0 flex-1">
              <Link href={href} aria-current={active ? 'page' : undefined}
                className={cn('relative flex min-h-16 flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors', active ? 'text-accent-700' : 'text-ink-muted hover:text-ink')}>
                <span className={cn('flex h-7 w-12 items-center justify-center rounded-full', active && 'bg-accent-50')}><Icon className="size-5" aria-hidden="true" /></span>
                {label}
                {href === '/notifications' && unreadNotifications !== null && unreadNotifications > 0 ? <span className="absolute top-1 right-1/2 -mr-6 min-w-4 rounded-full bg-accent-600 px-1 text-center text-[0.625rem] leading-4 text-accent-contrast tabular" aria-label={`${unreadNotifications} unread`}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span> : null}
                {href === '/notifications' && unreadNotifications === null ? <span className="sr-only">Unread count unavailable</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

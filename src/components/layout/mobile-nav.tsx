'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell, Home, SquareStack, User } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Mobile navigation.
 *
 * Before this, the header hid Feed, Projects and Messages below the `sm` breakpoint and
 * offered nothing in their place — on a phone the only destination a signed-in user
 * could reach was their own profile. Since most students will open this on a phone, that
 * was the most severe defect in the interface, not a rough edge.
 *
 * Four destinations, because a thumb-reachable bar holds four before the labels start
 * competing. Everything else is reachable from these: settings from Me, search from the
 * feed and from the header. The count on Notifications is passed in from the server so
 * the badge is a real number rather than a decorative dot.
 *
 * `aria-current="page"` is what makes the active item announced rather than only
 * coloured, and the bottom padding respects the home-bar inset on iOS.
 */
const items = [
  { href: '/feed', label: 'Feed', Icon: Home },
  { href: '/projects', label: 'Projects', Icon: SquareStack },
  { href: '/notifications', label: 'Alerts', Icon: Bell },
  { href: '/me', label: 'Profile', Icon: User },
] as const

export function MobileNav({ unreadNotifications = 0 }: { unreadNotifications?: number }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper/95 backdrop-blur-[2px] sm:hidden',
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="flex items-stretch">
        {items.map(({ href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-14 flex-col items-center justify-center gap-1 text-2xs',
                  active ? 'text-accent-700' : 'text-ink-muted',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
                {href === '/notifications' && unreadNotifications > 0 ? (
                  <span
                    className="absolute top-2 right-1/2 mr-4 min-w-4 rounded-full bg-accent-600 px-1 text-center text-[0.625rem] leading-4 text-white tabular"
                    aria-label={`${unreadNotifications} unread`}
                  >
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

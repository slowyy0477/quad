import 'server-only'

import Link from 'next/link'
import { Bell, Search } from 'lucide-react'
import { HeaderMenus } from '@/components/layout/header-menus'
import { NotificationHeaderPreview } from '@/components/layout/notification-header-preview'
import { Logo } from '@/components/layout/logo'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SubmitButton } from '@/components/ui/submit-button'
import { signOutAction } from '@/features/auth/actions'
import { isDataConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { LocalModeBanner } from './local-mode-banner'
import type { SessionUser } from '@/lib/supabase/server'

const profileLinks = [
  ['/me', 'Your profile'],
  ['/me/edit', 'Edit your profile'],
  ['/connections/followers', 'Followers'],
  ['/connections/following', 'Following'],
  ['/connections', 'Connections'],
  ['/settings', 'Account & settings'],
] as const

/** Identity, staff destinations and notification activity stay server-owned. */
export function SiteHeader({ user, unreadNotifications = 0, staffRole = null }: { user: SessionUser | null; unreadNotifications?: number | null; staffRole?: 'admin' | 'moderator' | null }) {
  const configured = isDataConfigured()
  const metadataName = user?.user_metadata?.display_name
  const displayName = typeof metadataName === 'string' && metadataName.trim() ? metadataName : 'You'
  const unread = typeof unreadNotifications === 'number' &&
    Number.isSafeInteger(unreadNotifications) && unreadNotifications >= 0 ? unreadNotifications : null
  const signOutForm = (
    <form action={signOutAction}>
      <SubmitButton variant="secondary" block pendingLabel="Signing out…">Sign out</SubmitButton>
    </form>
  )
  const staffLink = staffRole ? (
    <Link href="/admin"
      className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-accent-700 hover:bg-accent-50">
      {staffRole === 'admin' ? 'Site administration' : 'Moderation workspace'}
    </Link>
  ) : null

  return (
    <header className="app-header sticky top-0 z-40 border-b border-hairline">
      <div className="mx-auto flex min-h-16 min-w-0 w-full max-w-[1440px] flex-wrap items-center gap-1.5 gap-y-2 px-4 py-2 sm:gap-3 sm:px-6">
        <Link href={user ? '/feed' : '/'} className="flex min-h-11 shrink-0 items-center rounded-md" aria-label="Bulla home"><Logo /></Link>
        {isLocalMode() ? <LocalModeBanner /> : null}
        {!configured ? <Link href="/setup" className="hidden sm:block"><Badge tone="highlight">Setup required</Badge></Link> : null}
        {user ? <form action="/search" className="relative mx-auto hidden min-w-0 w-full max-w-sm md:block" role="search" aria-label="Search Bulla">
          <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-ink-faint" aria-hidden="true" />
          <label htmlFor="header-search" className="sr-only">Search Bulla</label>
          <input id="header-search" name="q" type="search" placeholder="Search people, projects, campus…" maxLength={120}
            className="min-h-11 w-full rounded border border-hairline bg-paper-sunken/70 pr-3 pl-9 text-sm placeholder:text-ink-faint" />
        </form> : null}
        <nav className="ml-auto flex shrink-0 items-center gap-1" aria-label="Main">
          {user ? (
            <HeaderMenus
              profileTrigger={
                <span aria-hidden="true">
                  <Avatar name={displayName} src={typeof user.user_metadata?.avatar_url === 'string' ? user.user_metadata.avatar_url : null} size="sm" />
                </span>
              }
              profileContent={
                <>
                  <nav aria-label="Your account" className="space-y-1">
                    {profileLinks.map(([href, label]) => (
                      <Link key={href} href={href} prefetch={false}
                        className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-paper-sunken">
                        {label}
                      </Link>
                    ))}
                  </nav>
                  <div className="mt-4 border-t border-hairline pt-3">{signOutForm}</div>
                </>
              }
              notificationTrigger={
                <>
                  <Bell className="size-5" aria-hidden="true" />
                  {unread !== null && unread > 0 ? <span aria-hidden="true" className="absolute top-1 right-0.5 min-w-4 rounded-full bg-accent-600 px-1 text-center text-[0.625rem] leading-4 text-accent-contrast tabular">{unread > 99 ? '99+' : unread}</span> : null}
                </>
              }
              notificationLabel={unread === null ? 'Notifications, unread count unavailable'
                : `Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
              notificationContent={unread === null ? <>
                <p role="status" className="mb-3 text-xs text-ink-muted">Unread count could not be loaded.</p>
                <NotificationHeaderPreview />
              </> : <NotificationHeaderPreview />}
              campusStaffLink={staffLink}
              campusFooter={signOutForm}
            />
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex"><Link href="/about">About</Link></Button>
              <Button asChild variant="ghost" size="sm"><Link href="/login">Sign in</Link></Button>
              <Button asChild variant="primary" size="sm"><Link href="/signup">Join Bulla</Link></Button>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}

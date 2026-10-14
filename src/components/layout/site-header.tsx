import Link from 'next/link'
import { Bell, Settings } from 'lucide-react'
import { Logo } from '@/components/layout/logo'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/features/auth/actions'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

/**
 * Site header.
 *
 * A Server Component, so the signed-in and signed-out headers are decided on the
 * server and the page never flickers from one to the other. It reads the user with
 * `getUser()`, which verifies the token rather than trusting the cookie.
 *
 * Below `sm` this carries only the logo, the notification count and the avatar: Feed,
 * Projects and Notifications move to the bottom bar (see mobile-nav.tsx), because a
 * header that hides every destination and offers nothing in its place is a phone user
 * with no navigation at all.
 *
 * The unread count is passed in from the layout, which performs exactly one count query
 * per request for it. A badge that guesses is worse than no badge.
 *
 * When Supabase is not configured it says so, in the header, on every page. That
 * is the honest state for this deployment: accounts genuinely do not work, and a
 * header offering "Sign in" with no backend behind it would be a fake control.
 */
export async function SiteHeader({ unreadNotifications = 0 }: { unreadNotifications?: number }) {
  const configured = isSupabaseConfigured()
  const user = configured ? await getUser() : null

  const displayName =
    (typeof user?.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : null) ??
    user?.email?.split('@')[0] ??
    'You'

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/90 backdrop-blur-[2px]">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href={user ? '/feed' : '/'} className="rounded" aria-label="Quad home">
          <Logo />
        </Link>

        {!configured ? (
          <Link href="/setup" className="hidden rounded sm:block">
            <Badge tone="highlight">Setup required</Badge>
          </Link>
        ) : null}

        <nav className="ml-auto flex items-center gap-1" aria-label="Main">
          {user ? (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/feed">Feed</Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/projects">Projects</Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/messages">Messages</Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/search">Search</Link>
              </Button>

              <Link
                href="/notifications"
                className="relative ml-1 hidden rounded p-2 text-ink-muted hover:bg-paper-sunken hover:text-ink sm:inline-flex"
              >
                <Bell className="size-4" aria-hidden="true" />
                <span className="sr-only">
                  Notifications{unreadNotifications > 0 ? `, ${unreadNotifications} unread` : ''}
                </span>
                {unreadNotifications > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1 right-1 min-w-3.5 rounded-full bg-accent-600 px-1 text-center text-[0.625rem] leading-3.5 text-white tabular"
                  >
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                ) : null}
              </Link>

              <Button asChild variant="ghost" size="icon" className="hidden sm:inline-flex">
                <Link href="/settings">
                  <Settings className="size-4" aria-hidden="true" />
                  <span className="sr-only">Settings</span>
                </Link>
              </Button>

              <Link
                href="/me"
                className="ml-1 flex items-center gap-2 rounded px-1 py-1 hover:bg-paper-sunken"
              >
                <Avatar
                  name={displayName}
                  src={
                    typeof user.user_metadata?.avatar_url === 'string'
                      ? user.user_metadata.avatar_url
                      : null
                  }
                  size="sm"
                />
                <span className="sr-only">Your profile</span>
              </Link>

              {/* A form, not a link: signing out changes state, and a GET that
                  changes state is fetched by link prefetchers and browser
                  previews. People would be signed out by hovering. */}
              <form action={signOutAction} className="hidden sm:block">
                <Button type="submit" variant="ghost" size="sm">
                  Sign out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/about">About</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild variant="primary" size="sm">
                <Link href="/signup">Join Quad</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}

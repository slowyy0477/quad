import type { Metadata, Viewport } from 'next'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { MobileNav } from '@/components/layout/mobile-nav'
import { SiteWorkspace } from '@/components/layout/site-workspace'
import { isDataConfigured } from '@/lib/env'
import { BRAND } from '@/lib/brand'
import { getUser } from '@/lib/supabase/server'
import { getUnreadNotificationCount } from '@/features/notifications/queries'
import { getStaffRole } from '@/features/admin/queries'
import { headers } from 'next/headers'
import { ThemeScript } from '@/components/ui/theme-script'
import { PwaControls } from '@/components/pwa-controls'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: BRAND.title,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.description,
  applicationName: BRAND.name,
  manifest: '/manifest.webmanifest',
  icons: { icon: BRAND.icon, apple: '/icons/bulla-apple.png' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: BRAND.name },
  // Relative Open Graph images and canonical URLs need a base. Without it Next
  // emits a warning and social scrapers get a relative URL they cannot fetch.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: BRAND.name,
    title: BRAND.title,
    description: BRAND.description,
  },
  robots: {
    // Nothing here is ready to be indexed, and a half-built site in search
    // results is harder to undo than to prevent. Flipped in the launch checklist.
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  // `themeColor` per scheme so the mobile browser chrome matches the page instead
  // of sitting as a white band above a dark interface.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: BRAND.lightCanvas },
    { media: '(prefers-color-scheme: dark)', color: BRAND.darkCanvas },
  ],
}

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const nonce = (await headers()).get('x-nonce') || undefined
  const user = isDataConfigured() ? await getUser() : null
  const [unreadNotifications, staffRole] = await Promise.all([
    user ? getUnreadNotificationCount() : Promise.resolve(0),
    user ? getStaffRole() : Promise.resolve(null),
  ])
  return (
    // data-scroll-behavior tells Next that the smooth scrolling in globals.css is
    // deliberate, so it does not disable it during route transitions.
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head><ThemeScript nonce={nonce} /></head>
      <body className={`flex min-h-dvh flex-col${user ? ' pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0' : ''}`}>
        {/* First focusable element on the page. See .skip-link in globals.css. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        <SiteHeader user={user} unreadNotifications={unreadNotifications} staffRole={staffRole} />
        <PwaControls />

        <div className="flex-1">
          <SiteWorkspace signedIn={Boolean(user)}>{children}</SiteWorkspace>
        </div>

        <SiteFooter compact={Boolean(user)} />
        {user ? <MobileNav unreadNotifications={unreadNotifications} /> : null}
      </body>
    </html>
  )
}

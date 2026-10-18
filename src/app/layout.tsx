import type { Metadata, Viewport } from 'next'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { LocalModeBanner } from '@/components/layout/local-mode-banner'
import { isLocalMode } from '@/lib/mode'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Quad — the university student network',
    template: '%s · Quad',
  },
  description:
    'One profile for your studies, projects and collaborations. Find people at your university, publish what you are building, and keep track of what you are learning.',
  applicationName: 'Quad',
  // Relative Open Graph images and canonical URLs need a base. Without it Next
  // emits a warning and social scrapers get a relative URL they cannot fetch.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: 'Quad',
    title: 'Quad — the university student network',
    description:
      'One profile for your studies, projects and collaborations. Built for university students.',
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
    { media: '(prefers-color-scheme: light)', color: '#fcfbf9' },
    { media: '(prefers-color-scheme: dark)', color: '#1b1c1f' },
  ],
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    // data-scroll-behavior tells Next that the smooth scrolling in globals.css is
    // deliberate, so it does not disable it during route transitions.
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col">
        {/* First focusable element on the page. See .skip-link in globals.css. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        {isLocalMode() ? <LocalModeBanner /> : null}
        <SiteHeader />

        <main id="main" className="flex-1">
          {children}
        </main>

        <SiteFooter />
      </body>
    </html>
  )
}

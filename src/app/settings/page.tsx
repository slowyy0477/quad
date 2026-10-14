import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { PrivacyForm } from '@/features/settings/components/privacy-form'
import { getOwnSettings } from '@/features/settings/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
}

/**
 * Settings.
 *
 * Appearance is a three-way choice applied before first paint (see theme-toggle.tsx and
 * theme-script.tsx) — `globals.css` has documented a dark theme and a settings page that
 * offers one since the design system was written, and until now neither existed.
 *
 * Every control on this page writes to a real column. What is not built is said so in
 * place rather than shown disabled or faked: email change and account deletion need
 * flows that do not exist yet, and a greyed-out button would imply a feature.
 */
export default async function SettingsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl">Settings</h1>
        <Alert tone="warning" title="Setup required" className="mt-6">
          This deployment has no database, so there are no settings to store.{' '}
          <Link href="/setup">See what is missing</Link>.
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/settings')

  const settings = await getOwnSettings()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl">Settings</h1>
      <p className="mt-2 text-sm text-ink-muted">
        These apply to your account on Quad. Nothing here is shared with your university.
      </p>

      {settings.error ? (
        <Alert tone="danger" title="Some settings could not be read" className="mt-6">
          {settings.error}
        </Alert>
      ) : null}

      <section className="mt-10">
        <SectionHeading
          title="Appearance"
          description="Applies immediately, on this device. 'System' follows your operating system and keeps following it."
        />
        <ThemeToggle className="mt-4" />
      </section>

      <section className="mt-10">
        <SectionHeading
          title="Privacy"
          description="Who can see your profile, and who can reach you. These are enforced by the database, not by hiding buttons."
        />
        <Surface className="mt-4 p-5">
          {settings.profile ? (
            <PrivacyForm profile={settings.profile} />
          ) : (
            <p className="text-sm text-ink-muted">
              Your profile could not be loaded, so these controls are not shown rather than shown
              doing nothing.
            </p>
          )}
        </Surface>
      </section>

      <section className="mt-10">
        <SectionHeading title="Account" description="Things that change who you are on Quad." />
        <Surface className="mt-4 divide-y divide-hairline">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-medium text-ink">Email address</p>
              <p className="text-sm text-ink-muted">{user.email}</p>
            </div>
            <BadgeLikeNote />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-medium text-ink">Password</p>
              <p className="text-sm text-ink-muted">
                A reset link is sent to your email address; Quad never shows your password.
              </p>
            </div>
            <Button asChild variant="secondary" size="sm">
              <Link href="/reset-password">Send a reset link</Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-medium text-ink">Delete account</p>
              <p className="max-w-md text-sm text-ink-muted">
                Not built yet. Deletion has to remove your posts, messages and uploads as well as
                your profile, and it is not something to guess at. Until it exists, ask and it will
                be done by hand.
              </p>
            </div>
          </div>
        </Surface>
      </section>

      <p className="mt-10 text-sm text-ink-muted">
        Looking for your name, university or skills? Those live on your{' '}
        <Link href="/me/edit" className="text-accent-700 underline underline-offset-2">
          profile
        </Link>
        .
      </p>
    </div>
  )
}

/** A plain note rather than a disabled control: disabled implies "will work later". */
function BadgeLikeNote() {
  return <span className="text-xs text-ink-faint">Change by email request, not built yet</span>
}

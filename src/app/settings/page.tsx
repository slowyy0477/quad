import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { PrivacyForm } from '@/features/settings/components/privacy-form'
import { getOwnSettings } from '@/features/settings/queries'
import { isDataConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
}

/** Account navigation stays concise; sensitive changes have dedicated reauthentication. */
export default async function SettingsPage() {
  if (!isDataConfigured()) {
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
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-3xl">Settings</h1>
      <p className="mt-2 text-sm text-ink-muted">
        These apply to your account on Bulla. Nothing here is shared with your university.
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
        <SectionHeading title="Account" description="Things that change who you are on Bulla." />
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
                Change it after verifying your account. Other sessions will be signed out.
              </p>
            </div>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings/password">Change password</Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-medium text-ink">Account security</p>
              <p className="max-w-md text-sm text-ink-muted">
                Staff can set up an authenticator and verify access. Local preview
                accounts do not have cloud multi-factor authentication.
              </p>
            </div>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings/security">Review security</Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <p className="text-sm font-medium text-ink">Your data and account</p>
              <p className="max-w-md text-sm text-ink-muted">
                Download your own data or request deletion. Verification, shared-project
                ownership and cleanup rules are explained before you confirm.
              </p>
            </div>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings/account">Manage account data</Link>
            </Button>
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

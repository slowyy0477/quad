import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { Button } from '@/components/ui/button'
import { PasswordChangeForm } from '@/features/auth/components/password-change-form'
import { revokePasswordSessionsAction } from '@/features/auth/password-actions'
import { SubmitButton } from '@/components/ui/submit-button'
import { pendingRecoveryToken } from '@/features/auth/recovery'
import { getAuthCapabilities } from '@/features/auth/providers'
import { isDataConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Change your password' }
export const dynamic = 'force-dynamic'

export default async function PasswordPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const local = isLocalMode()
  if (!isDataConfigured()) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-12">
        <h1 className="text-3xl">Change your password</h1>
        <Alert tone="warning" className="mt-6">
          No account service is configured. <Link href="/setup">View configuration steps</Link>.
        </Alert>
      </div>
    )
  }
  // This is an informational receipt, never authorization for a password write.
  if (params.changed === '1') {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-12">
        <h1 className="text-3xl">Password changed</h1>
        <Alert tone="success" className="mt-6">
          Your new password was saved and account sessions were signed out. Sign in with your new password.
        </Alert>
        {!local ? <p className="mt-4 text-sm text-ink-muted">
          The account service revokes refresh sessions. Already-issued access tokens may remain valid until they expire.
        </p> : null}
        <Button asChild variant="primary" className="mt-6"><Link href="/login">Sign in again</Link></Button>
      </div>
    )
  }
  const recovery = !local && params.recovery === '1'
  if (recovery) {
    const token = await pendingRecoveryToken()
    const capabilities = await getAuthCapabilities()
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-12">
        <h1 className="text-3xl">Set a new password</h1>
        {token && capabilities.emailRecovery ? (
          <>
            <p className="mt-3 text-ink-muted">
              Submit below to verify the one-time link from your email and set a new password.
              Opening this page alone does not verify the link or change your password.
            </p>
            <Surface className="mt-6 p-5 sm:p-6"><PasswordChangeForm recovery /></Surface>
          </>
        ) : (
          <Alert tone="warning" className="mt-6">
            {!capabilities.emailRecovery
              ? capabilities.recoveryUnavailableReason
              : 'This page has no recovery link to verify.'}{' '}
            <Link href="/reset-password">Check recovery availability or request a fresh link</Link>.
          </Alert>
        )}
      </div>
    )
  }
  const user = await getUser()
  if (!user) redirect('/login?next=/settings/password')
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-accent-700 underline">Back to settings</Link>
      <h1 className="mt-3 text-3xl">Change your password</h1>
      <p className="mt-3 text-ink-muted">
        Confirm your current password, then choose a new one. This changes only your signed-in account.
      </p>
      <Surface className="mt-6 p-5 sm:p-6">
        {params.error === 'revocation' ? (
          <div className="space-y-4">
            <Alert tone="warning">All-device sign-out was not confirmed. Your password may already have changed; retry sign-out without submitting your password again.</Alert>
            <form action={revokePasswordSessionsAction}>
              <SubmitButton variant="primary" block pendingLabel="Signing out all devices…">Retry sign-out on all devices</SubmitButton>
            </form>
          </div>
        ) : <PasswordChangeForm email={user.email ?? undefined} />}
      </Surface>
      <p className="mt-5 text-sm text-ink-muted">
        {local
          ? 'Local accounts have no email recovery or second factor. This app cannot reset a forgotten local password.'
          : <>Forgot your password or only used Google? <Link href="/reset-password" className="text-accent-700 underline">Check email recovery availability</Link>.</>}
      </p>
      {!local ? <p className="mt-3 text-xs text-ink-muted">
        Global sign-out revokes refresh sessions. Issued access tokens may remain valid until their expiry.
      </p> : null}
    </div>
  )
}

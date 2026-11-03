import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { StaffMfaForm } from '@/features/auth/components/staff-mfa-form'
import { getStaffMfaSettings } from '@/features/auth/staff-mfa'
import { isLocalMode } from '@/lib/mode'

export const metadata: Metadata = { title: 'Account security', referrer: 'no-referrer' }
export const dynamic = 'force-dynamic'

export default async function SecurityPage() {
  const settings = await getStaffMfaSettings()
  if (settings.state === 'signed_out') redirect('/login?next=/settings/security')

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-accent-700 underline">Back to settings</Link>
      <h1 className="mt-3 text-3xl">Account security</h1>
      {settings.state === 'unavailable' ? (
        <Alert tone="warning" className="mt-6">
          The account service or staff permissions could not be verified. MFA controls and staff assurance are unavailable.
          No authenticator was created by opening this page. <Link href="/setup">View configuration information</Link>.
        </Alert>
      ) : isLocalMode() || settings.state === 'local_unsupported' ? (
        <Alert tone="info" className="mt-6">
          Local accounts have no multi-factor authentication, provider recovery or AAL2 assurance.
          Local staff tools are only a private, loopback-bound preview—not a public deployment.
          You can <Link href="/settings/password">change your password with your current password</Link>.
        </Alert>
      ) : settings.state === 'not_staff' ? (
        <Alert tone="info" className="mt-6">
          Authenticator enrollment on this screen is currently for staff accounts.
          It does not grant a staff role or restrict ordinary account routes.
          You can <Link href="/settings/password">manage your password</Link>.
        </Alert>
      ) : settings.state === 'cloud' ? (
        <>
          <p className="mt-3 text-ink-muted">
            Staff access requires an active account session and a recently verified authenticator.
            A password or Google sign-in alone does not establish staff assurance.
          </p>
          <Alert tone={settings.assured ? 'success' : 'warning'} className="mt-6">
            {settings.assured
              ? 'This staff session is currently verified. Access is checked again on every request and expires five minutes after the latest accepted MFA event.'
              : settings.assuranceUnavailable
                ? 'Live staff-session assurance could not be confirmed. Staff access remains blocked even if your provider shows MFA enabled.'
                : 'Verify an authenticator code below. Staff access remains blocked until fresh live session assurance is confirmed.'}
          </Alert>
          {settings.hasOtherFactors ? (
            <p className="mt-4 text-sm text-ink-muted">
              Other provider factors are preserved. This screen enrolls and challenges TOTP authenticator apps only;
              security-key challenges, phone factors and factor-removal recovery are not implemented here.
            </p>
          ) : null}
          <Surface className="mt-6 p-5 sm:p-6">
            <StaffMfaForm factors={settings.factors} canEnroll={settings.canEnroll} />
          </Surface>
          <p className="mt-5 text-xs text-ink-muted">
            MFA enrollment is complete only after provider verification and session-cookie persistence.
            No email or cloud settings are changed by viewing this page.
          </p>
        </>
      ) : null}
    </div>
  )
}

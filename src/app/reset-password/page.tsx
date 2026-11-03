import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { ResetRequestForm } from '@/features/auth/components/reset-request-form'
import { getAuthCapabilities } from '@/features/auth/providers'

export const metadata: Metadata = { title: 'Reset your password' }

export default async function ResetPasswordPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const capabilities = await getAuthCapabilities()
  const params = await searchParams
  const configured = capabilities.emailRecovery

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-16">
      <h1 className="text-3xl">Reset your password</h1>
      <p className="mt-2 text-ink-muted">
        {configured
          ? 'Request a one-time link using the email address on your cloud account. Delivery depends on the configured email service.'
          : 'Email recovery is not available on this deployment. No local account is recovered by entering an email address.'}
      </p>

      {!configured ? (
        <Alert tone="warning" title="Password reset is unavailable here" className="mt-6">
          <p>
            {capabilities.recoveryUnavailableReason}{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      ) : null}

      {params.error === 'recovery_link' || params.error === 'legacy_link' ? (
        <Alert tone="warning" title="Request a new recovery link" className="mt-6">
          This link is missing, invalid, or uses an older recovery flow. The form below requests a
          fresh link when email recovery is configured.
        </Alert>
      ) : null}

      <Surface className="mt-6 p-5 sm:p-6">
        <ResetRequestForm disabled={!configured} />
      </Surface>

      <p className="mt-5 text-center text-sm text-ink-muted">
        <Link href="/login" className="text-accent-700 underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
      {capabilities.status === 'local' ? <p className="mt-3 text-center text-sm text-ink-muted">
        Still signed in and know your password? <Link href="/settings/password" className="text-accent-700 underline">Change your local password</Link>.
      </p> : null}
    </div>
  )
}

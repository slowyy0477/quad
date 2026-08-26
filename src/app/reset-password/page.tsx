import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { ResetRequestForm } from '@/features/auth/components/reset-request-form'
import { isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Reset your password' }

export default function ResetPasswordPage() {
  const configured = isSupabaseConfigured()

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-16">
      <h1 className="text-3xl">Reset your password</h1>
      <p className="mt-2 text-ink-muted">
        Enter the address you signed up with and we will email you a link to set a new password.
      </p>

      {!configured ? (
        <Alert tone="warning" title="Password reset is unavailable here" className="mt-6">
          <p>
            This deployment has no database or email service connected.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
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
    </div>
  )
}

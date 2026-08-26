import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button'
import { SignUpForm } from '@/features/auth/components/sign-up-form'
import { isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Create your account' }

export default function SignUpPage() {
  const configured = isSupabaseConfigured()

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-16">
      <h1 className="text-3xl">Create your profile</h1>
      <p className="mt-2 text-ink-muted">
        Already here?{' '}
        <Link href="/login" className="text-accent-700 underline underline-offset-2">
          Sign in instead
        </Link>
        .
      </p>

      {!configured ? (
        <Alert tone="warning" title="Accounts are unavailable here" className="mt-6">
          <p>
            This deployment has no database connected, so no account can be created. The form is
            disabled rather than accepting details it cannot save.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      ) : null}

      <Surface className="mt-6 p-5 sm:p-6">
        <SignUpForm disabled={!configured} />

        <div className="my-5 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-hairline" />
          <span className="text-2xs tracking-wide text-ink-faint uppercase">or</span>
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <GoogleSignInButton next="/onboarding" disabled={!configured} />
      </Surface>

      <p className="mt-5 text-xs text-ink-faint">
        We ask for your name and email. Nothing is shared with anyone outside Quad, and your email
        address is never shown on your profile.
      </p>
    </div>
  )
}

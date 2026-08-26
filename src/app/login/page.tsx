import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Surface } from '@/components/ui/surface'
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button'
import { SignInForm } from '@/features/auth/components/sign-in-form'
import { safeRedirect } from '@/features/auth/redirect'
import { isSupabaseConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Sign in' }

/** Callback failures arrive as `?error=`; each gets a sentence a person can act on. */
const callbackMessages: Record<string, string> = {
  link_expired: 'That link has expired or was already used. Request a new one below.',
  oauth: 'We could not start Google sign-in. Try again, or use your email and password.',
  access_denied: 'Google sign-in was cancelled.',
}

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  // searchParams is a Promise in Next 16.
  const params = await searchParams
  const next = safeRedirect(typeof params.next === 'string' ? params.next : null)
  const errorCode = typeof params.error === 'string' ? params.error : null
  const configured = isSupabaseConfigured()

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:py-16">
      <h1 className="text-3xl">Welcome back</h1>
      <p className="mt-2 text-ink-muted">
        Sign in to your Quad account.{' '}
        <Link href="/signup" className="text-accent-700 underline underline-offset-2">
          Need an account?
        </Link>
      </p>

      {!configured ? (
        <Alert tone="warning" title="Sign-in is unavailable here" className="mt-6">
          <p>
            This deployment has no database connected, so there is nothing to sign in to. The form
            below is disabled rather than pretending to work.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      ) : null}

      {errorCode ? (
        <Alert tone="danger" className="mt-6">
          {callbackMessages[errorCode] ?? 'Sign-in did not complete. Please try again.'}
        </Alert>
      ) : null}

      <Surface className="mt-6 p-5 sm:p-6">
        <SignInForm next={next} disabled={!configured} />

        <div className="my-5 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-hairline" />
          <span className="text-2xs tracking-wide text-ink-faint uppercase">or</span>
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <GoogleSignInButton next={next} disabled={!configured} />
      </Surface>

      <p className="mt-5 text-center text-sm text-ink-muted">
        <Link href="/reset-password" className="text-accent-700 underline underline-offset-2">
          Forgot your password?
        </Link>
      </p>
    </div>
  )
}

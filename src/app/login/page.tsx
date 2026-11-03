import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { AccountShell } from '@/features/auth/components/account-shell'
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button'
import { SignInForm } from '@/features/auth/components/sign-in-form'
import { safeRedirect } from '@/features/auth/redirect'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'

export const metadata: Metadata = { title: 'Sign in' }
const callbackMessages: Record<string, string> = {
  link_expired: 'That link has expired or was already used. Request a new one below.',
  oauth: 'We could not start Google sign-in. Try again, or use your email and password.',
  access_denied: 'Google sign-in was cancelled.',
}

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams
  const next = safeRedirect(typeof params.next === 'string' ? params.next : null)
  const errorCode = typeof params.error === 'string' ? params.error : null
  const local = isLocalMode()
  const configured = local || isSupabaseConfigured()

  return (
    <AccountShell title="Welcome back." description="Sign in to pick up your projects, learning goals and campus conversations."
      footer={<>New to Bulla? <Link href="/signup" className="inline-flex min-h-11 items-center font-semibold text-accent-700 underline underline-offset-4">Create an account</Link></>}>
      <h2 className="text-xl">Sign in with email</h2>
      <p className="mt-1 mb-6 text-sm text-ink-muted">Use the email address on your account.</p>
      {!configured ? <Alert tone="warning" title="Sign-in is unavailable" className="mb-5"><p>The account service is unavailable. <Link href="/help">Get help</Link>.</p></Alert> : null}
      {errorCode ? <Alert tone="danger" className="mb-5">{callbackMessages[errorCode] ?? 'Sign-in did not complete. Please try again.'}</Alert> : null}
      <SignInForm next={next} disabled={!configured} />
      {!local && configured ? <>
        <div className="my-5 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-hairline" /><span className="text-xs text-ink-faint">or</span><span className="h-px flex-1 bg-hairline" /></div>
        <GoogleSignInButton next={next} />
        <Link href="/reset-password" className="mt-3 flex min-h-11 items-center justify-center text-sm font-medium text-accent-700 underline underline-offset-4">Forgot your password?</Link>
      </> : null}
      {local ? <p className="mt-5 border-t border-hairline pt-4 text-xs text-ink-muted">Local accounts stay on this computer. Google sign-in and email recovery are unavailable in local mode.</p> : null}
    </AccountShell>
  )
}

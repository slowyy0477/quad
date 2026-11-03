import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { AccountShell } from '@/features/auth/components/account-shell'
import { GoogleSignInButton } from '@/features/auth/components/google-sign-in-button'
import { SignUpForm } from '@/features/auth/components/sign-up-form'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'

export const metadata: Metadata = { title: 'Create your account' }

export default function SignUpPage() {
  const local = isLocalMode()
  const configured = local || isSupabaseConfigured()
  return (
    <AccountShell joining title="Your next chapter starts here." description="Create an account now. Add your university, interests and projects as you go."
      footer={<>Already have an account? <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-accent-700 underline underline-offset-4">Sign in</Link></>}>
      <h2 className="text-xl">Create your account</h2>
      <p className="mt-1 mb-6 text-sm text-ink-muted">Just the essentials. Your profile comes next.</p>
      {!configured ? <Alert tone="warning" title="Accounts are unavailable" className="mb-5"><p>No account service is connected. <Link href="/setup">View configuration steps</Link>.</p></Alert> : null}
      <SignUpForm disabled={!configured} />
      {!local && configured ? <>
        <div className="my-5 flex items-center gap-3" aria-hidden="true"><span className="h-px flex-1 bg-hairline" /><span className="text-xs text-ink-faint">or</span><span className="h-px flex-1 bg-hairline" /></div>
        <GoogleSignInButton next="/onboarding" />
      </> : null}
      <p className="mt-5 border-t border-hairline pt-4 text-xs text-ink-muted">{local ? 'Local accounts and their content stay on this computer. Email verification and Google sign-in are unavailable here.' : 'Your email address is used for your account, not displayed on your student profile.'}</p>
    </AccountShell>
  )
}

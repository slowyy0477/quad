import Link from 'next/link'
import type { Metadata } from 'next'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Check your email' }

/**
 * Post-signup confirmation.
 *
 * Says "if an account was created" rather than "your account was created",
 * because the signup action deliberately does not distinguish a new address from
 * one that already exists — see the note in features/auth/actions.ts. The wording
 * has to match the behaviour or the page leaks what the action withheld.
 */
export default async function CheckEmailPage({ searchParams }: PageProps<'/signup/check-email'>) {
  const params = await searchParams
  const email = typeof params.email === 'string' ? params.email : null

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 text-center">
      <MailCheck className="mx-auto size-8 text-accent-600" aria-hidden="true" />
      <h1 className="mt-4 text-2xl">Check your email</h1>

      <p className="mt-3 text-ink-muted">
        {email ? (
          <>
            If an account can be created for <span className="font-medium text-ink">{email}</span>,
            a confirmation link is on its way. Open it to finish setting up your profile.
          </>
        ) : (
          <>
            If an account can be created for that address, a confirmation link is on its way. Open
            it to finish setting up your profile.
          </>
        )}
      </p>

      <p className="mt-4 text-sm text-ink-faint">
        The link expires after a while. Nothing arrived? Check spam, then try signing up again — and
        if you already have an account, sign in instead.
      </p>

      <div className="mt-8 flex justify-center gap-3">
        <Button asChild variant="secondary">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    </div>
  )
}

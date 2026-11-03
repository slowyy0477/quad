import Link from 'next/link'
import type { Metadata } from 'next'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isLocalMode } from '@/lib/mode'

export const metadata: Metadata = { title: 'Reset link sent' }

/**
 * Says "if an account exists" on purpose. Confirming that a given address is
 * registered turns this form into an account-existence check that anyone can run
 * against any email address.
 */
export default function ResetSentPage() {
  const local = isLocalMode()
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 text-center">
      <MailCheck className="mx-auto size-8 text-accent-600" aria-hidden="true" />
      <h1 className="mt-4 text-2xl">{local ? 'Email recovery is unavailable' : 'Check your email'}</h1>
      <p className="mt-3 text-ink-muted">
        {local
          ? 'Local accounts have no email service or forgotten-password recovery. This page has not sent any message.'
          : 'If an account exists for that address and email delivery is configured, check your inbox for a recovery link. Use the latest link; it works once and expires according to the account service settings.'}
      </p>
      <div className="mt-8 flex justify-center">
        <Button asChild variant="secondary">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </div>
  )
}

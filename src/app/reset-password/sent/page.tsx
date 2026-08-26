import Link from 'next/link'
import type { Metadata } from 'next'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Reset link sent' }

/**
 * Says "if an account exists" on purpose. Confirming that a given address is
 * registered turns this form into an account-existence check that anyone can run
 * against any email address.
 */
export default function ResetSentPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 text-center">
      <MailCheck className="mx-auto size-8 text-accent-600" aria-hidden="true" />
      <h1 className="mt-4 text-2xl">Check your email</h1>
      <p className="mt-3 text-ink-muted">
        If an account exists for that address, a link to set a new password is on its way. The link
        works once and expires after an hour.
      </p>
      <div className="mt-8 flex justify-center">
        <Button asChild variant="secondary">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </div>
  )
}

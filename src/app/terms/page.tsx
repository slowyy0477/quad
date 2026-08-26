import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'

export const metadata: Metadata = { title: 'Terms of use' }

/**
 * Terms of use — a draft, and labelled as one.
 *
 * This document was not written by a lawyer and must not be presented as though it
 * were. The brief was explicit that legal content must not be invented and must be
 * marked as needing human review before launch, so the notice below is part of the
 * page rather than a comment in the source: a reader has to see it.
 *
 * What follows is an honest description of how the software actually behaves, which
 * is the useful raw material for a real lawyer to work from — not a substitute for
 * one.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Terms of use</h1>

      <Alert tone="warning" title="Draft — requires legal review before launch" className="mt-6">
        <p>
          This is a plain-English description of how Quad works, written by the people building it.
          It has not been reviewed by a lawyer and is not a contract. It must be replaced with a
          reviewed document before Quad is opened to real users.
        </p>
      </Alert>

      <div className="mt-8 space-y-6 text-sm text-ink-muted">
        <section>
          <h2 className="text-lg text-ink">Who can use Quad</h2>
          <p className="mt-1.5">
            Current university students and staff. You need a working email address, and one account
            per person.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">Your content stays yours</h2>
          <p className="mt-1.5">
            You keep ownership of everything you post. You grant Quad permission to store it and to
            show it to the audience you chose in that item&rsquo;s visibility setting, and nothing
            wider. Deleting content removes it from the platform; backups are retained for a limited
            period for recovery, and are not readable by other users.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">What you may not do</h2>
          <p className="mt-1.5">
            The{' '}
            <Link href="/guidelines" className="text-accent-700 underline underline-offset-2">
              community guidelines
            </Link>{' '}
            are part of these terms. In addition: do not attempt to access data you were not granted
            access to, do not attempt to overwhelm the service, and do not scrape the platform.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">Skills and achievements are self-declared</h2>
          <p className="mt-1.5">
            Quad records what you say about your own abilities. It does not test them and makes no
            representation to anyone — including any employer — that a stated skill level is
            accurate. Achievements are awarded automatically for actions taken on the platform and
            mean only that: that the action happened here.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">The service is in development</h2>
          <p className="mt-1.5">
            Quad is unfinished and provided as-is. Features may change or be removed, and data loss
            during development is possible. Do not use Quad as the only copy of anything you need.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">Ending your account</h2>
          <p className="mt-1.5">
            You can deactivate or delete your account at any time. We may suspend an account that
            breaches the guidelines, and will say which rule was breached when we do.
          </p>
        </section>
      </div>
    </div>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { BugReportForm } from '@/features/bugs/components/bug-report-form'
import { BugReportList } from '@/features/bugs/components/bug-report-list'
import { getOwnBugReports } from '@/features/bugs/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

/**
 * Report a bug.
 *
 * A real form, not a mailto link and not a placeholder. It replaces an eight-line
 * page that promised a form and rendered nothing, which is the specific failure
 * PRODUCT.md rule 2 is about: a control that does nothing is worse than no
 * control, because it costs the reader the effort of using it and teaches them
 * that reporting things here does not work.
 *
 * What the page is honest about:
 *
 *   * **Who reads this.** One person maintains Quad. There is no support team, no
 *     ticket number and no response time, and saying so is better than a
 *     reassurance that gets discovered to be false.
 *   * **The list below the form is real.** It is `bug_reports` filtered by the
 *     reporter, so a reader can see that their report went somewhere. A form whose
 *     submissions vanish into an inbox nobody can look into is indistinguishable
 *     from a form whose submissions vanish.
 *   * **This is not how you report a person.** Reporting a post, a comment or an
 *     account is done on the thing itself, where the report carries the target and
 *     reaches the moderation queue. Sending a moderation complaint here would put
 *     it in the wrong queue, so the page says where to go instead.
 *
 * `robots: { index: false }` — a form page is not a search result, and the query
 * string people arrive with is nobody's business.
 */
export const metadata: Metadata = {
  title: 'Report a bug',
  description: 'Tell the maintainer something is broken.',
  robots: { index: false, follow: false },
}

export default async function ReportABugPage() {
  const configured = isSupabaseConfigured()
  const user = configured ? await getUser() : null
  const signedIn = Boolean(user)

  const own = signedIn ? await getOwnBugReports() : { rows: [], total: 0, error: null }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <header className="pb-6">
        <h1 className="text-3xl">Report a bug</h1>
        <p className="mt-2 max-w-prose text-ink-muted">
          Something broken, something confusing, something that lost your work — all of it is
          useful, and this form is the only way to send it.
        </p>
      </header>

      {!configured ? (
        <Alert tone="warning" title="Supabase is not configured" className="mt-6">
          There is no database to write to, so the form is not rendered. Set{' '}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{' '}
          <code>.env.local</code> and restart the dev server.
        </Alert>
      ) : null}

      {configured && !signedIn ? (
        <Alert tone="info" title="Sign in first" className="mt-6">
          Bug reports are stored against an account, so the maintainer can ask you for more detail
          and so the same report does not arrive five times.{' '}
          <Link href="/login?next=/report-a-bug" className="rounded underline underline-offset-2">
            Sign in
          </Link>{' '}
          and come back — the form will be here.
        </Alert>
      ) : null}

      {configured ? (
        <Surface className="mt-6 p-5">
          <BugReportForm signedIn={signedIn} />
        </Surface>
      ) : null}

      <div className="mt-6 space-y-3 text-sm text-ink-muted">
        <p>
          Reports are read by the one person who maintains Quad, roughly in the order they arrive.
          There is no support desk, no ticket number and no promised response time — a report about a
          typo may sit for a month and a report about data loss will not.
        </p>
        <p>
          <span className="text-ink">This is not how you report a person.</span> To report a post, a
          comment, a project, an idea, a message or an account, use the Report control on the thing
          itself. That reaches the moderation queue with the content attached; a report sent here
          would reach the bug list instead.
        </p>
      </div>

      {signedIn ? (
        <section className="mt-10">
          <SectionHeading level={2} title="What you have sent" />

          {own.error ? (
            <Alert tone="danger" title="Your reports could not be loaded" className="mt-4">
              {own.error}
            </Alert>
          ) : (
            <div className="mt-4">
              <BugReportList
                reports={own.rows ?? []}
                emptyMessage="Nothing yet. If you send a report, it appears here straight away, with its status changing as the maintainer works through it."
              />
            </div>
          )}

          {own.rows && own.rows.length >= 20 ? (
            <p className="mt-3 text-xs text-ink-faint">
              Showing the twenty most recent. Older reports are still stored and are visible to the
              maintainer.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

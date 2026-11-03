import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

/** Account entry is a configure surface: the form comes before feature decoration. */
export function AccountShell({ title, description, children, footer, joining = false }: {
  title: string; description: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; joining?: boolean
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:py-16">
      <div className="auth-layout">
        <section className="min-w-0">
          <p className="eyebrow">{joining ? 'Start your campus workspace' : 'Back to your campus'}</p>
          <h1 className="mt-3 text-3xl sm:text-4xl">{title}</h1>
          <p className="mt-4 max-w-md text-base text-ink-muted sm:text-lg">{description}</p>
          <div className="mt-8 hidden max-w-md border-t border-rule pt-6 lg:block">
            <h2 className="text-xl">A place for what you’re working on.</h2>
            <p className="mt-3 text-sm text-ink-muted">Find a project worth joining. Turn a study plan into progress. Keep your classmates close.</p>
            <ol className="mt-6 space-y-5">
              {[
                ['01', 'Make it yours', 'Your university, interests and skills, on one profile.'],
                ['02', 'Find your people', 'Projects, ideas and students with shared interests.'],
                ['03', 'Keep moving', 'Learning goals and a study log for your semester.'],
              ].map(([number, heading, body]) => (
                <li key={number} className="flex items-start gap-4">
                  <span aria-hidden="true" className="w-6 shrink-0 pt-1 font-mono text-xs whitespace-nowrap text-accent-700">{number}</span>
                  <div><p className="text-sm font-semibold">{heading}</p><p className="mt-1 text-sm text-ink-muted">{body}</p></div>
                </li>
              ))}
            </ol>
            <Link href="/about" className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent-700">More about Bulla<ArrowUpRight className="size-4" aria-hidden="true" /></Link>
          </div>
        </section>
        <div className="min-w-0">
          <section className="auth-form-panel" aria-label={joining ? 'Create your account' : 'Sign in to Bulla'}>{children}</section>
          {footer ? <div className="mt-5 text-center text-sm text-ink-muted">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}

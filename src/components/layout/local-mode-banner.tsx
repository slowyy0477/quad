import Link from 'next/link'

/**
 * The local-mode strip.
 *
 * One line, at the top of every page, saying which mode this build is in and where
 * the data actually lives. It is not a warning banner to be dismissed — it is a
 * statement of fact about the deployment, and it stays until the deployment changes.
 *
 * The honesty matters more than the tidiness: everything behind this page is stored
 * in a JSON file with no row-level security, and a reviewer who mistakes that for
 * the Postgres build would draw the wrong conclusion about what has been proved.
 *
 * At 390px the long clause is dropped rather than wrapped over four lines. The short
 * sentence still says the important part, and the detail is one tap away.
 */
export function LocalModeBanner() {
  return (
    <div className="border-b border-highlight-400/45 bg-highlight-100">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-2xs text-highlight-700 sm:px-6">
        <span className="font-medium uppercase tracking-[0.14em]">Local mode</span>
        <span aria-hidden>·</span>
        <span>
          Data is stored on this computer.
          <span className="hidden sm:inline">
            {' '}
            Accounts, posts and messages live in <code className="font-mono">data/local.json</code>
            : no database, no email, nothing leaves the machine.
          </span>
        </span>
        <Link href="/status" className="py-1 underline underline-offset-2 hover:text-ink sm:ml-auto">
          What works
        </Link>
      </div>
    </div>
  )
}

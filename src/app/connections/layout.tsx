import type { Metadata } from 'next'
import { ConnectionsNav } from '@/features/connections/components/connections-nav'

export const metadata: Metadata = { title: 'People' }

/**
 * The connections area.
 *
 * The heading and the section bar live here so the four sections share them and
 * cannot drift apart. Each section keeps its own URL, its own query and its own
 * cursor, which is why this is a navigation of real links rather than one page
 * with a tab strip: a section that cannot be linked to or opened in a second tab
 * is a section people stop using.
 */
export default function ConnectionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl">People</h1>
      <p className="mt-2 max-w-prose text-ink-muted">
        Connecting with someone is a two-sided decision they have to accept. Following is not: it
        asks for nothing and tells the other person nothing.
      </p>

      <div className="mt-6">
        <ConnectionsNav />
      </div>

      <div className="mt-8">{children}</div>
    </div>
  )
}

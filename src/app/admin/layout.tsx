import type { Metadata } from 'next'
import { AdminNav } from '@/features/admin/components/admin-nav'
import { AdminUnconfigured, StaffOnly } from '@/features/admin/components/admin-shell'
import { getStaffRole } from '@/features/admin/queries'
import { countOpenBugReports } from '@/features/bugs/queries'
import { getModerationCounts } from '@/features/moderation/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

/**
 * The /admin shell, and the first of two guards.
 *
 * This layout refuses a non-moderator by URL. It is not a hidden link and it is
 * not a client-side check: the role is read from `user_roles` under the caller's
 * own session on every request, and a request that arrives here with no role gets
 * a page that says so. `proxy.ts` redirects signed-out visitors away from /admin,
 * but that is a convenience and SECURITY.md §2.1 is explicit that it protects
 * nothing — a request that never passes through the proxy reaches this file.
 *
 * Every page under this directory checks the same thing again for itself. That is
 * not redundancy for its own sake: a layout is not a security boundary in the
 * Next.js sense — pages can render without their layout in some error and
 * streaming paths — and "the layout checked" is exactly the reasoning that leaves
 * one page exposed.
 *
 * `robots: { index: false }` is repeated from the root layout deliberately. If
 * somebody ever unsets it at the root, this area must not become indexable by
 * default.
 */
export const metadata: Metadata = {
  title: 'Moderation',
  robots: { index: false, follow: false },
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <AdminUnconfigured />

  const [role, user] = await Promise.all([getStaffRole(), getUser()])

  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  const counts = await getModerationCounts()
  // Zero for a moderator, and honestly so: it is the number of rows they can read.
  const openBugs = role === 'admin' ? await countOpenBugReports() : 0

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="pb-5">
        <h1 className="font-display text-2xl text-ink">Moderation</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Every decision here is recorded against your account with the reason you give, and the
          record cannot be edited or deleted afterwards. Deciding a report about yourself is
          refused by the database, not by this page.
        </p>
      </header>

      <AdminNav
        role={role}
        openReports={counts.openReports}
        pendingUniversities={counts.pendingUniversities}
        openBugs={openBugs}
      />

      <div className="mt-6">{children}</div>
    </div>
  )
}

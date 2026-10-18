import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { SectionHeading, Surface } from '@/components/ui/surface'
import type { StaffRole } from '@/features/admin/queries'

/**
 * Shared pieces of the /admin shell.
 *
 * Two jobs: the plain statement of what a moderator cannot see, and the refusal a
 * signed-in non-moderator gets at a /admin URL. The second is a component and not
 * a redirect, because a redirect to the feed looks like the page does not exist —
 * and "the page does not exist" is what people conclude when they cannot find a
 * thing, which makes them ask. Saying "this is not available to your account" is
 * both true and the end of the conversation.
 */

/**
 * What a moderator cannot see.
 *
 * Written from the threat model rather than from the code, so it stays true if
 * the code changes: each line names something docs/SECURITY.md §8 says is not
 * visible, and each is enforced by a policy in 0002/0010/0020.
 */
export function ModerationLimits({ role }: { role: StaffRole }) {
  return (
    <Surface className="mt-10 p-5">
      <SectionHeading
        level={3}
        title="What you cannot see from here"
        description="Worth reading once. A moderator who believes they have more reach than they do makes worse decisions than one who knows the edge."
      />

      <ul className="mt-3 space-y-3 text-sm text-ink-muted">
        <li>
          <span className="text-ink">Private messages nobody reported.</span> A reported message is
          readable, so it can be judged. The rest of that conversation — and every other
          conversation in the database — is not. There is no policy under which you can open a
          thread, and the queue does not name the sender of a message.
        </li>
        <li>
          <span className="text-ink">Anyone&rsquo;s password.</span> There is nothing to see.
          Supabase Auth stores a hash, and no code path in this application can read it.
        </li>
        <li>
          <span className="text-ink">The audit log, as editable text.</span> Decisions are
          append-only: there is no UPDATE policy, no DELETE policy and no grant for either, and a
          trigger refuses both on top of that. A wrong decision is corrected by recording a second
          one that supersedes it, and both stay on the record.
        </li>
        <li>
          <span className="text-ink">A report about you.</span> You cannot decide it, not even to
          dismiss it. Another moderator will.
        </li>
        {role === 'moderator' ? (
          <li>
            <span className="text-ink">A report about an administrator.</span> A moderator who
            could suspend an administrator could take the site&rsquo;s checks offline. Another
            administrator decides those.
          </li>
        ) : null}
        <li>
          <span className="text-ink">Bug reports, unless you are an administrator.</span> They
          carry the environment somebody was using, and the maintainer reads them.
        </li>
      </ul>
    </Surface>
  )
}

/** The refusal a signed-in non-moderator sees at a /admin URL. */
export function StaffOnly({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
      <h1 className="font-display text-2xl">Not available to your account</h1>

      <Alert tone="warning" title="Moderators only" className="mt-6">
        {signedIn
          ? 'This area is for moderators. Your account does not hold that role, so nothing behind this URL has been rendered for it.'
          : 'This area is for moderators. Sign in with an account that holds the role.'}
      </Alert>

      <p className="mt-6 text-sm text-ink-muted">
        Moderation decisions are recorded against the account that made them, which is why the role
        is not something the interface can grant.
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <Link href="/feed">Back to the feed</Link>
        </Button>
        {signedIn ? null : (
          <Button asChild variant="primary">
            <Link href="/login?next=/admin">Sign in</Link>
          </Button>
        )}
      </div>
    </div>
  )
}

/** What /admin shows when there is no database to talk to. */
export function AdminUnconfigured() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
      <h1 className="font-display text-2xl">Moderation</h1>

      <Alert tone="warning" title="Supabase is not configured" className="mt-6">
        There is no database to read. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
        <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code> and restart the dev
        server.
      </Alert>

      <p className="mt-6 text-sm text-ink-muted">
        The queues, the audit log and the university requests all live in Postgres, so this page has
        nothing to show rather than an empty version of itself.
      </p>
    </div>
  )
}

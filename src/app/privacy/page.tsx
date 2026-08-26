import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'

export const metadata: Metadata = { title: 'Privacy' }

/**
 * Privacy notice — a draft, and labelled as one.
 *
 * Same rule as the terms page: not written by a lawyer, not presented as if it
 * were. What it does contain is accurate about the software, which is the part
 * engineers are actually qualified to write. Where a claim would depend on
 * operational decisions nobody has made yet (retention periods, sub-processors),
 * it says so instead of inventing a number.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Privacy</h1>

      <Alert tone="warning" title="Draft — requires legal review before launch" className="mt-6">
        <p>
          This describes what the software stores and who can read it. It is accurate about the
          implementation and incomplete as a legal privacy notice: retention periods, the identity of
          any sub-processors, and the lawful basis for each purpose still need to be decided and
          reviewed before launch.
        </p>
      </Alert>

      <div className="mt-8 space-y-6 text-sm text-ink-muted">
        <section>
          <h2 className="text-lg text-ink">What is stored</h2>
          <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
            <li>
              <span className="font-medium text-ink">Account:</span> email address, and a password
              hash if you signed up with a password. Quad never stores your password and no
              administrator can read it — password checking happens inside Supabase Auth.
            </li>
            <li>
              <span className="font-medium text-ink">Profile:</span> whatever you put on it. All of
              it is optional except a display name and a handle.
            </li>
            <li>
              <span className="font-medium text-ink">Content:</span> posts, projects, ideas,
              messages, goals and study log entries, each with the visibility you set.
            </li>
            <li>
              <span className="font-medium text-ink">Relationships:</span> connections, follows and
              blocks. Blocks are not shown to the person blocked.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg text-ink">Who can read it</h2>
          <p className="mt-1.5">
            Each row in the database carries a visibility setting, and access is enforced by
            row-level security in Postgres rather than by the interface. A row you are not permitted
            to read is not returned, regardless of how the request is made. Private messages are
            readable only by their participants.
          </p>
          <p className="mt-2">
            Two exceptions, stated because they are the ones people are entitled to know about:
            platform administrators hold a database key that can bypass those rules and is required
            for backups and for investigating abuse; and once moderation tooling exists, a moderator
            reviewing a reported message will be able to read that specific reported message. Every
            such action will be written to an append-only audit log.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">What is not done with it</h2>
          <p className="mt-1.5">
            Your content is not sold, is not used to target advertising, and is not used to train
            machine-learning models. Quad has no advertising at present; if that changes, adverts
            will not appear in private messages and will not be targeted using message content.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">Third parties currently involved</h2>
          <p className="mt-1.5">
            Supabase, which hosts the database, authentication and file storage. If you sign in with
            Google, Google confirms your identity to Supabase; Quad requests your name, email address
            and profile picture and no other permission. Analytics and email delivery providers are
            not yet chosen, and this notice will name them when they are.
          </p>
        </section>

        <section>
          <h2 className="text-lg text-ink">Your control</h2>
          <p className="mt-1.5">
            You can change any profile field, change the visibility of anything you have posted,
            delete individual items, and delete your account. Deleting your account removes your
            profile and content; messages you sent will show as being from a former member so that
            the remaining participants&rsquo; conversations stay readable.
          </p>
        </section>
      </div>
    </div>
  )
}

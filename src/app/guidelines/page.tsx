import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'

export const metadata: Metadata = {
  title: 'Community guidelines',
  description: 'What is expected of people on Quad, and what happens when those expectations are not met.',
}

const rules = [
  {
    title: 'Be identifiable',
    body: 'Use a name people at your university would recognise. Anonymous accounts make a small academic community unworkable and are the main vector for harassment in one.',
  },
  {
    title: 'Post your own work, and say when it is not',
    body: 'Sharing someone else\'s project is fine when you credit them. Presenting it as yours is not. The same goes for coursework: if a project was a group assignment, list the group.',
  },
  {
    title: 'No academic dishonesty',
    body: 'Do not post solutions to assessments that are still open, do not offer to write someone\'s work for them, and do not ask. Quad is for what you built, not for circumventing what you were asked to build.',
  },
  {
    title: 'No harassment',
    body: 'Sustained unwanted contact, pile-ons, slurs, sexual harassment, and posting someone\'s personal details. Blocking exists and is enforced by the database, not by hiding a button — a blocked account cannot read your posts or message you.',
  },
  {
    title: 'No commercial spam',
    body: 'Recruiting for a paid product, a crypto scheme, or an essay mill. Genuine internship and scholarship postings belong in Opportunities.',
  },
  {
    title: 'Respect visibility settings',
    body: 'If something was shared with connections or with a university, do not republish it more widely. The platform enforces who can read a row; it cannot stop a person copying and pasting, so this one is on you.',
  },
]

export default function GuidelinesPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">Community guidelines</h1>
      <p className="mt-3 text-ink-muted">
        Quad is a small, mostly non-anonymous community of people who will run into each other in
        seminars. These are the expectations that follow from that.
      </p>

      <Alert tone="warning" title="Enforcement is not built yet" className="mt-6">
        <p>
          Reporting, moderation queues and the admin audit log are the next piece of work. Until they
          exist there is no in-app way to report a breach of these guidelines, and it would be
          dishonest to show a report button that goes nowhere.
        </p>
      </Alert>

      <div className="mt-8 space-y-6">
        {rules.map((rule) => (
          <section key={rule.title} className="border-t border-hairline pt-4">
            <h2 className="text-lg">{rule.title}</h2>
            <p className="mt-1.5 text-sm text-ink-muted">{rule.body}</p>
          </section>
        ))}
      </div>

      <section className="mt-10 border-t border-rule pt-6">
        <h2 className="text-xl">What happens when a rule is broken</h2>
        <p className="mt-2 text-sm text-ink-muted">
          The intended process, once the moderation tooling exists: a warning for a first minor
          breach, hiding or removing the specific content, temporary suspension for repetition, and a
          permanent ban for harassment or academic-dishonesty-for-hire. Every moderation action will
          be recorded in an append-only audit log with the moderator, the reason and the timestamp,
          and the person affected will be told what was actioned and why.
        </p>
      </section>
    </div>
  )
}

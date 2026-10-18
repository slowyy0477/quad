import Link from 'next/link'
import {
  ArrowRight,
  CalendarDays,
  FolderGit2,
  GraduationCap,
  Lightbulb,
  MessagesSquare,
  Target,
  Users,
} from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

/**
 * Landing page.
 *
 * Deliberately makes no claims it cannot back. No "10,000 students", no "trusted
 * by", no counter animating up from zero -- there is no one on this platform yet
 * and inventing a number would be the most straightforwardly dishonest thing on
 * the page. What it does instead is describe what the thing is for, and link to a
 * build-status page that says which parts actually work.
 *
 * Layout is a broadsheet: a wide measure for the lead, a rule under the masthead,
 * a three-column grid of departments below. Not a hero image with a gradient.
 */
const sections = [
  {
    icon: GraduationCap,
    title: 'A profile that says something',
    body: 'University, department, programme, semester. Skills you declare, projects you have actually shipped, and what you are studying right now — instead of a job title you do not have yet.',
  },
  {
    icon: FolderGit2,
    title: 'Projects, not just posts',
    body: 'Publish coursework, side projects and research with a real write-up, links, and the people who worked on it. Mark a project as looking for collaborators and let people apply.',
  },
  {
    icon: Lightbulb,
    title: 'Ideas before they are projects',
    body: 'Post a half-formed idea, see who is interested, and convert it into a project with its collaborators attached when it stops being hypothetical.',
  },
  {
    icon: Users,
    title: 'People at your university',
    body: 'Connections, follows, and a feed that knows the difference between your course, your university, and everyone. Search by skill, department or programme.',
  },
  {
    icon: MessagesSquare,
    title: 'Conversations that stay private',
    body: 'Direct and group messages. Private means private: message access is enforced in the database, not by hiding a button.',
  },
  {
    icon: Target,
    title: 'Learning you can see',
    body: 'Semester goals, a daily study log, and a streak that counts days you actually logged. Progress you set yourself, measured against what you said you would do.',
  },
  {
    icon: CalendarDays,
    title: 'Opportunities and events',
    body: 'Internships, scholarships, competitions, hackathons and society events, posted by students and staff at your university rather than scraped from somewhere else.',
  },
]

export default async function HomePage() {
  const configured = isSupabaseConfigured()
  const user = configured ? await getUser() : null

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      {!configured ? (
        <div className="pt-6">
          <Alert tone="warning" title="This deployment has no database connected">
            <p>
              You are seeing the interface, not a working platform. Sign-in, profiles, posts and
              messages need Supabase credentials before they do anything.{' '}
              <Link href="/setup">See what is missing and how to set it up</Link>.
            </p>
          </Alert>
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Lead                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="border-b border-rule py-14 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            <p className="font-sans text-2xs font-semibold tracking-[0.14em] text-accent-700 uppercase">
              For university students
            </p>

            <h1 className="mt-4 text-4xl text-balance sm:text-5xl">
              Your degree is more than a transcript.
            </h1>

            <p className="mt-5 max-w-2xl text-lg text-ink-muted">
              Quad is a network built around what students actually do: study something specific,
              build things, work with people, and get slowly better at a craft. One profile that
              holds all of it — and a community from your own university attached to it.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              {user ? (
                <Button asChild variant="primary" size="lg">
                  <Link href="/feed">
                    Go to your feed
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
                    <Link href="/signup">Create your profile</Link>
                  </Button>
                  <Button asChild variant="secondary" size="lg" className="w-full sm:w-auto">
                    <Link href="/login">Sign in</Link>
                  </Button>
                </>
              )}
            </div>

            <p className="mt-4 text-sm text-ink-faint">
              Free while in development. No adverts in private messages, ever.
            </p>
          </div>

          {/* A statement of intent rather than a screenshot of invented data. */}
          <aside className="lg:border-l lg:border-hairline lg:pl-10">
            <h2 className="font-sans text-2xs font-semibold tracking-[0.14em] text-ink-faint uppercase">
              What this is not
            </h2>
            <ul className="mt-4 space-y-4 text-sm text-ink-muted">
              <li>
                <span className="font-medium text-ink">Not a job board.</span> Nobody is asking you
                for eight years of experience. Skill levels here are what you say they are, and the
                interface says so.
              </li>
              <li>
                <span className="font-medium text-ink">Not an engagement machine.</span> No infinite
                doomscroll, no notification invented to pull you back, no metric that rewards
                posting for its own sake.
              </li>
              <li>
                <span className="font-medium text-ink">Not finished.</span> Quad is being built in
                the open, and the{' '}
                <Link href="/status" className="text-accent-700 underline underline-offset-2">
                  status page
                </Link>{' '}
                lists every feature and whether it works yet.
              </li>
            </ul>
          </aside>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Departments                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="py-14 sm:py-16">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl">What is inside</h2>
          <p className="text-2xs uppercase tracking-[0.14em] text-ink-faint">In active development</p>
        </div>

        <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map(({ icon: Icon, title, body }) => (
            <article key={title} className="border-t border-hairline pt-4">
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-accent-600" aria-hidden="true" />
                <h3 className="text-lg">{title}</h3>
              </div>
              <p className="mt-1.5 text-sm text-ink-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Privacy — the part students actually ask about                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="border-t border-rule py-14 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <h2 className="text-2xl">Privacy that is enforced, not promised</h2>
            <p className="mt-4 text-ink-muted">
              Every profile, post, project and message on Quad has a visibility setting, and every
              one of them is checked inside the database by row-level security. Hiding a button is
              not a permission model: if you are not allowed to read a row, the query returns
              nothing, whether it came from this website or from anywhere else.
            </p>
            <p className="mt-4 text-ink-muted">
              There are 52 tables and every one of them has policies. The rules are covered by an
              automated test suite that signs in as each kind of user and checks what they can and
              cannot reach.
            </p>
          </div>

          <dl className="grid gap-6 sm:grid-cols-2">
            {[
              ['Public', 'Anyone, including people who are not signed in.'],
              ['University', 'Only students verified at the same university as you.'],
              ['Connections', 'Only people whose connection request you accepted.'],
              ['Private', 'Only you.'],
            ].map(([term, definition]) => (
              <div key={term} className="border-t border-hairline pt-3">
                <dt className="font-display text-base font-semibold text-ink">{term}</dt>
                <dd className="mt-1 text-sm text-ink-muted">{definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Close                                                               */}
      {/* ------------------------------------------------------------------ */}
      {!user ? (
        <section className="border-t border-rule py-14 text-center sm:py-16">
          <h2 className="text-2xl">Start with a profile</h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-muted">
            Takes a minute. Add your university, pick a handle, and put one project on it — you can
            fill in the rest as the semester goes.
          </p>
          <div className="mt-7 flex justify-center">
            <Button asChild variant="primary" size="lg">
              <Link href="/signup">
                Create your profile
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

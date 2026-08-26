import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'About',
  description: 'What Quad is for, who it is for, and what it deliberately is not.',
}

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl">About Quad</h1>

      <div className="mt-6 space-y-5 text-ink-muted">
        <p>
          Quad is a network for university students. The premise is that the interesting facts about
          a student are specific — what they are studying, what they are building, who they are
          building it with, what they are trying to get better at this semester — and that none of
          the existing places to put those facts were designed for them.
        </p>

        <h2 className="pt-4 text-xl text-ink">Who it is for</h2>
        <p>
          Undergraduates and postgraduates, and the societies, labs and course groups they belong
          to. Not recruiters, and not alumni networking in the LinkedIn sense. A first-year with one
          half-finished project should not be competing for attention with someone who has a decade
          of employment history.
        </p>

        <h2 className="pt-4 text-xl text-ink">What it deliberately is not</h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <span className="font-medium text-ink">Not a skill-verification service.</span> When you
            say you are intermediate at Python, Quad records that you said so. It has no way to test
            the claim and does not pretend otherwise — skill levels are shown as self-declared,
            everywhere they appear.
          </li>
          <li>
            <span className="font-medium text-ink">Not an attention business.</span> There is no
            algorithmic feed designed to keep you scrolling, and no notification that exists to pull
            you back rather than to tell you something happened.
          </li>
          <li>
            <span className="font-medium text-ink">Not a data broker.</span> Adverts, if they are
            ever introduced, will not appear in private messages, and will not be targeted using the
            contents of anything you write.
          </li>
        </ul>

        <h2 className="pt-4 text-xl text-ink">Built in the open, and unfinished</h2>
        <p>
          Quad is in active development. Large parts of it exist as a database with enforced
          permissions and no interface yet. Rather than hide that, the{' '}
          <Link href="/status" className="text-accent-700 underline underline-offset-2">
            build status page
          </Link>{' '}
          lists every feature and its actual state, and pages for unbuilt features say plainly that
          they are unbuilt.
        </p>

        <h2 className="pt-4 text-xl text-ink">Affiliation</h2>
        <p>
          Quad is not affiliated with, endorsed by, or operated on behalf of any university. Where a
          university appears on the platform it is because students added it, and a “verified”
          marker means an administrator checked the institution exists — not that the institution
          approved of anything here.
        </p>
      </div>
    </div>
  )
}

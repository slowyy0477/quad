import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { SectionHeading } from '@/components/ui/surface'
import { SkillsEditor } from '@/features/skills/components/skills-editor'
import {
  listInterestCatalogue,
  listProfileInterests,
  listProfileSkills,
  listSkillCatalogue,
} from '@/features/skills/queries'
import { getMyProfile } from '@/features/profiles/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Skills and interests',
  robots: { index: false, follow: false },
}

/**
 * Editing your own skills and interests.
 *
 * A route of its own rather than more fields on `/me/edit`, for two reasons: the
 * edit page is one form with one save at the bottom, and this is a list where each
 * row saves itself; and these rows are in different tables with different policies,
 * so folding them into one form would hide which table a failure came from.
 *
 * The sentence about self-declared levels is on this page as well as on the
 * profile. It is the claim the whole feature rests on, and a reader who only ever
 * sees this page is the person most likely to assume a level means something.
 */
export default async function SkillsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl">Skills and interests</h1>
        <Alert tone="warning" title="No database connected" className="mt-6">
          <p>
            Skills are rows in a catalogue table. Without Supabase credentials there is nowhere to
            save one. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/me/skills')

  const profile = await getMyProfile()

  if (profile.state !== 'ok') {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl">Skills and interests</h1>
        <Alert tone="danger" title="Your profile could not be read" className="mt-6">
          <p>
            A skill is claimed by a profile, so without the profile row there is nothing to attach
            them to. This is the same missing-row problem described on{' '}
            <Link href="/me">your profile page</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const [skills, interests, skillCatalogue, interestCatalogue] = await Promise.all([
    listProfileSkills(profile.profile.id),
    listProfileInterests(profile.profile.id),
    listSkillCatalogue(),
    listInterestCatalogue(),
  ])

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <p className="font-sans text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
        Your profile
      </p>
      <h1 className="mt-2 text-3xl">Skills and interests</h1>
      <p className="mt-2 max-w-prose text-ink-muted">
        Skills are what you can do; interests are what you want to talk about. They are separate on
        purpose — claiming you can do something and wanting to discuss it are different statements.
      </p>

      <Alert tone="info" title="Levels are self-declared" className="mt-6">
        <p>
          Quad does not test anyone&rsquo;s skills and does not verify a level. Nothing on your
          profile is presented as checked — not by a badge, not by a colour, not by a score out of
          five.
        </p>
      </Alert>

      <div className="mt-10">
        <SectionHeading
          title="Skills"
          description="Each row saves on its own.
          Nothing here is a rating: the level is your own description of where you are."
          className="border-b border-hairline"
        />
        <div className="mt-5">
          <SkillsEditor
            skills={skills}
            interests={interests}
            skillCatalogue={skillCatalogue}
            interestCatalogue={interestCatalogue}
          />
        </div>
      </div>

      <p className="mt-10 border-t border-hairline pt-4 text-xs text-ink-faint">
        Skills and interests appear on{' '}
        <Link href="/me" className="text-accent-700 underline underline-offset-2">
          your profile
        </Link>
        . A skill you add yourself is reviewed by a moderator before anyone else can see the name,
        and the row is labelled while it waits.
      </p>
    </div>
  )
}

import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { NewProjectForm } from '@/features/projects/components/new-project-form'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Create a project',
  robots: { index: false, follow: false },
}

/**
 * Create a project.
 *
 * One page, three decisions. The slug is generated from the title and collision-checked
 * against the unique index by `app.unique_slug` in the insert trigger, so a second
 * "Campus Ride Share" becomes `campus-ride-share-2` rather than failing. The owner and
 * the university are taken from the session and the owner's profile, and the creator's
 * membership row — with the owner role — is written by the same trigger, so a new
 * project demonstrably has one person on it.
 *
 * After creation the reader lands on the project with a first-update offer, which is
 * the composer already on that page.
 */
export default async function NewProjectPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-2xl">Create a project</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          A project is stored in Postgres. Without Supabase credentials there is nowhere to save it.{' '}
          <Link href="/setup">Configuration steps</Link>.
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/projects/new')

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <SectionHeading
        title="Create a project"
        description="Three things, and the rest is generated. You become the owner straight away."
      />

      <Surface className="mt-5 p-5">
        <NewProjectForm />
      </Surface>

      <p className="mt-6 text-sm text-ink-muted">
        Want to float the idea before there is a team?{' '}
        <Link href="/ideas" className="text-accent-700 underline underline-offset-2">
          Post it in the idea vault
        </Link>{' '}
        and people who want to help can say so.
      </p>

      <div className="mt-8">
        <Button asChild variant="ghost">
          <Link href="/projects">Back to projects</Link>
        </Button>
      </div>
    </div>
  )
}

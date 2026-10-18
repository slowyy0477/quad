import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { NewEventForm } from '@/features/events/components/new-event-form'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Create an event' }

/**
 * Signed-out readers are sent to sign in rather than shown a form whose submit would fail:
 * an event is attached to an account, and the insert trigger takes the organiser from the
 * session.
 */
export default async function NewEventPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Create an event</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            An event is stored in Postgres, so there is nothing to create without Supabase credentials.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/events/new')

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl text-ink">Create an event</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        A workshop, a hackathon, a study group, a talk. Give it a time and the zone that time is in, and it
        appears on the calendar for everyone who can see it.
      </p>

      <div className="mt-6">
        <NewEventForm />
      </div>
    </div>
  )
}

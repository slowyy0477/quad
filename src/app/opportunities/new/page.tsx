import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { NewOpportunityForm } from '@/features/opportunities/components/new-opportunity-form'
import { listSkillOptions } from '@/features/opportunities/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Post a listing' }

/**
 * The posting form.
 *
 * Signed-out readers are sent to sign in rather than shown a form whose submit would
 * fail: a listing is attached to an account, and the insert trigger takes the author from
 * the session.
 */
export default async function NewOpportunityPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Post a listing</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            A listing is stored in Postgres, so there is nothing to post into without Supabase
            credentials. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/opportunities/new')

  const skills = await listSkillOptions()

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl text-ink">Post a listing</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        An internship, a scholarship, a competition, a research placement. Post it here and it appears on
        the board for everyone whose university it belongs to.
      </p>

      <div className="mt-6">
        <NewOpportunityForm skills={skills} />
      </div>
    </div>
  )
}

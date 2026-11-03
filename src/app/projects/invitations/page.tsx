import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { InviteResponse } from '@/features/projects/components/invite-response'
import { listMyProjectInvitations } from '@/features/projects/invitations'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Project invitations' }

export default async function ProjectInvitationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!await getUser()) redirect('/login?next=%2Fprojects%2Finvitations')
  const params = await searchParams
  const result = await listMyProjectInvitations({
    cursor: Array.isArray(params.cursor) ? params.cursor[0] : params.cursor,
    limit: 10,
  })

  return (
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <SectionHeading level={1} title="Project invitations"
        description="Private invitations sent to you. Accepting joins the team; declining does not."
        action={<Button asChild variant="secondary" size="sm"><Link href="/projects">Back to projects</Link></Button>} />

      {result.error ? (
        <Alert className="mt-6" tone="danger" title="Invitations could not be loaded">{result.error}</Alert>
      ) : result.invitations.length === 0 ? (
        <EmptyState className="mt-6" title="No pending project invitations">
          <p>New invitations appear here. You can also discover teams that are open to join.</p>
          <Link href="/projects?lens=open" className="mt-3 inline-flex min-h-11 items-center text-accent-700 underline underline-offset-4">
            Explore open projects
          </Link>
        </EmptyState>
      ) : (
        <div className="mt-6 space-y-4">
          {result.invitations.map(invitation => <InviteResponse key={invitation.id} invitation={invitation} />)}
          {result.nextCursor
            ? <LoadMore href={cursorHref('/projects/invitations', params, result.nextCursor)} label="Older invitations" />
            : <EndOfList label="That is every pending invitation." />}
        </div>
      )}
    </div>
  )
}

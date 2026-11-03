'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SubmitButton } from '@/components/ui/submit-button'
import { convertIdeaToProjectAction } from '@/features/ideas/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Turning an idea into a project.
 *
 * This is the one control on the page whose consequences are not obvious, so it states
 * them before it is pressed rather than after: what is created, what carries across,
 * who may be invited, and that it happens once. Interest counts are recorded
 * offers, not guarantees: current privacy, blocks and write limits still apply.
 *
 * The conversion runs `public.convert_idea_to_project_with_invites`, which creates the project
 * and marks the idea converted in one transaction and refuses a second run. The invites
 * are real `project_invites` rows, so the existing notification trigger tells each
 * person; nothing is faked with a message.
 */
export function ConvertForm({
  ideaId,
  interestCount,
  requiredSkillCount,
  status,
  convertedProjectSlug,
}: {
  ideaId: string
  interestCount: number
  requiredSkillCount: number
  status: string
  convertedProjectSlug?: string | null
}) {
  const [state, action] = useActionState(convertIdeaToProjectAction, emptyFormState)

  if (status === 'converted') {
    return (
      <Alert tone="success" title="This idea is a project now">
        {convertedProjectSlug ? (
          <>
            It lives at{' '}
            <Link href={`/projects/${convertedProjectSlug}`} className="text-accent-700 underline underline-offset-2">
              /projects/{convertedProjectSlug}
            </Link>
            . An idea converts once; there is nothing left to do here.
          </>
        ) : (
          <>It has been converted, and the project it became is linked from it.</>
        )}
      </Alert>
    )
  }

  return (
    <form action={action} className="space-y-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The idea was not converted">
          {state.message}
        </Alert>
      ) : null}

      <input type="hidden" name="ideaId" value={ideaId} />

      <div className="rounded border border-hairline bg-paper-sunken p-4">
        <p className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
          What happens when you convert
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-ink">
          <li>A new project is created from this title, pitch and category, with you as its owner.</li>
          <li>
            {requiredSkillCount > 0
              ? `${requiredSkillCount} required ${requiredSkillCount === 1 ? 'skill' : 'skills'} carry across to the project.`
              : 'No required skills are listed, so none carry across — you can add them on the project afterwards.'}
          </li>
          <li>
            {interestCount > 0
              ? `${interestCount} ${interestCount === 1 ? 'person has' : 'people have'} offered to help. Eligible people will be invited, subject to privacy, blocks and limits.`
              : 'No offers are currently recorded. Invitation eligibility is checked when you convert.'}
          </li>
          <li className="text-ink-muted">
            This happens once. The idea is marked as converted and cannot be converted again.
          </li>
        </ul>
      </div>

      <SubmitButton variant="primary" pendingLabel="Converting…">
        Create the project from this idea
      </SubmitButton>

      <p className="text-xs text-ink-muted">
        Not ready?{' '}
        <Link href="/projects/new" className="text-accent-700 underline underline-offset-2">
          Create a project by hand
        </Link>{' '}
        instead — an idea is only the shortcut.
      </p>

      <Button asChild variant="ghost" size="sm">
        <Link href={`/ideas/${ideaId}`}>Back to the idea</Link>
      </Button>
    </form>
  )
}

'use server'

import { revalidatePath } from 'next/cache'
import {
  action,
  ActionError,
  formInput,
  rateLimit,
  requireActiveAccount,
  requireRole,
  toFormState,
} from '@/lib/action'
import { bugReportSchema, bugTriageSchema } from '@/features/bugs/schemas'
import type { BugFormState, BugTriageFormState } from '@/features/bugs/form-state'

/**
 * Bug reports and their triage.
 *
 * Bug reports go through the same pipeline as everything else on purpose. A "just
 * for the maintainer" form is the classic place where the wrapper gets skipped,
 * and it is the form most likely to be spammed by somebody who has noticed that
 * it writes a row.
 *
 * The triage path is administrator-only in two places that cannot disagree:
 * `requireRole('admin')` is the courteous refusal, and `bug_reports` has no UPDATE
 * policy for moderators (0020), so removing the step would still change nothing.
 */

const fileBug = action(bugReportSchema)
  .use(requireActiveAccount)
  .use(rateLimit('bug:file'))
  .run(async ({ input, supabase }) => {
    const { error } = await supabase.from('bug_reports').insert({
      title: input.title,
      body: input.body,
      page_url: input.pageUrl ?? null,
    })

    if (error) {
      console.error('[bugs:fileBug]', error.code, error.message)
      throw error
    }

    revalidatePath('/report-a-bug')
    revalidatePath('/admin/bug-reports')

    return {
      message:
        'Thank you — it is on the list. Bug reports are read by the person who maintains Quad, in the order they arrive.',
    }
  })

export async function submitBugReportAction(
  _previous: BugFormState,
  formData: FormData,
): Promise<BugFormState> {
  const result = await fileBug(formInput(formData))
  return toFormState(
    result,
    'Thank you — it is on the list. Bug reports are read by the person who maintains Quad, in the order they arrive.',
    formData,
  )
}

const triageBug = action(bugTriageSchema)
  .use(requireActiveAccount)
  .use(requireRole('admin'))
  .use(rateLimit('bug:triage'))
  .run(async ({ input, supabase }) => {
    // Status only: `grant update (status)` in 0020 is column-by-column, so
    // `reporter_id` and `created_at` cannot be written back by a client even by
    // accident.
    const { data, error } = await supabase
      .from('bug_reports')
      .update({ status: input.status })
      .eq('id', input.bugId)
      .select('id')
      .returns<{ id: string }[]>()

    if (error) {
      console.error('[bugs:triageBug]', error.code, error.message)
      throw error
    }

    /*
     * An UPDATE filtered away by a policy is not an error, it is zero rows — and
     * reporting success for a write that did not happen is how a maintainer ends
     * up believing a bug was closed. The `.select('id')` above exists to make the
     * difference visible here rather than nowhere.
     */
    if (!data || data.length === 0) {
      throw new ActionError(
        'That report was not changed: it no longer exists, or it is not yours to change.',
      )
    }

    revalidatePath('/admin/bug-reports')
    revalidatePath('/report-a-bug')

    return { message: 'Saved.' }
  })

export async function triageBugReportAction(
  _previous: BugTriageFormState,
  formData: FormData,
): Promise<BugTriageFormState> {
  const result = await triageBug(formInput(formData))
  return toFormState(result, 'Saved.', formData)
}

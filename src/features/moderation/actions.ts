'use server'

import { revalidatePath } from 'next/cache'
import {
  action,
  ActionError,
  formInput,
  guard,
  rateLimit,
  requireActiveAccount,
  requireRole,
  toFormState,
  type ActionContext,
} from '@/lib/action'
import {
  moderationDecisionSchema,
  reportSchema,
  universityReviewSchema,
  REPORT_TARGET_COLUMN,
  type ModerationAction,
  type ReportInput,
} from '@/features/moderation/schemas'
import type {
  ModerationFormState,
  ReportFormState,
  UniversityReviewFormState,
} from '@/features/moderation/form-state'

/**
 * Moderation writes.
 *
 * Every action here goes through the wrapper in src/lib/action.ts — parse, auth,
 * account status, rate limit, ownership guard, service, revalidate — which is
 * what ARCHITECTURE §4 specifies and what the three actions written before it
 * existed have not yet been moved onto.
 *
 * What is *not* here is the part that matters most: authorised writes. A report
 * is inserted into a table whose INSERT grant excludes `status`, `reviewed_by`
 * and `reporter_id`; a decision is made by calling a SECURITY DEFINER function
 * that checks `app.is_moderator()` for itself and refuses a report about the
 * caller. Removing every check in this file would make the interface worse and
 * would not make any of those writes possible. That is the point of putting
 * authorisation in Postgres.
 */

/** The table each report kind's target lives in, for the visibility guard. */
const TARGET_TABLE: Record<ReportInput['kind'], string> = {
  post: 'posts',
  comment: 'comments',
  project: 'projects',
  idea: 'ideas',
  message: 'messages',
  profile: 'profiles',
}

/**
 * Can the caller see what they are reporting?
 *
 * Not an authorisation decision — it cannot be, because the query runs under the
 * caller's own RLS and returns nothing for a row they may not read. It is there
 * so the refusal is a sentence rather than a foreign-key error, and because
 * without it the report table becomes an enumeration oracle: file a report
 * against a guessed id and see whether it is refused.
 */
async function targetIsVisible(ctx: ActionContext, input: ReportInput): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from(TARGET_TABLE[input.kind])
    .select('id')
    .eq('id', input.targetId)
    .maybeSingle<{ id: string }>()

  if (error) {
    console.error('[moderation:targetIsVisible]', input.kind, error.code, error.message)
    return false
  }

  return Boolean(data)
}

const fileReport = action(reportSchema)
  .use(requireActiveAccount)
  .use(rateLimit('report:file'))
  .use(guard('You can only report something you can see.', targetIsVisible))
  .run(async ({ input, supabase }) => {
    const { error } = await supabase.from('reports').insert({
      kind: input.kind,
      reason: input.reason,
      detail: input.detail ?? null,
      // One target column, chosen by the same map the CHECK constraint mirrors.
      [REPORT_TARGET_COLUMN[input.kind]]: input.targetId,
    })

    if (error) {
      console.error('[moderation:fileReport]', error.code, error.message)

      // 23505 is the partial unique index: this reader already has an open
      // report about this thing. The generic sentence for a duplicate key
      // ("something with that name already exists") would be nonsense here,
      // which is why the domain overrides it and the wrapper keeps the rest.
      if (error.code === '23505') {
        throw new ActionError(
          'You have already reported this, and a moderator has not decided on it yet. ' +
            'They will get to it — reporting it again does not move it up the queue.',
        )
      }

      throw error
    }

    revalidatePath('/report-a-bug')
    return {
      message:
        'Thank you. A moderator will look at it, and you will be told when they have decided.',
    }
  })

export async function submitReportAction(
  _previous: ReportFormState,
  formData: FormData,
): Promise<ReportFormState> {
  const result = await fileReport(formInput(formData))
  return toFormState(
    result,
    'Thank you. A moderator will look at it, and you will be told when they have decided.',
    formData,
  )
}

// ---------------------------------------------------------------------------
// Deciding a report
// ---------------------------------------------------------------------------

/**
 * What the database's `hint` codes mean in the interface.
 *
 * The RPC raises with a stable machine-readable hint and prose meant for a log.
 * Mapping the hint rather than the message keeps the copy in this file — where it
 * can be read, reviewed and translated — and keeps `error.message` out of the
 * browser, which is the rule the whole application follows.
 */
const DECISION_REFUSALS: Record<string, string> = {
  not_moderator: 'That is not available to your account.',
  self_moderation_forbidden:
    'You cannot decide a report about yourself. Ask another moderator to look at it.',
  admin_target_forbidden:
    'Reports about an administrator are decided by another administrator.',
  report_closed: 'That report has already been decided. Reload the queue to see the current state.',
  report_not_found: 'That report no longer exists.',
  reason_required: 'A reason is required: the reason is what the audit log records.',
  no_target: 'The account this report is about no longer exists, so there is nobody to act on.',
  no_content_for_kind:
    'That is a profile report: warn or suspend the account instead of hiding content.',
  unknown_action: 'That action is not one this queue supports.',
  account_suspended: 'Your account is suspended, so it cannot decide reports at the moment.',
}

/** What to say after each action succeeded. */
const DECISION_COPY: Record<ModerationAction, string> = {
  hide_content: 'Hidden. The author has been told their content was hidden.',
  remove_content: 'Removed. The author has been told their content was removed.',
  restore_content: 'Restored. The content is visible again.',
  warn_user: 'Warning recorded on the account.',
  suspend_user: 'The account is suspended for the period you chose.',
  dismiss_report: 'Dismissed. The reporter has been told it was reviewed.',
}

const decideReport = action(moderationDecisionSchema)
  // A suspended moderator cannot decide reports, which is what makes suspension
  // mean something for the staff accounts too. The database refuses it as well,
  // through the same predicate.
  .use(requireActiveAccount)
  .use(requireRole('moderator'))
  .use(rateLimit('moderation:decide'))
  .run(async ({ input, supabase }) => {
    const { error } = await supabase.rpc('moderate_report', {
      p_report_id: input.reportId,
      p_action: input.action,
      p_reason: input.reason,
      p_days: input.days,
    })

    if (error) {
      console.error('[moderation:decideReport]', error.code, error.message, error.hint ?? '')

      const refusal = error.hint ? DECISION_REFUSALS[error.hint] : undefined
      if (refusal) throw new ActionError(refusal)

      throw error
    }

    revalidatePath('/admin')
    revalidatePath('/admin/audit')
    // The feed, because hiding or removing content changes what everyone sees.
    revalidatePath('/feed')

    return { message: DECISION_COPY[input.action] }
  })

export async function decideReportAction(
  _previous: ModerationFormState,
  formData: FormData,
): Promise<ModerationFormState> {
  const result = await decideReport(formInput(formData))
  return toFormState(result, 'Done.', formData)
}

// ---------------------------------------------------------------------------
// Reviewing a university request
// ---------------------------------------------------------------------------

const reviewUniversity = action(universityReviewSchema)
  .use(requireActiveAccount)
  .use(requireRole('moderator'))
  .use(rateLimit('moderation:university'))
  .run(async ({ input, supabase }) => {
    const { error } = await supabase.rpc('review_university_request', {
      p_university_id: input.universityId,
      p_decision: input.decision,
      p_reason: input.reason,
    })

    if (error) {
      console.error('[moderation:reviewUniversity]', error.code, error.message, error.hint ?? '')

      const refusal = error.hint ? DECISION_REFUSALS[error.hint] : undefined
      if (refusal) throw new ActionError(refusal)

      throw error
    }

    revalidatePath('/admin/universities')
    revalidatePath('/admin/audit')
    revalidatePath('/universities')

    return {
      message:
        input.decision === 'approve'
          ? 'Approved. The university is now listed publicly.'
          : 'Rejected. The request is closed and the reason is in the audit log.',
    }
  })

export async function reviewUniversityAction(
  _previous: UniversityReviewFormState,
  formData: FormData,
): Promise<UniversityReviewFormState> {
  const result = await reviewUniversity(formInput(formData))
  return toFormState(result, 'Done.', formData)
}

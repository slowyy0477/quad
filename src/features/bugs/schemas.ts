import { z } from 'zod'
import { optionalText, requiredText } from '@/lib/form-schemas'

/**
 * Bug report validation.
 *
 * The same bounds as the CHECK constraints in 0020. A form that accepts what the
 * database refuses produces an error message about a database constraint, which
 * is the one thing the house rules say a person should never see.
 */

/** Where a report can be in its life. Admin-only to set; see bugTriageSchema. */
export const BUG_STATUSES = ['open', 'reviewed', 'fixed', 'closed'] as const
export type BugStatus = (typeof BUG_STATUSES)[number]

/**
 * The words a person reads for each state.
 *
 * In the schema module rather than in the queries or the components, because both
 * the reader's list and the maintainer's triage control render the same four
 * states and two vocabularies for one status is how a person ends up unsure
 * whether "reviewed" and "looked at" are the same thing. This module is imported
 * by client components already (it holds the zod schemas), so nothing here may
 * touch the database.
 */
export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Received',
  reviewed: 'Looked at',
  fixed: 'Fixed',
  closed: 'Closed without a fix',
}

/**
 * What a reader may put in the form.
 *
 * There is no severity and no category field, and that is not an omission: the
 * `bug_reports` table in 0020 has neither column, and a select whose value is
 * dropped on the floor is a control that appears to do something. When triage
 * needs a category it will be a column, a grant and a field, in that order.
 */
export const bugReportSchema = z.object({
  title: requiredText(3, 160, 'The summary'),
  body: requiredText(10, 5000, 'What happened'),
  /** Filled in by the form from window.location. Empty when it cannot be read. */
  pageUrl: optionalText(500, 'The page'),
})

/**
 * Triage: the status, and nothing else.
 *
 * `grant update (status)` in 0020 is column-by-column, so a resolution note is
 * not merely absent from this schema — it is a column the client cannot write at
 * all. A triage note belongs in a comment on the issue tracker, where it survives
 * longer than a text field on a table nobody reads twice.
 */
export const bugTriageSchema = z.object({
  bugId: z.string().trim().uuid(),
  status: z.enum(BUG_STATUSES),
})

export type BugReportInput = z.infer<typeof bugReportSchema>
export type BugTriageInput = z.infer<typeof bugTriageSchema>

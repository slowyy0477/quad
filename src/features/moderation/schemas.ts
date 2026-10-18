import { z } from 'zod'
import { optionalText, requiredText } from '@/lib/form-schemas'

/**
 * Moderation validation.
 *
 * The bounds here mirror the CHECK constraints in 0020 exactly. The database is
 * what makes them true; this is what makes the refusal legible before a round
 * trip.
 *
 * Note what is absent from every schema below: `status`, `reviewed_by`,
 * `reviewed_at`, `actor_id` and `reporter_id`. They are the columns that decide
 * what a row means, they are not in any client INSERT grant, and a form field for
 * one of them would be a field whose value is discarded — which is worse than no
 * field, because it looks like it did something.
 */

/** The things a reader can report. The list is the CHECK constraint on reports.kind. */
export const REPORT_KINDS = ['post', 'comment', 'project', 'idea', 'message', 'profile'] as const

export type ReportKind = (typeof REPORT_KINDS)[number]

/**
 * The column a report of each kind stores its target in.
 *
 * One map, used by the action that files a report, so the kind and the target
 * column cannot disagree — the CHECK constraint `reports_kind_matches_target`
 * would catch it, but as a failed write rather than as a code path that cannot
 * produce the mismatch.
 */
export const REPORT_TARGET_COLUMN: Record<ReportKind, string> = {
  post: 'post_id',
  comment: 'comment_id',
  project: 'project_id',
  idea: 'idea_id',
  message: 'message_id',
  profile: 'user_id',
}

/**
 * The fixed list the report dialog offers.
 *
 * Fixed rather than free text because a queue of five hundred reports that each
 * say something different in their own words cannot be triaged by category, and
 * because "choose a reason" is a decision the reporter can make in two seconds.
 * `detail` is where they say more.
 *
 * Reword one of these and the stored `reports.reason` values keep the old
 * wording, deliberately: the database CHECK is a length bound and not a list, so
 * a copy change is not a data migration.
 */
export const REPORT_REASONS = [
  'Harassment or bullying',
  'Hate speech',
  'Threats or violence',
  'Sexual or explicit content',
  'Spam or advertising',
  'Scam or fraud',
  'Impersonation',
  'Something else',
] as const

/**
 * A report, as filed from the dialog.
 *
 * `z.enum(REPORT_REASONS)` carries no custom message because the control that
 * produces this value is a radio group over exactly this list: a value outside it
 * is a hand-crafted request, and the generic "invalid option" is the right
 * amount of information to give it.
 */
export const reportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  targetId: z.string().trim().uuid('That report did not name anything to look at'),
  reason: z.enum(REPORT_REASONS),
  detail: optionalText(2000, 'The detail'),
})

export type ReportInput = z.infer<typeof reportSchema>

/** The actions the queue offers. The list is the CHECK on moderation_actions.action. */
export const MODERATION_ACTIONS = [
  'hide_content',
  'remove_content',
  'restore_content',
  'warn_user',
  'suspend_user',
  'dismiss_report',
] as const

export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

/**
 * A decision.
 *
 * The reason is required and bounded to the same 3..1000 as the column. There is
 * deliberately no "confirm" boolean: the confirmation is the dialog, and a hidden
 * field pretending to prove a human read something proves nothing.
 */
export const moderationDecisionSchema = z.object({
  reportId: z.string().trim().uuid('That report could not be identified'),
  action: z.enum(MODERATION_ACTIONS),
  reason: requiredText(3, 1000, 'The reason'),
  /** Suspension length in days. Ignored by every other action. */
  days: z.coerce.number().int().min(1).max(365).default(7),
})

export type ModerationDecisionInput = z.infer<typeof moderationDecisionSchema>

/** Reviewing a pending university request. */
export const universityReviewSchema = z.object({
  universityId: z.string().trim().uuid('That request could not be identified'),
  decision: z.enum(['approve', 'reject']),
  reason: requiredText(3, 1000, 'The reason'),
})

export type UniversityReviewInput = z.infer<typeof universityReviewSchema>

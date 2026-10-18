import type { FormState } from '@/lib/form-state'

/**
 * Form state for the moderation surfaces.
 *
 * These live beside the actions and not in them for a hard reason: a `'use server'`
 * module may only export async functions, so exporting a plain object from
 * `actions.ts` throws at module evaluation. See the same note in
 * features/auth/form-state.ts.
 *
 * The types are `FormState` with a name, rather than a parallel shape: a report
 * form and a project form return the same four things, and two definitions of
 * "what a form returns" is how a field error ends up rendered in one place and
 * dropped in another.
 */

export type ReportFormState = FormState
export const emptyReportState: ReportFormState = { status: 'idle' }

export type ModerationFormState = FormState
export const emptyModerationState: ModerationFormState = { status: 'idle' }

export type UniversityReviewFormState = FormState
export const emptyUniversityReviewState: UniversityReviewFormState = { status: 'idle' }

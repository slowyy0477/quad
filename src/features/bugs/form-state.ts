import type { FormState } from '@/lib/form-state'

/**
 * Form state for the bug-report surfaces.
 *
 * Defined beside the actions and not inside them: a `'use server'` module may
 * export nothing but async functions, so a type or a constant exported from one
 * becomes a build error. Client components need both the initial state to hand to
 * `useActionState` and the type to hold it.
 */

export type BugFormState = FormState

export const emptyBugFormState: BugFormState = { status: 'idle' }

export type BugTriageFormState = FormState

export const emptyBugTriageFormState: BugTriageFormState = { status: 'idle' }

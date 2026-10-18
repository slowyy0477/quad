/**
 * The fixed vocabularies the learning tables use.
 *
 * These lists mirror the CHECK constraints in 0011_learning.sql exactly, and the
 * constraint is quoted next to each one. If they drift the database rejects the write,
 * which is the right failure but a confusing one — so the authority is named here
 * rather than left to be rediscovered.
 */

/** `semesters.term` CHECK. Nullable: a term is optional, the name is not. */
export const SEMESTER_TERMS = [
  { value: 'fall', label: 'Autumn / Fall' },
  { value: 'spring', label: 'Spring' },
  { value: 'summer', label: 'Summer' },
  { value: 'winter', label: 'Winter' },
  { value: 'other', label: 'Other' },
] as const

export const SEMESTER_TERM_VALUES = SEMESTER_TERMS.map((term) => term.value)

export function termLabel(value: string | null) {
  if (!value) return null
  return SEMESTER_TERMS.find((term) => term.value === value)?.label ?? value
}

/** `goals.category` CHECK. */
export const GOAL_CATEGORIES = [
  { value: 'skill', label: 'Skill' },
  { value: 'course', label: 'Course' },
  { value: 'project', label: 'Project' },
  { value: 'career', label: 'Career' },
  { value: 'habit', label: 'Habit' },
  { value: 'reading', label: 'Reading' },
  { value: 'fitness', label: 'Fitness' },
  { value: 'other', label: 'Other' },
] as const

export const GOAL_CATEGORY_VALUES = GOAL_CATEGORIES.map((category) => category.value)

export function goalCategoryLabel(value: string) {
  return GOAL_CATEGORIES.find((category) => category.value === value)?.label ?? value
}

/** `goals.status` CHECK. */
export const GOAL_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'abandoned', label: 'Abandoned' },
] as const

export const GOAL_STATUS_VALUES = GOAL_STATUSES.map((status) => status.value)

export function goalStatusLabel(value: string) {
  return GOAL_STATUSES.find((status) => status.value === value)?.label ?? value
}

/** `courses.status` CHECK. */
export const COURSE_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'dropped', label: 'Dropped' },
] as const

export const COURSE_STATUS_VALUES = COURSE_STATUSES.map((status) => status.value)

export function courseStatusLabel(value: string) {
  return COURSE_STATUSES.find((status) => status.value === value)?.label ?? value
}

/**
 * The self-reported scales on `daily_logs`.
 *
 * Named for what they are: opinions the writer holds about their own day, not scores
 * the platform awarded. `study_sessions.focus_rating` was deliberately renamed away
 * from `productivity` for the same reason, and nothing here is ever aggregated.
 */
export const MOOD_SCALE = [
  { value: 1, label: 'Rough' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Steady' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Great' },
] as const

export function scaleLabel(value: number | null) {
  if (value === null) return null
  return MOOD_SCALE.find((step) => step.value === value)?.label ?? null
}

/**
 * `daily_logs.hours_studied` is `numeric(4, 1)` with a 0..24 CHECK — one decimal place,
 * so the entry is in hours and the form says so. There is no minutes column on this
 * table: `study_sessions.duration_minutes` measures one sitting, and a day is not a
 * sitting. Converting minutes into hours here would round 50 minutes to 0.8 hours and
 * quietly change the number the writer typed.
 */
export const HOURS_STUDIED_MAX = 24
export const HOURS_STUDIED_STEP = 0.5

/** The page size of an entry list. Not a cursor: this list is bounded by days. */
export const LOG_LIST_DAYS = 30

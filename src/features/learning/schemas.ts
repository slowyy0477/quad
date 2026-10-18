import { z } from 'zod'
import { VISIBILITY_VALUES } from '@/features/projects/constants'
import { optionalDate, optionalInt, optionalText, requiredText } from '@/lib/form-schemas'
import {
  COURSE_STATUS_VALUES,
  GOAL_CATEGORY_VALUES,
  HOURS_STUDIED_MAX,
  SEMESTER_TERM_VALUES,
} from '@/features/learning/constants'

/**
 * Learning validation.
 *
 * The bounds mirror the CHECK constraints in 0011_learning.sql: `semesters.name` 1..80,
 * `courses.title` 1..160 and code 1..32, `goals.title` 1..160 with `target_value` > 0 and
 * <= 1000000, `goal_milestones.title` 1..200, `daily_logs.hours_studied` numeric(4, 1)
 * between 0 and 24, mood and productivity between 1 and 5.
 *
 * What is absent matters as much as what is here. `profile_id` is never sent — the
 * before-write trigger overwrites it with `auth.uid()`. `progress_percent`,
 * `completed_at`, `milestone_count` and `completed_milestone_count` are absent because
 * the database derives them and has no UPDATE grant to hand out: a form field for any of
 * them would be a control that lies. `daily_logs.log_date` is present on the insert and
 * not on the update, matching the column grants exactly — the uniqueness of one row per
 * day is enforced by `daily_logs_one_per_day`, and the database refuses to let a row
 * move to another day.
 */

/** A required number from `<input type="number">`, which posts a string. */
const requiredNumber = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .min(1, message)
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= min && value <= max, { message })

/** An optional number with at most one decimal place, matching `numeric(4, 1)`. */
const optionalDecimal = (max: number, message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : Number(value)))
    .refine(
      (value) =>
        value === undefined ||
        (Number.isFinite(value) && value >= 0 && value <= max && Math.round(value * 10) === value * 10),
      { message },
    )

const isoDate = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)

const booleanFlag = z
  .string()
  .trim()
  .transform((value) => value === 'true')

// -----------------------------------------------------------------------------
// Semesters and courses
// -----------------------------------------------------------------------------

export const semesterCreateSchema = z.object({
  name: requiredText(1, 80, 'The name'),
  term: z
    .enum([...SEMESTER_TERM_VALUES, ''] as unknown as [string, ...string[]])
    .transform((value) => (value === '' ? undefined : value)),
  year: optionalInt(1950, 2100, 'The year must be between 1950 and 2100'),
  startDate: optionalDate('The start date'),
  endDate: optionalDate('The end date'),
})

export const semesterCurrentSchema = z.object({
  semesterId: z.string().uuid('That semester could not be identified'),
  isCurrent: booleanFlag,
})

export const courseCreateSchema = z.object({
  semesterId: z.string().uuid('That semester could not be identified'),
  code: optionalText(32, 'The course code'),
  title: requiredText(1, 160, 'The title'),
  instructor: optionalText(120, 'The instructor'),
  credits: optionalDecimal(60, 'Credits must be between 0 and 60'),
  status: z.enum(COURSE_STATUS_VALUES as [string, ...string[]]),
})

// -----------------------------------------------------------------------------
// Goals and milestones
// -----------------------------------------------------------------------------

export const goalCreateSchema = z.object({
  title: requiredText(1, 160, 'The title'),
  description: optionalText(2000, 'The description'),
  category: z.enum(GOAL_CATEGORY_VALUES as [string, ...string[]]),
  targetValue: requiredNumber(0.01, 1_000_000, 'The target must be a number above 0'),
  unit: optionalText(24, 'The unit'),
  semesterId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : value))
    .refine((value) => value === undefined || z.string().uuid().safeParse(value).success, {
      message: 'Choose a semester from the list',
    }),
  targetDate: optionalDate('The target date'),
  visibility: z.enum(VISIBILITY_VALUES as [string, ...string[]]),
})

export const goalProgressSchema = z.object({
  goalId: z.string().uuid('That goal could not be identified'),
  currentValue: requiredNumber(0, 1_000_000, 'The value must be between 0 and 1,000,000'),
})

/**
 * Completion is a status change and nothing else.
 *
 * It cannot be a direct write to `completed_at`: the column has no UPDATE grant and
 * `goals_before_write` derives it from `status` in both directions, so reopening a goal
 * clears the date rather than leaving a stale one behind. `abandoned` and `paused` are
 * not offered here because the tracker does not present those as actions.
 */
export const goalStatusSchema = z.object({
  goalId: z.string().uuid('That goal could not be identified'),
  status: z.enum(['active', 'completed']),
})

export const milestoneCreateSchema = z.object({
  goalId: z.string().uuid('That goal could not be identified'),
  title: requiredText(1, 200, 'The step'),
  targetDate: optionalDate('The date'),
})

export const milestoneToggleSchema = z.object({
  milestoneId: z.string().uuid('That step could not be identified'),
  isCompleted: booleanFlag,
})

// -----------------------------------------------------------------------------
// The daily log
// -----------------------------------------------------------------------------

/**
 * One entry per day.
 *
 * `logDate` is on this schema because the insert needs it, and it is the day the writer
 * says the entry belongs to — defaulted on the page to the database's own today, so the
 * form and the streak agree on which day a new entry lands in. It is not written on an
 * update: the column has no UPDATE grant, deliberately, so an existing entry cannot be
 * moved onto another day and collide with one that is already there.
 */
export const dailyLogSchema = z.object({
  logDate: isoDate('Pick a date'),
  hoursStudied: optionalDecimal(
    HOURS_STUDIED_MAX,
    `Hours studied is between 0 and ${HOURS_STUDIED_MAX}, in steps of six minutes`,
  ),
  mood: optionalInt(1, 5, 'Mood is a number from 1 to 5'),
  productivity: optionalInt(1, 5, 'Productivity is a number from 1 to 5'),
  summary: optionalText(2000, 'The note'),
  wins: optionalText(1000, 'What went well'),
  blockers: optionalText(1000, 'What got in the way'),
})

export type SemesterCreateInput = z.infer<typeof semesterCreateSchema>
export type CourseCreateInput = z.infer<typeof courseCreateSchema>
export type GoalCreateInput = z.infer<typeof goalCreateSchema>
export type DailyLogInput = z.infer<typeof dailyLogSchema>

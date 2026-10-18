'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isSupabaseConfigured } from '@/lib/env'
import { isLocalMode } from '@/lib/mode'
import { id, mutate, now } from '@/lib/local/db'
import { describeWriteError, echoValues, fieldErrorsOf, type FormState } from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { databaseToday, shiftDate } from '@/features/learning/streak'
import {
  courseCreateSchema,
  dailyLogSchema,
  goalCreateSchema,
  goalProgressSchema,
  goalStatusSchema,
  milestoneCreateSchema,
  milestoneToggleSchema,
  semesterCreateSchema,
  semesterCurrentSchema,
} from '@/features/learning/schemas'

/**
 * Learning writes: semesters, courses, goals, milestones and the daily log.
 *
 * WHAT THE DATABASE ALREADY DECIDES, SO THIS FILE DOES NOT ARGUE ABOUT IT
 * ----------------------------------------------------------------------
 *   * `app.semesters_before_write` forces `profile_id` to the caller and demotes any
 *     previous `is_current` row, so "make this the current term" is one UPDATE rather
 *     than a two-statement dance this could get half-way through. The partial unique
 *     index on `(profile_id) where is_current` is what makes that true.
 *   * `app.courses_before_write` refuses a course filed under someone else's semester
 *     with `hint = 'semester_not_owned'`, because `semester_id` would otherwise be an
 *     oracle for whether a private row exists.
 *   * `app.goals_before_write` clamps the goal's visibility to the owner profile's, and
 *     refuses anchors the caller does not own — `hint = 'course_not_owned'`,
 *     `'semester_not_owned'`, `'not_project_member'`.
 *   * `goals.completed_at` and `goal_milestones.completed_at` follow their status
 *     columns in both directions, and `progress_percent`, `milestone_count` and
 *     `completed_milestone_count` are generated or trigger-maintained. None of them is
 *     sent from a form; none of them has an UPDATE grant.
 *   * `app.daily_logs_before_write` refuses a date more than a day ahead, and
 *     `daily_logs_one_per_day` is a unique constraint on `(profile_id, log_date)`.
 *
 * THE ONE THING AN UPDATE MUST NOT TRUST
 * --------------------------------------
 * `error === null`. RLS declining an update is not an error in Postgres: the statement
 * succeeds and changes nothing. Every update below asks for the row back and treats an
 * empty answer as a refusal, which is the only way "that is not yours" reaches the
 * reader as a sentence instead of as a silent no-op.
 *
 * LOCAL MODE — THE TRIGGERS ARE NOW THIS FILE'S JOB
 * -------------------------------------------------
 * The store has no triggers, no grants and no RLS, so each local branch below writes the
 * same rules out in TypeScript, in the same order the triggers apply them:
 *
 *   * ownership is checked before the write and the answer is the same sentence the
 *     policy's silence produces in Supabase mode — "not yours" and "not there" are still
 *     one answer, and each branch returns exactly the `FormState` the Supabase path
 *     returns for the equivalent refusal, via `describeWriteError` with the same code
 *     overrides;
 *   * `is_current` stays exclusive per profile by demoting the other rows in the same
 *     mutation, which is what `semesters_before_write` does and why there is no window
 *     with two current terms;
 *   * `completed_at` still follows `status` / `is_completed` in both directions;
 *   * a goal's visibility is still clamped to the owner profile's;
 *   * a daily log still cannot be dated more than a day ahead, and still cannot become a
 *     second row for the same day — the existing row is edited in place, because
 *     `daily_logs_one_per_day` would refuse the insert and because the streak counts days,
 *     not entries.
 *
 * Counters are the one thing deliberately *not* written here: the read side derives
 * `milestone_count`, `completed_milestone_count` and `progress_percent` from the rows, so
 * this file must not maintain a second version of them by hand. That is what
 * `app.sync_goal_milestone_counts` and the generated column did, and the port moved that
 * work to `queries.ts` rather than duplicating it.
 *
 * THE ID FORMAT
 * -------------
 * Every id column is `uuid` in Postgres and the schemas assert that shape. The store's ids
 * are opaque `sem_…` / `gol_…` strings, so in local mode an id field is checked against the
 * store's id shape and then handed to the schema as a placeholder uuid, while the *real*
 * posted value is what the store is searched by. Everything else — lengths, ranges, enums,
 * date formats, cross-field rules — is still decided by the same schema, unchanged. A value
 * that is neither a store id nor a uuid is passed through untouched and fails validation,
 * which is what a hand-edited form field deserves.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so nothing can be saved.',
}

/** Both pages these writes can change. Cheap, and forgetting one is a stale meter. */
function revalidateLearning() {
  revalidatePath('/goals')
  revalidatePath('/log')
}

// -----------------------------------------------------------------------------
// Local-mode scaffolding
// -----------------------------------------------------------------------------

/** `id('sem')` shape: lowercase prefix, underscore, lowercase alphanumerics. */
const LOCAL_ID = /^[a-z]+_[a-z0-9]{1,64}$/

/** A syntactically valid uuid, standing in for an id the schemas require to look like one. */
const UUID_PLACEHOLDER = '00000000-0000-4000-8000-000000000000'

/** See "THE ID FORMAT" above. */
function localiseId(value: string): string {
  return LOCAL_ID.test(value) ? UUID_PLACEHOLDER : value
}

/** The `visibility_rank` table from 0001: higher is more visible. */
function visibilityRank(visibility: string): number {
  switch (visibility) {
    case 'public':
      return 3
    case 'university':
      return 2
    case 'connections':
      return 1
    default:
      return 0
  }
}

/** `app.clamp_visibility`: the less visible of the two. Content cannot out-rank its author. */
function clampVisibility(requested: string, ceiling: string): string {
  return visibilityRank(requested) <= visibilityRank(ceiling) ? requested : ceiling
}

/** The "I cannot attribute this to a profile" answer. Impossible in practice; honest if it happens. */
const NO_PROFILE: FormState = { status: 'error', message: 'Sign in again to save that.' }

// -----------------------------------------------------------------------------
// Semesters and courses
// -----------------------------------------------------------------------------

export async function createSemesterAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return createSemesterLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = semesterCreateSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    term: String(formData.get('term') ?? ''),
    year: String(formData.get('year') ?? ''),
    startDate: String(formData.get('startDate') ?? ''),
    endDate: String(formData.get('endDate') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { error } = await supabase.from('semesters').insert({
    // profile_id is overwritten by the trigger with auth.uid(); it is sent only because
    // the column is NOT NULL and the insert policy reads it.
    profile_id: user.id,
    name: parsed.data.name,
    term: parsed.data.term ?? null,
    year: parsed.data.year ?? null,
    start_date: parsed.data.startDate ?? null,
    end_date: parsed.data.endDate ?? null,
  })

  if (error) {
    return {
      ...describeWriteError(error, 'learning:semester:create', {
        // `semesters_dates_ordered` is a real rule the form cannot express: two optional
        // dates that only break when both are given and out of order.
        '23514': 'The end date has to be on or after the start date.',
      }),
      values: echoValues(formData),
    }
  }

  revalidateLearning()
  return { status: 'success', message: 'Semester added.' }
}

async function createSemesterLocally(formData: FormData): Promise<FormState> {
  const parsed = semesterCreateSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    term: String(formData.get('term') ?? ''),
    year: String(formData.get('year') ?? ''),
    startDate: String(formData.get('startDate') ?? ''),
    endDate: String(formData.get('endDate') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // `semesters_dates_ordered check (start_date is null or end_date is null or
    // end_date >= start_date)`.
    if (parsed.data.startDate && parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) {
      return {
        ...describeWriteError({ code: '23514', message: 'semesters_dates_ordered' }, 'learning:semester:create', {
          '23514': 'The end date has to be on or after the start date.',
        }),
        values: echoValues(formData),
      }
    }

    db.semesters.push({
      id: id('sem'),
      // The trigger would force this to the caller; locally it is the caller's profile.
      profile_id: profile.id,
      name: parsed.data.name,
      term: parsed.data.term ?? null,
      year: parsed.data.year ?? null,
      start_date: parsed.data.startDate ?? null,
      end_date: parsed.data.endDate ?? null,
      // The form has no "current" control and the column defaults to false. Making the
      // term current is `setCurrentSemesterAction`, which is what keeps the flag exclusive.
      is_current: false,
      created_at: now(),
    })

    revalidateLearning()
    return { status: 'success', message: 'Semester added.' }
  })
}

/**
 * Make one semester the current one.
 *
 * The demotion of the previous current semester happens in the before-write trigger, so
 * there is no window in which two rows are current and no second statement for this to
 * fail between. Locally the demotion happens in the same mutation, for the same reason.
 */
export async function setCurrentSemesterAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return setCurrentSemesterLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = semesterCurrentSchema.safeParse({
    semesterId: String(formData.get('semesterId') ?? ''),
    isCurrent: String(formData.get('isCurrent') ?? 'false'),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('semesters')
    .update({ is_current: parsed.data.isCurrent })
    .eq('id', parsed.data.semesterId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'learning:semester:current')
  if (!data) return { status: 'error', message: 'That semester is not yours to change.' }

  revalidateLearning()
  return { status: 'success', message: parsed.data.isCurrent ? 'Set as your current term.' : 'No longer your current term.' }
}

async function setCurrentSemesterLocally(formData: FormData): Promise<FormState> {
  const semesterId = String(formData.get('semesterId') ?? '')
  const parsed = semesterCurrentSchema.safeParse({
    semesterId: localiseId(semesterId),
    isCurrent: String(formData.get('isCurrent') ?? 'false'),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // The policy (`semesters_own`) as a filter: another profile's row is not visible, and
    // an UPDATE that matches nothing is reported as "not yours", never as success.
    const semester = db.semesters.find(
      (candidate) => candidate.id === semesterId && candidate.profile_id === profile.id,
    )
    if (!semester) return { status: 'error', message: 'That semester is not yours to change.' }

    if (parsed.data.isCurrent) {
      // `semesters_before_write`: demote the outgoing current term first, so the partial
      // unique index on `(profile_id) where is_current` is never transiently violated.
      for (const other of db.semesters) {
        if (other.profile_id === profile.id && other.is_current && other.id !== semester.id) {
          other.is_current = false
        }
      }
    }

    semester.is_current = parsed.data.isCurrent

    revalidateLearning()
    return {
      status: 'success',
      message: parsed.data.isCurrent ? 'Set as your current term.' : 'No longer your current term.',
    }
  })
}

export async function createCourseAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return createCourseLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = courseCreateSchema.safeParse({
    semesterId: String(formData.get('semesterId') ?? ''),
    code: String(formData.get('code') ?? ''),
    title: String(formData.get('title') ?? ''),
    instructor: String(formData.get('instructor') ?? ''),
    credits: String(formData.get('credits') ?? ''),
    status: String(formData.get('status') ?? 'in_progress'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { error } = await supabase.from('courses').insert({
    profile_id: user.id,
    semester_id: parsed.data.semesterId,
    code: parsed.data.code ?? null,
    title: parsed.data.title,
    instructor: parsed.data.instructor ?? null,
    credits: parsed.data.credits ?? null,
    status: parsed.data.status,
  })

  if (error) {
    return {
      ...describeWriteError(error, 'learning:course:create', {
        '23505': 'You already have a course with that code in this term.',
        '42501': 'That semester is not yours.',
      }),
      values: echoValues(formData),
    }
  }

  revalidateLearning()
  return { status: 'success', message: 'Course added.' }
}

async function createCourseLocally(formData: FormData): Promise<FormState> {
  const semesterId = String(formData.get('semesterId') ?? '')
  const parsed = courseCreateSchema.safeParse({
    semesterId: localiseId(semesterId),
    code: String(formData.get('code') ?? ''),
    title: String(formData.get('title') ?? ''),
    instructor: String(formData.get('instructor') ?? ''),
    credits: String(formData.get('credits') ?? ''),
    status: String(formData.get('status') ?? 'in_progress'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // `courses_before_write`: a course cannot be filed under someone else's term, because
    // `semester_id` would then answer questions about rows that profile cannot see.
    const semester = db.semesters.find((candidate) => candidate.id === semesterId)
    if (!semester || semester.profile_id !== profile.id) {
      return {
        ...describeWriteError({ code: '42501', message: 'semester_not_owned' }, 'learning:course:create', {
          '42501': 'That semester is not yours.',
        }),
        values: echoValues(formData),
      }
    }

    // `courses_profile_code_key`: (profile_id, semester_id, lower(code)), nulls not
    // distinct, where code is not null. So an empty code never collides and a code is
    // compared case-insensitively.
    const code = parsed.data.code ?? null
    if (
      code !== null &&
      db.courses.some(
        (course) =>
          course.profile_id === profile.id &&
          course.semester_id === semester.id &&
          course.code !== null &&
          course.code.toLowerCase() === code.toLowerCase(),
      )
    ) {
      return {
        ...describeWriteError({ code: '23505', message: 'courses_profile_code_key' }, 'learning:course:create', {
          '23505': 'You already have a course with that code in this term.',
        }),
        values: echoValues(formData),
      }
    }

    db.courses.push({
      id: id('crs'),
      semester_id: semester.id,
      profile_id: profile.id,
      code,
      title: parsed.data.title,
      instructor: parsed.data.instructor ?? null,
      credits: parsed.data.credits ?? null,
      status: parsed.data.status,
      grade: null,
      created_at: now(),
    })

    revalidateLearning()
    return { status: 'success', message: 'Course added.' }
  })
}

// -----------------------------------------------------------------------------
// Goals
// -----------------------------------------------------------------------------

export async function createGoalAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (isLocalMode()) return createGoalLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = goalCreateSchema.safeParse({
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    category: String(formData.get('category') ?? 'other'),
    targetValue: String(formData.get('targetValue') ?? ''),
    unit: String(formData.get('unit') ?? ''),
    semesterId: String(formData.get('semesterId') ?? ''),
    targetDate: String(formData.get('targetDate') ?? ''),
    visibility: String(formData.get('visibility') ?? 'private'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { error } = await supabase.from('goals').insert({
    profile_id: user.id,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    category: parsed.data.category,
    target_value: parsed.data.targetValue,
    unit: parsed.data.unit ?? null,
    semester_id: parsed.data.semesterId ?? null,
    target_date: parsed.data.targetDate ?? null,
    visibility: parsed.data.visibility,
  })

  if (error) {
    return {
      ...describeWriteError(error, 'learning:goal:create', {
        '42501': 'That semester is not yours.',
      }),
      values: echoValues(formData),
    }
  }

  revalidateLearning()
  return { status: 'success', message: 'Goal created.' }
}

async function createGoalLocally(formData: FormData): Promise<FormState> {
  const semesterId = String(formData.get('semesterId') ?? '').trim()
  const parsed = goalCreateSchema.safeParse({
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    category: String(formData.get('category') ?? 'other'),
    targetValue: String(formData.get('targetValue') ?? ''),
    unit: String(formData.get('unit') ?? ''),
    semesterId: localiseId(semesterId),
    targetDate: String(formData.get('targetDate') ?? ''),
    visibility: String(formData.get('visibility') ?? 'private'),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // `goals_before_write`: a semester anchor has to be the caller's own row, or the goal
    // would be a probe into whether someone else's private term exists.
    if (semesterId !== '') {
      const semester = db.semesters.find((candidate) => candidate.id === semesterId)
      if (!semester || semester.profile_id !== profile.id) {
        return {
          ...describeWriteError({ code: '42501', message: 'semester_not_owned' }, 'learning:goal:create', {
            '42501': 'That semester is not yours.',
          }),
          values: echoValues(formData),
        }
      }
    }

    db.goals.push({
      id: id('gol'),
      profile_id: profile.id,
      semester_id: semesterId === '' ? null : semesterId,
      course_id: null,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      category: parsed.data.category,
      status: 'active',
      target_value: parsed.data.targetValue,
      current_value: 0,
      unit: parsed.data.unit ?? null,
      // Zero progress on a goal with no progress: this is the value the read side derives
      // from `current_value / target_value` anyway, not a counter kept here.
      progress_percent: 0,
      // Clamped to the owner profile's visibility, exactly as the trigger does.
      visibility: clampVisibility(parsed.data.visibility, profile.visibility),
      target_date: parsed.data.targetDate ?? null,
      completed_at: null,
      milestone_count: 0,
      completed_milestone_count: 0,
      created_at: now(),
    })

    revalidateLearning()
    return { status: 'success', message: 'Goal created.' }
  })
}

/** Move the reported progress. `progress_percent` is derived, so it is never sent. */
export async function updateGoalProgressAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return updateGoalProgressLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = goalProgressSchema.safeParse({
    goalId: String(formData.get('goalId') ?? ''),
    currentValue: String(formData.get('currentValue') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('goals')
    .update({ current_value: parsed.data.currentValue })
    .eq('id', parsed.data.goalId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'learning:goal:progress')
  if (!data) return { status: 'error', message: 'That goal is not yours to update.' }

  revalidateLearning()
  return { status: 'success', message: 'Progress updated.' }
}

async function updateGoalProgressLocally(formData: FormData): Promise<FormState> {
  const goalId = String(formData.get('goalId') ?? '')
  const parsed = goalProgressSchema.safeParse({
    goalId: localiseId(goalId),
    currentValue: String(formData.get('currentValue') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    const goal = db.goals.find((candidate) => candidate.id === goalId && candidate.profile_id === profile.id)
    if (!goal) return { status: 'error', message: 'That goal is not yours to update.' }

    goal.current_value = parsed.data.currentValue

    revalidateLearning()
    return { status: 'success', message: 'Progress updated.' }
  })
}

/**
 * Complete a goal, or reopen one.
 *
 * A status change and nothing else. `completed_at` is written by the before-write
 * trigger from this column in both directions, so reopening clears the date rather than
 * leaving a stale completion behind, and there is no way for the interface to claim a
 * completion the row does not carry.
 */
export async function setGoalStatusAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return setGoalStatusLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = goalStatusSchema.safeParse({
    goalId: String(formData.get('goalId') ?? ''),
    status: String(formData.get('status') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('goals')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.goalId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'learning:goal:status')
  if (!data) return { status: 'error', message: 'That goal is not yours to change.' }

  revalidateLearning()
  return {
    status: 'success',
    message:
      parsed.data.status === 'completed'
        ? 'Marked complete. It is your own record of finishing it.'
        : 'Reopened.',
  }
}

async function setGoalStatusLocally(formData: FormData): Promise<FormState> {
  const goalId = String(formData.get('goalId') ?? '')
  const parsed = goalStatusSchema.safeParse({
    goalId: localiseId(goalId),
    status: String(formData.get('status') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    const goal = db.goals.find((candidate) => candidate.id === goalId && candidate.profile_id === profile.id)
    if (!goal) return { status: 'error', message: 'That goal is not yours to change.' }

    goal.status = parsed.data.status

    // `goals_before_write`: completed_at follows status in both directions. Completing
    // keeps an existing date; reopening clears it rather than leaving a stale one.
    if (goal.status === 'completed') {
      goal.completed_at ??= now()
    } else {
      goal.completed_at = null
    }

    revalidateLearning()
    return {
      status: 'success',
      message:
        parsed.data.status === 'completed'
          ? 'Marked complete. It is your own record of finishing it.'
          : 'Reopened.',
    }
  })
}

// -----------------------------------------------------------------------------
// Milestones
// -----------------------------------------------------------------------------

/**
 * Add a step to a goal.
 *
 * `goal_id` is not trusted: the `goal_milestones_write_own` policy requires the parent
 * goal to be the caller's, and a milestone attached to someone else's goal is refused by
 * RLS rather than by a check here. The counts on the goal are updated afterwards by
 * `app.sync_goal_milestone_counts`, which is why this does not touch them.
 */
export async function addMilestoneAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return addMilestoneLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = milestoneCreateSchema.safeParse({
    goalId: String(formData.get('goalId') ?? ''),
    title: String(formData.get('title') ?? ''),
    targetDate: String(formData.get('targetDate') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { error } = await supabase.from('goal_milestones').insert({
    goal_id: parsed.data.goalId,
    title: parsed.data.title,
    target_date: parsed.data.targetDate ?? null,
  })

  if (error) {
    return {
      ...describeWriteError(error, 'learning:milestone:create', {
        '42501': 'That goal is not yours to add a step to.',
      }),
      values: echoValues(formData),
    }
  }

  revalidateLearning()
  return { status: 'success', message: 'Step added.' }
}

async function addMilestoneLocally(formData: FormData): Promise<FormState> {
  const goalId = String(formData.get('goalId') ?? '')
  const parsed = milestoneCreateSchema.safeParse({
    goalId: localiseId(goalId),
    title: String(formData.get('title') ?? ''),
    targetDate: String(formData.get('targetDate') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // `goal_milestones_write_own`: the parent goal has to be the caller's. The read that
    // counts the steps also derives the counts, so nothing is incremented here.
    const goal = db.goals.find((candidate) => candidate.id === goalId && candidate.profile_id === profile.id)
    if (!goal) {
      return {
        ...describeWriteError({ code: '42501', message: 'goal_milestones_write_own' }, 'learning:milestone:create', {
          '42501': 'That goal is not yours to add a step to.',
        }),
        values: echoValues(formData),
      }
    }

    db.goal_milestones.push({
      id: id('mls'),
      goal_id: goal.id,
      title: parsed.data.title,
      is_completed: false,
      completed_at: null,
      target_date: parsed.data.targetDate ?? null,
      // The column defaults to 0 and the form sends no order, so this must not invent one
      // the database would not have: steps added here sort after the seeded ones by title.
      sort_order: 0,
    })

    revalidateLearning()
    return { status: 'success', message: 'Step added.' }
  })
}

/** Tick a step off, or untick it. The two completion dates follow this flag. */
export async function toggleMilestoneAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return toggleMilestoneLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = milestoneToggleSchema.safeParse({
    milestoneId: String(formData.get('milestoneId') ?? ''),
    isCompleted: String(formData.get('isCompleted') ?? 'false'),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('goal_milestones')
    .update({ is_completed: parsed.data.isCompleted })
    .eq('id', parsed.data.milestoneId)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeWriteError(error, 'learning:milestone:toggle')
  if (!data) return { status: 'error', message: 'That step is not yours to tick off.' }

  revalidateLearning()
  return { status: 'success' }
}

async function toggleMilestoneLocally(formData: FormData): Promise<FormState> {
  const milestoneId = String(formData.get('milestoneId') ?? '')
  const parsed = milestoneToggleSchema.safeParse({
    milestoneId: localiseId(milestoneId),
    isCompleted: String(formData.get('isCompleted') ?? 'false'),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/goals')

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    const milestone = db.goal_milestones.find((candidate) => candidate.id === milestoneId)
    // The policy reaches the step only through a goal this profile owns; without the
    // parent the row is as invisible as it would be to PostgREST.
    const goal = milestone
      ? db.goals.find((candidate) => candidate.id === milestone.goal_id && candidate.profile_id === profile.id)
      : undefined
    if (!milestone || !goal) {
      return { status: 'error', message: 'That step is not yours to tick off.' }
    }

    milestone.is_completed = parsed.data.isCompleted
    // `goal_milestones_before_write`: completed_at follows is_completed, both directions.
    if (milestone.is_completed) {
      milestone.completed_at ??= now()
    } else {
      milestone.completed_at = null
    }

    revalidateLearning()
    return { status: 'success' }
  })
}

// -----------------------------------------------------------------------------
// The daily log
// -----------------------------------------------------------------------------

/**
 * Save one day's entry, editing it if it already exists.
 *
 * TWO STATEMENTS RATHER THAN AN UPSERT, AND WHY
 * --------------------------------------------
 * `daily_logs` has a column-level UPDATE grant: `mood, productivity, hours_studied,
 * summary, wins, blockers, updated_at`. `log_date` and `profile_id` are deliberately not
 * in it, so an entry cannot be moved onto another day and collide with one already
 * there — the `daily_logs_protect_columns` trigger enforces the same thing from the other
 * side.
 *
 * An upsert would break on exactly that grant: PostgREST's `merge-duplicates` resolves the
 * conflict with `DO UPDATE SET <every column in the payload>`, which includes `log_date`,
 * and the statement would be refused. So the row is updated first, and inserted only when
 * nothing matched. A `23505` on the insert means a second submission of the same form
 * raced this one; the entry exists, so it is reported as saved rather than as an error.
 *
 * Locally the same order: the (profile_id, log_date) row is edited in place when it
 * exists and created only when it does not. Two rows for one day would violate
 * `daily_logs_one_per_day` and, worse, would make the streak count a day twice, so the
 * lookup is what keeps "one entry a day" true rather than a counter that drifts.
 */
export async function saveDailyLogAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return saveDailyLogLocally(formData)

  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = dailyLogSchema.safeParse({
    logDate: String(formData.get('logDate') ?? ''),
    hoursStudied: String(formData.get('hoursStudied') ?? ''),
    mood: String(formData.get('mood') ?? ''),
    productivity: String(formData.get('productivity') ?? ''),
    summary: String(formData.get('summary') ?? ''),
    wins: String(formData.get('wins') ?? ''),
    blockers: String(formData.get('blockers') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/log')

  const fields = {
    hours_studied: parsed.data.hoursStudied ?? null,
    mood: parsed.data.mood ?? null,
    productivity: parsed.data.productivity ?? null,
    summary: parsed.data.summary ?? null,
    wins: parsed.data.wins ?? null,
    blockers: parsed.data.blockers ?? null,
  }

  const supabase = await createClient()
  const { data: updated, error: updateError } = await supabase
    .from('daily_logs')
    .update(fields)
    .eq('profile_id', user.id)
    .eq('log_date', parsed.data.logDate)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (updateError) {
    return {
      ...describeWriteError(updateError, 'learning:log:update', {
        '23514': 'One of those values is outside what the log accepts. Hours studied is 0 to 24.',
      }),
      values: echoValues(formData),
    }
  }

  if (updated) {
    revalidateLearning()
    return { status: 'success', message: 'Entry updated.' }
  }

  const { error: insertError } = await supabase.from('daily_logs').insert({
    // Stamped from the session by the trigger; sent because the column is NOT NULL.
    profile_id: user.id,
    log_date: parsed.data.logDate,
    ...fields,
  })

  if (insertError) {
    // The unique constraint is `daily_logs_one_per_day`. A second submission of the same
    // day is not a failure worth showing anyone.
    if (insertError.code === '23505') {
      revalidateLearning()
      return { status: 'success', message: 'That day already had an entry.' }
    }
    return {
      ...describeWriteError(insertError, 'learning:log:insert', {
        '23514': 'One of those values is outside what the log accepts. Hours studied is 0 to 24.',
        '22007': 'A daily log cannot be dated in the future.',
      }),
      values: echoValues(formData),
    }
  }

  revalidateLearning()
  return { status: 'success', message: 'Entry saved.' }
}

async function saveDailyLogLocally(formData: FormData): Promise<FormState> {
  const parsed = dailyLogSchema.safeParse({
    logDate: String(formData.get('logDate') ?? ''),
    hoursStudied: String(formData.get('hoursStudied') ?? ''),
    mood: String(formData.get('mood') ?? ''),
    productivity: String(formData.get('productivity') ?? ''),
    summary: String(formData.get('summary') ?? ''),
    wins: String(formData.get('wins') ?? ''),
    blockers: String(formData.get('blockers') ?? ''),
  })

  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/log')

  // `daily_logs_before_write`: `log_date > current_date + 1` is refused, with one day of
  // tolerance for the writer's time zone. `current_date` is the database's own day, which
  // is the UTC day `databaseToday()` returns.
  if (parsed.data.logDate > shiftDate(databaseToday(), 1)) {
    return {
      ...describeWriteError({ code: '22007', message: 'log_date_future' }, 'learning:log:insert', {
        '22007': 'A daily log cannot be dated in the future.',
      }),
      values: echoValues(formData),
    }
  }

  const fields = {
    hours_studied: parsed.data.hoursStudied ?? null,
    mood: parsed.data.mood ?? null,
    productivity: parsed.data.productivity ?? null,
    summary: parsed.data.summary ?? null,
    wins: parsed.data.wins ?? null,
    blockers: parsed.data.blockers ?? null,
  }

  return mutate<FormState>((db) => {
    const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
    if (!profile) return NO_PROFILE

    // `daily_logs_one_per_day`: the day is the key. An existing entry is edited in place —
    // `log_date` and `profile_id` are never moved, matching the column grant — and a second
    // row for the same day is never created.
    const existing = db.daily_logs.find(
      (log) => log.profile_id === profile.id && log.log_date === parsed.data.logDate,
    )

    if (existing) {
      existing.hours_studied = fields.hours_studied
      existing.mood = fields.mood
      existing.productivity = fields.productivity
      existing.summary = fields.summary
      existing.wins = fields.wins
      existing.blockers = fields.blockers
      // `app.set_updated_at`.
      existing.updated_at = now()

      revalidateLearning()
      return { status: 'success', message: 'Entry updated.' }
    }

    db.daily_logs.push({
      id: id('log'),
      profile_id: profile.id,
      log_date: parsed.data.logDate,
      ...fields,
      created_at: now(),
      updated_at: now(),
    })

    revalidateLearning()
    return { status: 'success', message: 'Entry saved.' }
  })
}

/** Unused today, kept out: there is no delete affordance in this workstream. */

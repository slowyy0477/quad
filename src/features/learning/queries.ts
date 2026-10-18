import 'server-only'

import type { Database } from '@/lib/db/database.types'
import { isLocalMode } from '@/lib/mode'
import { readStore, type LocalGoal, type LocalMilestone, type LocalLog } from '@/lib/local/db'
import { createClient, getUser } from '@/lib/supabase/server'
import { databaseToday, streakFromLogDates } from '@/features/learning/streak'

/**
 * Learning reads: semesters, courses, goals, milestones, the daily log and the
 * achievements a reader has been awarded.
 *
 * THERE IS NO OWNERSHIP FILTER IN THESE SELECTS
 * ---------------------------------------------
 * `semesters`, `courses`, `study_sessions` and `daily_logs` are owner-only in the
 * database — `semesters_own`, `courses_own`, `daily_logs_own` — and `goal_milestones`
 * follows its goal's visibility through `app.can_view_goal`. Every query below is
 * therefore already scoped to what the reader may see, inside Postgres, and a second copy
 * of the rule in TypeScript would be a copy that can drift from the one an attacker
 * cannot skip by talking to PostgREST directly.
 *
 * The consequence worth stating: a goal belonging to someone else, filtered out by RLS,
 * comes back as no rows — the same answer as a goal that does not exist. That is the
 * correct behaviour, so "not yours" and "not there" are the same page.
 *
 * LOCAL MODE
 * ----------
 * There is no RLS to lean on, so each local branch below writes the same policy out in
 * TypeScript, literally: every row is filtered to the reader's own `profile_id`, and rows
 * belonging to anyone else are dropped before the shape is built (LOCAL-MODE.md rule 4).
 * "Refused by the database" becomes "not in the array". The volumes are one person's
 * development data, so the filtering is a `.filter()` rather than a query language.
 *
 * WHAT IS COMPUTED AND WHAT IS READ
 * ---------------------------------
 * In Supabase mode the streak is not computed here. `current_study_streak()` does it,
 * over the real `daily_logs` rows, on every render — there is no stored counter to drift
 * and no way to set one. The progress meter is fed `milestone_count` and
 * `completed_milestone_count`, which `app.sync_goal_milestone_counts` maintains from the
 * rows themselves; a goal with no milestones is fed 0 and 0, and `ProgressMeter` renders
 * nothing at all for that, which is the honest outcome.
 *
 * In local mode nothing maintains those counters and nothing computes the streak, so both
 * are derived here from the arrays — the milestone counts by counting the milestone rows,
 * and the streak with `streakFromLogDates`, which is the interface's copy of the database's
 * gap-and-island rule. `progress_percent` is derived the way the generated column derives
 * it, including `floor()` rather than `round()`.
 */

type GoalRow = Database['public']['Tables']['goals']['Row']
type CourseRow = Database['public']['Tables']['courses']['Row']
type SemesterRow = Database['public']['Tables']['semesters']['Row']
type DailyLogRow = Database['public']['Tables']['daily_logs']['Row']

export type CourseView = {
  id: CourseRow['id']
  code: CourseRow['code']
  title: CourseRow['title']
  instructor: CourseRow['instructor']
  credits: CourseRow['credits']
  status: CourseRow['status']
  grade: CourseRow['grade']
}

export type SemesterView = {
  id: SemesterRow['id']
  name: SemesterRow['name']
  term: SemesterRow['term']
  year: SemesterRow['year']
  start_date: SemesterRow['start_date']
  end_date: SemesterRow['end_date']
  is_current: SemesterRow['is_current']
  courses: CourseView[]
}

export type MilestoneView = {
  id: string
  title: string
  is_completed: boolean
  completed_at: string | null
  target_date: string | null
  sort_order: number
}

export type GoalView = {
  id: GoalRow['id']
  title: GoalRow['title']
  description: GoalRow['description']
  category: GoalRow['category']
  status: GoalRow['status']
  target_value: GoalRow['target_value']
  current_value: GoalRow['current_value']
  unit: GoalRow['unit']
  progress_percent: GoalRow['progress_percent']
  visibility: GoalRow['visibility']
  target_date: GoalRow['target_date']
  completed_at: GoalRow['completed_at']
  milestone_count: GoalRow['milestone_count']
  completed_milestone_count: GoalRow['completed_milestone_count']
  created_at: GoalRow['created_at']
  milestones: MilestoneView[]
}

const COURSE_SELECT = 'id, code, title, instructor, credits, status, grade'

/** The reader's own profile row, which is what every learning table is keyed by. */
async function localProfile(db: Awaited<ReturnType<typeof readStore>>, userId: string) {
  return db.profiles.find((profile) => profile.user_id === userId) ?? null
}

function toCourseView(course: {
  id: string
  code: string | null
  title: string
  instructor: string | null
  credits: number | null
  status: string
  grade: string | null
}): CourseView {
  return {
    id: course.id,
    code: course.code,
    title: course.title,
    instructor: course.instructor,
    credits: course.credits,
    status: course.status,
    grade: course.grade,
  }
}

function toMilestoneView(milestone: LocalMilestone): MilestoneView {
  return {
    id: milestone.id,
    title: milestone.title,
    is_completed: milestone.is_completed,
    completed_at: milestone.completed_at,
    target_date: milestone.target_date,
    sort_order: milestone.sort_order,
  }
}

/**
 * `goals.progress_percent` is a generated column in 0011 — copy the CASE exactly:
 *
 *   when target_value <= 0             then null
 *   when current_value >= target_value then 100
 *   when current_value <= 0            then 0
 *   else floor(current_value * 100 / target_value)
 *
 * `floor` and not `round`, because a goal is not shown as complete before it is: 5 of 12
 * sets is 41%, not 42%. The store's own `progress_percent` column is the value a trigger
 * would have cached, and nothing maintains it in local mode, so it is not read.
 */
function progressPercent(current: number, target: number): number | null {
  if (target <= 0) return null
  if (current >= target) return 100
  if (current <= 0) return 0
  return Math.floor((current * 100) / target)
}

/**
 * The reader's semesters, newest first, each with its courses.
 *
 * One nested select rather than a query per semester: a page that asks for the term
 * list and then asks again for every term's courses is N+1, and ARCHITECTURE §3 calls
 * that a bug in `queries.ts`.
 */
export async function listSemesters(): Promise<{
  semesters: SemesterView[] | null
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { semesters: [], error: null }

  if (isLocalMode()) {
    // `semesters_own` and `courses_own` in TypeScript: only this profile's rows.
    const db = await readStore()
    const profile = await localProfile(db, user.id)
    if (!profile) return { semesters: [], error: null }

    const mine = db.courses.filter((course) => course.profile_id === profile.id)

    // start_date desc nulls last, then created_at desc — the same two ORDER BYs the
    // Supabase query asks for, so a term without dates sinks to the bottom of the list.
    const semesters = db.semesters
      .filter((semester) => semester.profile_id === profile.id)
      .sort(compareSemesters)
      .map((semester) => ({
        id: semester.id,
        name: semester.name,
        term: semester.term,
        year: semester.year,
        start_date: semester.start_date,
        end_date: semester.end_date,
        is_current: semester.is_current,
        // The nested select had no ORDER BY; the store's insertion order is kept, which
        // is the order the term's courses were added in.
        courses: mine
          .filter((course) => course.semester_id === semester.id)
          .map(toCourseView),
      }))

    return { semesters, error: null }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('semesters')
    .select(`id, name, term, year, start_date, end_date, is_current, courses(${COURSE_SELECT})`)
    .order('start_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .returns<(Omit<SemesterView, 'courses'> & { courses: CourseView[] })[]>()

  if (error) {
    console.error('[learning:listSemesters]', error.code, error.message)
    return { semesters: null, error: 'Your semesters could not be loaded.' }
  }

  return {
    // The nested collection is absent rather than empty when a semester has no courses.
    semesters: (data ?? []).map((semester) => ({ ...semester, courses: semester.courses ?? [] })),
    error: null,
  }
}

function compareSemesters(
  a: { start_date: string | null; created_at: string },
  b: { start_date: string | null; created_at: string },
): number {
  if (a.start_date !== b.start_date) {
    if (a.start_date === null) return 1
    if (b.start_date === null) return -1
    return a.start_date < b.start_date ? 1 : -1
  }
  if (a.created_at === b.created_at) return 0
  return a.created_at < b.created_at ? 1 : -1
}

const MILESTONE_SELECT = 'id, title, is_completed, completed_at, target_date, sort_order'

const GOAL_SELECT = `
  id, title, description, category, status, target_value, current_value, unit,
  progress_percent, visibility, target_date, completed_at,
  milestone_count, completed_milestone_count, created_at,
  goal_milestones(${MILESTONE_SELECT})
`

type GoalJoinRow = Omit<GoalView, 'milestones'> & { goal_milestones: MilestoneView[] | null }

function toGoalView(row: GoalJoinRow): GoalView {
  const { goal_milestones, ...goal } = row
  return {
    ...goal,
    milestones: [...(goal_milestones ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
    ),
  }
}

/**
 * `sort_order` ascending, then title — the order the nested select is sorted into. Written
 * against the two fields it uses so the same comparator serves the store rows and the
 * views built from them.
 */
const compareMilestones = (
  a: { sort_order: number; title: string },
  b: { sort_order: number; title: string },
) => a.sort_order - b.sort_order || a.title.localeCompare(b.title)

/**
 * One goal from the store plus its milestone rows, with the counters derived.
 *
 * `milestone_count` / `completed_milestone_count` are not read from the goal row: in the
 * database `app.sync_goal_milestone_counts` maintains them from the milestone rows, and
 * in local mode nothing does. Counting the array is the same answer the trigger would
 * give, and it cannot disagree with the checklist the card renders.
 */
function toLocalGoalView(goal: LocalGoal, milestones: LocalMilestone[]): GoalView {
  const sorted = milestones.map(toMilestoneView).sort(compareMilestones)
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    category: goal.category,
    status: goal.status,
    target_value: goal.target_value,
    current_value: goal.current_value,
    unit: goal.unit,
    progress_percent: progressPercent(goal.current_value, goal.target_value),
    visibility: goal.visibility,
    target_date: goal.target_date,
    completed_at: goal.completed_at,
    milestone_count: sorted.length,
    completed_milestone_count: sorted.filter((milestone) => milestone.is_completed).length,
    created_at: goal.created_at,
    milestones: sorted,
  }
}

/**
 * The reader's goals for one semester — or, with `semesterId: null`, the ones they have
 * not filed under a term.
 *
 * Milestones come back nested because every goal on this page renders its own checklist,
 * and a query per goal would be exactly the N+1 the standards forbid. `abandoned` goals
 * are excluded from the tracker: they are kept in the database (a goal is a record of
 * intent, including the ones dropped), but a list of things you said you would do does
 * not need the things you decided you would not.
 */
export async function listGoals(
  semesterId: string | null,
  limit = 50,
): Promise<{ goals: GoalView[] | null; error: string | null }> {
  const user = await getUser()
  if (!user) return { goals: [], error: null }

  if (isLocalMode()) {
    const db = await readStore()
    const profile = await localProfile(db, user.id)
    if (!profile) return { goals: [], error: null }

    const goals = db.goals
      .filter((goal) => goal.profile_id === profile.id)
      .filter((goal) => goal.status !== 'abandoned')
      .filter((goal) => goal.semester_id === semesterId)
      .sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit)
      .map((goal) =>
        toLocalGoalView(
          goal,
          db.goal_milestones.filter((milestone) => milestone.goal_id === goal.id),
        ),
      )

    return { goals, error: null }
  }

  const supabase = await createClient()
  let query = supabase
    .from('goals')
    .select(GOAL_SELECT)
    .neq('status', 'abandoned')
    .order('created_at', { ascending: false })
    .limit(limit)

  query = semesterId === null ? query.is('semester_id', null) : query.eq('semester_id', semesterId)

  const { data, error } = await query.returns<GoalJoinRow[]>()

  if (error) {
    console.error('[learning:listGoals]', error.code, error.message)
    return { goals: null, error: 'Your goals could not be loaded.' }
  }

  return { goals: (data ?? []).map(toGoalView), error: null }
}

export type DailyLogView = {
  id: DailyLogRow['id']
  log_date: DailyLogRow['log_date']
  hours_studied: DailyLogRow['hours_studied']
  mood: DailyLogRow['mood']
  productivity: DailyLogRow['productivity']
  summary: DailyLogRow['summary']
  wins: DailyLogRow['wins']
  blockers: DailyLogRow['blockers']
  created_at: DailyLogRow['created_at']
  updated_at: DailyLogRow['updated_at']
}

export type StudyLogView = {
  /** The database's own answer, or 0. Rendered only when there is at least one entry. */
  streak: number
  /** The last `STREAK_WINDOW_DAYS` days, oldest first, marked from stored rows. */
  days: string[]
  entries: DailyLogView[]
  entryCount: number
  error: string | null
}

function toDailyLogView(log: LocalLog): DailyLogView {
  return {
    id: log.id,
    log_date: log.log_date,
    hours_studied: log.hours_studied,
    mood: log.mood,
    productivity: log.productivity,
    summary: log.summary,
    wins: log.wins,
    blockers: log.blockers,
    created_at: log.created_at,
    updated_at: log.updated_at,
  }
}

const newestLogDateFirst = (a: { log_date: string }, b: { log_date: string }) =>
  a.log_date === b.log_date ? 0 : a.log_date < b.log_date ? 1 : -1

/**
 * The daily log page's whole data requirement, in three parallel reads.
 *
 * The streak is a `select public.current_study_streak()` — a real computation over the
 * rows, in the database, every time the page renders. The dates are the same rows,
 * fetched for the strip and for the entry list; `daily_logs.log_date` is unique per day
 * per profile, so the count of dates is the count of entries and two writes in one day
 * cannot produce two marks.
 *
 * In local mode there is no function to call, so the streak is `streakFromLogDates` over
 * the profile's rows — the same anchor-and-leading-run rule `current_study_streak()`
 * implements, held to the SQL by `tests/db/learning.test.ts`, with the same UTC day
 * boundary (`databaseToday()`). Nothing else about the shape changes.
 */
export async function getStudyLog({
  windowDays,
  listDays,
}: {
  windowDays: number
  listDays: number
}): Promise<StudyLogView> {
  const empty: StudyLogView = { streak: 0, days: [], entries: [], entryCount: 0, error: null }

  const user = await getUser()
  if (!user) return empty

  if (isLocalMode()) {
    const db = await readStore()
    const profile = await localProfile(db, user.id)
    if (!profile) return empty

    // `daily_logs_own`: the reader's own rows, and only those.
    const mine = db.daily_logs
      .filter((log) => log.profile_id === profile.id)
      .sort(newestLogDateFirst)

    return {
      streak: streakFromLogDates(
        mine.map((log) => log.log_date),
        databaseToday(),
      ),
      days: mine.slice(0, windowDays).map((log) => log.log_date),
      entries: mine.slice(0, listDays).map(toDailyLogView),
      entryCount: mine.length,
      error: null,
    }
  }

  const supabase = await createClient()

  const [streak, dates, recent] = await Promise.all([
    supabase.rpc('current_study_streak'),
    supabase
      .from('daily_logs')
      .select('log_date')
      .order('log_date', { ascending: false })
      .limit(windowDays)
      .returns<{ log_date: string }[]>(),
    supabase
      .from('daily_logs')
      .select(
        'id, log_date, hours_studied, mood, productivity, summary, wins, blockers, created_at, updated_at',
        { count: 'exact' },
      )
      .order('log_date', { ascending: false })
      .limit(listDays)
      .returns<DailyLogView[]>(),
  ])

  for (const [label, error] of [
    ['streak', streak.error],
    ['dates', dates.error],
    ['recent', recent.error],
  ] as const) {
    if (error) console.error(`[learning:getStudyLog:${label}]`, error.code, error.message)
  }

  if (dates.error || recent.error) {
    return { ...empty, error: 'Your study log could not be loaded.' }
  }

  return {
    // A failed streak call is 0 and the page then shows no streak at all when there are
    // no entries either; it never invents a number.
    streak: typeof streak.data === 'number' ? streak.data : 0,
    days: (dates.data ?? []).map((row) => row.log_date),
    entries: recent.data ?? [],
    // PostgREST reports the count of the filtered set rather than of the page, which is
    // what makes "you have logged 34 days" a stored fact and not `entries.length`.
    entryCount: recent.count ?? (recent.data ?? []).length,
    error: null,
  }
}

export type AchievementView = {
  key: string
  name: string
  description: string
  /** The plain-language statement of what was counted. Shown, never paraphrased. */
  criteria: string
  category: string
  tier: string
  icon: string
  sort_order: number
  awarded_at: string
  awarded_value: number | null
  is_pinned: boolean
}

type AchievementJoinRow = {
  awarded_at: string
  awarded_value: number | null
  is_pinned: boolean
  achievement_definitions: Omit<AchievementView, 'awarded_at' | 'awarded_value' | 'is_pinned'> | null
}

/**
 * The reader's achievements, newest first.
 *
 * Read-only, and not by convention: `authenticated` has no INSERT, no DELETE and no
 * UPDATE on this table beyond `is_pinned` (0012), and every row is written by
 * `app.award_achievement()` from a trigger that counted something real. So there is no
 * locked grid here, no "3 of 5" and no progress towards a badge — the platform tracks no
 * progress towards one, and a greyed-out badge implying otherwise would be a number the
 * interface invented.
 *
 * `criteria` is carried through to the page rather than summarised, because it is the
 * sentence that says exactly what was counted. A badge whose meaning the holder cannot
 * look up is decoration.
 *
 * LOCAL MODE: the store has no `profile_achievements` or `achievement_definitions` table
 * and the seed does not create any, so the honest answer here is an empty list with no
 * error. `/goals` already renders nothing for an empty list, so the section simply does
 * not appear — which is the truth: nothing has been awarded in this store. It is not an
 * error state, and it must not be dressed up as one.
 */
export async function listMyAchievements(): Promise<{
  achievements: AchievementView[] | null
  error: string | null
}> {
  const user = await getUser()
  if (!user) return { achievements: [], error: null }

  if (isLocalMode()) return { achievements: [], error: null }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profile_achievements')
    .select(
      'awarded_at, awarded_value, is_pinned, achievement_definitions(key, name, description, criteria, category, tier, icon, sort_order)',
    )
    .eq('profile_id', user.id)
    .order('awarded_at', { ascending: false })
    .returns<AchievementJoinRow[]>()

  if (error) {
    console.error('[learning:listMyAchievements]', error.code, error.message)
    return { achievements: null, error: 'Your achievements could not be loaded.' }
  }

  return {
    achievements: (data ?? [])
      .filter((row) => row.achievement_definitions !== null)
      .map((row) => ({
        ...row.achievement_definitions!,
        awarded_at: row.awarded_at,
        awarded_value: row.awarded_value,
        is_pinned: row.is_pinned,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.sort_order - b.sort_order),
    error: null,
  }
}

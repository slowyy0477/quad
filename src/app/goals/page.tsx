import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { getUser } from '@/lib/supabase/server'
import { termLabel } from '@/features/learning/constants'
import { listGoals, listMyAchievements, listSemesters } from '@/features/learning/queries'
import { AchievementList } from '@/features/learning/components/achievement-list'
import { CourseForm, CurrentTermButton } from '@/features/learning/components/course-form'
import { GoalCard } from '@/features/learning/components/goal-card'
import { GoalForm } from '@/features/learning/components/goal-form'
import { SemesterForm } from '@/features/learning/components/semester-form'

export const metadata: Metadata = {
  title: 'Goals',
  description: 'Terms, courses and the goals you set yourself, with the steps and the number that measure them.',
}

type SearchParams = Record<string, string | string[] | undefined>

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

/**
 * /goals
 *
 * A term panel and a goal list, not a dashboard. The page answers three questions in
 * order: which term am I in, what am I taking, and what did I say I would do — and it
 * answers them with rows, not with invented percentages.
 *
 * The selected term is URL state (`?semester=`), so a link to "my goals for Autumn 2026"
 * is a link, and going back restores the term you were looking at.
 */
export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const user = await getUser()

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
        <h1 className="text-3xl">Goals</h1>
        <p className="mt-2 max-w-prose text-ink-muted">
          Terms, courses, goals and the steps between you and them.
        </p>
        <EmptyState
          className="mt-8"
          title="Sign in to keep your own"
          action={
            <Button asChild variant="primary">
              <Link href="/login?next=/goals">Sign in</Link>
            </Button>
          }
        >
          Goals belong to an account, and they are private unless you choose to show them.
        </EmptyState>
      </div>
    )
  }

  const [semestersResult, achievementsResult] = await Promise.all([
    listSemesters(),
    listMyAchievements(),
  ])

  const semesters = semestersResult.semesters ?? []
  const requested = firstParam(params.semester)
  const selected =
    semesters.find((semester) => semester.id === requested) ??
    semesters.find((semester) => semester.is_current) ??
    semesters[0] ??
    null

  const [termGoals, looseGoals] = await Promise.all([
    selected ? listGoals(selected.id) : Promise.resolve({ goals: [], error: null }),
    listGoals(null),
  ])

  const termOptions = semesters.map((semester) => ({
    id: semester.id,
    label: [semester.name, semester.year ? String(semester.year) : null].filter(Boolean).join(' · '),
  }))

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="border-b border-rule pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-3xl">Goals</h1>
          <Link
            href="/log"
            className="text-sm text-accent-700 underline-offset-4 hover:underline"
          >
            The daily study log →
          </Link>
        </div>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          A term holds your courses and the goals you filed under it. Every number here is
          counted from rows you can point at — there is no completeness score and nothing is
          inferred.
        </p>
      </header>

      {semestersResult.error ? (
        <Alert className="mt-6" tone="danger" title="Your terms could not be loaded">
          {semestersResult.error}
        </Alert>
      ) : null}

      {semesters.length > 0 ? (
        <nav aria-label="Terms" className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          {semesters.map((semester) => {
            const active = selected?.id === semester.id
            return (
              <Link
                key={semester.id}
                href={`/goals?semester=${semester.id}`}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'border-b-2 border-accent-600 pb-0.5 text-sm font-medium text-ink'
                    : 'border-b-2 border-transparent pb-0.5 text-sm text-ink-muted hover:text-ink'
                }
              >
                {semester.name}
                {semester.is_current ? (
                  <span className="ml-1.5 text-2xs uppercase tracking-[0.1em] text-ink-faint">now</span>
                ) : null}
              </Link>
            )
          })}
        </nav>
      ) : null}

      {selected ? (
        <section className="mt-8" aria-labelledby="term-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2">
            <h2 id="term-heading" className="text-xl">
              {selected.name}
              {selected.term ? <span className="text-ink-muted"> · {termLabel(selected.term)}</span> : null}
              {selected.year ? <span className="text-ink-muted"> {selected.year}</span> : null}
            </h2>
            <CurrentTermButton semesterId={selected.id} isCurrent={selected.is_current} />
          </div>

          {selected.start_date || selected.end_date ? (
            <p className="mt-2 text-xs tabular-nums text-ink-faint">
              {selected.start_date ?? 'no start'} — {selected.end_date ?? 'no end'}
            </p>
          ) : null}

          <h3 className="mt-5 text-2xs font-medium uppercase tracking-[0.16em] text-ink-faint">
            Courses
          </h3>
          {selected.courses.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">
              No courses filed under this term yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-hairline">
              {selected.courses.map((course) => (
                <li key={course.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  {course.code ? (
                    <span className="text-2xs tabular-nums text-ink-faint">{course.code}</span>
                  ) : null}
                  <span className="text-sm text-ink">{course.title}</span>
                  {course.instructor ? (
                    <span className="text-xs text-ink-muted">{course.instructor}</span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2">
                    {course.credits !== null ? (
                      <span className="text-2xs tabular-nums text-ink-faint">
                        {course.credits} credits
                      </span>
                    ) : null}
                    {course.grade ? <Badge tone="outline">{course.grade}</Badge> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-3 group">
            <summary className="cursor-pointer text-xs text-accent-700 underline-offset-4 hover:underline">
              Add a course to this term
            </summary>
            <div className="mt-4">
              <CourseForm semesterId={selected.id} />
            </div>
          </details>
        </section>
      ) : (
        <EmptyState
          className="mt-8"
          title="No term yet"
          action={null}
        >
          Add your first term below. Goals can exist without one, but a term is what makes
          them a plan rather than a list.
        </EmptyState>
      )}

      <section className="mt-10" aria-labelledby="goals-heading">
        <SectionHeading
          title={selected ? `Goals for ${selected.name}` : 'Goals'}
          description="Steps are ticked; the number is typed. Neither is inferred from the other."
        />

        {termGoals.error ? (
          <Alert className="mt-4" tone="danger" title="Your goals could not be loaded">
            {termGoals.error}
          </Alert>
        ) : null}

        {(termGoals.goals ?? []).length === 0 ? (
          <EmptyState className="mt-4" title="No goals for this term yet">
            A goal needs a number to count towards — problems done, chapters read, weeks
            logged. Add one below and it can gain steps as you learn what they are.
          </EmptyState>
        ) : (
          <div className="mt-2">
            {(termGoals.goals ?? []).map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        )}

        <details className="mt-5">
          <summary className="cursor-pointer text-sm text-accent-700 underline-offset-4 hover:underline">
            Add a goal
          </summary>
          <div className="mt-4">
            <GoalForm semesters={termOptions} defaultSemesterId={selected?.id ?? null} />
          </div>
        </details>
      </section>

      {(looseGoals.goals ?? []).length > 0 ? (
        <section className="mt-10" aria-labelledby="loose-heading">
          <SectionHeading
            title="Outside any term"
            description="Goals you did not file under one. They count the same; they just have no term to belong to."
          />
          <div className="mt-2">
            {(looseGoals.goals ?? []).map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        </section>
      ) : null}

      {achievementsResult.error ? (
        <Alert className="mt-8" tone="warning" title="Achievements could not be loaded">
          {achievementsResult.error}
        </Alert>
      ) : null}

      {(achievementsResult.achievements ?? []).length > 0 ? (
        <section className="mt-10" aria-labelledby="achievements-heading">
          <SectionHeading
            title="Earned"
            description="Each one was awarded by a trigger that counted something real. There is no progress towards one, because the platform does not track any."
          />
          <div className="mt-2">
            <AchievementList achievements={achievementsResult.achievements ?? []} />
          </div>
        </section>
      ) : null}

      <section className="mt-10 border-t border-rule pt-6" aria-labelledby="terms-heading">
        <h2 id="terms-heading" className="text-base font-medium text-ink">
          Add a term
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          One term at a time is marked current; the database enforces that, so this is a move
          rather than a second flag.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-accent-700 underline-offset-4 hover:underline">
            New term
          </summary>
          <div className="mt-4">
            <SemesterForm />
          </div>
        </details>
      </section>
    </div>
  )
}

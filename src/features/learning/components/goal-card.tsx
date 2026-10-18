'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ProgressMeter } from '@/components/ui/progress-meter'
import { cn } from '@/lib/utils'
import { emptyFormState } from '@/lib/form-state'
import { goalCategoryLabel, goalStatusLabel } from '@/features/learning/constants'
import {
  addMilestoneAction,
  setGoalStatusAction,
  toggleMilestoneAction,
  updateGoalProgressAction,
} from '@/features/learning/actions'

/**
 * One goal.
 *
 * Structural prop type rather than an import from `queries.ts`, because that module is
 * `server-only`; the row shape it returns satisfies this and nothing has to be coupled to
 * it. That is also why the card is a client component: four small forms with independent
 * error states, each needing `useActionState`, and each writing one column the database
 * derives everything else from.
 */
export type GoalCardData = {
  id: string
  title: string
  description: string | null
  category: string
  status: string
  target_value: number | null
  current_value: number | null
  unit: string | null
  progress_percent: number | null
  target_date: string | null
  completed_at: string | null
  milestone_count: number
  completed_milestone_count: number
  milestones: {
    id: string
    title: string
    is_completed: boolean
    target_date: string | null
  }[]
}

function MilestoneToggle({
  milestone,
}: {
  milestone: GoalCardData['milestones'][number]
}) {
  const [state, action] = useActionState(toggleMilestoneAction, emptyFormState)

  return (
    <form action={action} className="flex items-start gap-2.5">
      <input type="hidden" name="milestoneId" value={milestone.id} />
      <input type="hidden" name="isCompleted" value={String(!milestone.is_completed)} />
      <button
        type="submit"
        aria-pressed={milestone.is_completed}
        className="group flex flex-1 items-start gap-2.5 py-1.5 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[2px] border text-[10px] font-semibold',
            milestone.is_completed
              ? 'border-accent-600 bg-accent-600 text-paper'
              : 'border-rule text-transparent group-hover:border-ink-faint',
          )}
        >
          ✓
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              'block text-sm',
              milestone.is_completed ? 'text-ink-faint line-through' : 'text-ink',
            )}
          >
            {milestone.title}
          </span>
          {milestone.target_date ? (
            <span className="block text-2xs text-ink-faint">by {milestone.target_date}</span>
          ) : null}
        </span>
      </button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-2xs text-danger-600">
          Not saved
        </p>
      ) : null}
    </form>
  )
}

function ProgressUpdate({ goal }: { goal: GoalCardData }) {
  const [state, action] = useActionState(updateGoalProgressAction, emptyFormState)
  const unit = goal.unit?.trim() || 'units'

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="goalId" value={goal.id} />
      <label htmlFor={`progress-${goal.id}`} className="sr-only">
        How many {unit} so far
      </label>
      <Input
        id={`progress-${goal.id}`}
        name="currentValue"
        type="number"
        min="0"
        step="any"
        defaultValue={goal.current_value ?? 0}
        className="h-8 w-24 text-sm"
      />
      <Button type="submit" variant="secondary" className="h-8 px-3 text-xs">
        Update
      </Button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="w-full text-2xs text-danger-600">
          {state.message}
        </p>
      ) : null}
      {state.status === 'success' && state.message ? (
        <p role="status" className="w-full text-2xs text-ink-muted">
          {state.message}
        </p>
      ) : null}
    </form>
  )
}

function AddMilestone({ goalId }: { goalId: string }) {
  const [state, action] = useActionState(addMilestoneAction, emptyFormState)

  return (
    <form action={action} className="mt-1 flex flex-wrap items-end gap-2">
      <input type="hidden" name="goalId" value={goalId} />
      <Field id={`milestone-${goalId}`} label="Add a step" className="min-w-0 flex-1">
        {(props) => (
          <Input
            {...props}
            name="title"
            maxLength={200}
            placeholder="Chapter 3 exercises"
            className="h-8 text-sm"
          />
        )}
      </Field>
      <Button type="submit" variant="ghost" className="h-8 px-3 text-xs">
        Add step
      </Button>
      {state.status === 'error' && state.fieldErrors?.title ? (
        <p role="alert" className="w-full text-2xs text-danger-600">
          {state.fieldErrors.title}
        </p>
      ) : null}
    </form>
  )
}

function StatusButton({ goal }: { goal: GoalCardData }) {
  const [state, action] = useActionState(setGoalStatusAction, emptyFormState)
  const done = goal.status === 'completed'

  return (
    <form action={action}>
      <input type="hidden" name="goalId" value={goal.id} />
      <input type="hidden" name="status" value={done ? 'active' : 'completed'} />
      <Button type="submit" variant="ghost" className="h-8 px-3 text-xs">
        {done ? 'Reopen' : 'Mark as done'}
      </Button>
      {state.status === 'error' && state.message ? (
        <p role="alert" className="mt-1 text-2xs text-danger-600">
          {state.message}
        </p>
      ) : null}
    </form>
  )
}

export function GoalCard({ goal }: { goal: GoalCardData }) {
  const done = goal.status === 'completed'
  const unit = goal.unit?.trim() || 'units'
  const hasNumber = (goal.target_value ?? 0) > 0

  return (
    <article className="border-b border-hairline py-5 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3
          className={cn(
            'font-display text-lg',
            done ? 'text-ink-muted line-through decoration-hairline' : 'text-ink',
          )}
        >
          {goal.title}
        </h3>
        <div className="flex items-center gap-1.5">
          <Badge tone="outline">{goalCategoryLabel(goal.category)}</Badge>
          {done ? <Badge tone="success">Done</Badge> : <Badge tone="neutral">{goalStatusLabel(goal.status)}</Badge>}
        </div>
      </div>

      {goal.description ? (
        <p className="mt-1 max-w-prose text-sm text-ink-muted">{goal.description}</p>
      ) : null}

      {goal.target_date ? (
        <p className="mt-1 text-2xs text-ink-faint">
          Target date {goal.target_date}
          {goal.completed_at ? ` · completed ${goal.completed_at.slice(0, 10)}` : ''}
        </p>
      ) : null}

      {goal.milestone_count > 0 ? (
        <ProgressMeter
          className="mt-3 max-w-sm"
          value={goal.completed_milestone_count}
          total={goal.milestone_count}
          label="Steps"
          tone={done ? 'success' : 'accent'}
        />
      ) : null}

      {hasNumber ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm tabular-nums text-ink-muted">
            <span className="text-ink">{goal.current_value ?? 0}</span> of {goal.target_value} {unit}
            {goal.progress_percent !== null ? (
              <span className="text-ink-faint"> · {goal.progress_percent}%</span>
            ) : null}
          </p>
          {done ? null : <ProgressUpdate goal={goal} />}
        </div>
      ) : null}

      {goal.milestones.length > 0 ? (
        <div className="mt-3 max-w-lg">
          <ul className="space-y-0.5">
            {goal.milestones.map((milestone) => (
              <li key={milestone.id}>
                <MilestoneToggle milestone={milestone} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {done ? null : (
        <div className="mt-3 max-w-lg">
          <AddMilestone goalId={goal.id} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3">
        <StatusButton goal={goal} />
        {goal.milestone_count === 0 && hasNumber ? (
          <span className="text-2xs text-ink-faint">No steps yet — the number above is the whole measure.</span>
        ) : null}
      </div>

      {!done && goal.milestone_count > 0 && goal.completed_milestone_count === goal.milestone_count ? (
        <Alert tone="info" className="mt-3">
          Every step is done. The goal is still open until you mark it done — the platform will
          not decide that for you.
        </Alert>
      ) : null}
    </article>
  )
}

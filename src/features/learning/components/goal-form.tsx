'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { VISIBILITIES } from '@/features/projects/constants'
import { GOAL_CATEGORIES } from '@/features/learning/constants'
import { createGoalAction } from '@/features/learning/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * A goal, with the three things that make it more than a wish: steps, a number, and a
 * state.
 *
 * Every control here writes to a column the database owns the arithmetic for — the
 * percentage, the completed counts and `completed_at` are derived by the trigger from
 * `current_value`, the milestone rows and `status`. So the form never offers a field for
 * any of them, and the meter above the form is read from the row that came back.
 *
 * `targetValue` is required and above zero because the column is: a goal without a number
 * to count towards cannot be met, and a goal that cannot be met is a note.
 */
export function GoalForm({
  semesters,
  defaultSemesterId,
}: {
  semesters: { id: string; label: string }[]
  defaultSemesterId: string | null
}) {
  const [state, action] = useActionState(createGoalAction, emptyFormState)

  return (
    <form action={action} className="space-y-5">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The goal was not saved">
          {state.message}
        </Alert>
      ) : null}

      <Field
        id="goal-title"
        label="The goal"
        required
        hint="One sentence, starting with a verb."
        error={state.fieldErrors?.title}
      >
        {(props) => (
          <Input
            {...props}
            name="title"
            maxLength={160}
            defaultValue={state.values?.title ?? ''}
            placeholder="Finish the discrete maths problem sets for the term"
          />
        )}
      </Field>

      <Field
        id="goal-description"
        label="What counts as done"
        hint="Optional. The definition you will use to decide, in advance."
        error={state.fieldErrors?.description}
      >
        {(props) => (
          <Textarea
            {...props}
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={state.values?.description ?? ''}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="goal-category" label="Kind" error={state.fieldErrors?.category}>
          {(props) => (
            <Select
              {...props}
              name="category"
              defaultValue={state.values?.category ?? 'academic'}
            >
              {GOAL_CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field id="goal-semester" label="Term" hint="Leave unset for a goal outside a term.">
          {(props) => (
            <Select {...props} name="semesterId" defaultValue={state.values?.semesterId ?? defaultSemesterId ?? ''}>
              <option value="">No term</option>
              {semesters.map((semester) => (
                <option key={semester.id} value={semester.id}>
                  {semester.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="goal-target"
          label="Target"
          required
          hint="A number the goal is counted in."
          error={state.fieldErrors?.targetValue}
        >
          {(props) => (
            <Input
              {...props}
              name="targetValue"
              type="number"
              min="0.01"
              step="any"
              defaultValue={state.values?.targetValue ?? ''}
              placeholder="12"
            />
          )}
        </Field>

        <Field id="goal-unit" label="Unit" hint="Problems, chapters, weeks…" error={state.fieldErrors?.unit}>
          {(props) => (
            <Input
              {...props}
              name="unit"
              maxLength={24}
              defaultValue={state.values?.unit ?? ''}
              placeholder="problem sets"
            />
          )}
        </Field>

        <Field id="goal-date" label="Target date" error={state.fieldErrors?.targetDate}>
          {(props) => (
            <Input {...props} name="targetDate" type="date" defaultValue={state.values?.targetDate ?? ''} />
          )}
        </Field>
      </div>

      <Field
        id="goal-visibility"
        label="Who can see it"
        hint="A public goal appears on your profile. A private one is yours alone."
      >
        {(props) => (
          <Select {...props} name="visibility" defaultValue={state.values?.visibility ?? 'public'}>
            {VISIBILITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="flex items-center justify-between gap-3 border-t border-hairline pt-4">
        <Badge tone="neutral">Steps can be added once it exists</Badge>
        <SubmitButton pendingLabel="Saving…">Add the goal</SubmitButton>
      </div>
    </form>
  )
}

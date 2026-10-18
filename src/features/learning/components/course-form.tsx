'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input, Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { COURSE_STATUSES } from '@/features/learning/constants'
import { createCourseAction, setCurrentSemesterAction } from '@/features/learning/actions'
import { emptyFormState } from '@/lib/form-state'

/** A course, filed under one of the reader's own terms. */
export function CourseForm({ semesterId }: { semesterId: string }) {
  const [state, action] = useActionState(createCourseAction, emptyFormState)

  return (
    <form action={action} className="space-y-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The course was not added">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? (
        <Alert tone="success">{state.message}</Alert>
      ) : null}

      <input type="hidden" name="semesterId" value={semesterId} />

      <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
        <Field id="course-code" label="Code" hint="CS-201" error={state.fieldErrors?.code}>
          {(props) => (
            <Input {...props} name="code" maxLength={32} defaultValue={state.values?.code ?? ''} />
          )}
        </Field>
        <Field id="course-title" label="Title" required error={state.fieldErrors?.title}>
          {(props) => (
            <Input
              {...props}
              name="title"
              maxLength={160}
              defaultValue={state.values?.title ?? ''}
              placeholder="Discrete Structures"
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="course-instructor" label="Instructor" error={state.fieldErrors?.instructor}>
          {(props) => (
            <Input {...props} name="instructor" maxLength={120} defaultValue={state.values?.instructor ?? ''} />
          )}
        </Field>
        <Field id="course-credits" label="Credits" hint="0 to 60, one decimal." error={state.fieldErrors?.credits}>
          {(props) => (
            <Input {...props} name="credits" type="number" min="0" max="60" step="0.5" defaultValue={state.values?.credits ?? ''} />
          )}
        </Field>
        <Field id="course-status" label="Status" error={state.fieldErrors?.status}>
          {(props) => (
            <Select {...props} name="status" defaultValue={state.values?.status ?? 'in_progress'}>
              {COURSE_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <SubmitButton pendingLabel="Adding…">Add the course</SubmitButton>
    </form>
  )
}

/**
 * Make a term the current one, or stop treating it as such.
 *
 * Two buttons rather than a switch: this is a state the database keeps unique, and a
 * toggle whose off-state is "no current term at all" reads as if it might delete something.
 */
export function CurrentTermButton({
  semesterId,
  isCurrent,
}: {
  semesterId: string
  isCurrent: boolean
}) {
  const [state, action] = useActionState(setCurrentSemesterAction, emptyFormState)

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="semesterId" value={semesterId} />
      <input type="hidden" name="isCurrent" value={String(!isCurrent)} />
      <Button type="submit" variant={isCurrent ? 'ghost' : 'secondary'} className="h-7 px-2.5 text-xs">
        {isCurrent ? 'This is your current term' : 'Make this the current term'}
      </Button>
      {state.status === 'error' && state.message ? (
        <span role="alert" className="text-2xs text-danger-600">
          {state.message}
        </span>
      ) : null}
    </form>
  )
}

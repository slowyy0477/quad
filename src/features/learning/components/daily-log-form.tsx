'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { HOURS_STUDIED_MAX, HOURS_STUDIED_STEP, MOOD_SCALE } from '@/features/learning/constants'
import { saveDailyLogAction } from '@/features/learning/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Today's entry.
 *
 * `logDate` defaults to the batch's own today, passed in from the server, and the page
 * states which boundary that is. The form does not send a time, only a date: the column is
 * a `date`, and one entry per day is a unique constraint, so a second submission on the
 * same day is an update to the same row rather than a second mark on the strip.
 *
 * Mood and productivity are the writer's own opinion on a five-step scale, named rather
 * than numbered, and nothing on the site aggregates them into a score.
 */
export function DailyLogForm({ today, existing }: { today: string; existing?: { hours_studied: number | null; mood: number | null; productivity: number | null; summary: string | null; wins: string | null; blockers: string | null } }) {
  const [state, action] = useActionState(saveDailyLogAction, emptyFormState)

  return (
    <form action={action} className="space-y-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The entry was not saved">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? (
        <Alert tone="success">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="log-date"
          label="Day"
          required
          hint="The database's day (UTC), not your device's."
          error={state.fieldErrors?.logDate}
        >
          {(props) => (
            <Input {...props} name="logDate" type="date" defaultValue={state.values?.logDate ?? today} />
          )}
        </Field>

        <Field id="log-hours" label="Hours studied" error={state.fieldErrors?.hoursStudied}>
          {(props) => (
            <Input
              {...props}
              name="hoursStudied"
              type="number"
              min="0"
              max={HOURS_STUDIED_MAX}
              step={HOURS_STUDIED_STEP}
              defaultValue={state.values?.hoursStudied ?? (existing?.hours_studied ?? '')}
            />
          )}
        </Field>

        <Field id="log-mood" label="How the day felt" error={state.fieldErrors?.mood}>
          {(props) => (
            <Select {...props} name="mood" defaultValue={state.values?.mood ?? (existing?.mood ?? '')}>
              <option value="">Not saying</option>
              {MOOD_SCALE.map((step) => (
                <option key={step.value} value={step.value}>
                  {step.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="log-productivity" label="How much got done" error={state.fieldErrors?.productivity}>
          {(props) => (
            <Select
              {...props}
              name="productivity"
              defaultValue={state.values?.productivity ?? (existing?.productivity ?? '')}
            >
              <option value="">Not saying</option>
              {MOOD_SCALE.map((step) => (
                <option key={step.value} value={step.value}>
                  {step.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        id="log-summary"
        label="What you did"
        hint="A sentence is enough. This is a record, not an essay."
        error={state.fieldErrors?.summary}
      >
        {(props) => (
          <Textarea
            {...props}
            name="summary"
            rows={3}
            maxLength={2000}
            defaultValue={state.values?.summary ?? (existing?.summary ?? '')}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="log-wins" label="What went well" error={state.fieldErrors?.wins}>
          {(props) => (
            <Textarea
              {...props}
              name="wins"
              rows={2}
              maxLength={1000}
              defaultValue={state.values?.wins ?? (existing?.wins ?? '')}
            />
          )}
        </Field>
        <Field id="log-blockers" label="What got in the way" error={state.fieldErrors?.blockers}>
          {(props) => (
            <Textarea
              {...props}
              name="blockers"
              rows={2}
              maxLength={1000}
              defaultValue={state.values?.blockers ?? (existing?.blockers ?? '')}
            />
          )}
        </Field>
      </div>

      <SubmitButton pendingLabel="Saving…">
        {existing ? 'Update this day' : 'Save the day'}
      </SubmitButton>
    </form>
  )
}

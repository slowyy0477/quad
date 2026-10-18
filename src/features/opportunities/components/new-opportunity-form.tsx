'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { createOpportunityAction } from '@/features/opportunities/actions'
import {
  OPPORTUNITY_TYPES,
  OPPORTUNITY_VISIBILITIES,
  WORK_MODES,
} from '@/features/opportunities/constants'
import type { SkillOption } from '@/features/opportunities/queries'
import { emptyFormState } from '@/lib/form-state'

/**
 * Post a listing.
 *
 * The author is the session, never a field: the insert trigger forces `posted_by` to
 * `auth.uid()`, along with the slug, the university and the provenance. The form says so
 * once, in the visibility hint, rather than offering a control for any of them.
 *
 * Applying is not recorded here or anywhere -- `apply_url` and `apply_email` are the
 * routes, and the organisation receives the application. The form asks for at least one
 * of them because the database refuses a listing without a way to apply.
 */
export function NewOpportunityForm({ skills }: { skills: SkillOption[] }) {
  const [state, action] = useActionState(createOpportunityAction, emptyFormState)
  const values = state.values ?? {}

  return (
    <form action={action} className="space-y-5">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The listing was not saved">
          {state.message}
        </Alert>
      ) : null}

      <Field
        id="opportunity-title"
        label="Title"
        required
        hint="What the role or award is called, as the organisation writes it."
        error={state.fieldErrors?.title}
      >
        {(props) => (
          <Input {...props} name="title" defaultValue={values.title} maxLength={160} autoComplete="off" />
        )}
      </Field>

      <Field
        id="opportunity-organisation"
        label="Organisation"
        required
        hint="The employer, funder or team offering it."
        error={state.fieldErrors?.organisation}
      >
        {(props) => (
          <Input
            {...props}
            name="organisation"
            defaultValue={values.organisation}
            maxLength={160}
            autoComplete="organization"
          />
        )}
      </Field>

      <Field
        id="opportunity-description"
        label="Description"
        required
        hint="At least 20 characters. What the work is, who it suits, and anything a reader would need to decide."
        error={state.fieldErrors?.description}
      >
        {(props) => (
          <Textarea
            {...props}
            name="description"
            rows={8}
            defaultValue={values.description}
            maxLength={10000}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="opportunity-type" label="Type" required error={state.fieldErrors?.type}>
          {(props) => (
            <Select {...props} name="type" defaultValue={values.type ?? 'internship'}>
              {OPPORTUNITY_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id="opportunity-mode"
          label="Where"
          required
          hint="Remote means the work can be done from anywhere."
          error={state.fieldErrors?.workMode}
        >
          {(props) => (
            <Select {...props} name="workMode" defaultValue={values.workMode ?? 'onsite'}>
              {WORK_MODES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id="opportunity-location"
          label="Location"
          hint="A city, or a campus. Leave empty for a fully remote listing."
          error={state.fieldErrors?.location}
        >
          {(props) => (
            <Input {...props} name="location" defaultValue={values.location} maxLength={160} />
          )}
        </Field>

        <Field
          id="opportunity-compensation"
          label="Compensation"
          hint="Free text on purpose: “PKR 60,000 a month”, “unpaid”, “stipend, amount TBC”."
          error={state.fieldErrors?.compensation}
        >
          {(props) => (
            <Input {...props} name="compensation" defaultValue={values.compensation} maxLength={120} />
          )}
        </Field>

        <Field
          id="opportunity-deadline"
          label="Closing date"
          hint="The last day to apply. Leave empty only if there is genuinely no deadline."
          error={state.fieldErrors?.deadline}
        >
          {(props) => <Input {...props} name="deadline" type="date" defaultValue={values.deadline} />}
        </Field>

        <Field
          id="opportunity-start"
          label="Starts on"
          hint="Optional, and it cannot be before the closing date."
          error={state.fieldErrors?.startsOn}
        >
          {(props) => <Input {...props} name="startsOn" type="date" defaultValue={values.startsOn} />}
        </Field>
      </div>

      <fieldset className="space-y-4 rounded border border-hairline p-4">
        <legend className="px-1 text-sm font-medium text-ink">How to apply</legend>
        <p className="text-xs text-ink-muted">
          Quad does not take applications and does not record who applied — the organisation does. One of
          these two is required.
        </p>

        <Field
          id="opportunity-apply-url"
          label="Application link"
          hint="Start with https:// — a bare domain is not accepted."
          error={state.fieldErrors?.applyUrl}
        >
          {(props) => (
            <Input
              {...props}
              name="applyUrl"
              type="url"
              inputMode="url"
              defaultValue={values.applyUrl}
              placeholder="https://"
            />
          )}
        </Field>

        <Field
          id="opportunity-apply-email"
          label="Or an email address"
          hint="Where a reader should send their application."
          error={state.fieldErrors?.applyEmail}
        >
          {(props) => (
            <Input
              {...props}
              name="applyEmail"
              type="email"
              inputMode="email"
              defaultValue={values.applyEmail}
            />
          )}
        </Field>
      </fieldset>

      <Field
        id="opportunity-visibility"
        label="Who can see it"
        hint="A university listing is stored as public if your profile has no university, because otherwise nobody could see it."
        error={state.fieldErrors?.visibility}
      >
        {(props) => (
          <Select {...props} name="visibility" defaultValue={values.visibility ?? 'public'}>
            {OPPORTUNITY_VISIBILITIES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Skills it asks for</legend>
        <p className="text-xs text-ink-muted">
          Optional. These are stored rows, so the board can match a listing to what students declare.
        </p>
        {skills.length === 0 ? (
          <p className="text-xs text-ink-faint">No skills list is available to choose from yet.</p>
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded border border-rule p-3">
            {skills.map((skill) => (
              <label key={skill.id} className="flex items-center gap-2.5 text-sm text-ink">
                <Checkbox name="skillIds" value={skill.id} />
                {skill.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <SubmitButton variant="primary" pendingLabel="Posting…">
        Post the listing
      </SubmitButton>
    </form>
  )
}

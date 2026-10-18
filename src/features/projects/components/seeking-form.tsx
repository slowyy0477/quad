'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { saveSeekingAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'
import type { SkillOption } from '@/features/projects/queries'

/**
 * "Seeking members": the flag, the target size and the required skills.
 *
 * The skills are checkboxes with one name, so the form posts `skillIds` as a repeated
 * field and the action reads it with `getAll`. What is ticked is what the project
 * needs, and the action replaces the required set with exactly that — so unticking a
 * skill is how the owner withdraws the ask.
 *
 * The flag is a checkbox rather than a switch: it is a value submitted with the form,
 * not a setting that changes the moment it is flipped. On a private project the
 * control is not offered at all, because the trigger forces the flag off on write and
 * a checkbox that silently does nothing is worse than no checkbox.
 */
export function SeekingForm({
  slug,
  isSeekingMembers,
  teamSizeTarget,
  lookingFor,
  skills,
  selectedSkillIds,
  canAdvertise,
}: {
  slug: string
  isSeekingMembers: boolean
  teamSizeTarget: number | null
  lookingFor: string | null
  skills: SkillOption[]
  selectedSkillIds: string[]
  canAdvertise: boolean
}) {
  const [state, action] = useActionState(saveSeekingAction, emptyFormState)

  return (
    <form action={action} className="space-y-6">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="Not saved">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="slug" value={slug} />

      {canAdvertise ? (
        <label htmlFor="seeking-flag" className="flex items-start gap-3">
          <span className="pt-0.5">
            <Checkbox id="seeking-flag" name="isSeekingMembers" defaultChecked={isSeekingMembers} />
          </span>
          <span>
            <span className="block text-sm text-ink">Show this project under “Open to join”</span>
            <span className="block text-xs text-ink-muted">
              It leaves that list on its own once the member count reaches the team size below.
            </span>
          </span>
        </label>
      ) : (
        <Alert tone="info" title="A private project cannot advertise">
          This project is private, so nobody who could answer would be able to see it. Make it visible
          to your university or to anyone to turn the open-to-join listing back on.
        </Alert>
      )}

      <Field
        id="seeking-size"
        label="Team size you are aiming for"
        hint="Optional. Leave it empty and the project stays listed until you turn the flag off."
        error={state.fieldErrors?.teamSizeTarget}
      >
        {(props) => (
          <Input
            {...props}
            name="teamSizeTarget"
            type="number"
            min={1}
            max={50}
            defaultValue={teamSizeTarget ?? ''}
            className="max-w-32"
          />
        )}
      </Field>

      <Field
        id="seeking-looking-for"
        label="What you are looking for, in your own words"
        hint="Up to 1000 characters. The skills below are the machine-readable half of the same ask."
        error={state.fieldErrors?.lookingFor}
      >
        {(props) => (
          <Textarea {...props} name="lookingFor" rows={3} maxLength={1000} defaultValue={lookingFor ?? ''} />
        )}
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Required skills</legend>
        <p className="text-xs text-ink-muted">
          Tick what the team actually needs. These are what the “Needs” badges on the project list show,
          and what a conversion from an idea carries across.
        </p>
        {skills.length === 0 ? (
          <p className="text-sm text-ink-muted">
            There are no skills available to choose from yet, so this control is not shown rather than
            shown empty.
          </p>
        ) : (
          <ul className="flex max-h-72 flex-wrap gap-x-5 gap-y-2 overflow-y-auto rounded border border-hairline p-3">
            {skills.map((skill) => (
              <li key={skill.id}>
                <label htmlFor={`skill-${skill.id}`} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`skill-${skill.id}`}
                    name="skillIds"
                    value={skill.id}
                    defaultChecked={selectedSkillIds.includes(skill.id)}
                  />
                  {skill.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <SubmitButton variant="primary" pendingLabel="Saving…">
        Save team settings
      </SubmitButton>
    </form>
  )
}

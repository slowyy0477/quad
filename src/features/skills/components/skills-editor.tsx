'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input, Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import {
  addInterestAction,
  attachSkillAction,
  proposeInterestAction,
  proposeSkillAction,
  removeInterestAction,
  removeSkillAction,
  updateProfileSkillAction,
} from '@/features/skills/actions'
import {
  INTEREST_CATEGORY_LABELS,
  SKILL_CATEGORY_LABELS,
  SKILL_LEVEL_LABELS,
} from '@/features/skills/schemas'
import type {
  InterestOption,
  ProfileInterest,
  ProfileSkill,
  SkillOption,
} from '@/features/skills/queries'
import { emptyFormState, type FormState } from '@/lib/form-state'

/**
 * The skills and interests editor.
 *
 * Every row is its own form with its own message. That is not decoration: the
 * database can refuse a specific row — a skill that is already on the profile, one
 * whose catalogue entry someone else proposed and that is still awaiting review,
 * a level that is no longer valid — and a page-level error would leave the reader
 * hunting for which of eight rows it meant.
 *
 * The label on the level select is present but visually hidden. These rows repeat
 * a handful of controls many times, and eight visible "Level" labels would bury the
 * skill names they belong to; the accessible name is still tied to the control,
 * which is the part that matters.
 *
 * What is deliberately not here: years of experience. The column exists and the
 * schema accepts it, but a field nobody asked for is a field that collects stale
 * data. Nothing renders a control for a number the interface does not use.
 */

function Messages({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null

  return (
    <Alert tone={state.status === 'error' ? 'danger' : 'success'} className="text-xs">
      {state.message}
    </Alert>
  )
}

const LEVELS = ['learning', 'familiar', 'proficient', 'advanced'] as const

// -----------------------------------------------------------------------------
// One skill already on the profile
// -----------------------------------------------------------------------------

function SkillRow({ skill }: { skill: ProfileSkill }) {
  const [updateState, update] = useActionState(updateProfileSkillAction, emptyFormState)
  const [removeState, remove] = useActionState(removeSkillAction, emptyFormState)

  const levelId = `level-${skill.skill_id}`
  const learningId = `learning-${skill.skill_id}`

  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-ink">
          {skill.name}
          {!skill.is_approved ? (
            <span className="ml-2 text-xs text-ink-faint">waiting for review</span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <form action={update} className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <input type="hidden" name="skillId" value={skill.skill_id} />

          <div>
            <label htmlFor={levelId} className="sr-only">
              {skill.name} level
            </label>
            <Select id={levelId} name="level" defaultValue={skill.level} className="min-h-9 w-40">
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {SKILL_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
          </div>

          <label htmlFor={learningId} className="flex min-h-9 items-center gap-2 text-xs text-ink-muted">
            <Checkbox id={learningId} name="isLearning" defaultChecked={skill.is_learning} />
            Learning now
          </label>

          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </form>

        <form action={remove}>
          <input type="hidden" name="skillId" value={skill.skill_id} />
          <SubmitButton variant="ghost" size="sm" pendingLabel="Removing…">
            Remove {skill.name}
          </SubmitButton>
        </form>
      </div>

      <Messages state={updateState} />
      <Messages state={removeState} />
    </li>
  )
}

// -----------------------------------------------------------------------------
// Adding a skill
// -----------------------------------------------------------------------------

function AddSkillForm({ catalogue }: { catalogue: SkillOption[] }) {
  const [attachState, attach] = useActionState(attachSkillAction, emptyFormState)
  const [proposeState, propose] = useActionState(proposeSkillAction, emptyFormState)

  return (
    <div className="space-y-6">
      <form action={attach} className="space-y-4">
        <Field
          id="skill-add"
          label="Add a skill"
          hint="The list holds skills other students have claimed too, most used first. Levels are self-declared — Quad does not test them."
          error={attachState.fieldErrors?.skillId}
        >
          {(field) => (
            <Select {...field} name="skillId" defaultValue="">
              <option value="">Choose a skill…</option>
              {catalogue.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} — {SKILL_CATEGORY_LABELS[option.category as keyof typeof SKILL_CATEGORY_LABELS] ?? option.category}
                  {option.is_approved ? '' : ' (yours, awaiting review)'}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field id="skill-add-level" label="Level" error={attachState.fieldErrors?.level}>
            {(field) => (
              <Select {...field} name="level" defaultValue="learning">
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {SKILL_LEVEL_LABELS[level]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <label
            htmlFor="skill-add-learning"
            className="flex min-h-11 items-center gap-2 text-sm text-ink"
          >
            <Checkbox id="skill-add-learning" name="isLearning" />
            I am learning this now
          </label>

          <SubmitButton variant="primary" size="sm" pendingLabel="Adding…">
            Add skill
          </SubmitButton>
        </div>

        {catalogue.length === 0 ? (
          <p className="text-xs text-ink-muted">
            No skills are in the catalogue yet, so there is nothing to pick from. Use the form below.
          </p>
        ) : null}

        <Messages state={attachState} />
      </form>

      <form action={propose} className="space-y-4 border-t border-hairline pt-5">
        <p className="text-sm font-medium text-ink">Or add one that is not listed</p>
        <p className="max-w-prose text-xs text-ink-muted">
          A new skill goes to a moderator. Until one approves it, it is on your profile and visible
          only to you and to them — nobody else sees the name.
        </p>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field id="skill-new-name" label="Skill" error={proposeState.fieldErrors?.name}>
            {(field) => (
              <Input {...field} name="name" maxLength={60} spellCheck={false} />
            )}
          </Field>

          <Field id="skill-new-category" label="Kind" error={proposeState.fieldErrors?.category}>
            {(field) => (
              <Select {...field} name="category" defaultValue="language">
                {Object.entries(SKILL_CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">
            Add as new
          </SubmitButton>
        </div>

        <Messages state={proposeState} />
      </form>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Interests
// -----------------------------------------------------------------------------

function InterestRow({ interest }: { interest: ProfileInterest }) {
  const [state, remove] = useActionState(removeInterestAction, emptyFormState)

  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="rounded-sm border border-hairline bg-paper-sunken px-2 py-1 text-2xs text-ink-muted">
        {interest.name}
        {!interest.is_approved ? <span className="text-ink-faint"> · waiting for review</span> : null}
      </span>
      <form action={remove}>
        <input type="hidden" name="interestId" value={interest.interest_id} />
        <SubmitButton variant="ghost" size="sm" pendingLabel="Removing…">
          <span className="sr-only">Remove </span>
          {interest.name}
        </SubmitButton>
      </form>
      <Messages state={state} />
    </li>
  )
}

function AddInterestForm({ catalogue }: { catalogue: InterestOption[] }) {
  const [addState, add] = useActionState(addInterestAction, emptyFormState)
  const [proposeState, propose] = useActionState(proposeInterestAction, emptyFormState)

  return (
    <div className="space-y-6">
      <form action={add} className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field
          id="interest-add"
          label="Tag an interest"
          hint="Topics you want to talk about, which is a different claim from a skill you have."
          error={addState.fieldErrors?.interestId}
        >
          {(field) => (
            <Select {...field} name="interestId" defaultValue="">
              <option value="">Choose a topic…</option>
              {catalogue.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} —{' '}
                  {INTEREST_CATEGORY_LABELS[option.category as keyof typeof INTEREST_CATEGORY_LABELS] ??
                    option.category}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <SubmitButton variant="primary" size="sm" pendingLabel="Adding…">
          Add interest
        </SubmitButton>

        <div className="w-full">
          <Messages state={addState} />
        </div>
      </form>

      <form action={propose} className="space-y-4 border-t border-hairline pt-5">
        <p className="text-sm font-medium text-ink">Or add a topic that is not listed</p>
        <p className="max-w-prose text-xs text-ink-muted">
          New topics go to a moderator, and are visible only to you until one approves them.
        </p>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field id="interest-new-name" label="Topic" error={proposeState.fieldErrors?.name}>
            {(field) => <Input {...field} name="name" maxLength={60} spellCheck={false} />}
          </Field>

          <Field
            id="interest-new-category"
            label="Kind"
            error={proposeState.fieldErrors?.category}
          >
            {(field) => (
              <Select {...field} name="category" defaultValue="academic">
                {Object.entries(INTEREST_CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">
            Add as new
          </SubmitButton>
        </div>

        <Messages state={proposeState} />
      </form>
    </div>
  )
}

// -----------------------------------------------------------------------------
// The editor
// -----------------------------------------------------------------------------

export function SkillsEditor({
  skills,
  interests,
  skillCatalogue,
  interestCatalogue,
}: {
  skills: ProfileSkill[]
  interests: ProfileInterest[]
  skillCatalogue: SkillOption[]
  interestCatalogue: InterestOption[]
}) {
  return (
    <div className="space-y-10">
      <section aria-label="Your skills">
        {skills.length > 0 ? (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {skills.map((skill) => (
              <SkillRow key={skill.skill_id} skill={skill} />
            ))}
          </ul>
        ) : (
          <p className="border-t border-hairline pt-4 text-sm text-ink-muted">
            You have not added a skill yet. Levels are self-declared, so there is no wrong answer to
            give.
          </p>
        )}

        <div className="mt-6">
          <AddSkillForm catalogue={skillCatalogue} />
        </div>
      </section>

      <section aria-label="Your interests" className="border-t border-rule pt-8">
        {interests.length > 0 ? (
          <ul className="flex flex-wrap items-start gap-x-4 gap-y-3">
            {interests.map((interest) => (
              <InterestRow key={interest.interest_id} interest={interest} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">
            No interests tagged. These are the topics you would like to be found by, and they are
            separate from the skills you claim.
          </p>
        )}

        <div className="mt-6">
          <AddInterestForm catalogue={interestCatalogue} />
        </div>
      </section>
    </div>
  )
}

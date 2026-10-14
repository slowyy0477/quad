'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioOption } from '@/components/ui/radio-group'
import { SubmitButton } from '@/components/ui/submit-button'
import { updatePrivacyAction } from '@/features/settings/actions'
import { SETTINGS_IDLE } from '@/features/settings/form-state'
import type { PrivacySettings } from '@/features/settings/queries'

/**
 * Privacy settings.
 *
 * Radio groups rather than selects, because the whole point is that a reader can see all
 * four options and what separates them without opening anything. The descriptions state
 * the consequence rather than the label ("Only people you have accepted" beats "Connections"),
 * since the label means nothing to a first-year on their second day.
 *
 * The two booleans are checkboxes, not switches: they are values submitted with the form.
 * A switch would imply the change happened the moment it was flipped, which is not true
 * here — the change is applied by the database when the form is saved.
 */
export function PrivacyForm({ profile }: { profile: PrivacySettings }) {
  const [state, action] = useActionState(updatePrivacyAction, SETTINGS_IDLE)

  return (
    <form action={action} className="space-y-8">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="Not saved">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'saved' ? <Alert tone="success">{state.message}</Alert> : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Who can see your profile</legend>
        <RadioGroup name="visibility" defaultValue={profile.visibility}>
          <RadioOption
            id="visibility-public"
            value="public"
            label="Anyone"
            description="Visible to signed-out visitors, including your projects and posts marked public."
          />
          <RadioOption
            id="visibility-university"
            value="university"
            label="People at my university"
            description="Only accounts affiliated with the university on your profile."
          />
          <RadioOption
            id="visibility-connections"
            value="connections"
            label="Only people I have accepted"
            description="Connections can see it; nobody else can find you in search."
          />
          <RadioOption
            id="visibility-private"
            value="private"
            label="Only me"
            description="Your profile is not shown to anyone. You can still post and apply."
          />
        </RadioGroup>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Who can message you</legend>
        <RadioGroup name="allow_messages_from" defaultValue={profile.allow_messages_from}>
          <RadioOption id="messages-everyone" value="everyone" label="Anyone on Quad" />
          <RadioOption id="messages-university" value="university" label="People at my university" />
          <RadioOption id="messages-connections" value="connections" label="Only people I have accepted" />
          <RadioOption
            id="messages-nobody"
            value="nobody"
            label="Nobody"
            description="Existing conversations stay readable; no new ones can be started."
          />
        </RadioGroup>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Other</legend>

        <label htmlFor="allow-connection-requests" className="flex items-start gap-3">
          <span className="pt-0.5">
            <Checkbox
              id="allow-connection-requests"
              name="allow_connection_requests"
              defaultChecked={profile.allow_connection_requests}
            />
          </span>
          <span>
            <span className="block text-sm text-ink">Allow connection requests</span>
            <span className="block text-xs text-ink-muted">
              With this off, nobody can send you a request. Existing connections are unaffected.
            </span>
          </span>
        </label>

        <label htmlFor="searchable" className="flex items-start gap-3">
          <span className="pt-0.5">
            <Checkbox id="searchable" name="searchable" defaultChecked={profile.searchable} />
          </span>
          <span>
            <span className="block text-sm text-ink">Appear in search and suggestions</span>
            <span className="block text-xs text-ink-muted">
              With this off, people who already know your username can still open your profile.
            </span>
          </span>
        </label>
      </fieldset>

      <SubmitButton pendingLabel="Saving…">Save privacy settings</SubmitButton>
    </form>
  )
}

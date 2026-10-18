'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { submitBugReportAction } from '@/features/bugs/actions'
import { emptyBugFormState } from '@/features/bugs/form-state'

/**
 * The bug report form.
 *
 * Three fields, and the reason there are only three is PRODUCT.md's rule about
 * controls: each one is stored. There is no severity picker (no column), no
 * category (no column) and no "attach a screenshot" (no storage bucket) — every
 * one of those would be a control that does something and changes nothing.
 *
 * `pageUrl` is filled from `window.location` on mount rather than asked for.
 * Asking a reader to describe where they are is asking them to do the work the
 * browser will do for free, and getting it wrong ("the settings page") makes the
 * one field that makes a report actionable useless. The console warning it
 * replaces is the thing maintainers actually miss.
 */
export function BugReportForm({ signedIn }: { signedIn: boolean }) {
  const [state, send] = useActionState(submitBugReportAction, emptyBugFormState)
  const pageRef = useRef<HTMLInputElement>(null)

  /*
   * Where they are, filled in after mount rather than during render: the server
   * has no idea what URL the browser is on, and rendering a value the server
   * cannot know is a hydration mismatch. Only filled when it is empty, so a
   * reader who typed their own answer keeps it.
   */
  useEffect(() => {
    const field = pageRef.current
    if (field && !field.value) field.value = window.location.href
  }, [])

  if (state.status === 'success') {
    return (
      <Alert tone="success" title="Report received">
        {state.message}
      </Alert>
    )
  }

  return (
    <form action={send} className="space-y-5">
      {state.status === 'error' && !state.fieldErrors ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field
        id="bug-title"
        label="What went wrong, in one line"
        hint="Like a ticket title: the thing that failed, not the feeling."
        error={state.fieldErrors?.title}
        required
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            name="title"
            maxLength={160}
            defaultValue={state.values?.title}
            placeholder="The reply box loses what I typed if I switch tabs"
          />
        )}
      </Field>

      <Field
        id="bug-body"
        label="What you did, what you expected, what happened"
        hint="The steps matter more than the wording. If it happens every time, say so; if it happened once, say that too."
        error={state.fieldErrors?.body}
        required
      >
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            name="body"
            rows={8}
            maxLength={5000}
            defaultValue={state.values?.body}
            placeholder={'1. I opened a project and started writing a reply.\n2. I switched to another tab.\n3. I came back: the reply box is empty.'}
          />
        )}
      </Field>

      {/*
        Filled in by the component below. Left in the DOM deliberately: it is a
        normal form field, it is validated like one (500 characters), and a hidden
        input is a more honest way to submit a value the reader cannot see than an
        undeclared body key would be.
      */}
      <Field
        id="bug-page"
        label="The page you were on"
        hint="Filled in from your browser. Change it if it is wrong — “the settings page on my phone” is a perfectly good answer."
        error={state.fieldErrors?.pageUrl}
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            ref={pageRef}
            name="pageUrl"
            maxLength={500}
            defaultValue={state.values?.pageUrl}
            placeholder="https://…"
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-4">
        <SubmitButton variant="primary" pendingLabel="Sending…" disabled={!signedIn}>
          Send report
        </SubmitButton>
        <p className="text-xs text-ink-muted">
          {signedIn
            ? 'You will see it in the list below as soon as it is sent.'
            : 'Sign in first — reports are stored against an account, so the maintainer can follow up.'}
        </p>
      </div>
    </form>
  )
}

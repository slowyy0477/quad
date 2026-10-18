'use client'

import { useActionState, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert } from '@/components/ui/alert'
import { Select } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { Surface } from '@/components/ui/surface'
import { Textarea } from '@/components/ui/textarea'
import { createPostAction } from '@/features/feed/actions'
import {
  clearDraft,
  getServerSnapshot,
  getSnapshot,
  setDraftBody,
  subscribe,
} from '@/features/feed/draft'
import { emptyPostState } from '@/features/feed/form-state'
import type { AttachOption } from '@/features/feed/queries'

/**
 * The post composer.
 *
 * Four things, and the first three exist because a composer that loses what you
 * typed is the fastest way to lose a contribution:
 *
 * 1. **Autosize with a counter that appears only near the limit.** The autosizing
 *    `Textarea` grows to fit, so a long post is not written through a keyhole, and
 *    it shows `n / 5000` from 80 % rather than a live zero that teaches nobody
 *    anything until it matters.
 * 2. **The draft survives.** It lives in `sessionStorage`, read through
 *    `useSyncExternalStore` (see `features/feed/draft.ts`) rather than copied into
 *    state by an effect. The scope is deliberate: a draft belongs to this tab and
 *    this session, not to the device, and a half-written thought should not
 *    reappear days later on a shared machine. When one is restored the reader is
 *    *told* — a silently repopulated box reads like a bug.
 * 3. **Cmd/Ctrl+Enter submits**, which is what every other place a person writes
 *    text does, and there is a visible button as well so it is never the only way.
 * 4. **An attach picker** for a project or a goal. Only the reader's own projects
 *    (membership is checked by `posts_before_write`) and their own goals
 *    (`posts_goal_anchor`) are offered, because anything else is an action that
 *    cannot succeed.
 *
 * The visibility default stays `university`: a default has more effect on what
 * people share than any explanation beside it, and the safer default is the one
 * where a hastily written post reaches classmates rather than the open web. A post
 * attached to a private goal is clamped to that goal's visibility by trigger, and
 * the composer says so when it happens.
 */
export function PostComposer({
  authorFirstName,
  projects,
  goals,
}: {
  authorFirstName: string
  projects: AttachOption[]
  goals: AttachOption[]
}) {
  const [state, action] = useActionState(createPostAction, emptyPostState)
  const formRef = useRef<HTMLFormElement>(null)

  const draft = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [projectId, setProjectId] = useState('')
  const [goalId, setGoalId] = useState('')

  useEffect(() => {
    // `state` is a fresh object for every action result, so this runs once per
    // submit and only clears the composer on a real success. Both of these act on
    // an external system -- storage and the DOM -- which is what an effect is for.
    if (state.status !== 'success') return
    clearDraft()
    formRef.current?.reset()
  }, [state])

  const selectedGoal = goals.find((goal) => goal.id === goalId)

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      formRef.current?.requestSubmit()
    }
  }

  return (
    <Surface as="section" className="p-4" aria-labelledby="composer-heading">
      <h2 id="composer-heading" className="sr-only">
        Write a post
      </h2>

      <form ref={formRef} action={action} className="space-y-3">
        {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

        <Textarea
          name="body"
          value={draft.body}
          onChange={(event) => setDraftBody(event.target.value)}
          onKeyDown={onKeyDown}
          minRows={3}
          maxLength={5000}
          placeholder={`What are you working on, ${authorFirstName}?`}
          aria-label="Post body"
          aria-invalid={state.fieldErrors?.body ? true : undefined}
          aria-describedby={state.fieldErrors?.body ? 'composer-body-error' : 'composer-shortcut'}
          className="border-transparent bg-transparent px-0 hover:border-transparent focus-visible:border-transparent"
        />

        {state.fieldErrors?.body ? (
          <p id="composer-body-error" role="alert" className="text-xs font-medium text-danger-600">
            {state.fieldErrors.body}
          </p>
        ) : null}

        <p id="composer-shortcut" className="text-xs text-ink-faint">
          Press <kbd className="font-sans">Ctrl</kbd> or <kbd className="font-sans">⌘</kbd> and{' '}
          <kbd className="font-sans">Enter</kbd> to post.
        </p>

        {draft.restored ? (
          <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span className="rounded-sm border border-hairline bg-paper-sunken px-1.5 py-0.5">
              Draft restored
            </span>
            <span>Your unfinished post was kept in this tab.</span>
            <button
              type="button"
              onClick={clearDraft}
              className="rounded text-accent-700 underline underline-offset-2"
            >
              Discard it
            </button>
          </p>
        ) : null}

        <div className="grid gap-3 border-t border-hairline pt-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Attach a project
            <Select
              name="projectId"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value)
                // Mutually exclusive: a post is about one thing, and the TYPE is
                // derived from the attachment on the server.
                if (event.target.value) setGoalId('')
              }}
              className="min-h-9 py-1 text-xs"
            >
              <option value="">Nothing</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Attach a goal
            <Select
              name="goalId"
              value={goalId}
              onChange={(event) => {
                setGoalId(event.target.value)
                if (event.target.value) setProjectId('')
              }}
              className="min-h-9 py-1 text-xs"
            >
              <option value="">Nothing</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.label}
                  {goal.hint ? ` — ${goal.hint}` : ''}
                </option>
              ))}
            </Select>
          </label>

          {state.fieldErrors?.projectId ? (
            <p role="alert" className="text-xs font-medium text-danger-600 sm:col-span-2">
              {state.fieldErrors.projectId}
            </p>
          ) : null}
          {state.fieldErrors?.goalId ? (
            <p role="alert" className="text-xs font-medium text-danger-600 sm:col-span-2">
              {state.fieldErrors.goalId}
            </p>
          ) : null}

          {selectedGoal?.hint ? (
            <p className="text-xs text-ink-faint sm:col-span-2">
              {selectedGoal.label} is private, and a post attached to it is private too — the
              goal&apos;s visibility is the ceiling for the post.
            </p>
          ) : null}

          {projects.length === 0 && goals.length === 0 ? (
            <p className="text-xs text-ink-faint sm:col-span-2">
              You have no projects or goals to attach yet. Create one and its updates can be posted
              here.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Visible to
            <Select name="visibility" defaultValue="university" className="w-auto min-h-8 py-1 text-xs">
              <option value="public">Anyone</option>
              <option value="university">My university</option>
              <option value="connections">My connections</option>
              <option value="private">Only me</option>
            </Select>
          </label>

          <SubmitButton variant="primary" size="sm" pendingLabel="Posting…">
            Post
          </SubmitButton>
        </div>
      </form>
    </Surface>
  )
}

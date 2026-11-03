'use client'

import Link from 'next/link'
import { useActionState, useEffect, useRef, useState, useTransition } from 'react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { addGroupMembersAction, removeGroupMemberAction, setGroupMemberRoleAction } from '@/features/messages/actions'
import { emptyFormState, type FormState } from '@/lib/form-state'
import { FINAL_GROUP_ADMIN_COPY, GROUP_REACHABILITY_COPY } from '../group-contract'
import type { GroupChangeOutcome, GroupManagementPane, GroupMember } from '../types'

export function GroupMembers({ conversationId, group }: { conversationId: string; group: GroupManagementPane }) {
  const admin = group.role === 'admin'
  const [result, setResult] = useState<GroupChangeOutcome | null>(null)
  const summary = useRef<HTMLElement>(null)
  const focused = useRef<HTMLElement | null>(null)

  // Durable role/leave updates can remove or disable the focused control.
  // Do not steal focus from a composer or another control chosen in the meantime.
  useEffect(() => {
    const previous = focused.current
    if (previous && (!previous.isConnected || previous.matches(':disabled')) &&
        (document.activeElement === document.body || document.activeElement === previous)) {
      summary.current?.focus()
    }
  }, [group])

  // Own removal can replace this whole panel with the retained-history notice.
  // A captured heading is used only while this same thread still exists.
  useEffect(() => {
    const heading = summary.current?.closest('section[aria-labelledby="thread-heading"]')
      ?.querySelector<HTMLElement>('#thread-heading')
    return () => {
      const previous = focused.current
      if (heading?.isConnected && previous && !previous.isConnected &&
          document.activeElement === document.body) heading.focus()
    }
  }, [])

  return (
    <div className="border-b border-hairline">
      <details className="px-3 py-2 text-sm"
        onFocusCapture={event => { focused.current = event.target }}
        onBlurCapture={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
            focused.current = null
          }
        }}>
        <summary ref={summary} className="cursor-pointer rounded text-ink-muted hover:text-ink">Members ({group.active_count})</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-ink-muted">
            {admin ? 'You are a group admin. Only active admins can add people or change roles.' : 'Only active group admins can add people or change roles.'}
            {' '}Re-added people retain their old permitted history, never messages from their absence.
          </p>
          {admin && group.admin_count <= 1 ? <p className="text-xs text-ink-muted">{FINAL_GROUP_ADMIN_COPY}</p> : null}
          {group.admin_count === 0 ? (
            <Alert tone="info">No active admin is recorded. Membership management is unavailable; legacy roles are not guessed.</Alert>
          ) : null}
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {group.members.map(member => (
              <GroupMemberRow key={member.profile_id}
                member={member} conversationId={conversationId} admin={admin}
                onResult={setResult}
                finalAdmin={!member.left && member.available && member.role === 'admin' && group.admin_count <= 1} />
            ))}
          </ul>
          {group.has_more ? <p className="text-xs text-ink-muted">Showing 50 recorded members. Use a known handle below to re-add someone not shown.</p> : null}
          {admin ? <AddPeopleForm conversationId={conversationId} onResult={setResult} /> : null}
        </div>
      </details>
      {result ? (
        <p role={result.ok ? 'status' : 'alert'} aria-atomic="true"
          className={`px-3 pb-2 text-xs ${result.ok ? 'text-ink-muted' : 'text-danger-600'}`}>
          {result.message}
        </p>
      ) : null}
    </div>
  )
}

function AddPeopleForm({ conversationId, onResult }: {
  conversationId: string; onResult: (result: GroupChangeOutcome) => void
}) {
  const [state, add, pending] = useActionState(async (previous: FormState, formData: FormData) => {
    const next = await addGroupMembersAction(previous, formData)
    if (next.message) onResult({ ok: next.status === 'success', message: next.message })
    return next
  }, emptyFormState)
  const [handles, setHandles] = useState('')
  return (
    <details className="border-t border-hairline pt-2">
      <summary className="cursor-pointer rounded text-ink-muted hover:text-ink">Add people</summary>
      <form action={add} className="mt-3 space-y-3">
        <input type="hidden" name="conversationId" value={conversationId} />
        <p className="text-xs text-ink-muted">{GROUP_REACHABILITY_COPY}</p>
        <p className="text-xs text-ink-faint">10 handles per request; 20 active and 50 recorded people. Existing larger groups are preserved.</p>
        <Field id={`group-add-${conversationId}`} label="Handles to add" required
          hint="Use a departed person's handle to start a new membership interval."
          error={state.fieldErrors?.handles}>
          {props => <Input {...props} name="handles" value={handles} disabled={pending}
            onChange={event => setHandles(event.target.value)} maxLength={500}
            autoComplete="off" autoCapitalize="none" spellCheck={false} />}
        </Field>
        <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">Add people</SubmitButton>
      </form>
    </details>
  )
}

function GroupMemberRow({ member, conversationId, admin, finalAdmin, onResult }: {
  member: GroupMember; conversationId: string; admin: boolean; finalAdmin: boolean
  onResult: (result: GroupChangeOutcome) => void
}) {
  const name = member.profile?.display_name ?? 'A student'
  const [role, setRole] = useState(member.role)
  const [lastRole, setLastRole] = useState(member.role)
  const [pending, transition] = useTransition()
  const [removeResult, setRemoveResult] = useState<GroupChangeOutcome | null>(null)
  const [requested, setRequested] = useState(false)
  const [, readd] = useActionState(async (previous: FormState, formData: FormData) => {
    const next = await addGroupMembersAction(previous, formData)
    if (next.message) onResult({ ok: next.status === 'success', message: next.message })
    return next
  }, emptyFormState)
  // Refresh the changed member's selector, not another member's unsaved choice.
  if (lastRole !== member.role) {
    setLastRole(member.role)
    setRole(member.role)
  }
  return (
    <li className="space-y-2 rounded border border-hairline p-2">
      <div className="flex flex-wrap items-center gap-2">
        {member.profile ? (
          <Link href={`/u/${member.profile.username}`} className="min-w-0 truncate text-sm text-ink underline-offset-2 hover:underline">{name}</Link>
        ) : <span className="text-sm text-ink-muted">{name}</span>}
        <Badge tone="outline">{member.left ? 'Left' : member.role === 'admin' ? 'Admin' : 'Member'}</Badge>
        {!member.available ? <span className="text-xs text-ink-faint">Unavailable</span> : null}
      </div>
      {admin && !member.left ? (
        <div className="flex flex-wrap items-center gap-2">
          {member.available ? <>
          <label htmlFor={`group-role-${member.profile_id}`} className="sr-only">Role for {name}</label>
          <select id={`group-role-${member.profile_id}`} value={role}
            onChange={event => setRole(event.target.value as 'admin' | 'member')}
            disabled={pending || finalAdmin}
            className="min-h-11 rounded border border-rule bg-paper px-2 text-xs text-ink">
            <option value="member">Member</option><option value="admin">Admin</option>
          </select>
          <Button type="button" variant="secondary" size="sm" disabled={pending || finalAdmin || role === member.role}
            onClick={() => transition(async () => {
              onResult(await setGroupMemberRoleAction(conversationId, member.profile_id, role))
            })}>Save role for {name}</Button>
          </> : null}
          {!finalAdmin ? (
            <Dialog open={requested && removeResult?.ok !== true}
              onOpenChange={open => {
                setRequested(open)
                if (open) setRemoveResult(null)
              }}>
              <DialogTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={pending}>Remove {name}</Button></DialogTrigger>
              <DialogContent title={`Remove ${name} from group?`}
                description="This ends their membership now. Their permitted history remains, but messages sent after removal are not readable.">
                {removeResult && !removeResult.ok ? <Alert tone="danger">{removeResult.message}</Alert> : null}
                <DialogFooter>
                  <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
                  <Button type="button" variant="danger" disabled={pending}
                    onClick={() => transition(async () => {
                      const next = await removeGroupMemberAction(conversationId, member.profile_id)
                      setRemoveResult(next)
                      if (next.ok) onResult(next)
                    })}>Remove {name}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      ) : null}
      {admin && member.left && member.available && member.profile ? (
        <form action={readd} className="space-y-2">
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="handles" value={member.profile.username} />
          <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">Re-add {name}</SubmitButton>
        </form>
      ) : null}
    </li>
  )
}

'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Surface } from '@/components/ui/surface'
import { PasswordInput } from '@/features/auth/components/password-input'
import {
  DELETION_POLICY, DELETE_ACCOUNT_CONFIRMATION, EXPORT_DEFAULT_ROWS,
  EXPORT_EXCLUSIONS, EXPORT_MAX_ROWS, EXPORT_SECTIONS,
} from '../policy'
import type { ExportSection } from '../policy'
import type { AccountSummary, DeletionReceipt } from '../types'
import { LIFECYCLE_ERROR_MESSAGES } from '../types'
import { DeletionReceiptPanel } from './deletion-receipt'

function errorMessage(value: unknown) {
  const code = value && typeof value === 'object' ? (value as { code?: unknown }).code : null
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LIFECYCLE_ERROR_MESSAGES, code)
    ? LIFECYCLE_ERROR_MESSAGES[code as keyof typeof LIFECYCLE_ERROR_MESSAGES]
    : LIFECYCLE_ERROR_MESSAGES.unavailable
}

function Credentials({ prefix, hosted }: { prefix: string; hosted: boolean }) {
  return (
    <div className="space-y-3">
      <label htmlFor={`${prefix}-password`} className="block text-sm font-medium">Current password</label>
      <PasswordInput id={`${prefix}-password`} name="password" required={!hosted} maxLength={1024}
        autoComplete="current-password" aria-describedby={`${prefix}-verification-help`} />
      {hosted ? (
        <>
          <label htmlFor={`${prefix}-totp`} className="block text-sm font-medium">Authenticator code (if enrolled)</label>
          <Input id={`${prefix}-totp`} name="totpCode" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} aria-describedby={`${prefix}-verification-help`} />
        </>
      ) : null}
      <p id={`${prefix}-verification-help`} className="text-xs text-ink-muted">
        {hosted
          ? 'Use your current password. Staff and MFA-enabled accounts also need fresh strong verification. A passwordless account can use its first verified authenticator; email/recovery links alone are not enough. No enrolled factor means passwordless actions must wait for MFA setup.'
          : 'This verifies the signed-in local account again. Passwords are never included in exports or saved in these controls.'}
      </p>
    </div>
  )
}

function clearCredentials(form: HTMLFormElement) {
  for (const name of ['password', 'totpCode']) {
    const input = form.elements.namedItem(name)
    if (input instanceof HTMLInputElement) input.value = ''
  }
}

export function AccountControls({ summary }: { summary: AccountSummary }) {
  const [pending, setPending] = useState<'export' | 'delete' | null>(null)
  const [exportError, setExportError] = useState('')
  const [deletionError, setDeletionError] = useState('')
  const [exported, setExported] = useState(false)
  const [section, setSection] = useState<ExportSection | ''>('')
  const [after, setAfter] = useState('')
  const [continuations, setContinuations] = useState<{ section: ExportSection; cursor: string }[]>([])
  const [accepted, setAccepted] = useState<DeletionReceipt | null>(null)
  const exportForm = useRef<HTMLFormElement>(null)
  const deletionKey = useRef<string | null>(null)
  const blocked = summary.blockers.projects.length > 0 || summary.blockers.moreProjects ||
    summary.blockers.inconsistentOwnerRole || summary.blockers.lastAdministrator ||
    summary.blockers.sharedMedia || summary.blockers.ownedStorageBucket
  const hosted = summary.mode === 'supabase'

  async function exportData(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || accepted) return
    const form = event.currentTarget
    const values = new FormData(form)
    setPending('export')
    setExportError('')
    setExported(false)
    try {
      const response = await fetch('/api/account/export', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: String(values.get('password') ?? ''), totpCode: String(values.get('totpCode') ?? ''),
          section: section || undefined, after: after || undefined, limit: Number(values.get('limit')),
        }),
      })
      const result = await response.json()
      if (!response.ok || result.schema_version !== 1 || !result.sections || typeof result.sections !== 'object') {
        setExportError(errorMessage(result))
        return
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: 'application/json' }))
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = 'bulla-account-export.json'
        link.click()
      } finally { URL.revokeObjectURL(url) }
      setContinuations(Object.entries(result.sections).flatMap(([key, value]) => {
        const page = value as { next_cursor?: unknown }
        return Object.prototype.hasOwnProperty.call(EXPORT_SECTIONS, key) && typeof page?.next_cursor === 'string'
          ? [{ section: key as ExportSection, cursor: page.next_cursor }] : []
      }))
      setExported(true)
    } catch { setExportError(LIFECYCLE_ERROR_MESSAGES.unavailable) }
    finally { clearCredentials(form); setPending(null) }
  }

  async function requestDeletion(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || accepted || blocked) return
    const form = event.currentTarget
    const values = new FormData(form)
    if (values.get('confirmation') !== DELETE_ACCOUNT_CONFIRMATION || values.get('acknowledge') !== 'on') {
      setDeletionError(LIFECYCLE_ERROR_MESSAGES.confirmation_required)
      return
    }
    deletionKey.current ??= crypto.randomUUID()
    setPending('delete')
    setDeletionError('')
    try {
      const response = await fetch('/api/account/deletion', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: String(values.get('password') ?? ''), totpCode: String(values.get('totpCode') ?? ''),
          confirmation: String(values.get('confirmation')), acknowledge: values.get('acknowledge') === 'on',
          idempotencyKey: deletionKey.current,
        }),
      })
      const result = await response.json()
      if (!response.ok || result.ok !== true || !result.value?.id ||
          !['queued', 'processing', 'retry', 'blocked', 'failed', 'completed'].includes(result.value.state) ||
          !['media', 'content', 'auth', 'complete'].includes(result.value.phase)) {
        setDeletionError(errorMessage(result))
        return
      }
      setAccepted({ id: result.value.id, state: result.value.state, phase: result.value.phase })
      form.reset()
    } catch { setDeletionError('The response was interrupted. If a deletion receipt was returned, check it before resubmitting; a lost response does not prove the request failed.') }
    finally { clearCredentials(form); setPending(null) }
  }

  return (
    <div className="space-y-10">
      <noscript><p>JavaScript is required for account downloads and deletion requests. Credentials are never sent in a URL.</p></noscript>
      <section aria-labelledby="account-export-heading">
        <h2 id="account-export-heading" className="text-xl">Export your data</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Download bounded JSON: up to {EXPORT_MAX_ROWS} rows per selected section and 2 MiB per response. All sections downloads their first pages, not an unlimited archive. Next pages require verification again.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-muted">{EXPORT_EXCLUSIONS.map(line => <li key={line}>{line}</li>)}</ul>
        <Surface className="mt-4 p-5">
          <form ref={exportForm} method="post" onSubmit={exportData} aria-busy={pending === 'export'} className="space-y-4">
            <fieldset disabled={pending !== null || accepted !== null} className="space-y-4">
              <legend className="sr-only">Reauthenticated own-data export</legend>
              <Credentials prefix="account-export" hosted={hosted} />
              <label htmlFor="account-export-section" className="block text-sm font-medium">Data section</label>
              <Select id="account-export-section" name="section" value={section}
                onChange={event => { setSection(event.target.value as ExportSection | ''); setAfter('') }}>
                <option value="">All sections: first pages</option>
                {Object.entries(EXPORT_SECTIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </Select>
              <label htmlFor="account-export-limit" className="block text-sm font-medium">Rows per section</label>
              <Input id="account-export-limit" name="limit" type="number" min={1} max={EXPORT_MAX_ROWS} defaultValue={EXPORT_DEFAULT_ROWS} required />
              <label htmlFor="account-export-after" className="block text-sm font-medium">Next-page cursor (optional)</label>
              <Input id="account-export-after" name="after" maxLength={256} value={after}
                onChange={event => setAfter(event.target.value)} disabled={!section} autoComplete="off" spellCheck={false} />
              <Button type="submit" variant="primary">Download own data</Button>
            </fieldset>
            {pending === 'export' ? <p role="status" className="text-sm">Verifying and preparing your export…</p> : null}
            {exportError ? <p role="alert" className="text-sm text-danger-700">{exportError}</p> : null}
            {exported ? <p role="status" className="text-sm">Export downloaded. It covers the selected pages only; media bytes and backups are excluded.</p> : null}
          </form>
          {continuations.length ? (
            <div className="mt-4 space-y-2" aria-label="Export next pages">
              <p className="text-sm text-ink-muted">More own records remain:</p>
              {continuations.map(next => (
                <Button type="button" key={next.section} size="sm" disabled={pending !== null || accepted !== null}
                  onClick={() => {
                    setSection(next.section); setAfter(next.cursor)
                    exportForm.current?.querySelector<HTMLInputElement>('[name="password"]')?.focus()
                  }}>
                  Next page: {EXPORT_SECTIONS[next.section]}
                </Button>
              ))}
            </div>
          ) : null}
        </Surface>
      </section>

      <section aria-labelledby="account-deletion-heading">
        <h2 id="account-deletion-heading" className="text-xl">Delete your account</h2>
        <ul id="account-deletion-policy" className="mt-3 list-disc space-y-2 pl-5 text-sm text-ink-muted">
          {DELETION_POLICY.map(line => <li key={line}>{line}</li>)}
        </ul>
        {hosted ? <p className="mt-3 text-sm text-ink-muted">
          {summary.hostedCleanupEnabled
            ? 'Hosted cleanup is opted in by configuration. This page does not verify that a worker is running or deployed.'
            : 'Hosted cleanup is not enabled. A request can disable access and wait durably, but it will need an operator to enable and run the cleanup worker.'}
        </p> : null}
        {blocked ? (
          <div role="alert" className="mt-4 rounded border border-warning-300 bg-paper-raised p-4 text-sm">
            <p>Deletion is blocked until ownership is resolved. No deletion has been queued.</p>
            {summary.blockers.projects.length ? <ul className="mt-2 list-disc space-y-2 pl-5">
              {summary.blockers.projects.map(project => <li key={project.id}>
                <Link href={`/projects/${encodeURIComponent(project.slug)}`} className="underline underline-offset-2">{project.title}</Link>
                {project.deleted ? ' — soft-deleted; restore or ask an operator to resolve ownership.' : ' — transfer ownership from the project’s member controls.'}
              </li>)}
            </ul> : null}
            {summary.blockers.moreProjects ? <p className="mt-2">Additional shared projects also need review.</p> : null}
            {summary.blockers.inconsistentOwnerRole ? <p className="mt-2">{LIFECYCLE_ERROR_MESSAGES.owner_role_inconsistent}</p> : null}
            {summary.blockers.lastAdministrator ? <p className="mt-2">{LIFECYCLE_ERROR_MESSAGES.last_administrator}</p> : null}
            {summary.blockers.sharedMedia || summary.blockers.ownedStorageBucket ? <p className="mt-2">Shared/unfinished images or a Storage bucket need an ownership review first.</p> : null}
          </div>
        ) : null}
        <Surface className="mt-4 p-5">
          {accepted ? <DeletionReceiptPanel initial={accepted} /> : (
            <form method="post" onSubmit={requestDeletion} aria-busy={pending === 'delete'} className="space-y-4">
              <fieldset disabled={pending !== null || blocked} className="space-y-4">
                <legend className="sr-only">Confirmed reauthenticated account deletion</legend>
                <Credentials prefix="account-delete" hosted={hosted} />
                <label htmlFor="account-delete-confirmation" className="block text-sm font-medium">Type {DELETE_ACCOUNT_CONFIRMATION} exactly</label>
                <Input id="account-delete-confirmation" name="confirmation" required maxLength={40} autoComplete="off" spellCheck={false}
                  aria-describedby="account-deletion-policy" />
                <label className="flex items-start gap-3 text-sm" htmlFor="account-delete-acknowledge">
                  <input id="account-delete-acknowledge" name="acknowledge" type="checkbox" required className="mt-1 size-4 shrink-0" />
                  I understand this policy, that account access is revoked immediately, and that cleanup cannot be undone here.
                </label>
                <Button type="submit" variant="danger">Confirm account deletion</Button>
              </fieldset>
              {pending === 'delete' ? <p role="status" className="text-sm">Verifying and recording your deletion request…</p> : null}
              {deletionError ? <p role="alert" className="text-sm text-danger-700">{deletionError}</p> : null}
            </form>
          )}
        </Surface>
      </section>
    </div>
  )
}

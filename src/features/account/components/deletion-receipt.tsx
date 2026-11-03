'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DeletionReceipt } from '../types'

export function deletionReceiptMessage(receipt: DeletionReceipt): string {
  switch (receipt.state) {
    case 'completed': return 'Account cleanup is complete in this data store. Backup retention and independently held provider data are separate.'
    case 'blocked': return 'Cleanup needs an ownership or media review. Account access remains disabled; an operator must resolve the blocker before retrying.'
    case 'failed': return 'Cleanup needs operator attention after repeated failures. Account access remains disabled; this is not a completed deletion.'
    case 'retry': return 'Cleanup is waiting for a retry. Account access remains disabled; deletion is not complete yet.'
    case 'processing': return 'Cleanup is processing. Account access remains disabled; deletion is not complete yet.'
    default: return 'Your request is durably queued and account access is disabled. Cleanup has not completed yet.'
  }
}

/** Explicit status checks only: no automatic polling, scheduled task or identity lookup. */
export function DeletionReceiptPanel({ initial }: { initial?: DeletionReceipt }) {
  const [receipt, setReceipt] = useState(initial ?? null)
  const [id, setId] = useState(initial?.id ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function check(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/account/deletion/status', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt: id.trim() }),
      })
      const result = await response.json()
      if (!response.ok || result.ok !== true || !result.value?.id ||
          !['queued', 'processing', 'retry', 'blocked', 'failed', 'completed'].includes(result.value.state) ||
          !['media', 'content', 'auth', 'complete'].includes(result.value.phase)) {
        setError('That receipt could not be checked. It may be unavailable, invalid or expired.')
        return
      }
      setReceipt({ id: result.value.id, state: result.value.state, phase: result.value.phase })
    } catch { setError('The receipt service could not be reached. Keep your receipt and try again.') }
    finally { setPending(false) }
  }
  return (
    <section aria-label="Deletion receipt" className="space-y-4">
      {receipt ? <p role="status" className="text-sm text-ink">{deletionReceiptMessage(receipt)}</p> : null}
      <p className="text-sm text-ink-muted">
        Save this random receipt to check cleanup after sign-out. It shows status only, never account details. Completed receipts expire after 30 days.
      </p>
      <Link href="/settings/account/deletion" className="inline-block text-sm underline underline-offset-2">
        Open the receipt checker after sign-out
      </Link>
      <form method="post" onSubmit={check} aria-busy={pending} className="space-y-3">
        <label htmlFor="account-deletion-receipt" className="block text-sm font-medium">Deletion receipt</label>
        <Input id="account-deletion-receipt" name="receipt" required maxLength={36} value={id}
          onChange={event => setId(event.target.value)} disabled={pending} autoComplete="off" spellCheck={false} />
        <Button type="submit" disabled={pending}>{pending ? 'Checking status…' : 'Check cleanup status'}</Button>
        {error ? <p role="alert" className="text-sm text-danger-700">{error}</p> : null}
      </form>
    </section>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { getAccountSummary } from '@/features/account/provider'
import { AccountControls } from '@/features/account/components/account-controls'
import { LIFECYCLE_ERROR_MESSAGES } from '@/features/account/types'
import { getUser } from '@/lib/supabase/server'
import { isDataConfigured } from '@/lib/env'

export const metadata: Metadata = { title: 'Account data and deletion', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

export default async function AccountSettingsPage() {
  if (!isDataConfigured()) return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl">Account data and deletion</h1>
      <Alert tone="warning" title="Account controls unavailable" className="mt-6">The account service is unavailable. <Link href="/help">Get help</Link>.</Alert>
    </div>
  )
  if (!await getUser()) redirect('/login?next=/settings/account')
  let summary
  try { summary = await getAccountSummary() } catch { summary = { ok: false as const, code: 'unavailable' as const } }
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <Link href="/settings" className="text-sm text-accent-700 underline underline-offset-2">Back to settings</Link>
      <h1 className="mt-4 text-3xl">Account data and deletion</h1>
      <p className="mb-8 mt-2 text-sm text-ink-muted">Sensitive actions verify your account again. An export is private; deletion is a durable, explicitly confirmed request.</p>
      {summary.ok ? <AccountControls summary={summary.value} /> : (
        <Alert tone="danger" title="Account controls unavailable">{LIFECYCLE_ERROR_MESSAGES[summary.code]}</Alert>
      )}
    </div>
  )
}

import 'server-only'

import { getUser } from '@/lib/supabase/server'
import { isDataConfigured } from '@/lib/env'
import { isLocalMode, assertNotDeployedInLocalMode } from '@/lib/mode'
import { endSession } from '@/lib/local/session'
import { exportLocalAccount, getLocalAccountBlockers, getLocalDeletionReceipt, requestLocalAccountDeletion, runLocalAccountDeletionJob } from '@/lib/local/account-lifecycle'
import { exportHostedAccount, getHostedAccountBlockers, getHostedDeletionReceipt, requestHostedAccountDeletion } from './hosted'
import type { AccountExport, AccountSummary, DeletionReceipt, ExportOptions, LifecycleResult } from './types'

function available() {
  assertNotDeployedInLocalMode()
  return isDataConfigured()
}

export async function getAccountSummary(): Promise<LifecycleResult<AccountSummary>> {
  if (!available()) return { ok: false, code: 'unavailable' }
  const user = await getUser()
  if (!user) return { ok: false, code: 'signed_out' }
  const local = isLocalMode()
  const blockers = local ? await getLocalAccountBlockers(user.id) : await getHostedAccountBlockers()
  if (!blockers.ok) return blockers
  return { ok: true, value: {
    mode: local ? 'local' : 'supabase',
    blockers: blockers.value,
    hostedCleanupEnabled: !local && process.env.BULLA_ACCOUNT_CLEANUP_ENABLED === '1',
  } }
}

export async function exportOwnAccount(input: { password: string; totpCode?: string } & ExportOptions): Promise<LifecycleResult<AccountExport>> {
  if (!available()) return { ok: false, code: 'unavailable' }
  const options = { section: input.section, after: input.after, limit: input.limit }
  if (!isLocalMode()) return exportHostedAccount(input, options)
  if (input.totpCode) return { ok: false, code: 'provider_assurance_required' }
  const user = await getUser()
  if (!user) return { ok: false, code: 'signed_out' }
  return exportLocalAccount(user.id, input.password, options)
}

export async function deleteOwnAccount(input: {
  password: string; totpCode?: string; confirmation: string; acknowledge: boolean; idempotencyKey: string
}): Promise<LifecycleResult<DeletionReceipt>> {
  if (!available()) return { ok: false, code: 'unavailable' }
  if (!isLocalMode()) return requestHostedAccountDeletion(input)
  if (input.totpCode) return { ok: false, code: 'provider_assurance_required' }
  const user = await getUser()
  if (!user) return { ok: false, code: 'signed_out' }
  const queued = await requestLocalAccountDeletion(user.id, input)
  if (!queued.ok) return queued
  try { await endSession() } catch { /* ALL local session digests are already revoked. */ }
  // Private local cleanup gets one opportunistic attempt AFTER its durable queue
  // commit. Recovery can resume the same job; never fire-and-forget a promise.
  try {
    const finished = await runLocalAccountDeletionJob(queued.value.id)
    return { ok: true, value: finished ?? queued.value }
  } catch {
    return { ok: true, value: queued.value }
  }
}

export async function getAccountDeletionReceipt(id: string): Promise<LifecycleResult<DeletionReceipt>> {
  if (!available()) return { ok: false, code: 'unavailable' }
  const value = isLocalMode() ? await getLocalDeletionReceipt(id) : await getHostedDeletionReceipt(id)
  return value ? { ok: true, value } : { ok: false, code: 'not_found' }
}

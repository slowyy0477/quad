import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { isLocalMode } from '@/lib/mode'
import { PRIVATE_IMAGE_BUCKET, validImageId } from '@/features/uploads/contracts'
import { parseDeletionReceipt } from './hosted'
import type { DeletionReceipt } from './types'

type WorkerCode = 'cleanup_failed' | 'provider_unavailable' | 'media_cleanup_failed' | 'media_ownership_review' | 'shared_media_ownership'
type Admin = ReturnType<typeof createAdminClient>
type Claim = { id: string; subject_id: string; phase: string; lease_token: string }
type Media = { id: string; source_kind: 'private_image' | 'owned_storage'; source_id: string | null; bucket_id: string; object_path: string }
export type HostedCleanupOptions = { maxJobs?: number; jobId?: string }
export type HostedCleanupReport = {
  enabled: boolean
  processed: number
  receipts: DeletionReceipt[]
  error?: 'configuration_unavailable' | 'provider_unavailable'
}

class WorkerFailure extends Error {
  constructor(readonly code: WorkerCode) { super(code) }
}

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

function claimFrom(value: unknown): Claim | null {
  if (!value || typeof value !== 'object') return null
  const claim = value as Claim
  return uuid(claim.id) && uuid(claim.subject_id) && uuid(claim.lease_token) &&
    ['media', 'content', 'auth'].includes(claim.phase) ? claim : null
}

function configuredBuckets(): Set<string> {
  const raw = process.env.BULLA_ACCOUNT_CLEANUP_BUCKETS
  const buckets = (raw ? raw.split(',') : [PRIVATE_IMAGE_BUCKET]).map(value => value.trim())
  if (!buckets.length || buckets.some(bucket => !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(bucket))) {
    throw new WorkerFailure('media_ownership_review')
  }
  return new Set(buckets)
}

function mediaFrom(value: unknown, claim: Claim, buckets: Set<string>): Media[] {
  if (!Array.isArray(value) || value.length > 50) throw new WorkerFailure('media_cleanup_failed')
  return value.map(item => {
    const row = item as Media | null
    if (!row || !uuid(row.id) || typeof row.bucket_id !== 'string' || !buckets.has(row.bucket_id) ||
        typeof row.object_path !== 'string' || row.object_path.length > 1024 ||
        /[\\\u0000-\u001f\u007f]/.test(row.object_path) ||
        row.object_path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new WorkerFailure('media_ownership_review')
    }
    if (row.source_kind === 'private_image') {
      if (!validImageId(row.source_id) || row.bucket_id !== PRIVATE_IMAGE_BUCKET || row.object_path !== `${row.source_id}.webp`) {
        throw new WorkerFailure('media_ownership_review')
      }
    } else if (row.source_kind !== 'owned_storage' || row.object_path.split('/')[0] !== claim.subject_id) {
      throw new WorkerFailure('media_ownership_review')
    }
    return { id: row.id, source_kind: row.source_kind, source_id: row.source_id, bucket_id: row.bucket_id, object_path: row.object_path }
  })
}

async function rpc(admin: Admin, name: string, args: Record<string, unknown> = {}) {
  const response = await admin.rpc(name, args)
  if (response.error) {
    if (response.error.hint === 'media_ownership_review' || response.error.hint === 'shared_media_ownership') {
      throw new WorkerFailure(response.error.hint)
    }
    throw new WorkerFailure('cleanup_failed')
  }
  return response.data as unknown
}

async function publicReceipt(admin: Admin, claim: Claim): Promise<DeletionReceipt> {
  try {
    const response = await admin.rpc('account_deletion_status', { p_receipt: claim.id })
    if (!response.error) {
      const receipt = parseDeletionReceipt(response.data)
      if (receipt) return receipt
    }
  } catch { /* A lost response cannot be relabelled as completed. */ }
  return { id: claim.id, state: 'processing', phase: claim.phase as DeletionReceipt['phase'] }
}

/**
 * Manual/operator entry point only. No route, timer, scheduler, deployment or
 * invocation is installed here. Exact "1" opt-in and non-local mode precede
 * even service-role construction. Tests MUST inject a fake Admin client.
 *
 * One invocation handles at most 3 jobs / 50 media objects per job. Partial
 * progress yields durably without consuming the failure budget. RPC leases
 * fence DB progress; bytes use the Storage API, then Auth admin.deleteUser.
 */
export async function runHostedAccountCleanup(options: HostedCleanupOptions = {}): Promise<HostedCleanupReport> {
  if (process.env.BULLA_ACCOUNT_CLEANUP_ENABLED !== '1' || isLocalMode()) {
    return { enabled: false, processed: 0, receipts: [] }
  }
  const maxJobs = options.maxJobs ?? 1
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 3 || (options.jobId && !uuid(options.jobId))) {
    throw new Error('Invalid bounded account cleanup options')
  }
  let admin: Admin
  try { admin = createAdminClient() } catch {
    return { enabled: true, processed: 0, receipts: [], error: 'configuration_unavailable' }
  }
  const report: HostedCleanupReport = { enabled: true, processed: 0, receipts: [] }
  for (let index = 0; index < maxJobs; index += 1) {
    let raw: unknown
    try { raw = await rpc(admin, 'account_deletion_claim', { p_job: options.jobId ?? null }) } catch {
      report.error = 'provider_unavailable'
      break
    }
    if (raw === null) break
    const claim = claimFrom(raw)
    if (!claim) { report.error = 'provider_unavailable'; break }
    report.processed += 1
    const fence = { p_job: claim.id, p_lease: claim.lease_token }
    try {
      const prepared = await rpc(admin, 'account_deletion_prepare_media', fence) as { ready?: unknown }
      if (prepared?.ready !== true) {
        report.receipts.push(await publicReceipt(admin, claim))
        if (options.jobId) break
        continue
      }
      const media = mediaFrom(await rpc(admin, 'account_deletion_media_batch', fence), claim, configuredBuckets())
      for (const row of media) {
        // The manifest RPC rechecks object identity/ownership. Never use an
        // arbitrary browser path, signed URL, public bucket or SQL byte delete.
        const removed = await admin.storage.from(row.bucket_id).remove([row.object_path])
        if (removed.error) throw new WorkerFailure('media_cleanup_failed')
        // SQL acknowledges only AFTER storage.objects confirms the key absent.
        await rpc(admin, 'account_deletion_mark_media_removed', { ...fence, p_media: row.id })
      }
      const remaining = mediaFrom(await rpc(admin, 'account_deletion_media_batch', fence), claim, configuredBuckets())
      if (remaining.length) {
        await rpc(admin, 'account_deletion_yield', fence)
        report.receipts.push(await publicReceipt(admin, claim))
        if (options.jobId) break
        continue
      }
      const content = await rpc(admin, 'account_deletion_cleanup_content', fence) as { ready?: unknown }
      if (content?.ready !== true) {
        report.receipts.push(await publicReceipt(admin, claim))
        if (options.jobId) break
        continue
      }
      const removedUser = await admin.auth.admin.deleteUser(claim.subject_id, false)
      if (removedUser.error && removedUser.error.status !== 404) throw new WorkerFailure('provider_unavailable')
      const completed = parseDeletionReceipt(await rpc(admin, 'account_deletion_finish', fence))
      if (!completed || completed.state !== 'completed') throw new WorkerFailure('provider_unavailable')
      report.receipts.push(completed)
    } catch (error) {
      const code = error instanceof WorkerFailure ? error.code : 'cleanup_failed'
      try { await rpc(admin, 'account_deletion_fail', { ...fence, p_code: code }) } catch { /* Expired leases recover through the queue. */ }
      report.receipts.push(await publicReceipt(admin, claim))
    }
    if (options.jobId) break
  }
  // Only public receipts/counts, never subjects, paths, hashes, leases or errors.
  return report
}

/** Explicit operator retry; it never overrides a fresh ownership recheck. */
export async function resumeHostedAccountDeletion(jobId: string): Promise<boolean> {
  if (process.env.BULLA_ACCOUNT_CLEANUP_ENABLED !== '1' || isLocalMode() || !uuid(jobId)) return false
  const result = await createAdminClient().rpc('account_deletion_resume', { p_job: jobId })
  return !result.error && result.data === true
}

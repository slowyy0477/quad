import 'server-only'

import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { localMediaRoot } from '@/lib/local/media'
import { mutate, type Tables } from '@/lib/local/db'
import type { LocalAccountDeletionJob } from '@/lib/local/domain-tables'
import { IMAGE_UPLOAD_LIMITS, IMAGE_RULES, imageObjectName, validImageId } from '@/features/uploads/contracts'
import type { PrivateImageRecord } from '@/features/uploads/types'

type MediaIndex = { version: 1; records: PrivateImageRecord[]; budgets: Record<string, unknown>[] }
const MAX_INDEX_BYTES = 2 * 1024 * 1024

function samePath(a: string, b: string) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function checkedDirectory(target: string) {
  const stat = await fs.lstat(/* turbopackIgnore: true */ target)
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !samePath(await fs.realpath(/* turbopackIgnore: true */ target), target)) throw new Error('Unsafe private media directory')
}

async function regularFile(target: string, maxBytes: number) {
  const stat = await fs.lstat(/* turbopackIgnore: true */ target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Unsafe private media file')
}

async function indexAt(root: string): Promise<MediaIndex> {
  const target = path.join(root, 'index.json')
  try {
    await regularFile(target, MAX_INDEX_BYTES)
    const value: unknown = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ target, 'utf8'))
    const index = value as MediaIndex
    if (!index || index.version !== 1 || !Array.isArray(index.records) || !Array.isArray(index.budgets) ||
        index.records.length > IMAGE_UPLOAD_LIMITS.imagesGlobal ||
        new Set(index.records.map(row => row?.id)).size !== index.records.length ||
        index.records.some(row => !row || !validImageId(row.id) ||
          !['avatar', 'project-cover'].includes(row.kind) || !['pending', 'ready', 'retired'].includes(row.state) ||
          typeof row.ownerId !== 'string' || typeof row.actorId !== 'string' ||
          (row.kind === 'avatar' ? row.profileId !== row.ownerId || row.projectId !== null : row.profileId !== null || typeof row.projectId !== 'string'))) {
      throw new Error('Invalid private media index')
    }
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, records: [], budgets: [] }
  }
}

/** Same lock order as uploads: media-index lock, then the local DB lock. */
export async function withLocalAccountMediaSnapshot<T>(
  work: (records: PrivateImageRecord[], root: string | null, index: MediaIndex) => Promise<T>,
): Promise<T> {
  const root = localMediaRoot()
  try { await checkedDirectory(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return work([], null, { version: 1, records: [], budgets: [] })
  }
  const lock = path.join(root, '.index-lock')
  const deadline = Date.now() + 5000
  for (;;) {
    try { await fs.mkdir(/* turbopackIgnore: true */ lock, { mode: 0o700 }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        await checkedDirectory(lock)
      } catch (lockError) {
        // A holder may release after mkdir reported EEXIST but before lstat.
        // Retry only that missing-directory race; unsafe links still fail.
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError
      }
      if (Date.now() >= deadline) throw new Error('Private media store is busy')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    const index = await indexAt(root)
    return await work(index.records, root, index)
  } finally {
    await fs.rmdir(/* turbopackIgnore: true */ lock)
  }
}

export function localMediaOwnershipBlocked(records: PrivateImageRecord[], db: Tables, profileId: string): boolean {
  return records.some(row =>
    (row.actorId === profileId && row.ownerId !== profileId) ||
    (row.ownerId === profileId && row.projectId !== null &&
      !db.projects.some(project => project.id === row.projectId && project.owner_id === profileId)),
  )
}

async function writeIndex(root: string, index: MediaIndex) {
  const target = path.join(root, 'index.json')
  await regularFile(target, MAX_INDEX_BYTES).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  const temp = path.join(root, `.account-index-${randomUUID()}.tmp`)
  const handle = await fs.open(/* turbopackIgnore: true */ temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(index)); await handle.sync() } finally { await handle.close() }
    await fs.rename(/* turbopackIgnore: true */ temp, target)
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function currentClaim(db: Tables, jobId: string, token: string) {
  const job = db.account_deletion_jobs.find(row => row.id === jobId)
  if (!job || job.state !== 'processing' || job.lease_token !== token || !job.user_id || !job.profile_id ||
      !job.lease_expires_at || Date.parse(job.lease_expires_at) <= Date.now()) throw new Error('Stale account cleanup claim')
  return job
}

/** Exact indexed image IDs only. Never enumerate, recursively remove or adopt files. */
async function removeImageFile(root: string, imageId: string, suffix: '.webp' | '.tmp') {
  if (!validImageId(imageId)) throw new Error('Invalid account image manifest')
  const objects = path.join(root, 'objects')
  try { await checkedDirectory(objects) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const target = path.resolve(objects, `${imageId}${suffix}`)
  const relative = path.relative(objects, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Image cleanup target escaped its root')
  try {
    await regularFile(target, IMAGE_RULES['project-cover'].outputBytes)
    await fs.unlink(/* turbopackIgnore: true */ target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * A durable manifest precedes retirement/unlink. A crash after byte removal or
 * index commit is harmless: the exact authorized manifest survives for retry.
 * Never accept a job ID/token from a Client Component or public cleanup route.
 */
export async function cleanupLocalAccountImages(
  jobId: string,
  token: string,
  ownershipBlocker: (db: Tables, job: LocalAccountDeletionJob) => LocalAccountDeletionJob['error_code'],
): Promise<'ready' | 'blocked'> {
  return withLocalAccountMediaSnapshot(async (records, root, index) => {
    function blockIfNeeded(db: Tables, job: LocalAccountDeletionJob) {
      const code = ownershipBlocker(db, job) ??
        (localMediaOwnershipBlocked(records, db, job.profile_id!) ? 'shared_media_ownership' : null)
      if (!code) return false
      job.state = 'blocked'
      job.error_code = code
      job.lease_token = job.lease_expires_at = null
      job.updated_at = new Date().toISOString()
      return true
    }
    const prepared = await mutate(db => {
      const job = currentClaim(db, jobId, token)
      // The media index is locked, and project/account rows are checked in the
      // most recent transaction snapshot before preparing any destructive target.
      if (blockIfNeeded(db, job)) return false
      const selected = records.filter(row => row.ownerId === job.profile_id)
      for (const row of selected) {
        if (!db.account_deletion_media.some(media => media.deletion_job_id === jobId && media.image_id === row.id)) {
          db.account_deletion_media.push({ id: randomUUID(), deletion_job_id: jobId, image_id: row.id, state: 'pending' })
        }
      }
      job.phase = 'media'
      return true
    })
    if (!prepared) return 'blocked'
    // The manifest is already durable. Hold the DB lock while checking current
    // ownership and removing its exact bytes, so membership/transfer mutations
    // cannot race between the last check and unlink. Lock order stays media→DB,
    // matching uploads. A filesystem/commit failure leaves the original manifest
    // available for idempotent recovery, even if an exact file is already absent.
    return mutate(async db => {
      const job = currentClaim(db, jobId, token)
      if (blockIfNeeded(db, job)) return 'blocked' as const
      const selected = records.filter(row => row.ownerId === job.profile_id)
      const pending = db.account_deletion_media.filter(row => row.deletion_job_id === jobId && row.state === 'pending')
      for (const media of pending) {
        const row = records.find(candidate => candidate.id === media.image_id)
        if (row && row.ownerId !== job.profile_id) {
          job.state = 'blocked'
          job.error_code = 'shared_media_ownership'
          job.lease_token = job.lease_expires_at = null
          job.updated_at = new Date().toISOString()
          return 'blocked' as const
        }
      }
      for (const row of selected) row.state = 'retired'
      if (root && selected.length) await writeIndex(root, index)
      for (const media of pending) {
        currentClaim(db, jobId, token)
        // A missing index row is authorized ONLY by this original durable ID.
        // It is never permission to discover additional object names.
        if (root) {
          imageObjectName(media.image_id)
          await removeImageFile(root, media.image_id, '.webp')
          await removeImageFile(root, media.image_id, '.tmp')
          index.records = index.records.filter(candidate => candidate.id !== media.image_id)
          await writeIndex(root, index)
        }
        media.state = 'removed'
      }
      if (root) {
        index.budgets = index.budgets.filter(row => row.subject !== job.profile_id)
        await writeIndex(root, index)
      }
      currentClaim(db, jobId, token).phase = 'content'
      return 'ready' as const
    })
  })
}

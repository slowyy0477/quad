import 'server-only'

import { createHash } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hasServiceRoleKey } from '@/lib/env'
import {
  PRIVATE_IMAGE_BUCKET, IMAGE_RULES, imageObjectName, imageUrl, parseUploadedImage, validImageId,
  type ImageUploadTarget, type UploadedImage,
} from './contracts'
import {
  ImageUploadError, uploadDenied, uploadQuotaExceeded, uploadRateLimited, uploadsUnavailable,
} from './errors'
import type { ImageBackend, ImageReservation } from './types'

type UserClient = Awaited<ReturnType<typeof createClient>>
type AdminClient = ReturnType<typeof createAdminClient>
const validUuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)

function usableOwnProfile(value: unknown, actorId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  if (profile.id !== actorId) return false
  if (profile.status === 'active') return true
  return profile.status === 'suspended' && typeof profile.suspended_until === 'string' &&
    Number.isFinite(Date.parse(profile.suspended_until)) && Date.parse(profile.suspended_until) <= Date.now()
}

function hostedWriteCapability(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const capability = value as Record<string, unknown>
  return capability.version === 1 && capability.enabled === true
}

function reservationFrom(value: unknown, actorId: string, target: ImageUploadTarget): ImageReservation {
  if (!value || typeof value !== 'object') throw uploadsUnavailable()
  const row = value as ImageReservation & { error?: string }
  if (row.error === 'upload_denied') throw uploadDenied()
  if (row.error === 'upload_rate_limited') throw uploadRateLimited()
  if (row.error === 'image_quota_exceeded') throw uploadQuotaExceeded()
  if (!validImageId(row.id) || row.actorId !== actorId || !validUuid(row.ownerId) ||
      row.kind !== target.kind || !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= Date.now() ||
      (target.kind === 'avatar'
        ? row.profileId !== actorId || row.ownerId !== actorId || row.projectId !== null
        : row.profileId !== null || row.projectId !== target.projectId)) throw uploadsUnavailable()
  return row
}

export function imageFromDatabase(value: unknown): UploadedImage | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!validImageId(row.id) || row.state !== 'ready') return null
  return parseUploadedImage({
    id: row.id, url: imageUrl(row.id), kind: row.kind, bytes: row.byte_count,
    width: row.width, height: row.height, contentType: 'image/webp',
  })
}

const imageColumns = 'id,kind,state,byte_count,width,height,sha256'

/** Retire first, remove bytes via Storage API, then forget ONLY retired metadata. */
async function removeRetired(admin: AdminClient, id: string, expiredOnly: boolean): Promise<void> {
  if (!validImageId(id)) throw uploadsUnavailable()
  const retirement = await admin.rpc('bulla_retire_image', { p_id: id, p_expired_only: expiredOnly })
  if (retirement.error || retirement.data !== true) return
  const deletion = await admin.storage.from(PRIVATE_IMAGE_BUCKET).remove([imageObjectName(id)])
  if (!deletion.error) await admin.rpc('bulla_forget_image', { p_id: id })
}

async function cleanupBounded(admin: AdminClient): Promise<void> {
  const candidates = await admin.from('private_images').select('id')
    .or(`state.eq.retired,and(state.eq.pending,expires_at.lte.${new Date().toISOString()})`)
    .limit(20)
  if (candidates.error || !Array.isArray(candidates.data)) throw uploadsUnavailable()
  for (const row of candidates.data) {
    if (!validImageId(row.id)) throw uploadsUnavailable()
    try { await removeRetired(admin, row.id, true) } catch { /* Quotas retain failed cleanup. */ }
  }
}

/** 0032 currently disables hosted writes until exact-object recovery is proven.
 * Missing/malformed readiness is also disabled; there is no env/test-mode opt-in.
 * Service role is necessary only for guarded metadata RPCs and normalized writes.
 * Reads NEVER use it: the user's/anonymous client's RLS remains authoritative.
 */
export async function createSupabaseImageBackend(write: boolean): Promise<ImageBackend> {
  if (write && !hasServiceRoleKey()) throw uploadsUnavailable()
  const client: UserClient = await createClient()
  let actorId: string | null = null
  let admin: AdminClient | null = null
  if (write) {
    const auth = await client.auth.getUser()
    if (auth.error || !auth.data.user) {
      throw new ImageUploadError(401, 'sign_in_required', 'Sign in to upload an image.')
    }
    actorId = auth.data.user.id
    const profile = await client.from('profiles').select('id,status,suspended_until')
      .eq('id', actorId).is('deleted_at', null).maybeSingle()
    if (profile.error) throw uploadsUnavailable()
    if (!usableOwnProfile(profile.data, actorId)) throw uploadDenied()
    admin = createAdminClient()
    // This read-only service RPC returns enabled:false in 0032. Do not start
    // even ordinary retired cleanup before readiness: bare-path deletion cannot
    // safely reconcile an object replaced after a separate metadata check.
    const readiness = await admin.rpc('bulla_image_upload_readiness')
    if (readiness.error || !hostedWriteCapability(readiness.data)) {
      throw new ImageUploadError(
        503, 'hosted_image_uploads_disabled',
        'Hosted image uploads are disabled pending storage recovery verification.',
      )
    }
    // Do not silently fall back to a public/raw bucket or create one at runtime.
    const bucket = await admin.storage.getBucket(PRIVATE_IMAGE_BUCKET)
    if (bucket.error || !bucket.data || bucket.data.public !== false ||
        Number(bucket.data.file_size_limit) !== IMAGE_RULES['project-cover'].outputBytes ||
        bucket.data.allowed_mime_types?.length !== 1 || bucket.data.allowed_mime_types[0] !== 'image/webp') {
      throw uploadsUnavailable()
    }
  }
  const collisions = new Set<string>()

  const writable = () => {
    if (!actorId || !admin) throw uploadsUnavailable()
    return { actorId, admin }
  }
  return {
    async reserve(target) {
      const trusted = writable()
      if (target.kind === 'project-cover' && !validUuid(target.projectId)) throw uploadDenied()
      await cleanupBounded(trusted.admin)
      const result = await trusted.admin.rpc('bulla_reserve_image', {
        p_actor: trusted.actorId, p_kind: target.kind,
        p_project: target.kind === 'project-cover' ? target.projectId : null,
      })
      if (result.error) throw uploadsUnavailable()
      return reservationFrom(result.data, trusted.actorId, target)
    },
    async publish(reservation, image) {
      const trusted = writable()
      if (reservation.actorId !== trusted.actorId ||
          !parseUploadedImage({ id: reservation.id, url: imageUrl(reservation.id), kind: reservation.kind, ...image }) ||
          image.data.length !== image.bytes || createHash('sha256').update(image.data).digest('hex') !== image.sha256) throw uploadDenied()
      const result = await trusted.admin.storage.from(PRIVATE_IMAGE_BUCKET).upload(
        imageObjectName(reservation.id), image.data,
        { contentType: 'image/webp', upsert: false, cacheControl: '0' },
      )
      if (result.error) {
        if (result.error.statusCode === '409' || /already exists|duplicate/i.test(result.error.message)) collisions.add(reservation.id)
        throw uploadsUnavailable()
      }
    },
    async commit(reservation, image) {
      const trusted = writable()
      const result = await trusted.admin.rpc('bulla_commit_image', {
        p_id: reservation.id, p_actor: trusted.actorId, p_sha256: image.sha256,
        p_bytes: image.bytes, p_width: image.width, p_height: image.height,
      })
      if (result.error) throw uploadsUnavailable()
      if (result.data?.error === 'upload_denied') throw uploadDenied()
      const saved = parseUploadedImage(result.data)
      if (!saved || saved.id !== reservation.id || saved.kind !== reservation.kind ||
          saved.bytes !== image.bytes || saved.width !== image.width || saved.height !== image.height) throw uploadsUnavailable()
      // A cleanup outage must not report an already-committed upload as failure.
      try { await cleanupBounded(trusted.admin) } catch { /* Later guarded requests retry. */ }
      return saved
    },
    async rollback(reservation) {
      const trusted = writable()
      if (reservation.actorId !== trusted.actorId) throw uploadDenied()
      if (collisions.has(reservation.id)) {
        // Preserve a pre-existing object after an exclusive-upload collision.
        const retired = await trusted.admin.rpc('bulla_retire_image', { p_id: reservation.id, p_expired_only: false })
        if (!retired.error && retired.data === true) await trusted.admin.rpc('bulla_forget_image', { p_id: reservation.id })
        return
      }
      await removeRetired(trusted.admin, reservation.id, false)
    },
    async current(target) {
      const auth = await client.auth.getUser()
      if (auth.error || !auth.data.user) throw new ImageUploadError(401, 'sign_in_required', 'Sign in to manage an image.')
      let query = client.from('private_images').select(imageColumns).eq('kind', target.kind).eq('state', 'ready')
      if (target.kind === 'avatar') query = query.eq('profile_id', auth.data.user.id)
      else {
        if (!validUuid(target.projectId)) throw uploadDenied()
        const project = await client.from('projects').select('id,owner_id,deleted_at,moderation_status')
          .eq('id', target.projectId).is('deleted_at', null).eq('moderation_status', 'active').maybeSingle()
        if (project.error) throw uploadsUnavailable()
        if (!project.data) throw uploadDenied()
        if (project.data.owner_id !== auth.data.user.id) {
          const member = await client.from('project_members').select('role')
            .eq('project_id', target.projectId).eq('profile_id', auth.data.user.id).eq('role', 'maintainer').maybeSingle()
          if (member.error) throw uploadsUnavailable()
          if (!member.data) throw uploadDenied()
        }
        query = query.eq('project_id', target.projectId)
      }
      const result = await query.maybeSingle()
      if (result.error) throw uploadsUnavailable()
      if (!result.data) return null
      const image = imageFromDatabase(result.data)
      if (!image) throw uploadsUnavailable()
      return image
    },
    async read(id) {
      if (!validImageId(id)) return null
      const record = await client.from('private_images').select(imageColumns).eq('id', id).eq('state', 'ready').maybeSingle()
      if (record.error) throw uploadsUnavailable()
      if (!record.data) return null
      const image = imageFromDatabase(record.data)
      if (!image || !/^[a-f0-9]{64}$/.test(record.data.sha256 ?? '')) throw uploadsUnavailable()
      const download = await client.storage.from(PRIVATE_IMAGE_BUCKET).download(imageObjectName(id))
      if (download.error) {
        if (['400', '401', '403', '404'].includes(String(download.error.statusCode))) return null
        throw uploadsUnavailable()
      }
      if (!download.data || download.data.size !== image.bytes || download.data.type !== 'image/webp') throw uploadsUnavailable()
      const data = Buffer.from(await download.data.arrayBuffer())
      if (createHash('sha256').update(data).digest('hex') !== record.data.sha256) throw uploadsUnavailable()
      // Replacement/privacy changes during transfer must not deliver a stale grant.
      const fresh = await client.from('private_images').select('id').eq('id', id).eq('state', 'ready')
        .eq('sha256', record.data.sha256).maybeSingle()
      if (fresh.error) throw uploadsUnavailable()
      return fresh.data ? { image, data } : null
    },
  }
}

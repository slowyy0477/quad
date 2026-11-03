import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', async () => {
  const context = await import('../helpers/image-request-cookies')
  return { cookies: context.imageRequestCookies, headers: context.imageRequestHeaders }
})

import { createImageUploadFixture } from '../helpers/image-upload-fixture'
import { runWithImageRequest } from '../helpers/image-request-cookies'
import { POST as rawAvatarPost } from '../../src/app/api/uploads/avatar/route'
import { POST as rawCoverPost } from '../../src/app/api/uploads/projects/[projectId]/cover/route'
import { GET as rawImageGet } from '../../src/app/api/images/[id]/route'
import { cleanupLocalAccountImages, withLocalAccountMediaSnapshot } from '../../src/features/account/local-media'
import { localDeletionBlockers } from '../../src/lib/local/account-lifecycle'
import { ACCOUNT_POLICY_VERSION } from '../../src/features/account/policy'
import { createLocalImageBackend } from '../../src/lib/local/media'
import { normalizeImage } from '../../src/features/uploads/normalize'
import { imageObjectName } from '../../src/features/uploads/contracts'
import type { PrivateImageRecord } from '../../src/features/uploads/types'

let fixture: Awaited<ReturnType<typeof createImageUploadFixture>>
let png: Uint8Array<ArrayBuffer>

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real provider calls in image lifecycle tests'))
  fixture = await createImageUploadFixture()
  png = new Uint8Array(await sharp({ create: { width: 70, height: 50, channels: 3, background: '#527b49' } }).png().toBuffer())
})

afterEach(async () => {
  vi.restoreAllMocks()
  fixture?.db.resetLocalCache()
  vi.unstubAllEnvs()
  await fixture?.cleanup()
})

const objectPath = (id: string) => path.join(fixture.mediaRoot, 'objects', imageObjectName(id))
const imageContext = (id: string) => ({ params: Promise.resolve({ id }) })
const avatarPost = (request: Request) => runWithImageRequest(request, () => rawAvatarPost(request))
const coverPost = (...args: Parameters<typeof rawCoverPost>) => runWithImageRequest(args[0], () => rawCoverPost(...args))
const imageGet = (...args: Parameters<typeof rawImageGet>) => runWithImageRequest(args[0], () => rawImageGet(...args))
const index = async (): Promise<{ records: PrivateImageRecord[] }> =>
  JSON.parse(await fs.readFile(path.join(fixture.mediaRoot, 'index.json'), 'utf8'))

function cleanupImages(jobId: string, token: string) {
  // Use the same real account/project blocker predicate as the production
  // worker. A test must not accidentally omit the required ownership check.
  return cleanupLocalAccountImages(jobId, token, (db, job) => {
    const blockers = localDeletionBlockers(db, job.user_id!, job.profile_id!)
    if (blockers.projects.length || blockers.moreProjects) return 'ownership_transfer_required'
    if (blockers.inconsistentOwnerRole) return 'owner_role_inconsistent'
    return blockers.lastAdministrator ? 'last_administrator' : null
  })
}

async function avatar(actor = fixture.owner) {
  const response = await avatarPost(fixture.request(actor, png))
  expect(response.status).toBe(201)
  return (await response.json()).image as { id: string; url: string }
}

/** Synthetic already-authorized durable claim precondition, NOT deletion auth proof. */
async function seedProcessingClaim(actor = fixture.owner, expired = false) {
  const id = randomUUID()
  const token = randomUUID()
  const now = new Date().toISOString()
  await fixture.db.mutate(db => {
    // A normal owner deletion would first have to resolve these collaborators.
    if (actor === fixture.owner) db.project_members = db.project_members.filter(member =>
      member.project_id !== fixture.project.id || member.profile_id === fixture.owner.profileId)
    db.users.find(user => user.id === actor.userId)!.disabled_at = now
    db.sessions = db.sessions.filter(session => session.user_id !== actor.userId)
    db.account_deletion_jobs.push({
      id, user_id: actor.userId, profile_id: actor.profileId, idempotency_key: randomUUID(),
      policy_version: ACCOUNT_POLICY_VERSION, state: 'processing', phase: 'media', attempts: 1,
      created_at: now, updated_at: now, next_attempt_at: now,
      lease_expires_at: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString(),
      lease_token: token, error_code: null, completed_at: null,
    })
  })
  return { id, token }
}

describe('actual local image/lifecycle helper interaction (synthetic D-drive only)', () => {
  it('removes exact indexed images, persists acknowledgements and preserves unknown files', async () => {
    const image = await avatar()
    const unknown = path.join(fixture.mediaRoot, 'objects', 'synthetic-unknown.txt')
    await fs.writeFile(unknown, 'SYNTHETIC_PRESERVE_UNKNOWN')
    const claim = await seedProcessingClaim()
    expect(await cleanupImages(claim.id, claim.token)).toBe('ready')
    expect((await index()).records).toHaveLength(0)
    await expect(fs.stat(objectPath(image.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(unknown, 'utf8')).toBe('SYNTHETIC_PRESERVE_UNKNOWN')
    const snapshot = await fixture.db.readStore()
    expect(snapshot.account_deletion_media).toMatchObject([{ deletion_job_id: claim.id, image_id: image.id, state: 'removed' }])
    expect(snapshot.account_deletion_jobs.find(job => job.id === claim.id)?.phase).toBe('content')
    expect((await imageGet(fixture.request(null), imageContext(image.id))).status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('retains a surviving project cover and blocks a deleting uploader who is not its owner', async () => {
    const response = await coverPost(fixture.request(fixture.maintainer, png),
      { params: Promise.resolve({ projectId: fixture.project.id }) })
    expect(response.status).toBe(201)
    const image = (await response.json()).image as { id: string }
    const before = await fs.readFile(objectPath(image.id))
    const claim = await seedProcessingClaim(fixture.maintainer)
    expect(await cleanupImages(claim.id, claim.token)).toBe('blocked')
    expect(await fs.readFile(objectPath(image.id))).toEqual(before)
    expect((await index()).records).toMatchObject([{ id: image.id, state: 'ready', ownerId: fixture.owner.profileId }])
    expect((await imageGet(fixture.request(fixture.owner), imageContext(image.id))).status).toBe(200)
  })

  it('retires before a failed unlink and safely retries from the durable original manifest', async () => {
    const image = await avatar()
    const claim = await seedProcessingClaim()
    const unlink = fs.unlink.bind(fs)
    const fail = vi.spyOn(fs, 'unlink').mockImplementation(async target => {
      if (String(target) === objectPath(image.id)) throw new Error('Synthetic media removal interruption')
      return unlink(target)
    })
    await expect(cleanupImages(claim.id, claim.token)).rejects.toThrow('Synthetic media removal interruption')
    expect((await index()).records).toMatchObject([{ id: image.id, state: 'retired' }])
    expect((await fixture.db.readStore()).account_deletion_media).toMatchObject([{ image_id: image.id, state: 'pending' }])
    expect((await imageGet(fixture.request(null), imageContext(image.id))).status).toBe(404)
    fail.mockRestore()
    expect(await cleanupImages(claim.id, claim.token)).toBe('ready')
    await expect(fs.stat(objectPath(image.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fixture.db.readStore()).account_deletion_media).toMatchObject([{ image_id: image.id, state: 'removed' }])
  })

  it('recovers when another guarded upload cleans a retired object before account cleanup resumes', async () => {
    const image = await avatar()
    const claim = await seedProcessingClaim()
    const unlink = fs.unlink.bind(fs)
    const fail = vi.spyOn(fs, 'unlink').mockImplementation(async target => {
      if (String(target) === objectPath(image.id)) throw new Error('Synthetic cleanup yield')
      return unlink(target)
    })
    await expect(cleanupImages(claim.id, claim.token)).rejects.toThrow('Synthetic cleanup yield')
    fail.mockRestore()
    const survivor = await avatar(fixture.outsider)
    expect((await index()).records.map(row => row.id)).toEqual([survivor.id])
    expect((await fixture.db.readStore()).account_deletion_media).toMatchObject([{ image_id: image.id, state: 'pending' }])
    expect(await cleanupImages(claim.id, claim.token)).toBe('ready')
    expect((await index()).records.map(row => row.id)).toEqual([survivor.id])
    expect((await imageGet(fixture.request(fixture.outsider), imageContext(survivor.id))).status).toBe(200)
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toEqual([imageObjectName(survivor.id)])
  })

  it('prevents a previously reserved local upload from publishing after account cleanup', async () => {
    const backend = createLocalImageBackend(fixture.request(fixture.owner, png))
    const reservation = await backend.reserve({ kind: 'avatar' })
    const normalized = await normalizeImage(Buffer.from(png), 'avatar', 'image/png')
    const claim = await seedProcessingClaim()
    expect(await cleanupImages(claim.id, claim.token)).toBe('ready')
    await expect(backend.publish(reservation, normalized)).rejects.toMatchObject({ status: 403 })
    await backend.rollback(reservation)
    expect((await index()).records).toHaveLength(0)
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toHaveLength(0)
  })

  it('rejects an expired local cleanup claim before unlinking or changing image metadata', async () => {
    const image = await avatar()
    const claim = await seedProcessingClaim(fixture.owner, true)
    const before = await fs.readFile(path.join(fixture.mediaRoot, 'index.json'), 'utf8')
    const unlink = vi.spyOn(fs, 'unlink')
    await expect(cleanupImages(claim.id, claim.token)).rejects.toThrow('Stale account cleanup claim')
    expect(unlink).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(fixture.mediaRoot, 'index.json'), 'utf8')).toBe(before)
    expect((await fs.stat(objectPath(image.id))).size).toBeGreaterThan(0)
  })

  it('retries a holder releasing between EEXIST and lstat without adopting an unsafe lock', async () => {
    const image = await avatar()
    const lock = path.join(fixture.mediaRoot, '.index-lock')
    const mkdir = fs.mkdir.bind(fs)
    const lstat = fs.lstat.bind(fs)
    let contended = false
    let released = false
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      if (String(args[0]) === lock && !contended) {
        contended = true
        throw Object.assign(new Error('Synthetic existing lock'), { code: 'EEXIST' })
      }
      return mkdir(...args)
    })
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === lock && contended && !released) {
        released = true
        throw Object.assign(new Error('Synthetic holder already released'), { code: 'ENOENT' })
      }
      return lstat(...args)
    })
    expect(await withLocalAccountMediaSnapshot(async records => records.map(row => row.id))).toEqual([image.id])
    expect(contended && released).toBe(true)
    expect((await fs.stat(objectPath(image.id))).size).toBeGreaterThan(0)
  })
})

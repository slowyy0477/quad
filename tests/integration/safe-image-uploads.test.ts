import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', async () => {
  const context = await import('../helpers/image-request-cookies')
  return { cookies: context.imageRequestCookies, headers: context.imageRequestHeaders }
})

import { createImageUploadFixture } from '../helpers/image-upload-fixture'
import { runWithImageRequest } from '../helpers/image-request-cookies'
import { POST as rawAvatarPost, GET as rawAvatarState } from '../../src/app/api/uploads/avatar/route'
import { POST as rawCoverPost } from '../../src/app/api/uploads/projects/[projectId]/cover/route'
import { GET as rawImageGet, HEAD as rawImageHead } from '../../src/app/api/images/[id]/route'
import { createLocalImageBackend, localMediaRoot, readLocalProjectCover } from '../../src/lib/local/media'
import { normalizeImage } from '../../src/features/uploads/normalize'
import { IMAGE_RULES, imageObjectName, imageUrl } from '../../src/features/uploads/contracts'

let fixture: Awaited<ReturnType<typeof createImageUploadFixture>>
let png: Uint8Array<ArrayBuffer>

beforeEach(async () => {
  fixture = await createImageUploadFixture()
  png = new Uint8Array(await sharp({ create: { width: 90, height: 60, channels: 3, background: '#366644' } }).png().toBuffer())
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Tests must never contact a real provider'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  fixture?.db.resetLocalCache()
  vi.unstubAllEnvs()
  await fixture?.cleanup()
})

const coverContext = () => ({ params: Promise.resolve({ projectId: fixture.project.id }) })
const imageContext = (id: string) => ({ params: Promise.resolve({ id }) })
const avatarPost = (request: Request) => runWithImageRequest(request, () => rawAvatarPost(request))
const avatarState = (request: Request) => runWithImageRequest(request, () => rawAvatarState(request))
const coverPost = (...args: Parameters<typeof rawCoverPost>) => runWithImageRequest(args[0], () => rawCoverPost(...args))
const imageGet = (...args: Parameters<typeof rawImageGet>) => runWithImageRequest(args[0], () => rawImageGet(...args))
const imageHead = (...args: Parameters<typeof rawImageHead>) => runWithImageRequest(args[0], () => rawImageHead(...args))
const index = async () => JSON.parse(await fs.readFile(path.join(fixture.mediaRoot, 'index.json'), 'utf8'))
async function uploadAvatar(actor = fixture.owner) {
  const response = await avatarPost(fixture.request(actor, png))
  expect(response.status).toBe(201)
  return (await response.json()).image as { id: string; url: string; kind: string; bytes: number }
}

describe('real local image routes with isolated synthetic D-drive data', () => {
  it('requires the actual synthetic Request cookie for protected snapshot writes and rejects revocation', async () => {
    const title = (await fixture.db.readStore()).projects[0].title
    const change = (db: Awaited<ReturnType<typeof fixture.db.readStore>>) => { db.projects[0].title = 'Synthetic cookie-authorized title' }
    await expect(fixture.db.mutate(change)).rejects.toThrow('requires a verified session user')
    await fixture.mutateAs(fixture.owner, change)
    const committed = await fixture.db.readStore()
    expect(committed.projects[0].title).toBe('Synthetic cookie-authorized title')
    expect(committed.mutation_limit_windows).toMatchObject([{ bucket: 'project:write', subject: fixture.owner.userId }])
    expect(title).not.toBe(committed.projects[0].title)
    await fixture.db.mutate(db => { db.sessions = db.sessions.filter(session => session.user_id !== fixture.owner.userId) })
    await expect(fixture.mutateAs(fixture.owner, db => { db.projects[0].title = 'Synthetic revoked-cookie attempt' }))
      .rejects.toThrow('requires a verified session user')
    expect((await fixture.db.readStore()).projects[0].title).toBe(committed.projects[0].title)
  })

  it('persists an own avatar, strips/normalizes bytes and returns an authorized private proxy', async () => {
    const before = await fixture.db.readStore()
    const image = await uploadAvatar()
    const after = await fixture.db.readStore()
    expect(after.profiles.find(row => row.id === fixture.owner.profileId)?.avatar_url).toBe(image.url)
    expect(after.profiles.filter(row => row.id !== fixture.owner.profileId)).toEqual(before.profiles.filter(row => row.id !== fixture.owner.profileId))
    expect(after.users).toEqual(before.users)
    expect(after.projects).toEqual(before.projects)
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toEqual([imageObjectName(image.id)])
    const served = await imageGet(fixture.request(null), imageContext(image.id))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/webp')
    expect(served.headers.get('cache-control')).toContain('private, no-store')
    expect(served.headers.get('vary')).toContain('Cookie')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    const bytes = Buffer.from(await served.arrayBuffer())
    expect((await sharp(bytes).metadata()).format).toBe('webp')
    expect(bytes).not.toEqual(Buffer.from(png))
    const state = await avatarState(fixture.request(fixture.owner))
    expect((await state.json()).image.id).toBe(image.id)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('requires a verified session and never creates media files on an unauthorized upload', async () => {
    for (const cookie of ['', 'quad_local_session=forged', `quad_local_session=${fixture.owner.token}; quad_local_session=${fixture.outsider.token}`]) {
      const response = await avatarPost(fixture.request(null, png, { cookie }))
      expect(response.status).toBe(401)
    }
    await expect(fs.stat(fixture.mediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses cross-origin uploads, MIME lies and huge declared lengths before file creation', async () => {
    expect((await avatarPost(fixture.request(fixture.owner, png, { origin: 'https://attacker.example' }))).status).toBe(403)
    expect((await avatarPost(fixture.request(fixture.owner, png, { 'content-type': 'image/svg+xml' }))).status).toBe(415)
    expect((await avatarPost(fixture.request(fixture.owner, png, { 'content-length': '999999999' }))).status).toBe(413)
    await expect(fs.stat(fixture.mediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores forged owner/profile headers and cannot reassociate an image through a public profile', async () => {
    await fixture.db.mutate(db => { db.profiles.find(row => row.id === fixture.owner.profileId)!.visibility = 'private' })
    const image = await uploadAvatar()
    await fixture.db.mutate(db => { db.profiles.find(row => row.id === fixture.outsider.profileId)!.avatar_url = image.url })
    expect((await imageGet(fixture.request(fixture.outsider), imageContext(image.id))).status).toBe(404)
    const response = await avatarPost(fixture.request(fixture.outsider, png, { 'x-owner-id': fixture.owner.profileId, 'x-profile-id': fixture.owner.profileId }))
    expect(response.status).toBe(201)
    expect((await fixture.db.readStore()).profiles.find(row => row.id === fixture.owner.profileId)?.avatar_url).toBe(image.url)
  })

  it('authorizes project owner/maintainer but refuses members, outsiders and traversal', async () => {
    for (const actor of [fixture.member, fixture.outsider]) {
      expect((await coverPost(fixture.request(actor, png), coverContext())).status).toBe(403)
    }
    expect((await coverPost(fixture.request(fixture.owner, png), { params: Promise.resolve({ projectId: '../../private' }) })).status).toBe(403)
    const before = await fs.readFile(fixture.dataPath, 'utf8')
    const response = await coverPost(fixture.request(fixture.maintainer, png), coverContext())
    expect(response.status).toBe(201)
    const image = (await response.json()).image
    // Local projects have NO cover column: only the runtime-owned media index changes.
    expect(await fs.readFile(fixture.dataPath, 'utf8')).toBe(before)
    expect(await readLocalProjectCover(fixture.project.id, fixture.maintainer.userId)).toHaveProperty('id', image.id)
    expect(await readLocalProjectCover(fixture.project.id, fixture.outsider.userId)).toBeNull()
    for (const actor of [fixture.owner, fixture.maintainer, fixture.member]) {
      expect((await imageGet(fixture.request(actor), imageContext(image.id))).status).toBe(200)
    }
    expect((await imageGet(fixture.request(fixture.outsider), imageContext(image.id))).status).toBe(404)
    expect((await imageGet(fixture.request(null), imageContext(image.id))).status).toBe(404)
  })

  it('rechecks privacy, blocks, suspension and deletion on every image request, including HEAD', async () => {
    const image = await uploadAvatar()
    const head = await imageHead(fixture.request(fixture.owner), imageContext(image.id))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(String(image.bytes))
    await fixture.db.mutate(db => { db.profiles.find(row => row.id === fixture.owner.profileId)!.visibility = 'private' })
    const deniedHead = await imageHead(fixture.request(null), imageContext(image.id))
    expect(deniedHead.status).toBe(404)
    expect(await deniedHead.text()).toBe('')
    await fixture.db.mutate(db => {
      db.profiles.find(row => row.id === fixture.owner.profileId)!.visibility = 'public'
      db.blocks.push({ id: 'blk_imagesowner', blocker_id: fixture.owner.profileId, blocked_id: fixture.outsider.profileId, reason: null, created_at: new Date().toISOString() })
    })
    expect((await imageGet(fixture.request(fixture.outsider), imageContext(image.id))).status).toBe(404)
    await fixture.db.mutate(db => { db.users.find(row => row.id === fixture.owner.userId)!.disabled_at = new Date().toISOString() })
    expect((await imageGet(fixture.request(null), imageContext(image.id))).status).toBe(404)
    expect((await avatarPost(fixture.request(fixture.owner, png))).status).toBe(401)
  })

  it('rechecks a manager role and session revocation after normalization, before commit', async () => {
    const backend = createLocalImageBackend(fixture.request(fixture.maintainer, png))
    const reservation = await backend.reserve({ kind: 'project-cover', projectId: fixture.project.id })
    const normalized = await normalizeImage(Buffer.from(png), 'project-cover', 'image/png')
    await backend.publish(reservation, normalized)
    await fixture.db.mutate(db => { db.project_members = db.project_members.filter(row => row.profile_id !== fixture.maintainer.profileId) })
    await expect(backend.commit(reservation, normalized)).rejects.toMatchObject({ status: 403 })
    await backend.rollback(reservation)
    expect((await index()).records).toHaveLength(0)
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toHaveLength(0)

    const avatarBackend = createLocalImageBackend(fixture.request(fixture.owner, png))
    const avatar = await avatarBackend.reserve({ kind: 'avatar' })
    const avatarBytes = await normalizeImage(Buffer.from(png), 'avatar', 'image/png')
    await avatarBackend.publish(avatar, avatarBytes)
    await fixture.db.mutate(db => { db.sessions = db.sessions.filter(row => row.user_id !== fixture.owner.userId) })
    await expect(avatarBackend.commit(avatar, avatarBytes)).rejects.toMatchObject({ status: 401 })
    await avatarBackend.rollback(avatar)
    expect((await fixture.db.readStore()).profiles.find(row => row.id === fixture.owner.profileId)?.avatar_url).toBeNull()
  })

  it('invalidates old IDs and cleans only replaced app-owned images after a successful commit', async () => {
    const first = await uploadAvatar()
    const second = await uploadAvatar()
    expect(second.id).not.toBe(first.id)
    expect((await imageGet(fixture.request(fixture.owner), imageContext(first.id))).status).toBe(404)
    expect((await imageGet(fixture.request(fixture.owner), imageContext(second.id))).status).toBe(200)
    expect((await index()).records.map((row: { id: string }) => row.id)).toEqual([second.id])
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toEqual([imageObjectName(second.id)])
  })

  it('rolls back bytes and profile state if an atomic metadata publish fails', async () => {
    const before = await fixture.db.readStore()
    const backend = createLocalImageBackend(fixture.request(fixture.owner, png))
    const reservation = await backend.reserve({ kind: 'avatar' })
    const normalized = await normalizeImage(Buffer.from(png), 'avatar', 'image/png')
    await backend.publish(reservation, normalized)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => rename(from, to))
      .mockRejectedValueOnce(new Error('synthetic index publish failure'))
    await expect(backend.commit(reservation, normalized)).rejects.toThrow('synthetic index publish failure')
    await backend.rollback(reservation)
    expect((await fixture.db.readStore()).profiles).toEqual(before.profiles)
    expect((await index()).records).toHaveLength(0)
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toHaveLength(0)
    expect((await fs.readdir(fixture.mediaRoot)).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('does not overwrite or delete a pre-existing object on exclusive-publish collision', async () => {
    const backend = createLocalImageBackend(fixture.request(fixture.owner, png))
    const reservation = await backend.reserve({ kind: 'avatar' })
    const target = path.join(fixture.mediaRoot, 'objects', imageObjectName(reservation.id))
    const marker = Buffer.from('SYNTHETIC_COLLISION_DO_NOT_OVERWRITE')
    await fs.writeFile(target, marker)
    const normalized = await normalizeImage(Buffer.from(png), 'avatar', 'image/png')
    await expect(backend.publish(reservation, normalized)).rejects.toMatchObject({ code: 'EEXIST' })
    await backend.rollback(reservation)
    expect(await fs.readFile(target)).toEqual(marker)
  })

  it('counts failed format attempts and enforces fixed N/N+1 budgets', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await avatarPost(fixture.request(fixture.owner, new TextEncoder().encode('<svg/>')))).status).toBe(415)
    }
    const blocked = await avatarPost(fixture.request(fixture.owner, png))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('600')
    expect((await index()).records).toHaveLength(0)
  })

  it('uses one shared filesystem lock to bound independently constructed reservations', async () => {
    const backends = Array.from({ length: 3 }, () => createLocalImageBackend(fixture.request(fixture.owner, png)))
    const results = await Promise.allSettled(backends.map(backend => backend.reserve({ kind: 'avatar' })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.find(result => result.status === 'rejected')).toHaveProperty('reason.status', 429)
    for (let position = 0; position < results.length; position += 1) {
      const result = results[position]
      if (result.status === 'fulfilled') await backends[position].rollback(result.value)
    }
    expect((await index()).records).toHaveLength(0)
  })

  it('charges pending/ready bytes conservatively and refuses an owner quota overflow', async () => {
    const backend = createLocalImageBackend(fixture.request(fixture.owner, png))
    const reserved = await backend.reserve({ kind: 'avatar' })
    await backend.rollback(reserved)
    const metadata = await index()
    metadata.records = Array.from({ length: 8 }, (_, position) => ({
      id: randomUUID(), kind: 'project-cover', ownerId: fixture.owner.profileId, actorId: fixture.owner.profileId,
      profileId: null, projectId: `prj_quota${position}`, state: 'ready',
      bytes: IMAGE_RULES['project-cover'].outputBytes, width: 1600, height: 900, sha256: 'a'.repeat(64),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }))
    await fs.writeFile(path.join(fixture.mediaRoot, 'index.json'), JSON.stringify(metadata))
    await expect(backend.reserve({ kind: 'avatar' })).rejects.toMatchObject({ status: 409, code: 'image_quota_exceeded' })
    expect((await index()).records).toHaveLength(8)
  })

  it('refuses runtime roots in the checkout/public/source/drive root and honors the DB-adjacent default', () => {
    for (const root of [process.cwd(), path.join(process.cwd(), 'public', 'images'), path.join(process.cwd(), 'src', 'images'), path.parse(fixture.mediaRoot).root]) {
      vi.stubEnv('BULLA_LOCAL_MEDIA_ROOT', root)
      expect(() => localMediaRoot()).toThrow()
    }
    vi.stubEnv('BULLA_LOCAL_MEDIA_ROOT', '')
    expect(localMediaRoot()).toBe(path.join(path.dirname(fixture.dataPath), 'bulla-private-images'))
  })

  it('refuses tampered normalized bytes and traversal identifiers', async () => {
    const image = await uploadAvatar()
    const target = path.join(fixture.mediaRoot, 'objects', imageObjectName(image.id))
    await fs.writeFile(target, Buffer.from('SYNTHETIC_TAMPER'))
    expect((await imageGet(fixture.request(fixture.owner), imageContext(image.id))).status).toBe(503)
    expect((await imageGet(fixture.request(fixture.owner), imageContext('../local.json'))).status).toBe(404)
    expect(image.url).toBe(imageUrl(image.id))
  })

  it('refuses an actual junction/symlink in its objects directory without touching the target', async () => {
    const redirected = path.join(fixture.directory, 'synthetic-redirect-target')
    await fs.mkdir(redirected)
    await fs.writeFile(path.join(redirected, 'synthetic-marker.txt'), 'PRESERVE_SYNTHETIC_TARGET')
    await fs.mkdir(fixture.mediaRoot)
    await fs.symlink(redirected, path.join(fixture.mediaRoot, 'objects'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await avatarPost(fixture.request(fixture.owner, png))).status).toBe(503)
    expect(await fs.readdir(redirected)).toEqual(['synthetic-marker.txt'])
    expect(await fs.readFile(path.join(redirected, 'synthetic-marker.txt'), 'utf8')).toBe('PRESERVE_SYNTHETIC_TARGET')
  })

  it('rolls back a lying Content-Length stream at the actual byte limit', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
      cancel,
    })
    const response = await avatarPost(fixture.request(fixture.owner, stream, { 'content-length': '1' }))
    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledOnce()
    expect((await index()).records).toHaveLength(0)
    expect((await fixture.db.readStore()).profiles.find(row => row.id === fixture.owner.profileId)?.avatar_url).toBeNull()
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toHaveLength(0)
  })

  it('does not reset a corrupt private index or expose its stored files', async () => {
    const image = await uploadAvatar()
    const target = path.join(fixture.mediaRoot, 'index.json')
    await fs.writeFile(target, '{"corrupt":true}')
    expect((await avatarPost(fixture.request(fixture.owner, png))).status).toBe(503)
    expect((await imageGet(fixture.request(fixture.owner), imageContext(image.id))).status).toBe(503)
    expect(await fs.readFile(target, 'utf8')).toBe('{"corrupt":true}')
    expect(await fs.readdir(path.join(fixture.mediaRoot, 'objects'))).toEqual([imageObjectName(image.id)])
  })

  it('refuses production-local uploads before opening the local store or creating media', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:3999')
    vi.stubEnv('BULLA_ALLOW_LOCAL_IN_PRODUCTION', '')
    const read = vi.spyOn(fs, 'readFile')
    expect((await avatarPost(fixture.request(fixture.owner, png))).status).toBe(503)
    expect(read).not.toHaveBeenCalled()
    await expect(fs.stat(fixture.mediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

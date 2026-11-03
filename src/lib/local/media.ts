import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { localStorePath, mutate, readStore, type LocalProfile, type Tables } from './db'
import { canManageLocalProject, canReadContent, canReadProfile, localActor, validLocalId } from './access'
import { assertNotDeployedInLocalMode } from '@/lib/mode'
import {
  IMAGE_RULES, IMAGE_UPLOAD_LIMITS, imageObjectName, imageUrl, parseUploadedImage,
  validImageId, type ImageUploadTarget, type UploadedImage,
} from '@/features/uploads/contracts'
import {
  ImageUploadError, uploadDenied, uploadQuotaExceeded, uploadRateLimited, uploadsUnavailable,
} from '@/features/uploads/errors'
import type {
  ImageBackend, ImageReservation, PrivateImageRecord,
} from '@/features/uploads/types'

type Budget = { subject: string; minute: number; minuteHits: number; tenMinutes: number; tenMinuteHits: number; day: number; dayHits: number }
type MediaIndex = { version: 1; records: PrivateImageRecord[]; budgets: Budget[] }
const emptyIndex = (): MediaIndex => ({ version: 1, records: [], budgets: [] })
const noFollow = constants.O_NOFOLLOW ?? 0

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** A dedicated runtime directory, never public/, source, a drive root or the DB. */
export function localMediaRoot(): string {
  const configured = process.env.BULLA_LOCAL_MEDIA_ROOT
  if (configured && !path.isAbsolute(configured)) throw uploadsUnavailable()
  const store = path.resolve(localStorePath())
  const root = path.resolve(configured || path.join(path.dirname(store), 'bulla-private-images'))
  const checkout = path.resolve(process.cwd())
  if (samePath(root, path.parse(root).root) || samePath(root, checkout) || samePath(root, store) ||
      inside(root, store) ||
      (inside(checkout, root) && !inside(path.join(checkout, 'data'), root))) throw uploadsUnavailable()
  return root
}

async function realDirectory(target: string): Promise<void> {
  const stat = await fs.lstat(/* turbopackIgnore: true */ target)
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !samePath(await fs.realpath(/* turbopackIgnore: true */ target), target)) throw uploadsUnavailable()
}

async function rootDirectory(create: boolean): Promise<string | null> {
  assertNotDeployedInLocalMode()
  const root = localMediaRoot()
  try {
    await realDirectory(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!create) return null
    // Check the existing ancestor BEFORE mkdir can follow a junction/symlink.
    let ancestor = path.dirname(root)
    for (;;) {
      try { await realDirectory(ancestor); break } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw uploadsUnavailable()
        ancestor = parent
      }
    }
    await fs.mkdir(/* turbopackIgnore: true */ root, { recursive: true, mode: 0o700 })
    await realDirectory(root)
  }
  return root
}

async function objectsDirectory(root: string, create = false): Promise<string> {
  const directory = path.join(root, 'objects')
  if (create) await fs.mkdir(/* turbopackIgnore: true */ directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await realDirectory(directory)
  return directory
}

async function regularFile(target: string, maxBytes: number): Promise<void> {
  const stat = await fs.lstat(/* turbopackIgnore: true */ target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw uploadsUnavailable()
}

function validRecord(value: unknown): value is PrivateImageRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as PrivateImageRecord
  if (!validImageId(row.id) || !['avatar', 'project-cover'].includes(row.kind) ||
      !['pending', 'ready', 'retired'].includes(row.state) ||
      !validLocalId(row.ownerId) || !validLocalId(row.actorId) ||
      !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.expiresAt)) ||
      !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > IMAGE_RULES[row.kind].outputBytes ||
      (row.kind === 'avatar'
        ? row.profileId !== row.ownerId || row.projectId !== null
        : row.profileId !== null || !row.projectId || !validLocalId(row.projectId))) return false
  if (row.state === 'ready' || row.sha256 !== null) {
    return /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && descriptor(row) !== null
  }
  return row.width === null && row.height === null && row.sha256 === null
}

async function readIndex(root: string): Promise<MediaIndex> {
  const target = path.join(root, 'index.json')
  try {
    await regularFile(target, 2 * 1024 * 1024)
    const raw: unknown = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ target, 'utf8'))
    const index = raw as MediaIndex | null
    if (!index || index.version !== 1 || !Array.isArray(index.records) || !Array.isArray(index.budgets) ||
        index.records.length > IMAGE_UPLOAD_LIMITS.imagesGlobal || !index.records.every(validRecord) ||
        new Set(index.records.map(row => row.id)).size !== index.records.length ||
        !index.budgets.every(budget => budget && (budget.subject === 'global' || validLocalId(budget.subject)) &&
          [budget.minute, budget.minuteHits, budget.tenMinutes, budget.tenMinuteHits, budget.day, budget.dayHits]
            .every(value => Number.isSafeInteger(value) && value >= 0))) throw uploadsUnavailable()
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex()
    throw error
  }
}

async function writeIndex(root: string, index: MediaIndex): Promise<void> {
  const target = path.join(root, 'index.json')
  await regularFile(target, 2 * 1024 * 1024).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  const temp = path.join(root, `.index-${randomUUID()}.tmp`)
  const handle = await fs.open(/* turbopackIgnore: true */ temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(index))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(/* turbopackIgnore: true */ temp, target)
  } finally {
    await fs.unlink(/* turbopackIgnore: true */ temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** A filesystem lock, not a process queue: independent Next workers share it. */
async function directoryLocked<T>(lock: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    if (Date.now() >= deadline) throw uploadsUnavailable()
    try { await fs.mkdir(/* turbopackIgnore: true */ lock, { mode: 0o700 }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { await realDirectory(lock) } catch (lockError) {
        // The holder can release between EEXIST and lstat. Retry that benign
        // race, while still refusing a symlink or non-directory replacement.
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError
        continue
      }
      if (Date.now() >= deadline) throw uploadsUnavailable()
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try { return await work() } finally { await fs.rmdir(/* turbopackIgnore: true */ lock) }
}

function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  return directoryLocked(path.join(root, '.index-lock'), work)
}

function tokenFromRequest(request: Request): string | undefined {
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith('quad_local_session='))
  if (matches.length !== 1) return undefined
  const token = matches[0].slice('quad_local_session='.length)
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

function actorIn(db: Tables, token: string | undefined): LocalProfile | null {
  if (!token) return null
  const hash = createHash('sha256').update(token).digest('hex')
  const session = db.sessions.find(row => row.token_hash === hash)
  if (!session) return null
  const created = Date.parse(session.created_at)
  const expires = Date.parse(session.expires_at)
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > Date.now() ||
      expires <= Date.now() || expires <= created) return null
  const user = db.users.find(row => row.id === session.user_id)
  if (!user || user.disabled_at != null) return null
  return localActor(db, user.id)
}

function requiredActor(db: Tables, token: string | undefined): LocalProfile {
  const actor = actorIn(db, token)
  if (!actor) throw new ImageUploadError(401, 'sign_in_required', 'Sign in to upload an image.')
  return actor
}

function association(db: Tables, actor: LocalProfile, target: ImageUploadTarget): Pick<ImageReservation, 'ownerId' | 'profileId' | 'projectId'> {
  if (target.kind === 'avatar') return { ownerId: actor.id, profileId: actor.id, projectId: null }
  if (!validLocalId(target.projectId) || !canManageLocalProject(db, target.projectId, actor)) throw uploadDenied()
  const project = db.projects.find(row => row.id === target.projectId)!
  return { ownerId: project.owner_id, profileId: null, projectId: project.id }
}

function sameSlot(a: ImageReservation, b: ImageReservation): boolean {
  return a.kind === b.kind && a.profileId === b.profileId && a.projectId === b.projectId
}

function descriptor(row: PrivateImageRecord): UploadedImage | null {
  return parseUploadedImage({
    id: row.id, url: imageUrl(row.id), kind: row.kind,
    width: row.width, height: row.height, bytes: row.bytes, contentType: 'image/webp',
  })
}

function readable(db: Tables, row: PrivateImageRecord, viewer: LocalProfile | null): boolean {
  if (row.state !== 'ready') return false
  if (row.kind === 'avatar') {
    const profile = db.profiles.find(profile => profile.id === row.profileId)
    return Boolean(profile?.avatar_url === imageUrl(row.id) && canReadProfile(db, profile, viewer))
  }
  const project = db.projects.find(project => project.id === row.projectId)
  return Boolean(project && project.owner_id === row.ownerId &&
    canReadContent(db, project, project.owner_id, viewer, 'project'))
}

function spendBudget(index: MediaIndex, subject: string): Budget {
  const now = Date.now()
  const minute = Math.floor(now / 60_000)
  const tenMinutes = Math.floor(now / 600_000)
  const day = Math.floor(now / 86_400_000)
  let budget = index.budgets.find(row => row.subject === subject)
  if (!budget) {
    budget = { subject, minute, minuteHits: 0, tenMinutes, tenMinuteHits: 0, day, dayHits: 0 }
    index.budgets.push(budget)
  }
  budget.minuteHits = budget.minute === minute ? Math.min(budget.minuteHits + 1, 31) : 1
  budget.tenMinuteHits = budget.tenMinutes === tenMinutes ? Math.min(budget.tenMinuteHits + 1, 6) : 1
  budget.dayHits = budget.day === day ? Math.min(budget.dayHits + 1, 21) : 1
  budget.minute = minute
  budget.tenMinutes = tenMinutes
  budget.day = day
  index.budgets = index.budgets.filter(row => row.subject === 'global' || row.day >= day - 1)
  return budget
}

async function unlinkOwnedFile(target: string): Promise<void> {
  try {
    await regularFile(target, IMAGE_RULES['project-cover'].outputBytes)
    await fs.unlink(/* turbopackIgnore: true */ target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Only exact IDs already in the private index; never enumerate owner files. */
async function cleanup(root: string, index: MediaIndex): Promise<void> {
  let objects: string
  try { objects = await objectsDirectory(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    objects = path.join(root, 'objects')
  }
  for (const row of [...index.records]) {
    if (row.state === 'pending' && Date.parse(row.expiresAt) <= Date.now()) row.state = 'retired'
    if (row.state !== 'retired') continue
    try {
      await unlinkOwnedFile(path.join(objects, imageObjectName(row.id)))
      await unlinkOwnedFile(path.join(objects, `${row.id}.tmp`))
      index.records = index.records.filter(candidate => candidate.id !== row.id)
    } catch {
      // Keep failed cleanup charged to quotas. A later guarded upload retries.
    }
  }
}

async function readObject(root: string, row: PrivateImageRecord): Promise<Buffer> {
  const objects = await objectsDirectory(root)
  const target = path.join(objects, imageObjectName(row.id))
  await regularFile(target, IMAGE_RULES[row.kind].outputBytes)
  const handle = await fs.open(/* turbopackIgnore: true */ target, constants.O_RDONLY | noFollow)
  try {
    const data = await handle.readFile()
    if (data.length !== row.bytes || createHash('sha256').update(data).digest('hex') !== row.sha256) throw uploadsUnavailable()
    return data
  } finally { await handle.close() }
}

/** No seeding or writes on construction/reads. Authentication is rechecked at commit. */
export function createLocalImageBackend(request: Request): ImageBackend {
  const token = tokenFromRequest(request)
  const published = new Set<string>()
  return {
    async reserve(target) {
      // A refused actor/association must not even create the media directory.
      const initialDb = await readStore()
      association(initialDb, requiredActor(initialDb, token), target)
      const root = (await rootDirectory(true))!
      return locked(root, async () => {
        const db = await readStore()
        const actor = requiredActor(db, token)
        const related = association(db, actor, target)
        const index = await readIndex(root)
        await cleanup(root, index)
        const actorBudget = spendBudget(index, actor.id)
        const globalBudget = spendBudget(index, 'global')
        const pending = index.records.filter(row => row.state === 'pending')
        const ownerRows = index.records.filter(row => row.ownerId === related.ownerId)
        const allocation = IMAGE_RULES[target.kind].outputBytes
        let error: ImageUploadError | null = null
        if (actorBudget.tenMinuteHits > IMAGE_UPLOAD_LIMITS.uploadsPerTenMinutes ||
            actorBudget.dayHits > IMAGE_UPLOAD_LIMITS.uploadsPerDay ||
            globalBudget.minuteHits > IMAGE_UPLOAD_LIMITS.uploadsPerMinuteGlobal ||
            pending.length >= IMAGE_UPLOAD_LIMITS.pendingGlobal ||
            pending.filter(row => row.actorId === actor.id).length >= IMAGE_UPLOAD_LIMITS.pendingPerActor) error = uploadRateLimited()
        else if (index.records.length >= IMAGE_UPLOAD_LIMITS.imagesGlobal ||
            ownerRows.length >= IMAGE_UPLOAD_LIMITS.imagesPerOwner ||
            index.records.reduce((total, row) => total + row.bytes, allocation) > IMAGE_UPLOAD_LIMITS.bytesGlobal ||
            ownerRows.reduce((total, row) => total + row.bytes, allocation) > IMAGE_UPLOAD_LIMITS.bytesPerOwner) error = uploadQuotaExceeded()
        if (error) { await writeIndex(root, index); throw error }
        const row: PrivateImageRecord = {
          id: randomUUID(), kind: target.kind, ...related, actorId: actor.id,
          expiresAt: new Date(Date.now() + IMAGE_UPLOAD_LIMITS.reservationTtlMs).toISOString(),
          createdAt: new Date().toISOString(), state: 'pending', bytes: allocation,
          width: null, height: null, sha256: null,
        }
        // Never overwrite or adopt a pre-existing unindexed file, even on collision.
        const objects = await objectsDirectory(root, true)
        for (const suffix of ['.webp', '.tmp']) {
          await fs.lstat(/* turbopackIgnore: true */ path.join(objects, `${row.id}${suffix}`)).then(
            () => { throw uploadsUnavailable() },
            (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error },
          )
        }
        index.records.push(row)
        await writeIndex(root, index)
        return { ...row }
      })
    },
    async publish(reservation, image) {
      const root = (await rootDirectory(false))!
      if (!root) throw uploadsUnavailable()
      await locked(root, async () => {
        const index = await readIndex(root)
        const row = index.records.find(row => row.id === reservation.id)
        if (!row || row.state !== 'pending' || row.actorId !== reservation.actorId ||
            Date.parse(row.expiresAt) <= Date.now()) throw uploadDenied()
        const db = await readStore()
        const actor = requiredActor(db, token)
        const target: ImageUploadTarget = row.kind === 'avatar' ? { kind: 'avatar' } : { kind: 'project-cover', projectId: row.projectId! }
        const related = association(db, actor, target)
        if (actor.id !== row.actorId || related.ownerId !== row.ownerId) throw uploadDenied()
        if (!parseUploadedImage({ id: row.id, url: imageUrl(row.id), kind: row.kind, ...image }) ||
            image.data.length !== image.bytes || createHash('sha256').update(image.data).digest('hex') !== image.sha256) throw uploadsUnavailable()
        const objects = await objectsDirectory(root, true)
        const temp = path.join(objects, `${row.id}.tmp`)
        const targetFile = path.join(objects, imageObjectName(row.id))
        const handle = await fs.open(/* turbopackIgnore: true */ temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600)
        try {
          await handle.writeFile(image.data)
          await handle.sync()
          await handle.close()
          // link is an atomic, no-overwrite publish on the same filesystem.
          await fs.link(/* turbopackIgnore: true */ temp, targetFile)
          published.add(row.id)
        } finally {
          await handle.close()
          await unlinkOwnedFile(temp)
        }
      })
    },
    async commit(reservation, image) {
      const root = await rootDirectory(false)
      if (!root || !published.has(reservation.id)) throw uploadsUnavailable()
      return locked(root, async () => {
        const index = await readIndex(root)
        const row = index.records.find(row => row.id === reservation.id)
        if (!row || row.state !== 'pending' || Date.parse(row.expiresAt) <= Date.now()) throw uploadDenied()
        const db = await readStore()
        const actor = requiredActor(db, token)
        const target: ImageUploadTarget = row.kind === 'avatar' ? { kind: 'avatar' } : { kind: 'project-cover', projectId: row.projectId! }
        const related = association(db, actor, target)
        if (actor.id !== row.actorId || related.ownerId !== row.ownerId) throw uploadDenied()
        const ready: PrivateImageRecord = { ...row, state: 'ready', bytes: image.bytes, width: image.width, height: image.height, sha256: image.sha256 }
        await readObject(root, ready)
        const result = descriptor(ready)
        if (!result) throw uploadsUnavailable()
        let previousAvatar: string | null = null
        if (row.kind === 'avatar') {
          previousAvatar = await mutate(snapshot => {
            const currentActor = requiredActor(snapshot, token)
            if (currentActor.id !== row.profileId) throw uploadDenied()
            const old = currentActor.avatar_url
            currentActor.avatar_url = result.url
            return old
          })
        }
        for (const old of index.records) {
          if (old.state === 'ready' && sameSlot(old, row)) old.state = 'retired'
        }
        Object.assign(row, ready)
        try {
          if (ready.kind === 'project-cover') {
            // Share the existing domain-store lock without rewriting its tables.
            // Membership/ownership edits cannot race the final permission check.
            const store = path.resolve(localStorePath())
            await realDirectory(path.dirname(store))
            await directoryLocked(`${store}.lock`, async () => {
              const latest = await readStore()
              const latestActor = requiredActor(latest, token)
              const latestRelated = association(latest, latestActor, target)
              if (latestActor.id !== ready.actorId || latestRelated.ownerId !== ready.ownerId) throw uploadDenied()
              await writeIndex(root, index)
            })
          } else await writeIndex(root, index)
        } catch (error) {
          // Avatar URLs and the media index are separate atomic files. Publish
          // the URL first while metadata is unreadable; restore it on failure.
          // A crash in that gap is fail-closed, not an accepted upload.
          if (ready.kind === 'avatar') await mutate(snapshot => {
            const profile = snapshot.profiles.find(profile => profile.id === ready.profileId)
            if (profile?.avatar_url === result.url) profile.avatar_url = previousAvatar
          })
          throw error
        }
        published.delete(row.id)
        // Once committed, cleanup problems cannot turn success into a false error.
        try { await cleanup(root, index); await writeIndex(root, index) } catch { /* Retired bytes remain charged. */ }
        return result
      })
    },
    async rollback(reservation) {
      const root = await rootDirectory(false)
      if (!root) return
      await locked(root, async () => {
        const index = await readIndex(root)
        const row = index.records.find(row => row.id === reservation.id)
        if (!row || row.state !== 'pending' || row.actorId !== reservation.actorId) return
        const objects = await objectsDirectory(root)
        // Only this adapter's successful publish may be removed immediately.
        // In particular a failed exclusive publish must not delete a collision.
        if (published.has(row.id)) await unlinkOwnedFile(path.join(objects, imageObjectName(row.id)))
        published.delete(row.id)
        index.records = index.records.filter(candidate => candidate.id !== row.id)
        await writeIndex(root, index)
      })
    },
    async current(target) {
      const db = await readStore()
      const actor = requiredActor(db, token)
      const related = association(db, actor, target)
      const root = await rootDirectory(false)
      if (!root) return null
      const index = await readIndex(root)
      const row = index.records.find(row => row.state === 'ready' && row.kind === target.kind &&
        row.profileId === related.profileId && row.projectId === related.projectId)
      return row && readable(db, row, actor) ? descriptor(row) : null
    },
    async read(id) {
      if (!validImageId(id)) return null
      const root = await rootDirectory(false)
      if (!root) return null
      // Authorization and file delivery share the media lock with replacement.
      return locked(root, async () => {
        const index = await readIndex(root)
        const row = index.records.find(row => row.id === id)
        const db = await readStore()
        if (!row || !readable(db, row, actorIn(db, token))) return null
        const image = descriptor(row)
        if (!image) throw uploadsUnavailable()
        try {
          const data = await readObject(root, row)
          const fresh = await readStore()
          if (!readable(fresh, row, actorIn(fresh, token))) return null
          return { image, data }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      })
    },
  }
}

/** Server-rendered project integration; user ID must come from verified auth. */
export async function readLocalProjectCover(projectId: string, viewerUserId: string | null): Promise<UploadedImage | null> {
  if (!validLocalId(projectId)) return null
  const root = await rootDirectory(false)
  if (!root) return null
  const db = await readStore()
  const viewer = localActor(db, viewerUserId)
  const index = await readIndex(root)
  const row = index.records.find(row => row.kind === 'project-cover' && row.projectId === projectId && row.state === 'ready')
  return row && readable(db, row, viewer) ? descriptor(row) : null
}

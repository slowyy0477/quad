import 'server-only'

import { cookies } from 'next/headers'
import { signUpSchema } from '@/features/auth/schemas'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mutate, readStore, id, now, type LocalProfile, type LocalUser, type Tables } from '@/lib/local/db'

/** Opaque local sessions. Only SHA-256 token digests are persisted, never bearer tokens. */

const COOKIE = 'quad_local_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** Kept stable so accounts and cookies from the older local application still work. */
export const LOCAL_SESSION_COOKIE = COOKIE

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (password.length > 1024 || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(stored)) return false
  const [, salt, expected] = stored.split('$')

  const derived = scryptSync(password, salt, 64)
  const known = Buffer.from(expected, 'hex')
  if (known.length !== derived.length) return false
  return timingSafeEqual(known, derived)
}

function tokenDigest(raw: string | undefined): string | null {
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null
  return createHash('sha256').update(raw).digest('hex')
}

/** Permanent disable never expires; temporary suspension requires a valid elapsed deadline. */
function accountAvailable(db: Tables, user: LocalUser | undefined): user is LocalUser {
  if (!user || user.disabled_at != null) return false
  const profile = db.profiles.find((candidate) => candidate.user_id === user.id)
  const state = profile && db.profile_account_states.find((candidate) => candidate.profile_id === profile.id)
  if (state?.status !== 'suspended') return true
  const deadline = state.suspended_until ? Date.parse(state.suspended_until) : NaN
  return Number.isFinite(deadline) && deadline <= Date.now()
}

/** Prevent an in-flight legacy-password login from creating a session after a change. */
export class LocalCredentialsChangedError extends Error {
  constructor() {
    super('Credentials changed before the session could be issued')
    this.name = 'LocalCredentialsChangedError'
  }
}

export async function startSession(
  userId: string,
  options?: { expectedPasswordHash: string },
): Promise<void> {
  const store = await cookies()
  const token = randomBytes(32).toString('base64url')
  const previous = tokenDigest(store.get(COOKIE)?.value)
  await mutate((db) => {
    const user = db.users.find((candidate) => candidate.id === userId)
    if (!accountAvailable(db, user)) throw new Error('Account is unavailable')
    if (options && user.password_hash !== options.expectedPasswordHash) throw new LocalCredentialsChangedError()
    const timestamp = Date.now()
    db.sessions = db.sessions.filter((session) => session.token_hash !== previous && Date.parse(session.expires_at) > timestamp)
    const current = db.sessions.filter((session) => session.user_id === userId).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const evicted = new Set(current.slice(0, Math.max(0, current.length - 4)).map((session) => session.id))
    db.sessions = db.sessions.filter((session) => !evicted.has(session.id))
    db.sessions.push({
      id: id('ses'),
      user_id: userId,
      token_hash: tokenDigest(token)!,
      created_at: now(),
      expires_at: new Date(Date.now() + MAX_AGE_SECONDS * 1000).toISOString(),
    })
  })
  try {
    store.set(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: MAX_AGE_SECONDS,
    })
  } catch (error) {
    await mutate((db) => {
      db.sessions = db.sessions.filter((session) => session.token_hash !== tokenDigest(token))
    })
    throw error
  }
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  const digest = tokenDigest(store.get(COOKIE)?.value)
  if (digest) await mutate((db) => {
    db.sessions = db.sessions.filter((session) => session.token_hash !== digest)
  })
  store.delete(COOKIE)
}

export type LocalSessionUser = {
  id: string
  email: string
  profile: LocalProfile | null
}

/** Resolve a bearer token through the private server-side session table. */
export async function getLocalUser(): Promise<LocalSessionUser | null> {
  return getLocalUserFromToken((await cookies()).get(COOKIE)?.value)
}

/** Cookie-independent authorization for the Node-runtime proxy. */
export async function getLocalUserFromToken(raw: string | undefined): Promise<LocalSessionUser | null> {
  const digest = tokenDigest(raw)
  if (!digest) return null
  return getLocalUserFromSnapshot(await readStore(), raw)
}

/**
 * The same session check against a locked write snapshot. Sensitive mutations
 * must not authorize against an earlier read and then write after revocation.
 */
export function getLocalUserFromSnapshot(db: Tables, raw: string | undefined): LocalSessionUser | null {
  const digest = tokenDigest(raw)
  if (!digest) return null

  const session = db.sessions.find((candidate) => candidate.token_hash === digest)
  if (!session) return null
  const created = Date.parse(session.created_at)
  const expires = Date.parse(session.expires_at)
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > Date.now() || expires <= Date.now() || expires <= created) return null
  const user = db.users.find((candidate) => candidate.id === session.user_id)
  if (!accountAvailable(db, user)) return null

  return {
    id: user.id,
    email: user.email,
    profile: db.profiles.find((profile) => profile.user_id === user.id) ?? null,
  }
}

/** Select from the transaction snapshot, never from a pre-write availability check. */
function usernameFromProfiles(displayName: string, email: string, profiles: LocalProfile[]): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 20).replace(/^_+|_+$/g, '')
  const seed = clean(displayName) || clean(email.split('@')[0] ?? '') || 'student'
  const base = seed.length >= 3 ? seed : `${seed}_student`
  const taken = new Set(profiles.map((profile) => profile.username.toLowerCase()))
  let candidate = base
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}${suffix}`
  return candidate
}

/** Informational only. Account creation allocates its username inside mutate. */
export async function uniqueUsername(displayName: string, email: string): Promise<string> {
  return usernameFromProfiles(displayName, email, (await readStore()).profiles)
}

/** Create the account and its profile in one write. Returns null when the email is taken. */
export async function createAccount({
  email,
  password,
  displayName,
  universityId = null,
}: {
  email: string
  password: string
  displayName: string
  universityId?: string | null
}): Promise<{ user: LocalUser; profile: LocalProfile } | null> {
  const parsed = signUpSchema.safeParse({ email, password, displayName, acceptTerms: 'on' })
  if (!parsed.success) throw new Error('Invalid account details')
  const normalised = parsed.data.email
  displayName = parsed.data.displayName

  return mutate((db) => {
    if (db.users.some((candidate) => candidate.email.trim().toLowerCase() === normalised)) return null
    const username = usernameFromProfiles(displayName, normalised, db.profiles)

    const user: LocalUser = {
      id: id('usr'),
      email: normalised,
      password_hash: hashPassword(password),
      created_at: now(),
    }

    const profile: LocalProfile = {
      id: id('prf'),
      user_id: user.id,
      username,
      display_name: displayName.trim(),
      bio: null,
      avatar_url: null,
      university_id: universityId,
      department: null,
      programme: null,
      semester: null,
      website: null,
      github: null,
      // This applies only to newly created rows. Existing accounts are not migrated.
      visibility: 'private',
      searchable: true,
      onboarding_completed: false,
      onboarding_step: 0,
      created_at: now(),
    }

    db.users.push(user)
    db.profiles.push(profile)
    return { user, profile }
  })
}

/** Verify an email and password. Returns the account, or null for either kind of miss. */
export async function checkCredentials(email: string, password: string): Promise<LocalUser | null> {
  const db = await readStore()
  const user = db.users.find((candidate) => candidate.email.trim().toLowerCase() === email.trim().toLowerCase())
  if (!accountAvailable(db, user)) return null
  if (!verifyPassword(password, user.password_hash)) return null
  return user
}

import 'server-only'

import { cookies } from 'next/headers'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mutate, readStore, id, now, type LocalProfile, type LocalUser } from '@/lib/local/db'

/**
 * Local accounts and sessions.
 *
 * WHAT IS REAL HERE
 * -----------------
 * Passwords are salted and hashed with scrypt (`N=16384, r=8, p=1`, 64-byte key) —
 * the same primitive a production system would use, and no plaintext is ever
 * written. The session cookie is an HMAC over the user id, `httpOnly`, `sameSite=lax`,
 * and `secure` outside development, so a cookie cannot be edited to become another
 * account without the signing key.
 *
 * WHAT IS NOT REAL, AND IS NOT PRETENDED TO BE
 * --------------------------------------------
 * There is no email verification, no password-reset delivery, no rate limiting and
 * no second factor. The signing key falls back to a constant when
 * `LOCAL_SESSION_SECRET` is unset, which is fine for one person on one laptop and
 * unacceptable anywhere else — hence the production guard in `src/lib/mode.ts`.
 * The interface says "local mode" in the header so nobody mistakes this for the
 * Postgres deployment.
 */

const COOKIE = 'quad_local_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function signingKey(): string {
  const configured = process.env.LOCAL_SESSION_SECRET
  if (configured && configured.length >= 16) return configured
  return 'quad-local-development-signing-key-do-not-deploy'
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !expected) return false

  const derived = scryptSync(password, salt, 64)
  const known = Buffer.from(expected, 'hex')
  if (known.length !== derived.length) return false
  return timingSafeEqual(known, derived)
}

function sign(userId: string): string {
  return createHmac('sha256', signingKey()).update(userId).digest('hex')
}

/** The cookie value: `<userId>.<hmac>`. The id is public; the signature is not. */
function token(userId: string): string {
  return `${userId}.${sign(userId)}`
}

function userIdFromToken(raw: string | undefined): string | null {
  if (!raw) return null
  const index = raw.lastIndexOf('.')
  if (index <= 0) return null

  const userId = raw.slice(0, index)
  const provided = raw.slice(index + 1)
  const expected = sign(userId)

  // Constant-time comparison, and equal lengths before the call is required:
  // timingSafeEqual throws on a length mismatch, which would be a crash reachable
  // by sending a wrong-shaped cookie.
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? userId : null
}

export async function startSession(userId: string): Promise<void> {
  const store = await cookies()
  store.set(COOKIE, token(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  store.delete(COOKIE)
}

export type LocalSessionUser = {
  id: string
  email: string
  profile: LocalProfile | null
}

/** The signed-in account, read from the signed cookie. */
export async function getLocalUser(): Promise<LocalSessionUser | null> {
  const store = await cookies()
  const userId = userIdFromToken(store.get(COOKIE)?.value)
  if (!userId) return null

  const db = await readStore()
  const user = db.users.find((candidate) => candidate.id === userId)
  if (!user) return null

  return {
    id: user.id,
    email: user.email,
    profile: db.profiles.find((profile) => profile.user_id === user.id) ?? null,
  }
}

/** A username from a display name, made unique against the accounts that exist. */
export async function uniqueUsername(displayName: string, email: string): Promise<string> {
  const db = await readStore()
  const base =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) ||
    email.split('@')[0]?.replace(/[^a-z0-9_]+/g, '_').slice(0, 20) ||
    'student'

  const taken = new Set(db.profiles.map((profile) => profile.username.toLowerCase()))
  if (!taken.has(base)) return base

  for (let suffix = 2; suffix < 500; suffix += 1) {
    const candidate = `${base}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}${Date.now().toString(36).slice(-4)}`
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
  const normalised = email.trim().toLowerCase()
  const username = await uniqueUsername(displayName, normalised)

  return mutate((db) => {
    if (db.users.some((candidate) => candidate.email === normalised)) return null

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
      visibility: 'public',
      searchable: true,
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
  const user = db.users.find((candidate) => candidate.email === email.trim().toLowerCase())
  if (!user) return null
  if (!verifyPassword(password, user.password_hash)) return null
  return user
}

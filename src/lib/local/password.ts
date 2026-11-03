import 'server-only'

import { cookies, headers } from 'next/headers'
import { passwordSchema, signInSchema } from '@/features/auth/schemas'
import { authAttemptSource, consumeAuthAttempt } from '@/lib/local/auth-security'
import { mutate, readStore, type Tables } from '@/lib/local/db'
import {
  getLocalUserFromSnapshot,
  hashPassword,
  LOCAL_SESSION_COOKIE,
  verifyPassword,
} from '@/lib/local/session'

export type LocalPasswordIdentity = Readonly<{ userId: string; profileId: string | null }>
export type LocalPasswordFailure = {
  ok: false
  reason: 'signed_out' | 'identity_mismatch' | 'invalid_password' | 'throttled'
  retryAfterSeconds?: number
}
export type LocalPasswordResult<T = LocalPasswordIdentity> =
  | { ok: true; value: T }
  | LocalPasswordFailure

export type LocalPasswordReauthentication = {
  /** Derive this from the verified server session, never a posted account ID. */
  expectedUserId: string
  currentPassword: string
}

function authenticate(
  db: Tables,
  token: string | undefined,
  input: LocalPasswordReauthentication,
): LocalPasswordResult {
  const actor = getLocalUserFromSnapshot(db, token)
  if (!actor) return { ok: false, reason: 'signed_out' }
  if (actor.id !== input.expectedUserId) return { ok: false, reason: 'identity_mismatch' }
  const user = db.users.find((row) => row.id === actor.id)!
  if (!signInSchema.shape.password.safeParse(input.currentPassword).success ||
      !verifyPassword(input.currentPassword, user.password_hash)) {
    return { ok: false, reason: 'invalid_password' }
  }
  return { ok: true, value: { userId: actor.id, profileId: actor.profile?.id ?? null } }
}

async function attempt(input: LocalPasswordReauthentication) {
  const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value
  const actor = getLocalUserFromSnapshot(await readStore(), token)
  if (!actor) return { token, failure: { ok: false, reason: 'signed_out' } as const }
  if (actor.id !== input.expectedUserId) {
    return { token, failure: { ok: false, reason: 'identity_mismatch' } as const }
  }
  // Share the existing account/source login budgets: reauthentication must not
  // become a second unbounded password-guessing endpoint.
  const budget = consumeAuthAttempt('login', actor.email, authAttemptSource(await headers()))
  if (!budget.allowed) {
    return {
      token,
      failure: { ok: false, reason: 'throttled', retryAfterSeconds: budget.retryAfterSeconds } as const,
    }
  }
  return { token, failure: null }
}

/**
 * Read-only reauthentication, bound to the current cookie AND expected identity.
 * The result is an observation, not a reusable grant. For account mutations use
 * withLocalPasswordReauthentication so verification and writes cannot race.
 */
export async function reauthenticateLocalPassword(
  input: LocalPasswordReauthentication,
): Promise<LocalPasswordResult> {
  const { token, failure } = await attempt(input)
  if (failure) return failure
  return authenticate(await readStore(), token, input)
}

/**
 * Server-only account-lifecycle hook. Runs a synchronous mutation only after
 * current-password verification inside the latest locked store snapshot.
 * Never return credentials, tokens, hashes or private rows from the callback.
 * A thrown callback/commit error leaves the previous durable snapshot intact.
 */
export async function withLocalPasswordReauthentication<T>(
  input: LocalPasswordReauthentication,
  change: (db: Tables, identity: LocalPasswordIdentity) => T,
): Promise<LocalPasswordResult<T>> {
  const { token, failure } = await attempt(input)
  if (failure) return failure
  return mutate((db) => {
    const verified = authenticate(db, token, input)
    if (!verified.ok) return verified
    const value = change(db, verified.value)
    if (value instanceof Promise) throw new Error('Reauthenticated local mutations must be synchronous')
    return { ok: true as const, value }
  })
}

export type LocalPasswordChangeResult =
  | { ok: true; cookieCleared: boolean }
  | LocalPasswordFailure
  | { ok: false; reason: 'invalid_new_password' | 'same_password' }

/** Change the hash and revoke ALL account sessions in the same durable commit. */
export async function changeLocalPassword(
  input: LocalPasswordReauthentication & { newPassword: string },
): Promise<LocalPasswordChangeResult> {
  if (!passwordSchema.safeParse(input.newPassword).success) {
    return { ok: false, reason: 'invalid_new_password' }
  }
  const result = await withLocalPasswordReauthentication(input, (db, identity) => {
    const account = db.users.find((row) => row.id === identity.userId)!
    if (verifyPassword(input.newPassword, account.password_hash)) return false
    account.password_hash = hashPassword(input.newPassword)
    db.sessions = db.sessions.filter((row) => row.user_id !== identity.userId)
    return true
  })
  if (!result.ok) return result
  if (!result.value) return { ok: false, reason: 'same_password' }

  // Durable revocation is already complete. A stale browser cookie is unusable
  // even if response-cookie deletion fails; do not suggest the password stayed old.
  try {
    (await cookies()).delete(LOCAL_SESSION_COOKIE)
    return { ok: true, cookieCleared: true }
  } catch {
    return { ok: true, cookieCleared: false }
  }
}

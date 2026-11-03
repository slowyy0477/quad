import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { isSupabaseConfigured, publicEnv } from '@/lib/env'
import { assertNotDeployedInLocalMode, isLocalMode } from '@/lib/mode'
import { createClient } from '@/lib/supabase/server'
import { getStaffAssurance } from './staff-assurance'
import type {
  StaffMfaActionState,
  StaffMfaEnrollmentResult,
  StaffMfaSettings,
} from './staff-mfa-state'

export const STAFF_MFA_MAX_AGE_SECONDS = 300
export const STAFF_MFA_FUTURE_SKEW_SECONDS = 30

export type StaffAssuranceReason =
  | 'signed_out' | 'not_staff' | 'mfa_required' | 'unavailable' | 'local_unsupported'

const refusals: Record<StaffAssuranceReason, string> = {
  signed_out: 'Sign in again before using staff account security.',
  not_staff: 'Staff account security is not available to this account.',
  mfa_required: 'Verify an authenticator code to establish a fresh staff session. Staff access remains blocked.',
  unavailable: 'Live staff-session assurance could not be checked. Staff access remains blocked; refresh or contact the operator.',
  local_unsupported: 'Local accounts have no MFA or AAL2 assurance. Staff tools are private-local preview only, not public deployment.',
}

export class StaffAssuranceError extends Error {
  constructor(readonly reason: StaffAssuranceReason) {
    super(refusals[reason])
    this.name = 'StaffAssuranceError'
  }
}

/** A current server observation, not a grant to store, post back or reuse later. */
export type VerifiedStaffSession = {
  userId: string
  role: 'admin' | 'moderator'
  verifiedAt: number
  validUntil: number
}

type Supabase = Awaited<ReturnType<typeof createClient>>
type Factors = NonNullable<Awaited<ReturnType<Supabase['auth']['mfa']['listFactors']>>['data']>['all']
type StaffContext = {
  supabase: Supabase
  userId: string
  role: VerifiedStaffSession['role']
  claims: Record<string, unknown>
  factors: Factors
}

const uuid = z.uuid().refine(value => value !== '00000000-0000-0000-0000-000000000000')
const enrollmentSchema = z.object({
  friendlyName: z.string().trim().min(1, 'Name this authenticator.')
    .max(60, 'Use at most 60 characters.')
    .regex(/^[^\u0000-\u001f\u007f]+$/, 'Use a name without control characters.'),
})
const verificationSchema = z.object({
  factorId: uuid,
  code: z.string().regex(/^[0-9]{6}$/, 'Enter the six-digit code from your authenticator app.'),
})

function invalidFields(error: z.ZodError): StaffMfaActionState {
  const fieldErrors: NonNullable<StaffMfaActionState['fieldErrors']> = {}
  for (const issue of error.issues) {
    const field = issue.path[0]
    if (field === 'friendlyName' || field === 'factorId' || field === 'code') {
      fieldErrors[field] ??= field === 'factorId' ? 'Choose one of your authenticators.' : issue.message
    }
  }
  return { status: 'error', fieldErrors }
}

function failure(error: unknown, fallback: string): StaffMfaActionState {
  if (error instanceof StaffAssuranceError) return { status: 'error', message: error.message }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'mfa_totp_enroll_not_enabled' || code === 'mfa_totp_verify_not_enabled') {
    return { status: 'error', message: 'The account provider has disabled authenticator enrollment or verification. Ask the operator to check the provider configuration.' }
  }
  if (code === 'mfa_verification_failed') {
    return { status: 'error', fieldErrors: { code: 'That code was not accepted. Check your device clock and enter a new six-digit code.' } }
  }
  if (code === 'mfa_challenge_expired' || code === 'mfa_ip_address_mismatch') {
    return { status: 'error', message: 'That challenge expired or was already used. Enter a new authenticator code and try again.' }
  }
  if (code === 'mfa_factor_not_found') {
    return { status: 'error', fieldErrors: { factorId: 'That authenticator is no longer available to your account. Refresh this page.' } }
  }
  if (code === 'mfa_factor_name_conflict') {
    return { status: 'error', fieldErrors: { friendlyName: 'Use a different authenticator name. An existing setup already uses that name.' } }
  }
  if (code === 'too_many_enrolled_mfa_factors') {
    return { status: 'error', message: 'The provider has reached this account’s authenticator limit. Use an existing authenticator or contact the operator; no factors were removed by this form.' }
  }
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || code === 'mfa_verification_rejected') {
    return { status: 'error', message: 'The account provider refused this attempt. Wait before retrying, or contact the operator.' }
  }
  if (code === 'insufficient_aal') return { status: 'error', message: refusals.mfa_required }
  // Raw provider errors can contain identifiers or secrets. Never log or echo them.
  return { status: 'error', message: fallback }
}

/**
 * MFA mutations need a writable request client. The shared read client correctly
 * tolerates Server Component cookie failures, which must NOT imply MFA success.
 * Track writes even if an SDK callback swallows a cookie adapter exception.
 */
async function mutationClient() {
  const env = publicEnv()
  const store = await cookies()
  let writes = 0
  let failed = false
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(values) {
        try {
          for (const { name, value, options } of values) store.set(name, value, options)
          if (values.length) writes++
        } catch {
          failed = true
          throw new Error('MFA session cookies could not be written.')
        }
      },
    },
  })
  return { supabase, written: () => writes, failed: () => failed }
}

async function cloudStaff() {
  // Do not open a local store or manufacture cloud assurance in public local mode.
  assertNotDeployedInLocalMode()
  const initial = await getStaffAssurance()
  if (initial.state !== 'mfa_required' && initial.state !== 'verified') {
    throw new StaffAssuranceError(initial.state)
  }
  if (isLocalMode()) throw new StaffAssuranceError('local_unsupported')
  if (!isSupabaseConfigured()) throw new StaffAssuranceError('unavailable')
  return initial.userId
}

async function readContext(supabase: Supabase, expectedUserId: string, token?: string): Promise<StaffContext> {
  if (!token) {
    const { data, error } = await supabase.auth.getSession()
    if (error || !data.session?.access_token) throw new StaffAssuranceError('signed_out')
    // getSession supplies ONLY the raw token; its cookie user/metadata is not authority.
    token = data.session.access_token
  }
  const [userResult, claimsResult] = await Promise.all([
    supabase.auth.getUser(token),
    supabase.auth.getClaims(token),
  ])
  const user = userResult.data.user
  const claims = claimsResult.data?.claims
  const now = Math.floor(Date.now() / 1_000)
  const issuer = `${publicEnv().NEXT_PUBLIC_SUPABASE_URL}/auth/v1`
  if (userResult.error || !user || user.id !== expectedUserId || user.is_anonymous === true) {
    throw new StaffAssuranceError('signed_out')
  }
  if (claimsResult.error || !claims || claims.sub !== user.id || claims.role !== 'authenticated' ||
      claims.is_anonymous === true || claims.iss !== issuer ||
      !(claims.aud === 'authenticated' || (Array.isArray(claims.aud) && claims.aud.includes('authenticated'))) ||
      !uuid.safeParse(claims.session_id).success ||
      !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > now + STAFF_MFA_FUTURE_SKEW_SECONDS ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp <= claims.iat ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))) {
    throw new StaffAssuranceError('unavailable')
  }
  const { data: roles, error: roleError } = await supabase.from('user_roles')
    .select('role').eq('user_id', user.id)
  if (roleError || !roles) throw new StaffAssuranceError('unavailable')
  const role = roles.some(row => row.role === 'admin') ? 'admin'
    : roles.some(row => row.role === 'moderator') ? 'moderator' : null
  if (!role) throw new StaffAssuranceError('not_staff')

  // The provider fetches the CURRENT user's factors, including unfinished ones.
  // A posted factor ID or an old cookie's factors never establishes ownership.
  const { data: factorData, error: factorError } = await supabase.auth.mfa.listFactors()
  if (factorError || !factorData || !Array.isArray(factorData.all)) {
    throw new StaffAssuranceError('unavailable')
  }
  if (factorData.all.some(factor => !factor || !uuid.safeParse(factor.id).success ||
      (factor.status !== 'verified' && factor.status !== 'unverified'))) {
    throw new StaffAssuranceError('unavailable')
  }
  return { supabase, userId: user.id, role, claims, factors: factorData.all }
}

function freshMfaTime(context: StaffContext, requiredType?: 'totp' | 'webauthn'): number | null {
  if (context.claims.aal !== 'aal2' || !Array.isArray(context.claims.amr)) return null
  const now = Math.floor(Date.now() / 1_000)
  const times: number[] = []
  for (const entry of context.claims.amr as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const { method, timestamp } = entry as Record<string, unknown>
    const factorType = method === 'totp' || method === 'mfa/totp' ? 'totp'
      : method === 'webauthn' || method === 'mfa/webauthn' ? 'webauthn' : null
    if (factorType && (!requiredType || requiredType === factorType) &&
        typeof timestamp === 'number' && Number.isSafeInteger(timestamp) &&
        timestamp >= now - STAFF_MFA_MAX_AGE_SECONDS && timestamp <= now + STAFF_MFA_FUTURE_SKEW_SECONDS &&
        context.factors.some(factor => factor.factor_type === factorType && factor.status === 'verified')) {
      times.push(timestamp)
    }
  }
  return times.length ? Math.max(...times) : null
}

async function assured(context: StaffContext): Promise<VerifiedStaffSession> {
  const verifiedAt = freshMfaTime(context)
  if (verifiedAt === null) throw new StaffAssuranceError('mfa_required')
  // Main's forward 0033 owns real auth.sessions/lifecycle/fresh-AAL2 enforcement.
  // No arguments, client identity, service-role key or JWT-only fallback.
  const { data, error } = await context.supabase.rpc('staff_session_assured')
  if (error) throw new StaffAssuranceError('unavailable')
  if (data !== true) throw new StaffAssuranceError('mfa_required')
  if (freshMfaTime(context) === null || (context.claims.exp as number) <= Math.floor(Date.now() / 1_000)) {
    throw new StaffAssuranceError('mfa_required')
  }
  return {
    userId: context.userId,
    role: context.role,
    verifiedAt,
    validUntil: Math.min(context.claims.exp as number, verifiedAt + STAFF_MFA_MAX_AGE_SECONDS),
  }
}

/**
 * Cloud boundary for EACH staff read/action, not only a layout. Local preview
 * access remains main's separate private-local role gate; it is never AAL2.
 * Missing 0033, revoked sessions, stale/removed factors and outages fail closed.
 */
export async function requireStaffAssurance(): Promise<VerifiedStaffSession> {
  try {
    const userId = await cloudStaff()
    return await assured(await readContext(await createClient(), userId))
  } catch (error) {
    if (error instanceof StaffAssuranceError) throw error
    throw new StaffAssuranceError('unavailable')
  }
}

/** Read-only settings projection. Enrollment and challenges never run on GET. */
export async function getStaffMfaSettings(): Promise<StaffMfaSettings> {
  try {
    assertNotDeployedInLocalMode()
    const initial = await getStaffAssurance()
    if (initial.state !== 'mfa_required' && initial.state !== 'verified') return { state: initial.state }
    if (isLocalMode()) return { state: 'local_unsupported' }
    if (!isSupabaseConfigured()) return { state: 'unavailable' }
    const context = await readContext(await createClient(), initial.userId)
    let isAssured = false
    let assuranceUnavailable = false
    try {
      await assured(context)
      isAssured = true
    } catch (error) {
      assuranceUnavailable = !(error instanceof StaffAssuranceError && error.reason === 'mfa_required')
    }
    return {
      state: 'cloud', assured: isAssured, assuranceUnavailable,
      canEnroll: !context.factors.some(factor => factor.status === 'verified') || isAssured,
      hasOtherFactors: context.factors.some(factor => factor.factor_type !== 'totp' && factor.status === 'verified'),
      factors: context.factors.filter(factor => factor.factor_type === 'totp' && uuid.safeParse(factor.id).success)
        .map((factor, index) => ({
          id: factor.id,
          name: factor.friendly_name?.slice(0, 60) || `Authenticator ${index + 1}`,
          status: factor.status,
        })),
    }
  } catch (error) {
    if (error instanceof StaffAssuranceError && error.reason !== 'mfa_required') return { state: error.reason }
    return { state: 'unavailable' }
  }
}

/** Render provider SVG as a bounded, inert data image, never injected HTML or a remote URL. */
function qrImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256_000) return null
  const prefix = 'data:image/svg+xml;utf-8,'
  const svg = (value.startsWith(prefix) ? value.slice(prefix.length) : value)
    .replace(/^\s*<\?xml[^?]*\?>\s*/i, '')
    // Supabase's SVGo renderer includes a harmless generator comment.
    .replace(/<!--[\s\S]*?-->/g, '').trim()
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg) ||
      /<!|<\s*(?:script|foreignObject|iframe|object|image|use|style|a)\b|\b(?:on[a-z]+|(?:xlink:)?href)\s*=|url\s*\(/i.test(svg)) {
    return null
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export async function enrollStaffAuthenticator(input: { friendlyName: unknown }): Promise<StaffMfaEnrollmentResult> {
  const parsed = enrollmentSchema.safeParse(input)
  if (!parsed.success) return invalidFields(parsed.error)
  try {
    const userId = await cloudStaff()
    const writer = await mutationClient()
    const context = await readContext(writer.supabase, userId)
    // A stolen AAL1 session must not add a replacement factor to an MFA account.
    if (context.factors.some(factor => factor.status === 'verified')) await assured(context)
    const { data, error } = await context.supabase.auth.mfa.enroll({
      factorType: 'totp', friendlyName: parsed.data.friendlyName, issuer: 'Bulla',
    })
    if (error) return failure(error, 'Authenticator enrollment was not confirmed. Refresh this page before retrying; an unfinished setup may exist.')
    const qrCode = qrImage(data?.totp.qr_code)
    if (!data || data.type !== 'totp' || !uuid.safeParse(data.id).success || !qrCode) {
      return { status: 'error', message: 'The provider did not return a safe setup QR. Refresh this page before retrying; an unfinished authenticator may exist.' }
    }
    const { data: factors, error: factorError } = await context.supabase.auth.mfa.listFactors()
    if (writer.failed() || factorError || !factors?.all.some(factor =>
      factor.id === data.id && factor.factor_type === 'totp' && factor.status === 'unverified')) {
      return { status: 'error', message: 'Ownership of the new authenticator could not be confirmed. Refresh this page before trying again.' }
    }
    // The QR is the ONLY setup secret returned. Discard raw secret/URI/tokens.
    return { status: 'enrolled', factorId: data.id, qrCode }
  } catch (error) {
    return failure(error, 'Authenticator enrollment was not confirmed. Refresh this page before retrying; an unfinished setup may exist.')
  }
}

export async function verifyStaffAuthenticator(input: { factorId: unknown; code: unknown }): Promise<StaffMfaActionState> {
  const parsed = verificationSchema.safeParse(input)
  if (!parsed.success) return invalidFields(parsed.error)
  let providerVerified = false
  try {
    const userId = await cloudStaff()
    const writer = await mutationClient()
    const context = await readContext(writer.supabase, userId)
    const factor = context.factors.find(item => item.id === parsed.data.factorId && item.factor_type === 'totp')
    if (!factor) return { status: 'error', fieldErrors: { factorId: 'Choose one of your authenticators. Refresh if it was removed.' } }
    if (factor.status !== 'verified' && context.factors.some(item => item.status === 'verified')) {
      await assured(context)
    }
    // A fresh provider challenge is created and redeemed in this same request.
    // Never accept posted challenge IDs, expiry, QR data, identity or AAL flags.
    const attemptAt = Math.floor(Date.now() / 1_000)
    const { data: challenge, error: challengeError } = await context.supabase.auth.mfa.challenge({ factorId: factor.id })
    if (challengeError) return failure(challengeError, 'The provider could not create an authenticator challenge. Try again later.')
    if (!challenge || challenge.type !== 'totp' || !uuid.safeParse(challenge.id).success ||
        !Number.isSafeInteger(challenge.expires_at) || challenge.expires_at <= Math.floor(Date.now() / 1_000)) {
      return { status: 'error', message: 'The provider challenge is missing or expired. Enter a new code and try again.' }
    }
    const before = writer.written()
    const { data, error } = await context.supabase.auth.mfa.verify({
      factorId: factor.id, challengeId: challenge.id, code: parsed.data.code,
    })
    if (error) return failure(error, 'Authenticator verification was not confirmed. Refresh account security before retrying.')
    providerVerified = true
    if (!data?.access_token || data.user.id !== userId || writer.failed() || writer.written() <= before) {
      throw new StaffAssuranceError('unavailable')
    }
    const { data: stored, error: storedError } = await context.supabase.auth.getSession()
    if (storedError || stored.session?.access_token !== data.access_token) {
      throw new StaffAssuranceError('unavailable')
    }
    const updated = await readContext(context.supabase, userId, data.access_token)
    const verifiedAt = freshMfaTime(updated, 'totp')
    if (updated.claims.session_id !== context.claims.session_id ||
        verifiedAt === null || verifiedAt < attemptAt - STAFF_MFA_FUTURE_SKEW_SECONDS ||
        (updated.claims.iat as number) < attemptAt - STAFF_MFA_FUTURE_SKEW_SECONDS ||
        !updated.factors.some(item => item.id === factor.id && item.factor_type === 'totp' && item.status === 'verified')) {
      throw new StaffAssuranceError('unavailable')
    }
    await assured(updated)
    return { status: 'verified', message: 'Authenticator verified for this session. Staff access is checked on every request and expires five minutes after verification.' }
  } catch (error) {
    if (providerVerified) {
      return { status: 'verified_unassured', message: 'The provider accepted the authenticator, but fresh live staff-session assurance or session persistence was not confirmed. Staff access remains blocked. Refresh or contact the operator.' }
    }
    return failure(error, 'Authenticator verification was not confirmed. Refresh account security before retrying; a provider-side change may already have completed.')
  }
}


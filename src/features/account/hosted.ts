import 'server-only'

import { createClient as createSupabaseClient, type User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { publicEnv } from '@/lib/env'
import { authAttemptSource, consumeAuthAttempt } from '@/lib/local/auth-security'
import { headers } from 'next/headers'
import { EXPORT_SECTION_NAMES } from './policy'
import type { ExportSection } from './policy'
import { ExportSizeError, finishAccountExport, projectExportRecord } from './export'
import type { AccountExport, DeletionReceipt, ExportOptions, LifecycleErrorCode, LifecycleResult, OwnershipBlockers } from './types'

type Client = Awaited<ReturnType<typeof createClient>>

const ERROR_CODES = new Set<LifecycleErrorCode>([
  'signed_out', 'identity_mismatch', 'invalid_password', 'throttled', 'invalid_request',
  'confirmation_required', 'ownership_transfer_required', 'owner_role_inconsistent',
  'last_administrator', 'shared_media_ownership', 'provider_assurance_required',
  'account_unavailable', 'export_too_large', 'unavailable', 'not_found',
])

export function hostedLifecycleFailure(error: { hint?: string | null; code?: string; status?: number } | null): LifecycleResult<never> {
  if (error?.hint && ERROR_CODES.has(error.hint as LifecycleErrorCode)) return { ok: false, code: error.hint as LifecycleErrorCode }
  if (error?.status === 429 || error?.code === 'over_request_rate_limit') return { ok: false, code: 'throttled', retryAfterSeconds: 60 }
  return { ok: false, code: 'unavailable' }
}

/** Only feed this claims returned by auth.getClaims(), not a decoded cookie/JWT. */
export function hasFreshStrongProviderAssurance(claims: Record<string, unknown>, timestamp = Date.now()): boolean {
  if (claims.aal !== 'aal2' || !Array.isArray(claims.amr)) return false
  return claims.amr.some(value => {
    if (!value || typeof value !== 'object') return false
    const method = value as { method?: unknown; timestamp?: unknown }
    const age = timestamp / 1000 - Number(method.timestamp)
    return typeof method.timestamp === 'number' && Number.isFinite(age) && age >= -30 && age <= 300 &&
      ['totp', 'mfa/totp', 'webauthn', 'mfa/webauthn'].includes(String(method.method))
  })
}

/**
 * Password sign-in is ephemeral: it must not switch the browser to another
 * account or persist fresh bearer tokens in form state. Identity is checked
 * against the original provider-verified user. DB RPCs independently require
 * fresh signed AMR AND a live auth.sessions row, including for raw callers.
 */
export async function withHostedAccountReauthentication<T>(
  input: { password: string; totpCode?: string },
  action: (client: Client, user: User) => Promise<LifecycleResult<T>>,
): Promise<LifecycleResult<T>> {
  const original = await createClient()
  const verified = await original.auth.getUser()
  const user = verified.data.user
  if (verified.error || !user) return { ok: false, code: 'signed_out' }
  if (user.is_anonymous) return { ok: false, code: 'provider_assurance_required' }
  const budget = consumeAuthAttempt('login', user.email ?? user.id, authAttemptSource(await headers()))
  if (!budget.allowed) return { ok: false, code: 'throttled', retryAfterSeconds: budget.retryAfterSeconds }
  const roles = await original.from('user_roles').select('role').eq('user_id', user.id)
  if (roles.error || !Array.isArray(roles.data)) return { ok: false, code: 'unavailable' }
  const needsMfa = roles.data.some(row => row.role === 'admin' || row.role === 'moderator') ||
    user.factors?.some(factor => factor.status === 'verified') === true
  let ephemeral: Client | null = null
  try {
    if (input.password) {
      if (!user.email) return { ok: false, code: 'provider_assurance_required' }
      const env = publicEnv()
      ephemeral = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
      const signedIn = await ephemeral.auth.signInWithPassword({ email: user.email, password: input.password })
      if (signedIn.error) {
        if (signedIn.error.status === 429) return { ok: false, code: 'throttled', retryAfterSeconds: 60 }
        return { ok: false, code: 'invalid_password' }
      }
      if (!signedIn.data.user || !signedIn.data.session || signedIn.data.user.id !== user.id) {
        return { ok: false, code: 'identity_mismatch' }
      }
      const fresh = await ephemeral.auth.getUser()
      if (fresh.error || fresh.data.user?.id !== user.id) return { ok: false, code: 'identity_mismatch' }
    }
    if (input.totpCode) {
      // A browser cannot supply a factor/user/email ID. Resolve the user's own
      // first verified authenticator from the provider-verified account.
      const factor = user.factors?.find(candidate => candidate.factor_type === 'totp' && candidate.status === 'verified')
      if (!factor || !/^\d{6}$/.test(input.totpCode)) return { ok: false, code: 'provider_assurance_required' }
      const challenge = await original.auth.mfa.challengeAndVerify({ factorId: factor.id, code: input.totpCode })
      if (challenge.error) return { ok: false, code: 'provider_assurance_required' }
    }
    if (needsMfa || !input.password || input.totpCode) {
      const proof = await original.auth.getClaims()
      if (proof.error || proof.data?.claims.sub !== user.id ||
          !hasFreshStrongProviderAssurance(proof.data.claims as unknown as Record<string, unknown>)) {
        return { ok: false, code: 'provider_assurance_required' }
      }
      return await action(original, user)
    }
    if (!ephemeral) return { ok: false, code: 'provider_assurance_required' }
    return await action(ephemeral, user)
  } finally {
    // No global sign-out on export: revoke only the temporary password session.
    if (ephemeral) await ephemeral.auth.signOut({ scope: 'local' }).catch(() => {})
  }
}

const hostedFields: Record<ExportSection, string> = {
  profile: 'id username display_name avatar_url cover_url headline bio university_id department_id program_id degree semester graduation_year location website github_username linkedin_url twitter_username visibility searchable allow_messages_from allow_connection_requests onboarding_completed created_at',
  posts: 'id body visibility project_id goal_id created_at deleted_at',
  comments: 'id post_id parent_id body created_at deleted_at',
  messages: 'id conversation_id body attachment_path attachment_mime attachment_size attachment_name created_at deleted_at',
  projects: 'id slug title tagline description category status visibility cover_url repo_url demo_url is_seeking_members looking_for team_size_target started_at completed_at created_at deleted_at',
  project_memberships: 'project_id role title joined_at',
  project_applications: 'id project_id message desired_role status reviewed_at created_at',
  project_invites_sent: 'id project_id message proposed_role status responded_at created_at updated_at',
  project_invites_received: 'id project_id status responded_at created_at updated_at',
  project_stars: 'project_id created_at',
  ideas: 'id title description category status visibility converted_project_id created_at deleted_at',
  idea_votes: 'idea_id created_at', idea_interest: 'idea_id message offering created_at',
  connections: 'id addressee_id status message created_at responded_at',
  follows: 'following_id created_at', blocks: 'blocked_id reason created_at',
  profile_skills: 'skill_id level is_learning display_order created_at',
  profile_interests: 'interest_id created_at', endorsements_given: 'profile_id skill_id created_at',
  achievements: 'achievement_key awarded_at awarded_value is_pinned',
  semesters: 'id name term year start_date end_date is_current created_at',
  courses: 'id semester_id code title instructor credits status grade created_at',
  goals: 'id semester_id course_id title description category status target_value current_value unit progress_percent visibility target_date completed_at created_at',
  goal_milestones: 'id goal_id title is_completed completed_at target_date sort_order',
  daily_logs: 'id log_date hours_studied mood productivity summary wins blockers created_at updated_at',
  opportunities: 'id title organisation description type work_mode visibility compensation location apply_url apply_email deadline starts_on status created_at deleted_at',
  opportunity_saves: 'opportunity_id created_at',
  events: 'id title description location starts_at ends_at timezone capacity visibility status created_at deleted_at',
  event_attendees: 'event_id status created_at', post_likes: 'post_id created_at', post_saves: 'post_id created_at',
  notifications: 'id type is_read created_at', reports: 'id kind reason detail status created_at',
  bug_reports: 'id title body page_url status created_at updated_at',
  university_requests: 'id name short_name city country website status created_at',
}

export async function exportHostedAccount(
  credentials: { password: string; totpCode?: string },
  options: ExportOptions,
): Promise<LifecycleResult<AccountExport>> {
  return withHostedAccountReauthentication(credentials, async (client, user) => {
    const exported = await client.rpc('account_export', {
      p_section: options.section ?? null, p_after: options.after ?? null, p_limit: options.limit ?? 25,
    })
    if (exported.error) return hostedLifecycleFailure(exported.error)
    const raw = exported.data as { subject_id?: unknown; sections?: unknown } | null
    if (!raw || raw.subject_id !== user.id || !raw.sections || typeof raw.sections !== 'object' || Array.isArray(raw.sections)) {
      return { ok: false, code: 'unavailable' }
    }
    const sections: AccountExport['sections'] = {}
    const expected = options.section ? [options.section] : EXPORT_SECTION_NAMES
    try {
      for (const section of expected) {
        const page = (raw.sections as Record<string, unknown>)[section] as { records?: unknown; next_cursor?: unknown } | undefined
        if (!page || !Array.isArray(page.records) || page.records.length > (options.limit ?? 25) ||
            !(page.next_cursor === null || (typeof page.next_cursor === 'string' && /^[A-Za-z0-9_:-]{1,256}$/.test(page.next_cursor))) ||
            page.records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
          return { ok: false, code: 'unavailable' }
        }
        sections[section] = {
          records: page.records.map(row => projectExportRecord(row, hostedFields[section].split(' '))),
          next_cursor: page.next_cursor,
        }
      }
      return { ok: true, value: finishAccountExport({ user_id: user.id, profile_id: user.id, email: user.email ?? null }, 'supabase', sections) }
    } catch (error) {
      if (error instanceof ExportSizeError) return { ok: false, code: 'export_too_large' }
      throw error
    }
  })
}

export function parseDeletionReceipt(value: unknown): DeletionReceipt | null {
  if (!value || typeof value !== 'object') return null
  const row = value as DeletionReceipt
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
      !['queued', 'processing', 'retry', 'blocked', 'failed', 'completed'].includes(row.state) ||
      !['media', 'content', 'auth', 'complete'].includes(row.phase)) return null
  return { id: row.id, state: row.state, phase: row.phase }
}

export async function requestHostedAccountDeletion(input: {
  password: string; totpCode?: string; confirmation: string; acknowledge: boolean; idempotencyKey: string
}): Promise<LifecycleResult<DeletionReceipt>> {
  const result = await withHostedAccountReauthentication(input, async client => {
    const queued = await client.rpc('account_request_deletion', {
      p_confirmation: input.confirmation, p_acknowledge: input.acknowledge, p_request_key: input.idempotencyKey,
    })
    if (queued.error) return hostedLifecycleFailure(queued.error)
    const value = parseDeletionReceipt(queued.data)
    return value ? { ok: true as const, value } : { ok: false as const, code: 'unavailable' as const }
  })
  if (result.ok) {
    // DB revocation/restriction already committed. A cookie/provider outage
    // must never turn an accepted durable request into a false "not queued".
    try { await (await createClient()).auth.signOut({ scope: 'global' }) } catch { /* Old JWT data access is gated by SQL. */ }
  }
  return result
}

export async function getHostedAccountBlockers(): Promise<LifecycleResult<OwnershipBlockers>> {
  const client = await createClient()
  const verified = await client.auth.getUser()
  if (verified.error || !verified.data.user) return { ok: false, code: 'signed_out' }
  const response = await client.rpc('account_lifecycle_preflight')
  if (response.error) return hostedLifecycleFailure(response.error)
  const row = response.data as OwnershipBlockers | null
  if (!row || !Array.isArray(row.projects) || row.projects.length > 50 ||
      ['moreProjects', 'inconsistentOwnerRole', 'lastAdministrator', 'sharedMedia', 'ownedStorageBucket'].some(key => typeof row[key as keyof OwnershipBlockers] !== 'boolean') ||
      row.projects.some(project => !project || typeof project.id !== 'string' || typeof project.slug !== 'string' || typeof project.title !== 'string' || typeof project.deleted !== 'boolean')) {
    return { ok: false, code: 'unavailable' }
  }
  return { ok: true, value: {
    projects: row.projects.map(project => ({ id: project.id, slug: project.slug, title: project.title, deleted: project.deleted })),
    moreProjects: row.moreProjects, inconsistentOwnerRole: row.inconsistentOwnerRole,
    lastAdministrator: row.lastAdministrator, sharedMedia: row.sharedMedia, ownedStorageBucket: row.ownedStorageBucket,
  } }
}

export async function getHostedDeletionReceipt(id: string): Promise<DeletionReceipt | null> {
  const response = await (await createClient()).rpc('account_deletion_status', { p_receipt: id })
  if (response.error) throw new Error('Account receipt lookup unavailable')
  return parseDeletionReceipt(response.data)
}

/** Local-only extensions. Foreign keys always reference profile ids, not user ids.
 * Catalogue / collaboration rows mirror docs/plan/SCHEMA.md and 0020_reports.sql.
 * Sidecar state keeps old JSON rows backwards compatible without weakening defaults.
 */
export type LocalConnection = { id: string; requester_id: string; addressee_id: string; status: 'pending' | 'accepted' | 'rejected'; message: string | null; created_at: string; responded_at: string | null }
export type LocalFollow = { id: string; follower_id: string; following_id: string; created_at: string }
export type LocalBlock = { id: string; blocker_id: string; blocked_id: string; reason: string | null; created_at: string }
export type LocalCatalogueEntry = { id: string; name: string; slug: string; category: string; is_approved: boolean; usage_count: number; created_by: string | null; created_at: string }
export type LocalProfileSkill = { id: string; profile_id: string; skill_id: string; level: 'learning' | 'familiar' | 'proficient' | 'advanced'; is_learning: boolean; display_order: number; endorsement_count: number; created_at: string }
export type LocalApplication = { id: string; project_id: string; applicant_id: string; message: string | null; desired_role: string | null; status: 'pending' | 'accepted' | 'rejected' | 'withdrawn'; reviewed_by: string | null; reviewed_at: string | null; created_at: string }
/** Private between the recipient and project managers; never a membership until accepted. */
export type LocalProjectInvite = { id: string; project_id: string; invitee_id: string; inviter_id: string; message: string | null; proposed_role: string | null; status: 'pending' | 'accepted' | 'declined' | 'revoked'; responded_at: string | null; created_at: string; updated_at: string }
export type LocalAchievementDefinition = { id: string; key: string; name: string; description: string; criteria: string; category: string; tier: string; icon: string; sort_order: number; is_active: boolean; created_at: string }
export type LocalAuditAction = { id: string; actor_id: string; report_id: string | null; action: string; reason: string; target_profile_id: string | null; target_id: string | null; created_at: string }
export type LocalUniversityRequest = { id: string; name: string; short_name: string | null; city: string | null; country: string | null; website: string | null; submitted_by: string; status: 'pending' | 'approved' | 'rejected'; reason: string | null; reviewed_by: string | null; reviewed_at: string | null; created_at: string }
/** Reference-only directory rows. is_verified curates the name, not membership. */
export type LocalDepartment = { id: string; university_id: string; name: string; slug: string; is_verified: boolean; created_by: string | null; created_at: string }
/** Durable lifecycle sidecars; completed jobs discard their account identifiers. */
export type LocalAccountDeletionJob = {
  id: string
  user_id: string | null
  profile_id: string | null
  idempotency_key: string | null
  policy_version: string
  state: 'queued' | 'processing' | 'retry' | 'blocked' | 'failed' | 'completed'
  phase: 'content' | 'media' | 'auth' | 'complete'
  attempts: number
  created_at: string
  updated_at: string
  next_attempt_at: string
  lease_expires_at: string | null
  lease_token: string | null
  error_code: 'cleanup_failed' | 'ownership_transfer_required' | 'owner_role_inconsistent' | 'last_administrator' | 'shared_media_ownership' | null
  completed_at: string | null
}
export type LocalRetainedModerationSummary = {
  id: string
  deletion_job_id: string
  category: 'report' | 'action'
  outcome: string
  /** UTC date only; no source row, actor, target, body, reason or identity. */
  occurred_on: string
  expires_at: string
}
export type LocalAccountDeletionMedia = {
  id: string
  deletion_job_id: string
  image_id: string
  state: 'pending' | 'removed'
}
export type DomainTables = {
  departments: LocalDepartment[]
  connections: LocalConnection[]
  follows: LocalFollow[]
  blocks: LocalBlock[]
  skills: LocalCatalogueEntry[]
  interests: LocalCatalogueEntry[]
  profile_skills: LocalProfileSkill[]
  profile_interests: { id: string; profile_id: string; interest_id: string; created_at: string }[]
  profile_skill_endorsements: { id: string; profile_id: string; skill_id: string; endorser_id: string; created_at: string }[]
  project_applications: LocalApplication[]
  project_invites: LocalProjectInvite[]
  project_stars: { id: string; project_id: string; profile_id: string; created_at: string }[]
  project_skills: { id: string; project_id: string; skill_id: string; is_required: boolean; created_at: string }[]
  idea_votes: { id: string; idea_id: string; profile_id: string; created_at: string }[]
  idea_interest: { id: string; idea_id: string; profile_id: string; message: string | null; offering: string | null; created_at: string }[]
  idea_skills: { id: string; idea_id: string; skill_id: string; created_at: string }[]
  achievement_definitions: LocalAchievementDefinition[]
  profile_achievements: { id: string; profile_id: string; achievement_key: string; awarded_at: string; awarded_value: number | null; is_pinned: boolean }[]
  moderation_actions: LocalAuditAction[]
  bug_reports: { id: string; reporter_id: string; title: string; body: string; page_url: string | null; status: 'open' | 'reviewed' | 'fixed' | 'closed'; created_at: string; updated_at: string }[]
  university_requests: LocalUniversityRequest[]
  profile_account_states: { id: string; profile_id: string; status: 'active' | 'suspended'; suspended_until: string | null; warning_count: number }[]
  content_moderation: { id: string; kind: string; target_id: string; status: 'active' | 'hidden' | 'removed' }[]
  participant_preferences: { id: string; conversation_id: string; profile_id: string; is_muted: boolean; left_at: string | null }[]
  account_deletion_jobs: LocalAccountDeletionJob[]
  account_retained_moderation: LocalRetainedModerationSummary[]
  account_deletion_media: LocalAccountDeletionMedia[]
}
export const EMPTY_DOMAIN_TABLES: DomainTables = {
  departments: [],
  connections: [], follows: [], blocks: [], skills: [], interests: [], profile_skills: [], profile_interests: [], profile_skill_endorsements: [],
  project_applications: [], project_invites: [], project_stars: [], project_skills: [], idea_votes: [], idea_interest: [], idea_skills: [],
  achievement_definitions: [], profile_achievements: [], moderation_actions: [], bug_reports: [], university_requests: [],
  profile_account_states: [], content_moderation: [], participant_preferences: [],
  account_deletion_jobs: [], account_retained_moderation: [], account_deletion_media: [],
}

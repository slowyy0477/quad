import 'server-only'

import type { Tables } from '@/lib/local/db'
import { ACCOUNT_POLICY_VERSION, EXPORT_EXCLUSIONS, EXPORT_MAX_BYTES, EXPORT_SECTION_NAMES } from './policy'
import type { ExportSection } from './policy'
import type { AccountExport, ExportOptions, ExportPage, ExportRecord } from './types'

type LocalExportSpec = {
  table: keyof Tables
  fields: readonly string[]
  own: (row: Record<string, unknown>, profileId: string, db: Tables) => boolean
}
const owned = (field: string) => (row: Record<string, unknown>, profileId: string) => row[field] === profileId
const fields = (names: string) => names.split(' ')

/** Positive projections, not "delete known secrets" from arbitrary stored rows. */
export const LOCAL_EXPORT_SPECS: Record<ExportSection, LocalExportSpec> = {
  profile: { table: 'profiles', own: (r, p) => r.id === p, fields: fields('id username display_name bio avatar_url university_id department_id department programme semester website github degree headline graduation_year location github_username linkedin_url twitter_username visibility searchable allow_messages_from allow_connection_requests onboarding_completed created_at') },
  posts: { table: 'posts', own: owned('author_id'), fields: fields('id body visibility project_id goal_id created_at deleted_at') },
  comments: { table: 'comments', own: owned('author_id'), fields: fields('id post_id parent_id body created_at deleted_at') },
  messages: { table: 'messages', own: owned('author_id'), fields: fields('id conversation_id body created_at') },
  projects: { table: 'projects', own: owned('owner_id'), fields: fields('id slug title purpose description category status visibility is_seeking_members team_size_target created_at deleted_at') },
  project_memberships: { table: 'project_members', own: owned('profile_id'), fields: fields('id project_id role created_at') },
  project_applications: { table: 'project_applications', own: owned('applicant_id'), fields: fields('id project_id message desired_role status created_at reviewed_at') },
  // Management is not authorship. Never export another manager's private note.
  project_invites_sent: { table: 'project_invites', own: owned('inviter_id'), fields: fields('id project_id message proposed_role status responded_at created_at updated_at') },
  // Receiving an invitation permits this relationship/outcome DTO, not an
  // export of its author's free text, identity or the private project itself.
  project_invites_received: { table: 'project_invites', own: owned('invitee_id'), fields: fields('id project_id status responded_at created_at updated_at') },
  project_stars: { table: 'project_stars', own: owned('profile_id'), fields: fields('id project_id created_at') },
  ideas: { table: 'ideas', own: owned('author_id'), fields: fields('id title description category status visibility converted_project_id created_at deleted_at') },
  idea_votes: { table: 'idea_votes', own: owned('profile_id'), fields: fields('id idea_id created_at') },
  idea_interest: { table: 'idea_interest', own: owned('profile_id'), fields: fields('id idea_id message offering created_at') },
  connections: { table: 'connections', own: owned('requester_id'), fields: fields('id addressee_id status message created_at responded_at') },
  follows: { table: 'follows', own: owned('follower_id'), fields: fields('id following_id created_at') },
  blocks: { table: 'blocks', own: owned('blocker_id'), fields: fields('id blocked_id reason created_at') },
  profile_skills: { table: 'profile_skills', own: owned('profile_id'), fields: fields('id skill_id level is_learning display_order created_at') },
  profile_interests: { table: 'profile_interests', own: owned('profile_id'), fields: fields('id interest_id created_at') },
  endorsements_given: { table: 'profile_skill_endorsements', own: owned('endorser_id'), fields: fields('id profile_id skill_id created_at') },
  achievements: { table: 'profile_achievements', own: owned('profile_id'), fields: fields('id achievement_key awarded_at awarded_value is_pinned') },
  semesters: { table: 'semesters', own: owned('profile_id'), fields: fields('id name term year start_date end_date is_current created_at') },
  courses: { table: 'courses', own: owned('profile_id'), fields: fields('id semester_id code title instructor credits status grade created_at') },
  goals: { table: 'goals', own: owned('profile_id'), fields: fields('id semester_id course_id title description category status target_value current_value unit progress_percent visibility target_date completed_at created_at') },
  goal_milestones: { table: 'goal_milestones', own: (r, p, db) => db.goals.some(g => g.id === r.goal_id && g.profile_id === p), fields: fields('id goal_id title is_completed completed_at target_date sort_order') },
  daily_logs: { table: 'daily_logs', own: owned('profile_id'), fields: fields('id log_date hours_studied mood productivity summary wins blockers created_at updated_at') },
  opportunities: { table: 'opportunities', own: owned('posted_by'), fields: fields('id title organisation description type work_mode visibility compensation location apply_url apply_email deadline starts_on status created_at deleted_at') },
  opportunity_saves: { table: 'opportunity_saves', own: owned('profile_id'), fields: fields('id opportunity_id post_id created_at') },
  events: { table: 'events', own: owned('created_by'), fields: fields('id title description location starts_at ends_at timezone capacity visibility status created_at deleted_at') },
  event_attendees: { table: 'event_attendees', own: owned('profile_id'), fields: fields('id event_id status created_at') },
  post_likes: { table: 'post_likes', own: owned('profile_id'), fields: fields('id post_id created_at') },
  post_saves: { table: 'post_saves', own: owned('profile_id'), fields: fields('id post_id created_at') },
  notifications: { table: 'notifications', own: owned('recipient_id'), fields: fields('id type is_read created_at') },
  reports: { table: 'reports', own: owned('reporter_id'), fields: fields('id reason detail status created_at') },
  bug_reports: { table: 'bug_reports', own: owned('reporter_id'), fields: fields('id title body page_url status created_at updated_at') },
  university_requests: { table: 'university_requests', own: owned('submitted_by'), fields: fields('id name short_name city country website status created_at') },
}

export class ExportSizeError extends Error {}

export function projectExportRecord(row: Record<string, unknown>, keys: readonly string[]): ExportRecord {
  const record: ExportRecord = {}
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string') {
      if (value.length > 20_000) throw new ExportSizeError('Export field exceeds the bounded page contract')
      record[key] = value
    } else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      record[key] = value
    }
    // Objects/metadata/unknown new columns cannot accidentally cross this DTO.
  }
  return record
}

export function finishAccountExport(
  subject: AccountExport['subject'],
  mode: AccountExport['mode'],
  sections: AccountExport['sections'],
): AccountExport {
  const value: AccountExport = {
    schema_version: 1,
    policy_version: ACCOUNT_POLICY_VERSION,
    mode,
    generated_at: new Date().toISOString(),
    subject,
    sections,
    complete_for_selected_sections: Object.values(sections).every(page => !page?.next_cursor),
    excluded: EXPORT_EXCLUSIONS,
    continuation: { method: 'POST', path: '/api/account/export', reauthenticate_each_page: true },
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > EXPORT_MAX_BYTES) throw new ExportSizeError('Export exceeds its byte limit')
  return value
}

export function buildLocalAccountExport(
  db: Tables,
  identity: { userId: string; profileId: string },
  options: ExportOptions,
): AccountExport {
  const sections: Partial<Record<ExportSection, ExportPage>> = {}
  const limit = options.limit ?? 25
  for (const section of options.section ? [options.section] : EXPORT_SECTION_NAMES) {
    const spec = LOCAL_EXPORT_SPECS[section]
    const candidates = (db[spec.table] as unknown as Record<string, unknown>[])
      .filter(row => spec.own(row, identity.profileId, db) && typeof row.id === 'string' && (!options.after || row.id > options.after))
      .sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
      .slice(0, limit + 1)
    sections[section] = {
      records: candidates.slice(0, limit).map(row => projectExportRecord(row, spec.fields)),
      next_cursor: candidates.length > limit ? String(candidates[limit - 1].id) : null,
    }
  }
  const user = db.users.find(row => row.id === identity.userId)
  return finishAccountExport({
    user_id: identity.userId, profile_id: identity.profileId, email: user?.email ?? null,
  }, 'local', sections)
}

/**
 * Build status.
 *
 * Current Bulla feature ledger, reviewed on 31 October 2026.
 * "Working" covers the explicit tested scope, not a production launch claim.
 * "Partial" also includes implemented features awaiting hosted verification.
 *
 * A single hand-maintained record of what works, so the claim appears in exactly
 * one place instead of being implied differently by each page. The brief forbids
 * describing a feature as complete when only its interface exists; this file is
 * how that promise is kept honest and reviewable.
 *
 * Statuses mean specific things:
 *
 *   working      end-to-end: schema, policies, server code and interface. Usable.
 *   partial      some of it works and the page says which part does not.
 *   schema-only  tables, policies and tests exist; there is no interface yet.
 *   planned      designed, not built. Nothing in the interface pretends otherwise.
 *
 * "Tested" refers to the automated database permission tests in tests/db, which
 * run the real migrations against an in-process Postgres and assert what each
 * role can and cannot do.
 */
export type FeatureStatus = 'working' | 'partial' | 'schema-only' | 'planned'
export const LAST_REVIEWED = '31 October 2026'

export type Feature = {
  area: string
  name: string
  status: FeatureStatus
  note: string
}

export const STATUS_LABELS: Record<FeatureStatus, string> = {
  working: 'Verified scope',
  partial: 'Partly complete',
  'schema-only': 'Database only',
  planned: 'Not implemented',
}

export const FEATURES: Feature[] = [
  // ---------------------------------------------------------------- foundation
  {
    area: 'Foundation',
    name: 'Database schema & row-level security',
    status: 'working',
    note: 'Versioned Postgres migrations and automated in-process permission tests exist. Hosted PostgREST/RLS behavior and production load still require staging verification.',
  },
  {
    area: 'Foundation',
    name: 'Function privilege hardening',
    status: 'working',
    note: 'Database functions have explicit role grants and permission tests. Live deployment configuration is not verified by those tests.',
  },
  {
    area: 'Foundation',
    name: 'Design system',
    status: 'partial',
    note: 'Bulla has a shared light/dark system, calmer navigation, campus artwork and reduced-motion-aware effects. Profiles, boards and university layouts are being refined; signed-in device, keyboard and accessibility acceptance is still in progress.',
  },

  // --------------------------------------------------------------------- auth
  {
    area: 'Accounts',
    name: 'Email and password sign-up and sign-in',
    status: 'partial',
    note: 'Local authentication/session security is tested; cloud signup/login actions exist. Hosted identity, email delivery and multi-device behavior still need end-to-end acceptance.',
  },
  {
    area: 'Accounts',
    name: 'Google sign-in',
    status: 'partial',
    note: 'Cloud OAuth code exists and is offered only in cloud mode. Provider setup and a real callback journey still need verification.',
  },
  {
    area: 'Accounts',
    name: 'Password reset by email',
    status: 'partial',
    note: 'The /settings/password page and guarded recovery/change-password actions are implemented, including local current-password verification and session revocation. Real hosted email delivery, recovery links and multi-device callbacks remain unverified. Local mode has no email recovery.',
  },
  {
    area: 'Accounts',
    name: 'Onboarding (username, university, programme)',
    status: 'partial',
    note: 'Signup defaults private in both providers and onboarding offers an explicit publication choice. Persistence and ownership have local/SQL regression coverage; real hosted signup and browser acceptance still need verification.',
  },
  {
    area: 'Accounts',
    name: 'Staff account security',
    status: 'partial',
    note: 'TOTP enrollment and verification controls exist at /settings/security, with fail-closed staff-session checks. Local accounts do not have cloud MFA. Hosted enrollment, expiry, lost-factor recovery and operator acceptance remain required.',
  },

  // ------------------------------------------------------------------- social
  {
    area: 'People',
    name: 'Profiles',
    status: 'partial',
    note: 'Profiles include permission-filtered, paginated project and learning portfolio sections, skills, interests and image controls. Local/SQL ownership and privacy regressions pass; hosted and full browser journeys remain in progress.',
  },
  {
    area: 'People',
    name: 'Universities, departments, programmes',
    status: 'partial',
    note: 'Browsing, reference data, institution requests and moderator review exist. Campus membership is self-declared, not verified student identity.',
  },
  {
    area: 'People',
    name: 'Connections, follows and blocking',
    status: 'partial',
    note: 'Actions, screens and local domain tests exist. Cross-mode counters, private-content behavior and two-account browser journeys remain acceptance work.',
  },

  // --------------------------------------------------------------------- feed
  {
    area: 'Feed',
    name: 'Posting and reading a text post',
    status: 'partial',
    note: 'Composer, structured posts, ranking, filters, permalinks and cursor controls exist. Local/hosted ordering and write/reload journeys need final acceptance.',
  },
  {
    area: 'Feed',
    name: 'Likes, comments and saved posts',
    status: 'partial',
    note: 'Likes, comments and the owner-only /saved list are implemented with permission-aware paging. Real two-account write/reload and hosted concurrency acceptance remain in progress.',
  },

  // ----------------------------------------------------------------- projects
  {
    area: 'Projects',
    name: 'Projects, collaborators and applications',
    status: 'partial',
    note: 'Listing/detail/create, roles, applications, review and updates exist. Ownership/role edge cases and full hosted collaboration journeys need verification.',
  },
  {
    area: 'Projects',
    name: 'Ideas and idea-to-project conversion',
    status: 'partial',
    note: 'Forms, voting, interest and conversion exist. Validate atomicity, privacy and membership outcomes in staging.',
  },

  // ---------------------------------------------------------------- messaging
  {
    area: 'Messaging',
    name: 'Direct and group conversations',
    status: 'partial',
    note: 'Message privacy windows, current DM consent, retained drafts, nonce retries and bodyless local activity have regression coverage. Group creation/management UI is being completed. Local mode is not realtime; hosted publication, reconnect and delivery remain unverified.',
  },

  // ---------------------------------------------------------------- learning
  {
    area: 'Learning',
    name: 'Semester goals and daily study log',
    status: 'partial',
    note: 'Goals, milestones, semesters and daily logs have screens/actions; new goals start private unless the author chooses sharing. Edit/reload, date boundaries and hosted provider parity still need final acceptance.',
  },
  {
    area: 'Learning',
    name: 'Achievements',
    status: 'partial',
    note: 'Stored achievements and display code exist. Verify real-event awards and idempotency in both providers; no skill mastery percentage is implied.',
  },

  // ----------------------------------------------------- discovery & community
  {
    area: 'Discovery',
    name: 'Opportunities and events',
    status: 'partial',
    note: 'Boards, details, creation, opportunity saves, event RSVPs and readable-target reporting are implemented. Listings are not automatically endorsed. Staff review, independent capacity races, timezones and hosted acceptance remain required.',
  },
  {
    area: 'Discovery',
    name: 'Search',
    status: 'partial',
    note: 'People-by-name, university, department and self-declared skill filters use stable URL-addressed keyset pages. SQL/privacy regressions pass; hosted query plans and large-dataset performance remain unmeasured.',
  },
  {
    area: 'Community',
    name: 'Notifications',
    status: 'partial',
    note: 'List/read actions, real unread badges and atomic bodyless local message activity are implemented with recipient-ownership tests. Hosted delivery, fan-out, stale-state invalidation and reconnect still need acceptance.',
  },

  // -------------------------------------------------------------- moderation
  {
    area: 'Safety',
    name: 'Reports, moderation and admin tools',
    status: 'partial',
    note: 'Reports include readable opportunities/events; decisions, audit, institution review and private local staff accounts exist. Mandatory write limits and fresh hosted staff assurance are being verified. Hosted/operator abuse acceptance remains a launch gate.',
  },
  {
    area: 'Safety',
    name: 'Bug reporting',
    status: 'partial',
    note: 'Submission, own reports and staff triage exist with local domain coverage. Hosted acceptance and operator response procedures remain.',
  },

  // ------------------------------------------------------------------- ops
  {
    area: 'Operations',
    name: 'File uploads (avatars, project images)',
    status: 'partial',
    note: 'Bounded JPEG/PNG/WebP validation, image normalization, private ownership and local avatar/project controls are implemented. Hosted uploads deliberately remain disabled until exact-object cleanup and storage acceptance are proven. Arbitrary files are not supported.',
  },
  {
    area: 'Operations',
    name: 'Rate limiting',
    status: 'partial',
    note: 'Server-owned budgets gate accepted direct SQL writes and atomic local mutations; local authentication has separate throttling. Independent connection tests, hosted transport, read/search and per-IP/Sybil protection remain acceptance or implementation work.',
  },
  {
    area: 'Operations',
    name: 'End-to-end browser tests',
    status: 'partial',
    note: 'Local browser smoke exists and wider real two-account, password, group, account-data, private-image and device suites are being integrated with fresh fixtures. Comprehensive hosted-provider and accessibility acceptance is not yet complete.',
  },
  {
    area: 'Operations',
    name: 'Account export and deletion',
    status: 'partial',
    note: 'The /settings/account controls and reauthenticated bounded export/deletion pipeline are implemented, including ownership blockers, session revocation and retained audit rules. Local browser acceptance and the hosted cleanup worker/recovery drill remain unverified.',
  },
  {
    area: 'Operations',
    name: '50,000-user capacity and recovery',
    status: 'planned',
    note: 'A workload and load/recovery acceptance plan exist. No production capacity benchmark or successful restore drill has been recorded.',
  },
]

export function featuresByArea() {
  const areas = new Map<string, Feature[]>()
  for (const feature of FEATURES) {
    const list = areas.get(feature.area) ?? []
    list.push(feature)
    areas.set(feature.area, list)
  }
  return [...areas.entries()]
}

export function statusCounts() {
  const counts: Record<FeatureStatus, number> = {
    working: 0,
    partial: 0,
    'schema-only': 0,
    planned: 0,
  }
  for (const feature of FEATURES) counts[feature.status] += 1
  return counts
}

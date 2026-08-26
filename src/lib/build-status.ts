/**
 * Build status.
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

export type Feature = {
  area: string
  name: string
  status: FeatureStatus
  note: string
}

export const STATUS_LABELS: Record<FeatureStatus, string> = {
  working: 'Working',
  partial: 'Partly working',
  'schema-only': 'Database only',
  planned: 'Planned',
}

export const FEATURES: Feature[] = [
  // ---------------------------------------------------------------- foundation
  {
    area: 'Foundation',
    name: 'Database schema & row-level security',
    status: 'working',
    note: '52 tables across 15 migrations, every one with RLS policies. Covered by an automated permission suite.',
  },
  {
    area: 'Foundation',
    name: 'Function privilege hardening',
    status: 'working',
    note: 'Every database function is granted to exactly the roles that need it, verified by a test that fails when a new function is added without a decision.',
  },
  {
    area: 'Foundation',
    name: 'Design system',
    status: 'partial',
    note: 'Tokens, buttons, inputs, fields, alerts, badges, avatars and surfaces exist. Dialogs, menus, tabs and toasts are not built yet.',
  },

  // --------------------------------------------------------------------- auth
  {
    area: 'Accounts',
    name: 'Email and password sign-up and sign-in',
    status: 'working',
    note: 'Real Supabase auth, server-side validation, and a profile row created by a database trigger. Needs Supabase credentials to run.',
  },
  {
    area: 'Accounts',
    name: 'Google sign-in',
    status: 'working',
    note: 'Implemented end-to-end. Requires a Google OAuth client to be configured in the Supabase dashboard first.',
  },
  {
    area: 'Accounts',
    name: 'Password reset by email',
    status: 'working',
    note: 'Sends a one-time link. Deliberately does not reveal whether an address is registered.',
  },
  {
    area: 'Accounts',
    name: 'Onboarding (username, university, programme)',
    status: 'planned',
    note: 'The database accepts all of it and enforces username uniqueness. The interface is not built, so new accounts keep their generated handle for now.',
  },

  // ------------------------------------------------------------------- social
  {
    area: 'People',
    name: 'Profiles',
    status: 'schema-only',
    note: 'Profiles, skills, interests, education and privacy settings are in the database with policies. No profile page yet.',
  },
  {
    area: 'People',
    name: 'Universities, departments, programmes',
    status: 'schema-only',
    note: 'Schema, verification state and student counts exist. No browsing interface, and no universities have been loaded.',
  },
  {
    area: 'People',
    name: 'Connections, follows and blocking',
    status: 'schema-only',
    note: 'Request/accept flow, mutual-connection rules and block enforcement are implemented as policies and tested. No interface.',
  },

  // --------------------------------------------------------------------- feed
  {
    area: 'Feed',
    name: 'Posting and reading a text post',
    status: 'partial',
    note: 'Writing and reading work against the real database. Ranking, following-only filters and pagination controls are not built; likes, comments and saves are database-only.',
  },
  {
    area: 'Feed',
    name: 'Likes, comments and saved posts',
    status: 'schema-only',
    note: 'Tables, counters and policies exist and are tested. The feed shows the real counts but has no controls yet.',
  },

  // ----------------------------------------------------------------- projects
  {
    area: 'Projects',
    name: 'Projects, collaborators and applications',
    status: 'schema-only',
    note: 'Ownership transfer, roles, join requests and the "seeking members" gate are implemented and tested in the database. No interface.',
  },
  {
    area: 'Projects',
    name: 'Ideas and idea-to-project conversion',
    status: 'schema-only',
    note: 'Including the conversion function that carries interested people across. No interface.',
  },

  // ---------------------------------------------------------------- messaging
  {
    area: 'Messaging',
    name: 'Direct and group conversations',
    status: 'schema-only',
    note: 'Participation-based access, read receipts and unread counts exist in the database. No interface, and no realtime subscription wired up.',
  },

  // ---------------------------------------------------------------- learning
  {
    area: 'Learning',
    name: 'Semester goals and daily study log',
    status: 'schema-only',
    note: 'Goals, milestones, study sessions and the streak calculation are implemented and tested. No interface.',
  },
  {
    area: 'Learning',
    name: 'Achievements',
    status: 'schema-only',
    note: 'Awarded by database triggers on real events, not by a scheduled job inventing them. No interface.',
  },

  // ----------------------------------------------------- discovery & community
  {
    area: 'Discovery',
    name: 'Opportunities and events',
    status: 'schema-only',
    note: 'Internships, scholarships, competitions and society events, with attendance. No interface.',
  },
  {
    area: 'Discovery',
    name: 'Search',
    status: 'planned',
    note: 'Trigram indexes exist on names and titles. The search migration and interface are not written.',
  },
  {
    area: 'Community',
    name: 'Notifications',
    status: 'schema-only',
    note: 'Generated by triggers on real events, de-duplicated, and impossible for a client to forge — 77 tests cover exactly that. No interface, no email delivery.',
  },

  // -------------------------------------------------------------- moderation
  {
    area: 'Safety',
    name: 'Reports, moderation and admin tools',
    status: 'planned',
    note: 'Admin and moderator roles exist and are enforced in policies. The reporting tables, audit log and admin interface are the next migration.',
  },
  {
    area: 'Safety',
    name: 'Bug reporting',
    status: 'planned',
    note: 'Planned as part of the same migration as reports.',
  },

  // ------------------------------------------------------------------- ops
  {
    area: 'Operations',
    name: 'File uploads (avatars, project images)',
    status: 'planned',
    note: 'Storage buckets, MIME and size validation, and ownership policies are not written yet. No upload control is shown anywhere.',
  },
  {
    area: 'Operations',
    name: 'Rate limiting',
    status: 'planned',
    note: 'Not implemented. Supabase applies its own limits to auth endpoints in the meantime.',
  },
  {
    area: 'Operations',
    name: 'End-to-end browser tests',
    status: 'planned',
    note: 'Playwright is installed; no specs are written. The current automated coverage is the database permission suite.',
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

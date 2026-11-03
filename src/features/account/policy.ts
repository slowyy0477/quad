/** Public copy/constants only. Never import a provider, datastore or key here. */
export const ACCOUNT_POLICY_VERSION = '2026-10-31-v1'
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE MY ACCOUNT'
export const MODERATION_RETENTION_DAYS = 30
export const EXPORT_MAX_ROWS = 100
export const EXPORT_DEFAULT_ROWS = 25
export const EXPORT_MAX_BYTES = 2 * 1024 * 1024

export const EXPORT_SECTIONS = {
  profile: 'Profile',
  posts: 'Own posts',
  comments: 'Own comments',
  messages: 'Own sent messages',
  projects: 'Own projects',
  project_memberships: 'Own project memberships',
  project_applications: 'Own project applications',
  project_invites_sent: 'Own sent project invitations',
  project_invites_received: 'Own received project invitation state (without sender notes)',
  project_stars: 'Own project stars',
  ideas: 'Own ideas',
  idea_votes: 'Own idea votes',
  idea_interest: 'Own expressions of interest',
  connections: 'Own connection requests',
  follows: 'Own outgoing follows',
  blocks: 'Own blocks',
  profile_skills: 'Own skills',
  profile_interests: 'Own interests',
  endorsements_given: 'Own endorsements given',
  achievements: 'Own achievements',
  semesters: 'Own semesters',
  courses: 'Own courses',
  goals: 'Own goals',
  goal_milestones: 'Own goal milestones',
  daily_logs: 'Own daily logs',
  opportunities: 'Own opportunities',
  opportunity_saves: 'Own opportunity saves',
  events: 'Own events',
  event_attendees: 'Own event attendance',
  post_likes: 'Own post likes',
  post_saves: 'Own saved posts',
  notifications: 'Own notification state (without preview bodies)',
  reports: 'Own filed reports (without staff notes)',
  bug_reports: 'Own bug reports',
  university_requests: 'Own university submissions',
} as const

export type ExportSection = keyof typeof EXPORT_SECTIONS
export const EXPORT_SECTION_NAMES = Object.keys(EXPORT_SECTIONS) as ExportSection[]

export const EXPORT_EXCLUSIONS = [
  'Passwords, hashes, sessions, bearer/refresh tokens and provider identity metadata',
  'Other senders’ messages, conversation previews and other users’ private rows',
  'Other authors’ project invitation notes/proposed roles and invitation participant identities',
  'Internal moderation notes and authentication/audit/security ledgers',
  'Media bytes, backups and data held independently by external providers',
] as const

export const DELETION_POLICY = [
  'Your profile, credentials, sessions and personal learning data are removed.',
  'Your posts and their reply threads, your comments, sent messages, ideas, opportunities and events are removed. Other people’s independent content remains.',
  'Sole-owner projects are removed. Projects with other members must be transferred first, including soft-deleted projects. Inconsistent owner roles and the last administrator also block deletion.',
  'Invitations sent by or addressed to you, and invitations to removed projects, are removed. Invitations alone are not membership and do not create an ownership blocker. Unrelated accounts and their invitations remain.',
  'Shared media must have its ownership resolved. Hosted media is removed through the Storage API before the Auth account, by an explicitly enabled worker.',
  'Only content-free moderation outcome summaries are retained for 30 days. They contain no names, account IDs, free-text reasons or message bodies.',
  'A queued request disables account access immediately. Cleanup can retry or require operator action; a request receipt is not proof of completion. Backups follow a separate, unverified recovery/retention process.',
] as const

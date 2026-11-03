import 'server-only'

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EMPTY_DOMAIN_TABLES, type DomainTables } from './domain-tables'
import { cookies } from 'next/headers'
import { getLocalUserFromSnapshot, LOCAL_SESSION_COOKIE } from './session'
import { enforceMutationLimits, type LocalMutationLimitWindow } from './mutation-limits'

/**
 * The local store.
 *
 * One JSON file, a handful of tables, and a promise queue so two writes cannot
 * interleave. This is deliberately the least clever database that can support the
 * interface: no query language, no joins, no indexes — the domain modules do the
 * filtering in TypeScript, and the volumes here (one person's development data)
 * make that correct rather than lazy.
 *
 * WHY IT EXISTS
 * -------------
 * The product is designed around Postgres and row-level security, and that is
 * still the target. But an interface that can only be exercised against a live
 * cloud project cannot be reviewed, and a review that depends on someone else's
 * dashboard is a review that does not happen. So there are two data modes:
 *
 *   local   this file. Accounts, posts, likes, everything, in `data/local.json`.
 *   supabase  the real thing, unchanged, when the project exists.
 *
 * The switch is `NEXT_PUBLIC_DATA_MODE` (see `src/lib/mode.ts`). The Supabase code
 * paths are not deleted or stubbed — they are simply not selected.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a security boundary and it must never be described as one. Row-level
 * security, the grants, the triggers and the 700 assertions in `tests/db` all
 * describe the Postgres deployment. In local mode the checks that remain are the
 * ones written in TypeScript, which is a different and weaker guarantee — and the
 * interface says so, in one place, rather than letting a green tick imply
 * otherwise. `data/local.json` is git-ignored and is never deployed: production
 * refuses to boot in local mode.
 */

export type Row = { id: string; [key: string]: unknown }

export type Tables = {
  users: LocalUser[]
  sessions: LocalSession[]
  profiles: LocalProfile[]
  universities: LocalUniversity[]
  posts: LocalPost[]
  post_likes: LocalLike[]
  post_saves: LocalSave[]
  comments: LocalComment[]
  projects: LocalProject[]
  project_members: LocalMember[]
  ideas: LocalIdea[]
  notifications: LocalNotification[]
  conversations: LocalConversation[]
  conversation_participants: LocalParticipant[]
  messages: LocalMessage[]
  semesters: LocalSemester[]
  courses: LocalCourse[]
  goals: LocalGoal[]
  goal_milestones: LocalMilestone[]
  daily_logs: LocalLog[]
  opportunities: LocalOpportunity[]
  opportunity_saves: LocalSave[]
  events: LocalEvent[]
  event_attendees: LocalAttendee[]
  reports: LocalReport[]
  user_roles: LocalUserRole[]
  mutation_limit_windows: LocalMutationLimitWindow[]
} & DomainTables

/**
 * A staff role.
 *
 * Mirrors `public.user_roles`: readable by its owner, writable by nobody through
 * the app. Locally the only writer is the seed, which is the equivalent of the
 * migration that grants the first administrator.
 */
export type LocalUserRole = {
  id: string
  user_id: string
  role: 'admin' | 'moderator'
  created_at: string
}

export type LocalSession = {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  expires_at: string
}

export type LocalUser = {
  id: string
  email: string
  password_hash: string
  created_at: string
  disabled_at?: string | null
}

export type LocalProfile = {
  id: string
  user_id: string
  username: string
  display_name: string
  bio: string | null
  avatar_url: string | null
  university_id: string | null
  department: string | null
  /** Undefined is legacy text-only affiliation; null is an explicit clear. */
  department_id?: string | null
  programme: string | null
  semester: string | null
  website: string | null
  github: string | null
  // Profile forms use canonical fields without discarding legacy programme/GitHub
  // values. Undefined means an older row; explicit null means the user cleared it.
  degree?: string | null
  headline?: string | null
  graduation_year?: number | null
  location?: string | null
  github_username?: string | null
  linkedin_url?: string | null
  twitter_username?: string | null
  onboarding_completed?: boolean
  onboarding_step?: number
  visibility: 'public' | 'university' | 'connections' | 'private'
  searchable: boolean
  // Optional because they were added to the store after the first accounts existed;
  // readers fall back to the same defaults the Postgres columns declare.
  allow_messages_from?: 'everyone' | 'university' | 'connections' | 'nobody'
  allow_connection_requests?: boolean
  created_at: string
}

export type LocalUniversity = {
  id: string
  name: string
  short_name: string | null
  city: string | null
  country: string | null
  student_count: number
  project_count: number
  created_at: string
}

export type LocalPost = {
  id: string
  author_id: string
  body: string
  visibility: 'public' | 'university' | 'connections' | 'private'
  project_id: string | null
  goal_id: string | null
  moderation_status: 'active' | 'hidden'
  like_count: number
  comment_count: number
  created_at: string
  deleted_at: string | null
}

export type LocalLike = { id: string; post_id: string; profile_id: string; created_at: string }
export type LocalSave = { id: string; post_id: string; profile_id: string; created_at: string }

export type LocalComment = {
  id: string
  post_id: string
  author_id: string
  parent_id: string | null
  body: string
  created_at: string
  deleted_at: string | null
}

export type LocalProject = {
  id: string
  owner_id: string
  slug: string
  title: string
  purpose: string
  description: string | null
  category: string
  status: 'planning' | 'active' | 'completed' | 'archived'
  visibility: 'public' | 'university' | 'connections' | 'private'
  is_seeking_members: boolean
  team_size_target: number | null
  member_count: number
  created_at: string
  deleted_at: string | null
}

export type LocalMember = {
  id: string
  project_id: string
  profile_id: string
  role: 'owner' | 'maintainer' | 'member'
  created_at: string
}

export type LocalIdea = {
  id: string
  author_id: string
  title: string
  description: string
  category: string
  status: 'open' | 'in_progress' | 'converted' | 'closed'
  visibility: 'public' | 'university' | 'connections' | 'private'
  upvote_count: number
  interest_count: number
  converted_project_id: string | null
  created_at: string
  deleted_at: string | null
}

export type LocalNotification = {
  id: string
  recipient_id: string
  actor_id: string | null
  type: string
  body: string | null
  is_read: boolean
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
}

export type LocalConversation = {
  id: string
  type: 'direct' | 'group'
  title: string | null
  last_message_at: string | null
  last_message_preview: string | null
  created_at: string
}

export type LocalParticipant = {
  id: string
  conversation_id: string
  profile_id: string
  /** Legacy missing roles are members, never inferred administrators. */
  role?: 'admin' | 'member'
  last_read_at: string | null
}

export type LocalMessage = {
  id: string
  conversation_id: string
  author_id: string
  body: string
  created_at: string
}

export type LocalSemester = {
  id: string
  profile_id: string
  name: string
  term: string | null
  year: number | null
  start_date: string | null
  end_date: string | null
  is_current: boolean
  created_at: string
}

export type LocalCourse = {
  id: string
  semester_id: string
  profile_id: string
  code: string | null
  title: string
  instructor: string | null
  credits: number | null
  status: string
  grade: string | null
  created_at: string
}

export type LocalGoal = {
  id: string
  profile_id: string
  semester_id: string | null
  course_id: string | null
  title: string
  description: string | null
  category: string
  status: 'active' | 'completed' | 'paused' | 'abandoned'
  target_value: number
  current_value: number
  unit: string | null
  progress_percent: number
  visibility: string
  target_date: string | null
  completed_at: string | null
  milestone_count: number
  completed_milestone_count: number
  created_at: string
}

export type LocalMilestone = {
  id: string
  goal_id: string
  title: string
  is_completed: boolean
  completed_at: string | null
  target_date: string | null
  sort_order: number
}

export type LocalLog = {
  id: string
  profile_id: string
  log_date: string
  hours_studied: number | null
  mood: number | null
  productivity: number | null
  summary: string | null
  wins: string | null
  blockers: string | null
  created_at: string
  updated_at: string
}

export type LocalOpportunity = {
  id: string
  posted_by: string
  title: string
  organisation: string
  description: string
  type: string
  work_mode: string
  visibility: string
  compensation: string | null
  location: string | null
  apply_url: string | null
  apply_email: string | null
  deadline: string | null
  starts_on: string | null
  status: string
  created_at: string
  deleted_at: string | null
}

export type LocalEvent = {
  id: string
  created_by: string
  title: string
  description: string
  location: string | null
  starts_at: string
  ends_at: string | null
  timezone: string
  capacity: number | null
  attendee_count: number
  visibility: string
  status: string
  created_at: string
  deleted_at: string | null
  /** New writes persist these; legacy snapshots retain their honest fallbacks. */
  slug?: string
  type?: string
  attendance_mode?: string
  is_all_day?: boolean
  join_url?: string | null
  location_url?: string | null
}

export type LocalAttendee = {
  id: string
  event_id: string
  profile_id: string
  status: 'going' | 'interested' | 'cancelled'
  created_at: string
}

export type LocalReport = {
  id: string
  reporter_id: string
  reason: string
  detail: string | null
  status: 'open' | 'actioned' | 'dismissed'
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  message_id: string | null
  reported_profile_id: string | null
  event_id?: string | null
  opportunity_id?: string | null
}

const EMPTY: Tables = {
  ...EMPTY_DOMAIN_TABLES,
  users: [],
  sessions: [],
  profiles: [],
  universities: [],
  posts: [],
  post_likes: [],
  post_saves: [],
  comments: [],
  projects: [],
  project_members: [],
  ideas: [],
  notifications: [],
  conversations: [],
  conversation_participants: [],
  messages: [],
  semesters: [],
  courses: [],
  goals: [],
  goal_milestones: [],
  daily_logs: [],
  opportunities: [],
  opportunity_saves: [],
  events: [],
  event_attendees: [],
  reports: [],
  user_roles: [],
  mutation_limit_windows: [],
}

let writing: Promise<void> = Promise.resolve()

export function localStorePath(): string {
  return process.env.LOCAL_DATA_PATH || path.join(process.cwd(), 'data', 'local.json')
}

/** Read a committed snapshot. Never cache across independently bundled workers. */
export async function readStore(): Promise<Tables> {
  try {
    // Runtime-owned private data is supplied by LOCAL_DATA_PATH, never a deploy
    // asset. Tracing this dynamic read included the source checkout's datastore.
    const raw = await fs.readFile(/* turbopackIgnore: true */ localStorePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid local store: expected a table object. Restore a known-good backup.')
    }
    for (const [name, rows] of Object.entries(parsed)) {
      if (!Array.isArray(rows)) throw new Error(`Invalid local store table: ${name}`)
    }
    return { ...structuredClone(EMPTY), ...parsed } as Tables
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return structuredClone(EMPTY)
  }
}

/** A filesystem lock prevents lost updates between Next's independent workers. */
async function lockStore(target: string): Promise<() => Promise<void>> {
  const lock = `${target}.lock`
  const deadline = Date.now() + 10_000
  await fs.mkdir(path.dirname(target), { recursive: true })
  for (;;) {
    try {
      await fs.mkdir(lock)
      return () => fs.rmdir(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error('Local store is busy. If the server crashed, stop it before removing the stale .lock folder.')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

/** Commit a private transaction snapshot; failures never become visible state. */
export async function mutate<T>(fn: (db: Tables) => T | Promise<T>): Promise<T> {
  const target = localStorePath()
  const transaction = writing.then(async () => {
    const release = await lockStore(target)
    try {
      const db = await readStore()
      const before = structuredClone(db)
      // Resolve from the locked snapshot, not a caller-selected ID or an earlier
      // getUser read. Non-request maintenance has no session; protected writes
      // then fail closed. Signup/session changes do not consume content budgets.
      let rawSession: string | undefined
      try { rawSession = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value } catch { /* Not a request. */ }
      const actor = getLocalUserFromSnapshot(before, rawSession)
      const result = await fn(db)
      db.mutation_limit_windows = enforceMutationLimits(before, db, {
        actorUserId: actor?.id ?? null,
        nowMs: Date.now(),
      })
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`
      try {
        const handle = await fs.open(temp, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(db, null, 2), 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(temp, target)
      } finally {
        await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      return result
    } finally {
      await release()
    }
  })
  writing = transaction.then(() => undefined, () => undefined)
  return transaction
}

/** A deterministic-enough id. Not a uuid's collision resistance, and not trying to be. */
export function id(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${random}`
}

export function now(): string {
  return new Date().toISOString()
}

/** Compatibility hook: committed snapshots are now read fresh on every call. */
export function resetLocalCache() {
  writing = Promise.resolve()
}

import 'server-only'

import { createClient, getUser } from '@/lib/supabase/server'
import { readStore, type LocalUniversity, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import type { Database } from '@/lib/db/database.types'

/**
 * University directory reads.
 *
 * There is no `status` filter on the browse query, and that is deliberate rather
 * than an omission. `universities_select_public` returns approved rows to
 * everyone and `universities_select_own_submission` returns a pending row to the
 * person who filed it, so an unapproved institution shows up in this list for its
 * submitter and for nobody else. That is the behaviour 0003's header describes,
 * decided in Postgres. A second copy of the rule here would be a copy that a
 * later surface forgets.
 *
 * `student_count` is the stored counter, maintained by
 * `app.sync_university_student_count` on every profile insert, update and delete.
 * Nothing here recomputes it: a `count(*)` in a list view is the shape of number
 * PRODUCT.md rule 1 forbids, and it would disagree with the number the same
 * person sees beside their own name.
 *
 * LOCAL MODE
 * ----------
 * The store has no triggers, so the stored counters in it are seed values that
 * nothing updates; showing 1,240 students beside three profile rows would be a
 * number the interface cannot stand behind. Both counters are therefore derived
 * here from the arrays, which is the same quantity the trigger maintains in
 * Postgres: the profiles naming the institution, and the live projects whose
 * owner or members are at it.
 *
 * Three `universities` columns have no local equivalent and are handled rather
 * than invented:
 *
 *   status   every row in the store is treated as approved. Local mode has no
 *            moderator and no submission queue, so there is no other state a row
 *            could be in.
 *   slug     derived from the name for identification. The store keeps no slug and
 *            nothing writes one back.
 *   website  null: the column does not exist.
 */

type UniversityRow = Database['public']['Tables']['universities']['Row']

export type UniversityListItem = Pick<
  UniversityRow,
  | 'id'
  | 'slug'
  | 'name'
  | 'short_name'
  | 'country'
  | 'city'
  | 'website'
  | 'status'
  | 'student_count'
  | 'project_count'
>

const LIST_COLUMNS =
  'id, slug, name, short_name, country, city, website, status, student_count, project_count'

/**
 * A term that can be handed to PostgREST's `or()` filter.
 *
 * `or()` is a comma-separated expression, and `%`/`*` are its wildcards, so a
 * comma, a bracket, a quote or a wildcard inside the search box would change the
 * shape of the query instead of the value being matched. They are replaced with
 * spaces here: this is a name lookup, not a syntax the reader is writing.
 */
function sanitiseTerm(term: string): string {
  return term
    .replace(/[%,()"\\*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -----------------------------------------------------------------------------
// Local-mode mapping
// -----------------------------------------------------------------------------

/** A slug for an institution. Derived from the name; never written back. */
function localSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'institution'
  )
}

/**
 * The derived counters for every institution, in one pass.
 *
 * A student is a profile whose `university_id` names the institution. A project
 * counts towards every institution one of its people is at — the owner and the
 * members — which is the local stand-in for `projects.university_id`, a column
 * the store does not have.
 */
function localCounters(db: Tables): Map<string, { students: number; projects: number }> {
  const counts = new Map<string, { students: number; projects: number }>()
  const bump = (id: string, key: 'students' | 'projects') => {
    const current = counts.get(id) ?? { students: 0, projects: 0 }
    current[key] += 1
    counts.set(id, current)
  }

  const universityOfProfile = new Map<string, string | null>()
  for (const profile of db.profiles) {
    universityOfProfile.set(profile.id, profile.university_id)
    if (profile.university_id) bump(profile.university_id, 'students')
  }

  const counted = new Set<string>()
  for (const project of db.projects) {
    if (project.deleted_at !== null) continue
    // One project counts once per institution, however many of its people are there.
    counted.clear()
    const participants = [
      project.owner_id,
      ...db.project_members
        .filter((member) => member.project_id === project.id)
        .map((member) => member.profile_id),
    ]
    for (const profileId of participants) {
      const universityId = universityOfProfile.get(profileId)
      if (!universityId || counted.has(universityId)) continue
      counted.add(universityId)
      bump(universityId, 'projects')
    }
  }

  return counts
}

function toLocalListItem(
  university: LocalUniversity,
  counts: Map<string, { students: number; projects: number }>,
): UniversityListItem {
  const counter = counts.get(university.id)
  return {
    id: university.id,
    slug: localSlug(university.name),
    name: university.name,
    short_name: university.short_name,
    country: university.country,
    city: university.city,
    website: null,
    status: 'approved',
    student_count: counter?.students ?? 0,
    project_count: counter?.projects ?? 0,
  }
}

export type UniversitySearch = {
  universities: UniversityListItem[]
  /** True when the query was truncated, so the page can say so rather than imply completeness. */
  truncated: boolean
  /** The reader's current affiliation, or null. Used to mark their own row. */
  myUniversityId: string | null
  error: string | null
}

/**
 * Browse or search the directory, by name, short name or city.
 *
 * One extra row is requested than the page shows. A query limited to exactly what
 * is displayed cannot distinguish "that is all of them" from "there is more", so
 * it can only ever guess — and guessing is what this codebase does not do.
 *
 * The local branch has every row in memory, so it applies the same idea to the
 * filtered array: one more than the page shows decides whether to say "and there
 * are more", and `-1` when there are none.
 */
export async function searchUniversities({
  q = '',
  limit = 60,
}: { q?: string; limit?: number } = {}): Promise<UniversitySearch> {
  const term = sanitiseTerm(q)

  if (isLocalMode()) {
    const db = await readStore()
    const myUniversityId = await getMyUniversityId()

    const wanted = term.toLowerCase()
    const counts = localCounters(db)
    const matches = db.universities
      .filter((university) => {
        if (!wanted) return true
        const haystack = [university.name, university.short_name, university.city]
        return haystack.some((value) => value?.toLowerCase().includes(wanted) ?? false)
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    const extra = matches.length > limit
    return {
      universities: matches.slice(0, limit).map((university) => toLocalListItem(university, counts)),
      truncated: extra,
      myUniversityId,
      error: null,
    }
  }

  const supabase = await createClient()

  let query = supabase.from('universities').select(LIST_COLUMNS).order('name').limit(limit + 1)

  if (term) {
    const pattern = `*${term}*`
    query = query.or(
      `name.ilike.${pattern},short_name.ilike.${pattern},city.ilike.${pattern}`,
    )
  }

  const [result, myUniversityId] = await Promise.all([query.returns<UniversityListItem[]>(), getMyUniversityId()])

  if (result.error) {
    console.error('[universities:searchUniversities]', result.error.code, result.error.message)
    return {
      universities: [],
      truncated: false,
      myUniversityId,
      error: 'The list of institutions could not be loaded. Please try again.',
    }
  }

  const rows = result.data ?? []
  return {
    universities: rows.slice(0, limit),
    truncated: rows.length > limit,
    myUniversityId,
    error: null,
  }
}

/**
 * The reader's own affiliation.
 *
 * Read from their profile row rather than from a separate "claim" table, because
 * there is no second table: `profiles.university_id` is the single place the
 * affiliation lives, which is what makes claiming a second institution a move
 * rather than a duplicate.
 *
 * In the local store that row is found by `user_id`, because the two ids differ
 * there; see `features/profiles/queries`.
 */
export async function getMyUniversityId(): Promise<string | null> {
  const user = await getUser()
  if (!user) return null

  if (isLocalMode()) {
    const db = await readStore()
    return db.profiles.find((profile) => profile.user_id === user.id)?.university_id ?? null
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('university_id')
    .eq('id', user.id)
    .maybeSingle<{ university_id: string | null }>()

  if (error) {
    console.error('[universities:getMyUniversityId]', error.code, error.message)
    return null
  }
  return data?.university_id ?? null
}

export type PendingSubmission = Pick<
  UniversityRow,
  'id' | 'name' | 'short_name' | 'city' | 'country' | 'created_at'
>

/**
 * The reader's own institution, named.
 *
 * `profiles.university_id` is a uuid and a uuid is not something to show anyone,
 * so the row is read back for its name. It can come back null while the profile
 * still names an id — a pending submission the reader filed is readable by them,
 * but a row that has since been rejected might not be — and the page treats that
 * as "nothing to show" rather than guessing at a name.
 */
export async function getMyUniversity(): Promise<UniversityListItem | null> {
  const universityId = await getMyUniversityId()
  if (!universityId) return null

  if (isLocalMode()) {
    const db = await readStore()
    const university = db.universities.find((row) => row.id === universityId)
    if (!university) return null
    return toLocalListItem(university, localCounters(db))
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('universities')
    .select(LIST_COLUMNS)
    .eq('id', universityId)
    .maybeSingle<UniversityListItem>()

  if (error) {
    console.error('[universities:getMyUniversity]', error.code, error.message)
    return null
  }
  return data
}

/**
 * Institutions this reader has filed that a moderator has not decided on yet.
 *
 * `status = 'pending'` is the whole filter: an approved row is already in the
 * public list above it, and a rejected one is reported on the row itself. RLS
 * confines this to the reader's own submissions, so the query does not name
 * `submitted_by` — it could not return anyone else's row if it tried.
 *
 * The local store has no `status` and no `submitted_by`, and no way to file one
 * either (see `requestUniversityAction`), so this is always empty rather than a
 * list of rows that could never exist.
 */
export async function listMyPendingSubmissions(): Promise<PendingSubmission[]> {
  const user = await getUser()
  if (!user) return []

  if (isLocalMode()) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('universities')
    .select('id, name, short_name, city, country, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .returns<PendingSubmission[]>()

  if (error) {
    console.error('[universities:listMyPendingSubmissions]', error.code, error.message)
    return []
  }
  return data ?? []
}

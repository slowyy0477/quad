import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'
import type { BugStatus } from '@/features/bugs/schemas'

/**
 * Bug report reads.
 *
 * Two audiences over one table, separated by RLS and not by a parameter:
 * `bug_reports_select_own` gives a reader their own rows, and
 * `bug_reports_select_admin` gives an administrator every row (0020). A moderator
 * calling `getBugReports` therefore gets an empty list rather than a refusal,
 * which is the honest answer to "which bug reports can I see" — and it is why the
 * admin shell renders the bug tab from a count that is genuinely zero for them
 * rather than hiding it.
 */

/**
 * A person, as this feature renders one.
 *
 * Declared here rather than imported from features/moderation/queries.ts, which
 * has a structurally identical type: a feature module importing another feature's
 * query layer is the coupling the house rules forbid, and a three-field shape is
 * cheaper to restate than to justify. The two are interchangeable to TypeScript,
 * so components accept either.
 */
export type ReporterRef = {
  id: string
  username: string
  displayName: string
}

export type BugReportRow = {
  id: string
  title: string
  body: string
  pageUrl: string | null
  status: BugStatus
  createdAt: string
  reporter: ReporterRef | null
}

export const BUGS_PAGE_SIZE = 25

type ReadResult<T> =
  | { rows: T; total: number; error: null }
  | { rows: null; total: 0; error: string }

const READ_FAILED = 'That list could not be loaded. Please try again.'

type RawBugRow = {
  id: string
  title: string
  body: string
  page_url: string | null
  status: BugStatus
  created_at: string
  reporter: { id: string; username: string; display_name: string } | null
}

const BUG_SELECT = `
  id, title, body, page_url, status, created_at,
  reporter:profiles!bug_reports_reporter_id_fkey ( id, username, display_name )
`

function toRow(raw: RawBugRow): BugReportRow {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    pageUrl: raw.page_url,
    status: raw.status,
    createdAt: raw.created_at,
    reporter: raw.reporter
      ? {
          id: raw.reporter.id,
          username: raw.reporter.username,
          displayName: raw.reporter.display_name,
        }
      : null,
  }
}

/** The reader's own reports, newest first. What /report-a-bug lists back. */
export async function getOwnBugReports(limit = 20): Promise<ReadResult<BugReportRow[]>> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('bug_reports')
    .select(BUG_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<RawBugRow[]>()

  if (error) {
    console.error('[bugs:getOwnBugReports]', error.code, error.message)
    return { rows: null, total: 0, error: READ_FAILED }
  }

  const rows = (data ?? []).map(toRow)
  return { rows, total: rows.length, error: null }
}

/**
 * Every report, for an administrator.
 *
 * `status` filters the view, it does not gate it: the rows a caller may see are
 * decided by the policies, and this parameter only chooses which of their own
 * rows to show. A moderator passing `status=fixed` gets the empty set they are
 * entitled to.
 */
export async function getBugReports({
  status,
  page = 1,
  perPage = BUGS_PAGE_SIZE,
}: { status?: BugStatus; page?: number; perPage?: number } = {}): Promise<
  ReadResult<BugReportRow[]>
> {
  const supabase = await createClient()
  const from = Math.max(0, page - 1) * perPage

  let query = supabase
    .from('bug_reports')
    .select(BUG_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + perPage - 1)

  if (status) query = query.eq('status', status)

  const { data, count, error } = await query.returns<RawBugRow[]>()

  if (error) {
    console.error('[bugs:getBugReports]', error.code, error.message)
    return { rows: null, total: 0, error: READ_FAILED }
  }

  const rows = (data ?? []).map(toRow)
  return { rows, total: count ?? rows.length, error: null }
}

/**
 * How many bug reports are open, for the admin shell's badge.
 *
 * Zero for a moderator, because zero is the number of rows they can read. A
 * hard-coded zero would be indistinguishable from "the count failed", so the
 * failure path logs and the number still comes from the database either way.
 */
export async function countOpenBugReports(): Promise<number> {
  // Local mode has no bug_reports table. Zero is the honest answer: no report has
  // been filed, because there is nowhere to file one.
  if (isLocalMode()) return 0

  const supabase = await createClient()

  const { count, error } = await supabase
    .from('bug_reports')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')

  if (error) {
    console.error('[bugs:countOpenBugReports]', error.code, error.message)
    return 0
  }

  return count ?? 0
}

/**
 * The status labels live in features/bugs/schemas.ts, next to the statuses
 * themselves, so that the reader's list and the maintainer's triage control
 * cannot develop two vocabularies for the same four states.
 */

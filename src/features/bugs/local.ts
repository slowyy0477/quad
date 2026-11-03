import { getUser } from '@/lib/supabase/server'
import { id, mutate, now, readStore, type Tables } from '@/lib/local/db'
import { localActor, localStaff, validLocalId } from '@/lib/local/access'
import { bugReportSchema, bugTriageSchema, type BugStatus } from './schemas'
import type { BugReportRow } from './queries'
import type { FormState } from '@/lib/form-state'

function safePage(value: string | undefined): string | null {
  if (!value) return null
  try { const url = new URL(value, 'https://local.invalid'); return ['http:', 'https:'].includes(url.protocol) ? (url.origin === 'https://local.invalid' ? url.pathname : url.origin + url.pathname) : null } catch { return null }
}
export async function bugWriteLocal(form: FormData, triage = false): Promise<FormState> {
  const user = await getUser()
  if (triage) {
    const bugId = String(form.get('bugId') ?? ''); const parsed = bugTriageSchema.omit({ bugId: true }).safeParse({ status: String(form.get('status') ?? '') })
    if (!validLocalId(bugId) || !parsed.success) return { status: 'error', message: 'Check the fields.' }
    return mutate(db => {
      const me = localActor(db, user?.id ?? null); const row = db.bug_reports.find(row => row.id === bugId)
      if (!localStaff(db, me, 'admin') || !row) return { status: 'error', message: 'That report was not changed.' }
      row.status = parsed.data.status; row.updated_at = now()
      return { status: 'success', message: 'Saved.' }
    })
  }
  const parsed = bugReportSchema.safeParse({ title: String(form.get('title') ?? ''), body: String(form.get('body') ?? ''), pageUrl: String(form.get('pageUrl') ?? '') })
  if (!parsed.success) return { status: 'error', message: 'Check the fields.' }
  return mutate(db => {
    const me = localActor(db, user?.id ?? null)
    if (!me) return { status: 'error', message: 'Sign in to file a report.' }
    db.bug_reports.push({ id: id('bug'), reporter_id: me.id, title: parsed.data.title, body: parsed.data.body, page_url: safePage(parsed.data.pageUrl), status: 'open', created_at: now(), updated_at: now() })
    return { status: 'success', message: 'Thank you — it is on the list.' }
  })
}
function bugRow(db: Tables, row: Tables['bug_reports'][number]): BugReportRow {
  const profile = db.profiles.find(profile => profile.id === row.reporter_id)
  return { id: row.id, title: row.title, body: row.body, pageUrl: row.page_url, status: row.status, createdAt: row.created_at, reporter: profile ? { id: profile.id, username: profile.username, displayName: profile.display_name } : null }
}
export async function bugsLocal({ own = false, status, page = 1, perPage = 25 }: { own?: boolean; status?: BugStatus; page?: number; perPage?: number } = {}): Promise<{ rows: BugReportRow[]; total: number; error: null }> {
  const user = await getUser(); const db = await readStore(); const me = localActor(db, user?.id ?? null)
  if (!me || (!own && !localStaff(db, me, 'admin'))) return { rows: [], total: 0, error: null }
  const rows = db.bug_reports.filter(row => (!own || row.reporter_id === me.id) && (!status || row.status === status)).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  const size = Math.min(100, Math.max(1, perPage)); const offset = Math.max(0,page-1)*size
  return { rows: rows.slice(offset, offset+size).map(row => bugRow(db,row)), total: rows.length, error: null }
}

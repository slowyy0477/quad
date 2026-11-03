import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { SectionHeading, Surface } from '@/components/ui/surface'
import { getAdminRole } from '@/features/admin/queries'
import { StaffOnly } from '@/features/admin/components/admin-shell'
import { readStore, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { getUser } from '@/lib/supabase/server'

/**
 * Everything the store holds, in one place.
 *
 * This exists because "the database" was, for a while, a claim made by a page
 * rather than something anybody could look at. An operator needs to answer three
 * questions without a terminal: what tables are there, how many rows are in each,
 * and what does a row actually look like.
 *
 * Two rules, both of them about not lying:
 *
 *   1. The count is computed from the array, not from a stored counter — the same
 *      rule the rest of the local port follows.
 *   2. A secret is never rendered. `password_hash` is masked to its scheme, so the
 *      page can prove a row exists without putting a hash on a screen somebody may
 *      be sharing.
 *
 * It is a read-only window. Writes still go through the application's own actions,
 * because a data browser with a delete button is a second implementation of every
 * rule the actions enforce.
 */

/** Columns whose values are never shown. */
const SECRET_COLUMNS = new Set(['password_hash', 'password', 'token', 'token_hash', 'secret', 'recovery_token', 'session_secret'])

/** How many rows of each table to show. Enough to recognise the data. */
const PREVIEW_ROWS = 4

function mask(column: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (SECRET_COLUMNS.has(column)) {
    return column === 'password_hash' && typeof value === 'string' && value.startsWith('scrypt$')
      ? 'scrypt hash (hidden)' : '(hidden)'
  }
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 60)
  const text = String(value)
  return text.length > 64 ? `${text.slice(0, 61)}…` : text
}

/** The columns of a table: the union of the keys of its first few rows. */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  for (const row of rows.slice(0, 50)) {
    for (const key of Object.keys(row)) seen.add(key)
  }
  return [...seen]
}

export default async function AdminDataPage() {
  const [role, user] = await Promise.all([getAdminRole(), getUser()])
  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  if (!isLocalMode()) {
    return (
      <Alert tone="info" title="This page reads the local store">
        You are running against Supabase. Use the Supabase dashboard&apos;s table editor for the same
        view; this page would show an empty local store instead of your data.
      </Alert>
    )
  }

  const db = (await readStore()) as unknown as Tables & Record<string, unknown[]>
  const names = Object.keys(db).sort()

  const rows = names.map((name) => {
    const table = (db[name] ?? []) as unknown as Record<string, unknown>[]
    return {
      name,
      count: table.length,
      columns: columnsOf(table),
      preview: table.slice(0, PREVIEW_ROWS),
    }
  })

  const totalRows = rows.reduce((sum, table) => sum + table.count, 0)
  const emptyTables = rows.filter((table) => table.count === 0).map((table) => table.name)
  const storePath = 'data/local.json'

  return (
    <div className="space-y-8">
      <div>
        <SectionHeading
          level={2}
          title="All data"
          description={`${rows.length} tables, ${totalRows} rows, read from ${storePath}. Counted from the rows themselves, not from a stored total.`}
        />
        <p className="mt-2 text-xs text-ink-faint">
          Read-only. <code className="font-mono">password_hash</code> is masked; nothing here can
          change a row. New rows appear when the application writes them.
        </p>
      </div>

      {emptyTables.length > 0 ? (
        <Alert tone="info" title="Empty tables">
          {emptyTables.join(', ')} — these exist in the store and have no rows yet. An empty table is
          not a broken one; it is a feature nobody has used.
        </Alert>
      ) : null}

      <div className="space-y-6">
        {rows.map((table) => (
          <Surface key={table.name} className="overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-4 py-3">
              <h3 className="font-mono text-sm text-ink">{table.name}</h3>
              <div className="flex items-center gap-2">
                <Badge tone={table.count === 0 ? 'outline' : 'neutral'}>
                  {table.count} {table.count === 1 ? 'row' : 'rows'}
                </Badge>
                <span className="text-xs text-ink-faint">
                  {table.columns.length} {table.columns.length === 1 ? 'column' : 'columns'}
                </span>
              </div>
            </div>

            {table.count === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-faint">No rows.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="bg-paper-sunken">
                      {table.columns.map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className="border-b border-hairline px-3 py-2 font-mono font-normal whitespace-nowrap text-ink-muted"
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.preview.map((row, index) => (
                      <tr key={index} className="border-b border-hairline last:border-0">
                        {table.columns.map((column) => (
                          <td
                            key={column}
                            className="max-w-56 truncate px-3 py-2 align-top text-ink-muted"
                            title={SECRET_COLUMNS.has(column) ? undefined : String(row[column] ?? '')}
                          >
                            {mask(column, row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {table.count > PREVIEW_ROWS ? (
              <p className="border-t border-hairline px-4 py-2 text-xs text-ink-faint">
                First {PREVIEW_ROWS} of {table.count} rows.
              </p>
            ) : null}
          </Surface>
        ))}
      </div>

      <p className="text-xs text-ink-faint">
        The schema these tables mirror lives in <code className="font-mono">supabase/migrations</code>
        . Where the two disagree, the migration is right and the store has a field missing — see{' '}
        <Link href="/status" className="underline underline-offset-2">
          the status page
        </Link>
        .
      </p>
    </div>
  )
}

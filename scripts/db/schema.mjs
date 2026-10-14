#!/usr/bin/env node
/**
 * Generate `src/lib/db/database.types.ts` and a readable schema reference from the
 * migrations themselves, without a live Supabase project.
 *
 *   node scripts/db/schema.mjs --types     # write src/lib/db/database.types.ts
 *   node scripts/db/schema.mjs --schema    # write docs/plan/SCHEMA.md
 *   node scripts/db/schema.mjs --json      # write docs/plan/schema.json
 *   node scripts/db/schema.mjs --all
 *
 * Why this exists. `npm run db:types` asks the Supabase CLI to introspect a linked
 * project, which needs a project and (for the CLI) Docker. Neither is available, and
 * the result was that 462 lines of `queries.ts` hand-declared row shapes against 52
 * tables and TypeScript could not catch a rename, a dropped column or a nullability
 * change. The migrations are the schema, and they already run in-process under
 * PGlite for the test suite — so the types can be derived from the same source the
 * tests use, with no network and no Docker.
 *
 * What it deliberately does not do: it is not a replacement for `npm run db:types`
 * against a real project. It is generated from `supabase/migrations/`, so anything
 * applied to a project by hand would be invisible here. When a live project exists,
 * prefer the CLI and treat this as the offline fallback — the two produce the same
 * shape, so switching does not change the call sites.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const BOOTSTRAP = join(ROOT, 'supabase', 'tests', 'bootstrap.sql')

const argv = process.argv.slice(2)
const want = (name) => argv.includes(`--${name}`) || argv.includes('--all')

// ------------------------------------------------------------------ the database

async function boot() {
  const pg = await PGlite.create({ extensions: { pg_trgm, btree_gin } })
  await pg.exec(await readFile(BOOTSTRAP, 'utf8'))

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  for (const name of files) {
    try {
      await pg.exec(await readFile(join(MIGRATIONS_DIR, name), 'utf8'))
    } catch (error) {
      throw new Error(`Migration failed: ${name}\n${error.message}`)
    }
  }
  return pg
}

const COLUMNS_SQL = /* sql */ `
  select
    c.table_name,
    c.column_name,
    c.ordinal_position,
    c.is_nullable,
    c.column_default,
    c.is_identity,
    c.is_generated,
    coalesce(c.udt_name, c.data_type) as udt_name,
    (select e.enumlabel is not null from pg_type t join pg_enum e on e.enumtypid = t.oid
      where t.typname = c.udt_name limit 1) as is_enum,
    col_description(format('%I.%I', c.table_schema, c.table_name)::regclass::oid,
                    c.ordinal_position) as comment
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  order by c.table_name, c.ordinal_position
`

const ENUMS_SQL = /* sql */ `
  select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
  group by t.typname
  order by t.typname
`

const VIEWS_SQL = /* sql */ `
  select c.table_name, c.column_name, c.ordinal_position, c.is_nullable, c.udt_name
  from information_schema.columns c
  join information_schema.views v
    on v.table_schema = c.table_schema and v.table_name = c.table_name
  where c.table_schema = 'public'
  order by c.table_name, c.ordinal_position
`

const FUNCTIONS_SQL = /* sql */ `
  select
    p.proname as name,
    pg_get_function_arguments(p.oid) as args,
    pg_get_function_result(p.oid) as result
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  order by p.proname
`

const FOREIGN_KEYS_SQL = /* sql */ `
  select
    tc.table_name,
    kcu.column_name,
    ccu.table_name as foreign_table,
    ccu.column_name as foreign_column
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
  join information_schema.constraint_column_usage ccu
    on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  order by tc.table_name, kcu.column_name
`

// ------------------------------------------------------------------ type mapping

/** Postgres type -> TypeScript, in the shape Supabase's generator emits. */
function tsType(column) {
  const t = column.udt_name
  if (column.is_enum) return `Database['public']['Enums']['${t}']`

  if (t.startsWith('_')) {
    const inner = { ...column, udt_name: t.slice(1) }
    const mapped = tsType(inner)
    return `(${mapped})[]`
  }

  switch (t) {
    case 'bool':
      return 'boolean'
    case 'int2':
    case 'int4':
    case 'int8':
    case 'float4':
    case 'float8':
    case 'numeric':
    case 'oid':
      return 'number'
    case 'json':
    case 'jsonb':
      return 'Json'
    case 'text':
    case 'varchar':
    case 'bpchar':
    case 'char':
    case 'uuid':
    case 'citext':
    case 'inet':
    case 'date':
    case 'time':
    case 'timetz':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
    case 'bytea':
    case 'name':
      return 'string'
    default:
      return 'unknown'
  }
}

function literal(value) {
  return JSON.stringify(value)
}

// ------------------------------------------------------------------ emitters

function emitTypes({ columns, enums, views, functions, foreignKeys }, migrationCount) {
  const tables = [...new Set(columns.map((c) => c.table_name))]

  const byTable = (name) => columns.filter((c) => c.table_name === name)

  const tableBlock = (name) => {
    const cols = byTable(name)

    const row = cols
      .map((c) => `          ${JSON.stringify(c.column_name)}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''}`)
      .join('\n')

    // Insert: anything with a default, an identity or a generated expression may be
    // omitted. Getting this wrong is the difference between `insert({ id: uuid() })`
    // compiling and every insert site apologising for a column it never needed.
    const insert = cols
      .map((c) => {
        const optional = c.is_nullable === 'YES' || c.column_default !== null || c.is_identity === 'YES' || c.is_generated !== 'NEVER'
        const type = tsType(c)
        const nullable = c.is_nullable === 'YES' ? ' | null' : ''
        return `          ${JSON.stringify(c.column_name)}${optional ? '?' : ''}: ${type}${nullable}`
      })
      .join('\n')

    const update = cols
      .map((c) => {
        const nullable = c.is_nullable === 'YES' ? ' | null' : ''
        return `          ${JSON.stringify(c.column_name)}?: ${tsType(c)}${nullable}`
      })
      .join('\n')

    const rel = foreignKeys
      .filter((fk) => fk.table_name === name)
      .map(
        (fk) =>
          `          {\n            foreignKeyName: ${literal(`${name}_${fk.column_name}_fkey`)}\n            columns: [${literal(fk.column_name)}]\n            isOneToOne: false\n            referencedRelation: ${literal(fk.foreign_table)}\n            referencedColumns: [${literal(fk.foreign_column)}]\n          },`,
      )
      .join('\n')

    return `      ${name}: {\n        Row: {\n${row}\n        }\n        Insert: {\n${insert}\n        }\n        Update: {\n${update}\n        }\n        Relationships: [\n${rel}\n        ]\n      }`
  }

  const viewNames = [...new Set(views.map((v) => v.table_name))]
  const viewBlock = (name) => {
    const cols = views.filter((v) => v.table_name === name)
    const row = cols
      .map((c) => `          ${JSON.stringify(c.column_name)}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''}`)
      .join('\n')
    return `      ${name}: {\n        Row: {\n${row}\n        }\n        Relationships: []\n      }`
  }

  const enumBlock = (e) =>
    `      ${e.name}: ${e.labels.map((l) => literal(l)).join(' | ')}`

  // Return types Supabase cannot express as a column set are left as unknown rather
  // than guessed: a wrong `Args` type compiles and then fails at runtime.
  const functionBlock = (fn) => {
    const args = parseArgs(fn.args)
    const argsBlock = args.length
      ? args.map((a) => `          ${literal(a.name)}: ${a.type}`).join('\n')
      : '        [_ in never]: never'
    return `      ${fn.name}: {\n        Args: {\n${argsBlock}\n        }\n        Returns: ${fn.result.startsWith('TABLE') || fn.result.startsWith('SETOF') ? 'Record<string, unknown>[]' : mapScalar(fn.result)}\n      }`
  }

  const uniqueFunctions = functions.filter((fn, index, all) => all.findIndex((f) => f.name === fn.name) === index)

  return `/**
 * Generated database types. **Do not edit by hand.**
 *
 *   npm run db:types:local     # regenerate from supabase/migrations (no network, no Docker)
 *   npm run db:types           # regenerate from a linked Supabase project (preferred)
 *
 * Derived from ${migrationCount} migrations by scripts/db/schema.mjs, applying the real
 * SQL to PostgreSQL 18 in-process — the same path the permission suite takes, so the
 * types and the tests cannot disagree about what the schema is.
 *
 * Why the file exists at all: before it, every \`queries.ts\` declared its own row
 * shapes against 52 tables and TypeScript could not catch a renamed column, a dropped
 * one, or a column that became nullable. A schema change now fails the build at the
 * exact call site that needs attention.
 *
 * Limitations, stated rather than discovered later:
 *   * Function argument names come from \`pg_get_function_arguments\`; a function whose
 *     arguments are unnamed is not representable and is mapped to \`[_ in never]\`.
 *   * Return types that are not a single column (TABLE(...), SETOF) are
 *     \`Record<string, unknown>[]\`. Add an explicit interface at the call site when a
 *     function's result matters — guessing here would compile and lie.
 *   * The \`app\` schema is not emitted: it is not exposed through PostgREST, and the
 *     application never queries it directly.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
${tables.map(tableBlock).join('\n')}
    }
    Views: {
${viewNames.length ? viewNames.map(viewBlock).join('\n') : `      [_ in never]: never`}
    }
    Functions: {
${uniqueFunctions.length ? uniqueFunctions.map(functionBlock).join('\n') : `      [_ in never]: never`}
    }
    Enums: {
${enums.map(enumBlock).join('\n')}
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update']
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T]
`
}

function parseArgs(argsText) {
  if (!argsText || argsText === '') return []
  const parts = []
  let depth = 0
  let current = ''

  for (const char of argsText) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)

  return parts.map((part, index) => {
    const trimmed = part.trim()
    const match = /^(?:(\w+)\s+)?(.*?)(?:\s+DEFAULT\s+.*)?$/i.exec(trimmed) ?? []
    const name = match[1] ?? `arg${index + 1}`
    const type = mapScalar((match[2] ?? '').replace(/^OUT\s+/i, '').trim())
    return { name, type }
  })
}

function mapScalar(sqlType) {
  const t = sqlType.toLowerCase().trim()
  if (t.startsWith('setof ')) return `${mapScalar(t.slice(6))}[]`
  if (t.endsWith('[]')) return `(${mapScalar(t.slice(0, -2))})[]`
  if (t.startsWith('table(') || t.includes('record')) return 'Record<string, unknown>[]'
  if (t.includes('uuid') || t.includes('text') || t.includes('char') || t.includes('timestamp') || t.includes('date') || t.includes('interval')) return 'string'
  if (t.includes('bool')) return 'boolean'
  if (t.includes('int') || t.includes('numeric') || t.includes('double') || t.includes('real') || t.includes('float')) return 'number'
  if (t.includes('json')) return 'Json'
  if (t === 'void' || t === '') return 'undefined'
  return 'unknown'
}

function emitSchemaMd({ columns, enums, views, functions, foreignKeys }) {
  const tables = [...new Set(columns.map((c) => c.table_name))]
  const lines = [
    '# Schema reference',
    '',
    '**Generated** by `npm run db:schema:local` from the migrations. Do not edit by hand.',
    '',
    'Not a substitute for reading a migration — the migrations carry the reasoning, this',
    'carries the shape. Use it to write a query without opening 17 files; use the migration',
    'when you need to know *why* a column exists or which policy governs it.',
    '',
    `**${tables.length} tables, ${views.length ? [...new Set(views.map((v) => v.table_name))].length : 0} views, ${enums.length} enums, ${functions.length} functions in \`public\`.`,
    '',
    '## Tables',
    '',
  ]

  for (const table of tables) {
    lines.push(`### ${table}`, '', '| Column | Type | Null | Default |', '| --- | --- | --- | --- |')
    for (const c of byTableColumns(columns, table)) {
      const type = c.is_enum ? `${c.udt_name} (enum)` : c.udt_name
      lines.push(
        `| \`${c.column_name}\` | ${type} | ${c.is_nullable === 'YES' ? 'yes' : 'no'} | ${c.column_default ? `\`${String(c.column_default).slice(0, 60)}\`` : ''} |`,
      )
    }
    const fks = foreignKeys.filter((fk) => fk.table_name === table)
    if (fks.length) {
      lines.push('', `References: ${fks.map((fk) => `\`${fk.column_name}\` → \`${fk.foreign_table}.${fk.foreign_column}\``).join(', ')}`)
    }
    lines.push('')
  }

  function byTableColumns(cols, name) {
    return cols.filter((c) => c.table_name === name)
  }

  const viewNames = [...new Set(views.map((v) => v.table_name))]
  if (viewNames.length) {
    lines.push('## Views', '')
    for (const view of viewNames) {
      lines.push(`### ${view}`, '', ...views.filter((v) => v.table_name === view).map((v) => `- \`${v.column_name}\` (${v.udt_name})`), '')
    }
  }

  lines.push('## Enums', '')
  for (const e of enums) lines.push(`- **${e.name}**: ${e.labels.map((l) => `\`${l}\``).join(', ')}`)

  lines.push('', '## Functions in `public`', '')
  for (const fn of functions) lines.push(`- \`${fn.name}(${fn.args})\` → ${fn.result}`)

  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------ main

const pg = await boot()
let columns
let enums
let views
let functions
let foreignKeys

if (want('types') || want('json') || want('schema')) {
  columns = (await pg.query(COLUMNS_SQL)).rows
  enums = (await pg.query(ENUMS_SQL)).rows.map((e) => ({ name: e.name, labels: e.labels }))
  views = (await pg.query(VIEWS_SQL)).rows
  functions = (await pg.query(FUNCTIONS_SQL)).rows
  foreignKeys = (await pg.query(FOREIGN_KEYS_SQL)).rows
}

const migrationCount = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).length
const tables = [...new Set((columns ?? []).map((c) => c.table_name))]

if (want('types')) {
  const out = join(ROOT, 'src', 'lib', 'db', 'database.types.ts')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, emitTypes({ columns, enums, views, functions, foreignKeys }, migrationCount))
  console.log(`  types   src/lib/db/database.types.ts   ${tables.length} tables, ${enums.length} enums`)
}

if (want('schema')) {
  const out = join(ROOT, 'docs', 'plan', 'SCHEMA.md')
  await writeFile(out, emitSchemaMd({ columns, enums, views, functions, foreignKeys }))
  console.log(`  schema  docs/plan/SCHEMA.md             ${tables.length} tables documented`)
}

if (want('json')) {
  const out = join(ROOT, 'docs', 'plan', 'schema.json')
  await writeFile(
    out,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        migrations: migrationCount,
        tables: Object.fromEntries(
          tables.map((t) => [
            t,
            columns
              .filter((c) => c.table_name === t)
              .map((c) => ({
                name: c.column_name,
                type: c.is_enum ? c.udt_name : c.udt_name,
                nullable: c.is_nullable === 'YES',
                default: c.column_default,
                enum: c.is_enum ? true : undefined,
              })),
          ]),
        ),
        enums,
        views: Object.fromEntries([...new Set(views.map((v) => v.table_name))].map((v) => [v, views.filter((x) => x.table_name === v).map((x) => x.column_name)])),
        functions: functions.map((f) => ({ name: f.name, args: f.args, returns: f.result })),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`  json    docs/plan/schema.json           ${functions.length} functions indexed`)
}

await pg.close()

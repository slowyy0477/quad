/**
 * Generate (never apply) a transactional SQL-editor migration bundle.
 *
 * Defaults remain supabase/apply-all.sql and supabase/apply-from-0016.sql,
 * resolved from this script's checkout, not the caller's working directory.
 * --from 0016 / --from=0016 must name an exact existing numeric version.
 *
 * Supabase separates <digits>_<name>.sql into version and name:
 * https://github.com/supabase/cli/blob/develop/apps/cli/src/command-internal/migration-history.ts
 * The numeric text retains leading zeros. This bundle never repairs history.
 * Imports expose pure helpers without reading migrations or writing output.
 */
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const checkoutRoot = path.resolve(path.dirname(scriptPath), '..')
const maxVersion = 9223372036854775807n

class BundleError extends Error {}

function numericVersion(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[^0-9]/u.test(value) && BigInt(value) <= maxVersion
}

function hasControls(value) {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function validateFrom(from) {
  if (from !== null && !numericVersion(from)) {
    throw new BundleError('--from must be a numeric migration prefix, e.g. --from 0016.')
  }
}

/** @param {string[]} args */
export function parseBundleArguments(args) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new BundleError('Unsupported bundle arguments; use only --from <version>.')
  }
  let from = null
  if (args.length) {
    if (args.length === 2 && args[0] === '--from') from = args[1]
    else if (args.length === 1 && args[0].startsWith('--from=')) from = args[0].slice(7)
    else throw new BundleError('Unsupported bundle arguments; use only --from <version>.')
    validateFrom(from)
  }
  return { from }
}

/** @param {string} filename */
export function parseMigrationFilename(filename) {
  // Reject both path separators and control characters before SQL interpolation.
  if (typeof filename !== 'string' || filename.length > 240 || hasControls(filename) || /[/\\]/u.test(filename)) {
    throw new BundleError('Invalid migration filename; expected <numeric-version>_<name>.sql.')
  }
  const match = /^([0-9]+)_(.+)\.sql$/u.exec(filename)
  if (!match || !numericVersion(match[1])) {
    throw new BundleError('Invalid migration filename; expected <numeric-version>_<name>.sql.')
  }
  return { filename, version: match[1], name: match[2] }
}

/**
 * @param {string[]} filenames
 * @param {string | null} [from]
 */
export function selectMigrations(filenames, from = null) {
  validateFrom(from)
  const migrations = filenames.filter(filename => /\.sql$/iu.test(filename)).map(parseMigrationFilename)
  if (!migrations.length) throw new BundleError('No migrations found.')
  const versions = new Set()
  for (const migration of migrations) {
    const numeric = BigInt(migration.version).toString()
    if (versions.has(numeric)) throw new BundleError('Duplicate migration versions require operator review.')
    versions.add(numeric)
  }
  if (from !== null && !migrations.some(migration => migration.version === from)) {
    throw new BundleError('--from must exactly match an existing migration version.')
  }
  // Match the CLI's lexical version ordering, not locale or full-stem ordering.
  return migrations.sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
    .filter(migration => from === null || migration.version >= from)
}

function samePath(left, right, api = path) {
  const a = api.resolve(left)
  const b = api.resolve(right)
  return api === path.win32 || (api === path && process.platform === 'win32')
    ? a.toLowerCase() === b.toLowerCase() : a === b
}

function inside(root, target, api = path) {
  const relative = api.relative(api.resolve(root), api.resolve(target))
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)
}

/**
 * No CLI path override. The optional checkout/path API is for pure fixture tests.
 * @param {string | null} [from]
 * @param {string} [checkout]
 */
export function resolveBundlePaths(from = null, checkout = checkoutRoot, api = path) {
  validateFrom(from)
  if (!api.isAbsolute(checkout)) throw new BundleError('Unsafe checkout path.')
  const root = api.resolve(checkout)
  const supabaseDir = api.join(root, 'supabase')
  const migrationsDir = api.join(supabaseDir, 'migrations')
  const outputName = from === null ? 'apply-all.sql' : `apply-from-${from}.sql`
  const outputPath = api.join(supabaseDir, outputName)
  if (!inside(root, migrationsDir, api) || !inside(supabaseDir, outputPath, api)) {
    throw new BundleError('Unsafe bundle path.')
  }
  return { root, supabaseDir, migrationsDir, outputName, outputPath }
}

const literal = value => `'${value.replace(/'/g, "''")}'`

/**
 * Pure SQL rendering; it neither queries a target nor repairs its history.
 * SQL files must remain transactional (no independent COMMIT or nontransactional DDL).
 * @param {{ filename: string, sql: string }[]} sources
 * @param {string | null} [from]
 */
export function renderBundle(sources, from = null) {
  const migrations = selectMigrations(sources.map(source => source.filename), from)
  const sourceByFilename = new Map(sources.map(source => [source.filename, source.sql]))
  if (migrations.some(migration => typeof sourceByFilename.get(migration.filename) !== 'string' ||
    !sourceByFilename.get(migration.filename).trim())) {
    throw new BundleError('A selected migration has no SQL content.')
  }
  const versionList = migrations.map(migration => literal(migration.version)).join(', ')
  const historyRows = migrations.map(migration =>
    `(${literal(migration.version)}, ${literal(migration.name)})`).join(',\n  ')
  const parts = [
    '-- ===========================================================================',
    from === null
      ? '-- Bulla -- complete schema, generated by scripts/bundle-migrations.mjs'
      : `-- Bulla -- migrations from ${from} onwards, generated by scripts/bundle-migrations.mjs`,
    `-- ${migrations.length} migration${migrations.length === 1 ? '' : 's'}, applied in one transaction.`,
    '-- Review the target and its backed-up history before applying in the SQL editor.',
    '-- Legacy full-stem history is refused, never converted or silently repaired.',
    '-- An error rolls back this transaction. Do not run alongside another migrator.',
    '-- DO NOT EDIT. Edit the migration files and regenerate.',
    '-- ===========================================================================',
    '',
    'begin;',
    '',
    '-- ####### Migration history preflight (before application SQL) #######',
    'create schema if not exists supabase_migrations;',
    'create table if not exists supabase_migrations.schema_migrations (',
    '  version text not null primary key,',
    '  statements text[],',
    '  name text',
    ');',
    "set local lock_timeout = '4s';",
    'lock table supabase_migrations.schema_migrations in exclusive mode;',
    '',
    'do $bulla_bundle_history$',
    'begin',
    '  if exists (select 1 from supabase_migrations.schema_migrations',
    "    where version ~ '^[0-9]+_') then",
    '    raise exception using',
    "      errcode = 'P0001',",
    "      message = 'Bulla bundle refused: legacy full-stem migration history requires operator reconciliation; no migrations applied.',",
    "      hint = 'Review a backup of the history and the applied schema with an operator. This bundle never rewrites history.';",
    '  end if;',
    '  if exists (select 1 from supabase_migrations.schema_migrations',
    "    where version !~ '^[0-9]+$') then",
    '    raise exception using',
    "      errcode = 'P0001',",
    "      message = 'Bulla bundle refused: nonnumeric migration history requires operator reconciliation; no migrations applied.';",
    '  end if;',
    '  if exists (select 1 from supabase_migrations.schema_migrations',
    `    where version in (${versionList})) then`,
    '    raise exception using',
    "      errcode = 'P0001',",
    "      message = 'Bulla bundle refused: selected migrations are already recorded; verify history and choose the first unapplied --from version.';",
    '  end if;',
    'end;',
    '$bulla_bundle_history$;',
    '',
    '-- Support older CLI ledgers that only have the version column.',
    'alter table supabase_migrations.schema_migrations add column if not exists statements text[];',
    'alter table supabase_migrations.schema_migrations add column if not exists name text;',
    '',
  ]
  for (const migration of migrations) {
    parts.push(`-- ####### ${migration.filename} #######`, '', sourceByFilename.get(migration.filename).trimEnd(), '')
  }
  parts.push(
    '-- ####### Record numeric versions and separate migration names #######',
    '-- statements remains nullable; this bundle does not split or duplicate migration SQL.',
    'insert into supabase_migrations.schema_migrations (version, name)',
    'values',
    `  ${historyRows};`,
    '',
    'commit;',
    '',
  )
  return parts.join('\n')
}

function plainAncestors(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(current, realpathSync(current))) {
        throw new BundleError('Unsafe migration or output directory.')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current === path.dirname(current)) break
  }
}

function plainFile(target, missingAllowed = false) {
  plainAncestors(path.dirname(target))
  let stat
  try { stat = lstatSync(target) } catch (error) {
    if (missingAllowed && error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      !samePath(target, realpathSync(target))) {
    throw new BundleError('Unsafe migration or output file.')
  }
  return stat
}

function openPlainFile(target, write = false) {
  const previous = plainFile(target, write)
  const flags = (write ? constants.O_WRONLY : constants.O_RDONLY) | (constants.O_NOFOLLOW || 0) |
    (previous ? 0 : constants.O_CREAT | constants.O_EXCL)
  const fd = openSync(target, flags, 0o600)
  const actual = fstatSync(fd)
  if (!actual.isFile() || actual.nlink !== 1 ||
      (previous && (actual.dev !== previous.dev || actual.ino !== previous.ino))) {
    closeSync(fd)
    throw new BundleError('Unsafe migration or output file.')
  }
  return fd
}

function main() {
  const { from } = parseBundleArguments(process.argv.slice(2))
  const locations = resolveBundlePaths(from)
  plainAncestors(locations.migrationsDir)
  const selected = selectMigrations(readdirSync(locations.migrationsDir), from)
  const sources = selected.map(migration => {
    const sourcePath = path.join(locations.migrationsDir, migration.filename)
    if (!inside(locations.migrationsDir, sourcePath)) throw new BundleError('Unsafe migration path.')
    const fd = openPlainFile(sourcePath)
    try { return { filename: migration.filename, sql: readFileSync(fd, 'utf8') } }
    finally { closeSync(fd) }
  })
  const output = renderBundle(sources, from)
  const fd = openPlainFile(locations.outputPath, true)
  try {
    ftruncateSync(fd, 0)
    writeFileSync(fd, output, 'utf8')
  } finally { closeSync(fd) }
  console.log(`Wrote supabase/${locations.outputName} — ${sources.length} migrations, ${output.split('\n').length} lines, ${(Buffer.byteLength(output) / 1024).toFixed(0)} KB`)
}

if (process.argv[1] && samePath(process.argv[1], scriptPath)) {
  try { main() } catch (error) {
    console.error(error instanceof BundleError ? error.message : 'Bulla bundle generation failed; check local migration and output paths.')
    process.exitCode = 1
  }
}

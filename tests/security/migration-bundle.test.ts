import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseBundleArguments, parseMigrationFilename, renderBundle, resolveBundlePaths, selectMigrations,
} from '../../scripts/bundle-migrations.mjs'

const script = await readFile(new URL('../../scripts/bundle-migrations.mjs', import.meta.url), 'utf8')
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const names = ['0001_extensions_and_helpers.sql', '0016_backfill_profiles.sql', '0022_bulla_brand.sql']
const sources = names.map((filename, index) => ({ filename, sql: `select ${index + 1};\n` }))

describe('migration bundle numeric version and strict CLI contract', () => {
  it('keeps leading-zero numeric versions separate from the complete name suffix', () => {
    expect(parseMigrationFilename(names[0])).toEqual({
      filename: names[0], version: '0001', name: 'extensions_and_helpers',
    })
    expect(parseMigrationFilename('20261031123456_example_name.sql')).toMatchObject({
      version: '20261031123456', name: 'example_name',
    })
    expect(parseMigrationFilename('9223372036854775807_large.sql').version).toBe('9223372036854775807')
  })

  it('accepts only no arguments or one exact --from form', () => {
    expect(parseBundleArguments([])).toEqual({ from: null })
    expect(parseBundleArguments(['--from', '0016'])).toEqual({ from: '0016' })
    expect(parseBundleArguments(['--from=0016'])).toEqual({ from: '0016' })
  })

  it.each([
    ['--from'], ['--from='], ['--from', '--from'], ['--from', '0016', '--from', '0022'],
    ['--from=0016', '--from=0022'], ['0016'], ['--fromx=0016'], ['--help'],
    ['--output=D:/owner.sql'], ['--from=0016=../../owner'], ['--from', '../0016'],
    ['--from', '0016_name'], ['--from', '16.sql'], ['--from', '-1'], ['--from', '+0016'],
    ['--from', '1e3'], ['--from', '1.6'], ['--from', ' 0016'], ['--from', '0016 '],
    ['--from', '0016\n'], ['--from', '0016\r'], ['--from', '0016\0'],
    ['--from', '9223372036854775808'], ['--from', '1'.repeat(129)],
  ].map(args => [args] as [string[]]))('rejects malformed, duplicate, unknown or path-bearing arguments without echoing them: %j', args => {
    expect(() => parseBundleArguments(args)).toThrow()
    try { parseBundleArguments(args) } catch (error) {
      expect([
        'Unsupported bundle arguments; use only --from <version>.',
        '--from must be a numeric migration prefix, e.g. --from 0016.',
      ]).toContain((error as Error).message)
    }
  })

  it.each([
    '../0001_owner.sql', 'nested/0001_owner.sql', 'nested\\0001_owner.sql',
    '0001_.sql', 'one_name.sql', '0001_name.SQL', '0001_name.sql\n',
    '0001_name\nselect 1.sql', '0001_name\0.sql', '9223372036854775808_overflow.sql',
  ])('rejects malformed or path-bearing SQL filenames: %s', filename => {
    expect(() => parseMigrationFilename(filename)).toThrow('Invalid migration filename')
  })

  it('selects an exact version inclusively without accepting abbreviated or nonexistent prefixes', () => {
    expect(selectMigrations([...names].reverse(), '0016').map(migration => migration.filename))
      .toEqual(names.slice(1))
    expect(selectMigrations(names, '0022').map(migration => migration.filename)).toEqual(names.slice(2))
    for (const from of ['16', '001', '0020', '0038']) {
      expect(() => selectMigrations(names, from)).toThrow('exactly match an existing migration version')
    }
    expect(() => selectMigrations(['README.md'])).toThrow('No migrations found')
  })

  it('sorts by the numeric-text version rather than the full filename stem', () => {
    const files = ['20261031120000_later.sql', '20261031_earlier.sql']
    expect(selectMigrations(files).map(migration => migration.version))
      .toEqual(['20261031', '20261031120000'])
    expect(files).toEqual(['20261031120000_later.sql', '20261031_earlier.sql'])
  })

  it('refuses duplicate versions, including inconsistent zero-padding', () => {
    expect(() => selectMigrations(['0001_first.sql', '0001_second.sql'])).toThrow('Duplicate migration versions')
    expect(() => selectMigrations(['0001_first.sql', '1_second.sql'])).toThrow('Duplicate migration versions')
  })
})

describe('migration bundle checkout fencing and transactional history refusal', () => {
  it('resolves default source and outputs from the actual script checkout without consulting cwd', () => {
    expect(resolveBundlePaths()).toMatchObject({
      root: path.resolve(checkout),
      migrationsDir: path.join(checkout, 'supabase', 'migrations'),
      outputPath: path.join(checkout, 'supabase', 'apply-all.sql'),
    })
    expect(resolveBundlePaths('0016').outputPath).toBe(path.join(checkout, 'supabase', 'apply-from-0016.sql'))
    expect(script).not.toContain('process.cwd(')
  })

  it('preserves the same fenced relative names on Windows and Linux', () => {
    const windows = resolveBundlePaths('0016', 'D:/Synthetic-Bulla-Task/checkout', path.win32)
    expect(windows.migrationsDir).toBe('D:\\Synthetic-Bulla-Task\\checkout\\supabase\\migrations')
    expect(windows.outputPath).toBe('D:\\Synthetic-Bulla-Task\\checkout\\supabase\\apply-from-0016.sql')
    const linux = resolveBundlePaths(null, '/tmp/synthetic-bulla/checkout', path.posix)
    expect(linux.outputPath).toBe('/tmp/synthetic-bulla/checkout/supabase/apply-all.sql')
    expect(() => resolveBundlePaths(null, 'relative-checkout', path.posix)).toThrow('Unsafe checkout path')
    expect(() => resolveBundlePaths('../owner', '/tmp/synthetic-bulla', path.posix)).toThrow('numeric migration prefix')
  })

  it('renders numeric versions plus separate names after all application SQL inside one transaction', () => {
    const output = renderBundle([...sources].reverse())
    expect(output).toContain('begin;')
    expect(output.endsWith('commit;\n')).toBe(true)
    expect(output).toContain('insert into supabase_migrations.schema_migrations (version, name)')
    for (const filename of names) {
      const migration = parseMigrationFilename(filename)
      expect(output).toContain(`('${migration.version}', '${migration.name}')`)
      expect(output).not.toContain(`('${filename.slice(0, -4)}')`)
    }
    expect(output.indexOf('select 1;')).toBeLessThan(output.indexOf('select 2;'))
    expect(output.indexOf('select 2;')).toBeLessThan(output.indexOf('select 3;'))
    expect(output.indexOf('select 3;')).toBeLessThan(output.indexOf('insert into supabase_migrations'))
  })

  it('refuses legacy history anywhere in the target before application SQL without disclosing history rows', () => {
    const output = renderBundle(sources, '0016')
    const guardStart = output.indexOf('do $bulla_bundle_history$')
    const legacyEnd = output.indexOf('  end if;', guardStart)
    const legacyGuard = output.slice(guardStart, legacyEnd)
    expect(legacyGuard).toContain("where version ~ '^[0-9]+_'")
    expect(legacyGuard).toContain('legacy full-stem migration history requires operator reconciliation')
    expect(legacyGuard).not.toContain('where version in')
    expect(legacyGuard).not.toMatch(/string_agg|raise notice|select version|message\s*=\s*format/i)
    expect(output.indexOf('$bulla_bundle_history$;', guardStart))
      .toBeLessThan(output.indexOf('-- ####### 0016_backfill_profiles.sql'))
    expect(output).not.toContain('-- ####### 0001_extensions_and_helpers.sql')
    expect(output).not.toMatch(/\b(?:update|delete from|truncate)\s+supabase_migrations\.schema_migrations/iu)
    expect(output).not.toMatch(/on conflict|migration repair/iu)
  })

  it('locks history transactionally and refuses already-recorded selected versions instead of overwriting them', () => {
    const output = renderBundle(sources, '0016')
    expect(output.indexOf('begin;')).toBeLessThan(output.indexOf('lock table'))
    expect(output).toContain("set local lock_timeout = '4s';")
    expect(output).toContain('lock table supabase_migrations.schema_migrations in exclusive mode;')
    expect(output).toContain("where version in ('0016', '0022')")
    expect(output).toContain('selected migrations are already recorded')
    expect(output).toContain('add column if not exists statements text[]')
    expect(output).toContain('add column if not exists name text')
  })

  it('escapes a CLI-valid quoted name and does not rewrite migration SQL or split its statements', () => {
    const sql = "do $body$ begin perform 'select; inside a literal'; end $body$;\n"
    const output = renderBundle([{ filename: "0001_quoted'name.sql", sql }])
    expect(output).toContain("('0001', 'quoted''name')")
    expect(output).toContain(sql.trimEnd())
    expect(output).not.toContain('sql.split')
    expect(() => renderBundle([{ filename: names[0], sql: ' \n' }])).toThrow('no SQL content')
  })

  it('gates CLI execution on direct invocation and checks links/files before opening or truncating output', () => {
    expect(script).toContain('if (process.argv[1] && samePath(process.argv[1], scriptPath))')
    expect(script).toContain('const previous = plainFile(target, write)')
    expect(script).toContain('stat.isSymbolicLink()')
    expect(script).toContain('constants.O_NOFOLLOW')
    expect(script).toContain('constants.O_CREAT | constants.O_EXCL')
    expect(script).toContain('actual.dev !== previous.dev || actual.ino !== previous.ino')
    expect(script.indexOf('const fd = openPlainFile(locations.outputPath, true)'))
      .toBeLessThan(script.indexOf('ftruncateSync(fd, 0)'))
    expect(script).not.toMatch(/execSync|spawnSync|child_process|process\.env|fs\.rm\(|unlinkSync/)
  })
})

/**
 * True independent PostgreSQL connections; never PGlite/Promise.all(asUser).
 * Opt in only for the empty disposable loopback DB provisioned by CI.
 * The service is left for CI teardown; no existing DB/schema is dropped/reset.
 */
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomInt } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { RATE_LIMITS, type RateLimitBucket } from '../../src/lib/rate-limit/budgets'

const enabled = process.env.BULLA_ABUSE_TEST_ISOLATED === '1'
const connectionUrl = process.env.BULLA_ABUSE_TEST_DATABASE_URL
const migrations = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))
const bootstrap = fileURLToPath(new URL('../../supabase/tests/bootstrap.sql', import.meta.url))
const user = '70000000-0000-4000-8000-000000000001'
const post = '70000000-0000-4000-8000-000000000002'
let connectionEnv: NodeJS.ProcessEnv

function disposableTarget(raw: string | undefined, isolated: boolean) {
  if (!isolated || !raw) throw new Error('Concurrency requires an explicitly isolated disposable database.')
  let target: URL
  try { target = new URL(raw) } catch {
    throw new Error('Refusing an invalid disposable database URL.')
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/bulla_abuse_test' || target.search || target.hash) {
    throw new Error('Refusing concurrency migrations outside the disposable loopback bulla_abuse_test database.')
  }
  return target
}

type Result = { code: number; stdout: string; stderr: string }
function connection() {
  const child = spawn(process.env.BULLA_ABUSE_TEST_PSQL || 'psql', [
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-',
  ], { env: connectionEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const result = new Promise<Result>(resolve => {
    const deadline = setTimeout(() => {
      child.kill()
      resolve({ code: 1, stdout, stderr: 'Disposable PostgreSQL connection timed out.' })
    }, 30_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', () => {
      clearTimeout(deadline)
      resolve({ code: 1, stdout, stderr: 'Native PostgreSQL client unavailable.' })
    })
    child.once('close', code => { clearTimeout(deadline); resolve({ code: code ?? 1, stdout, stderr }) })
    // A failed executable or server disconnect must not leave an unhandled
    // EPIPE while the other independently connected workers are still running.
    child.stdin.on('error', () => { child.kill() })
  })
  return { child, result, output: () => stdout }
}

async function sql(statement: string) {
  const handle = connection()
  handle.child.stdin.end(statement)
  const result = await handle.result
  if (result.code !== 0) throw new Error(`Disposable PostgreSQL statement failed: ${result.stderr}`)
  return result.stdout.trim()
}

beforeAll(async () => {
  if (!enabled) return
  const target = disposableTarget(connectionUrl, enabled)
  connectionEnv = {
    ...process.env,
    PGHOST: target.hostname === '[::1]' ? '::1' : target.hostname,
    PGPORT: target.port || '5432',
    PGDATABASE: 'bulla_abuse_test',
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
  }
  // Exact target and emptiness checked before any DDL. Never run this on hosted
  // Supabase or against a local database containing another task's tables.
  expect(await sql(`select current_database()`)).toBe('bulla_abuse_test')
  const occupied = await sql(
    `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'app', 'auth') and c.relkind in ('r', 'p', 'v', 'm')`,
  )
  if (occupied !== '0') throw new Error('Refusing to initialize a nonempty concurrency database; use a fresh disposable service.')
  await sql(await readFile(bootstrap, 'utf8'))
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await sql(await readFile(new URL(name, new URL('../../supabase/migrations/', import.meta.url)), 'utf8'))
  }
  await sql(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ('${user}', 'native-concurrency@example.test', '{"full_name":"Native fixture"}');
     insert into public.posts (id, author_id, body)
     values ('${post}', '${user}', 'Native update fixture');`,
  )
}, 120_000)

describe('native concurrency target safety (no database access)', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts an explicitly isolated %s test target', host => {
    expect(disposableTarget(`postgresql://fixture:synthetic@${host}:5432/bulla_abuse_test`, true).pathname).toBe('/bulla_abuse_test')
  })
  it.each([
    'postgresql://fixture:do-not-log-password@staging.example.test/bulla_abuse_test',
    'postgresql://fixture:do-not-log-password@127.0.0.1/owner_database',
    'postgresql://fixture:do-not-log-password@127.0.0.1/bulla_abuse_test?sslmode=require',
    'postgresql://fixture:do-not-log-password@127.0.0.1/bulla_abuse_test#fragment',
    'not-a-database-url',
  ])('refuses unsafe target %# without echoing credentials', raw => {
    try {
      disposableTarget(raw, true)
      throw new Error('Unsafe target accepted')
    } catch (error) {
      expect((error as Error).message).toMatch(/Refusing/)
      expect((error as Error).message).not.toContain('do-not-log-password')
    }
  })
  it('refuses an unset isolation flag or missing target', () => {
    expect(() => disposableTarget('postgresql://fixture@127.0.0.1/bulla_abuse_test', false)).toThrow(/explicitly isolated/)
    expect(() => disposableTarget(undefined, true)).toThrow(/explicitly isolated/)
  })
})

async function synchronizedWriters(bucket: RateLimitBucket, initialHits: number, count: number, mutation: string) {
  const { limit, windowSeconds } = RATE_LIMITS[bucket]
  await sql(
    `insert into app.rate_limit_windows (bucket, subject, window_start, hits)
     values ('${bucket}', '${user}', to_timestamp(floor(extract(epoch from clock_timestamp()) / ${windowSeconds}) * ${windowSeconds}), ${initialHits})
     on conflict (bucket, subject, window_start) do update set hits = excluded.hits;`,
  )
  const gateKey = randomInt(100000, 2000000000)
  const gate = connection()
  // Attach handlers immediately, including failure paths before awaiting the gate.
  const gateCompletion = gate.result
  gate.child.stdin.write(`select pg_advisory_lock(${gateKey});\n\\echo BULLA_GATE_READY\n`)
  const workers: ReturnType<typeof connection>[] = []
  let waiterPids: string[] = []
  let barrierFailure: unknown
  try {
    const readyDeadline = Date.now() + 10_000
    while (!gate.output().includes('BULLA_GATE_READY')) {
      if (gate.child.exitCode !== null) throw new Error('Native PostgreSQL gate connection failed.')
      if (Date.now() > readyDeadline) throw new Error('Concurrent writer gate did not become ready.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (let index = 0; index < count; index += 1) {
      const worker = connection()
      workers.push(worker)
      worker.child.stdin.end(
        `begin;
         set local role authenticated;
         select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true);
         select set_config('request.jwt.claim.sub', '${user}', true);
         select 'backend=' || pg_backend_pid();
         select 'preflight=' || public.check_rate_limit('${bucket}', ${limit}, ${windowSeconds});
         select pg_advisory_xact_lock_shared(${gateKey});
         ${mutation}
         commit;`,
      )
    }
    // Prove simultaneous, independently connected waiters BEFORE releasing them.
    // Starting Promise.all alone is not proof the statements actually overlapped.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const output = await sql(
        `select pid from pg_stat_activity
         where datname = current_database() and wait_event = 'advisory'
           and query like '%pg_advisory_xact_lock_shared(${gateKey})%'
         order by pid`,
      )
      waiterPids = output.split(/\r?\n/).filter(Boolean)
      if (waiterPids.length === count) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(new Set(waiterPids).size).toBe(count)
  } catch (error) {
    barrierFailure = error
  } finally {
    gate.child.stdin.end(`select pg_advisory_unlock(${gateKey});\n\\q\n`)
    await gateCompletion
  }
  const results = await Promise.all(workers.map(worker => worker.result))
  if (barrierFailure) throw barrierFailure
  expect(results).toHaveLength(count)
  const backendPids = results.map(result => result.stdout.match(/backend=(\d+)/)?.[1])
  expect(backendPids.every(Boolean)).toBe(true)
  expect(new Set(backendPids).size).toBe(count)
  expect([...backendPids].sort()).toEqual([...waiterPids].sort())
  expect(results.every(result => result.stdout.includes('preflight=true'))).toBe(true)
  const accepted = results.filter(result => result.code === 0)
  const refused = results.filter(result => result.code !== 0)
  expect(accepted).toHaveLength(limit - initialHits)
  expect(refused).toHaveLength(count - (limit - initialHits))
  expect(refused.every(result => result.stderr.includes('rate_limit_exceeded'))).toBe(true)
  const storedHits = await sql(
    `select hits from app.rate_limit_windows
     where bucket = '${bucket}' and subject = '${user}'
       and window_start = to_timestamp(floor(extract(epoch from clock_timestamp()) / ${windowSeconds}) * ${windowSeconds})`,
  )
  expect(Number(storedHits)).toBe(limit)
  console.info(`[abuse-concurrency] ${bucket}: ${count} distinct simultaneous backends; ${accepted.length} accepted, ${refused.length} refused; hits=${storedHits}.`)
}

describe.skipIf(!enabled)('native independent-connection abuse budgets', () => {
  it('allows exactly N of N+1 synchronized raw INSERTs despite every preflight allowing them', async () => {
    const limit = RATE_LIMITS['bug:file'].limit
    await synchronizedWriters('bug:file', 0, limit + 1,
      `insert into public.bug_reports (title, body) values ('Concurrent fixture', 'Native independent-connection synthetic fixture.');`,
    )
    expect(Number(await sql(`select count(*) from public.bug_reports where reporter_id = '${user}'`))).toBe(limit)
  }, 60_000)

  it('allows one of eight synchronized raw UPDATEs with one hit remaining and keeps the rest rolled back', async () => {
    const limit = RATE_LIMITS['post:write'].limit
    await synchronizedWriters('post:write', limit - 1, 8,
      `update public.posts set body = body || ' accepted' where id = '${post}';`,
    )
    expect(await sql(`select body from public.posts where id = '${post}'`)).toBe('Native update fixture accepted')
  }, 60_000)
})

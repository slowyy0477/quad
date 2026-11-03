import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempWorkspace, type TempWorkspace } from '../helpers/temp-workspace'

const execute = promisify(execFile)
const inspector = fileURLToPath(new URL('../../scripts/bulla/check-build.mjs', import.meta.url))
const canary = 'synthetic-bulla-server-key-canary-for-artifact-tests'
let fixture: TempWorkspace
let dist: string
let report: string

beforeEach(async () => {
  fixture = await createTempWorkspace('build-privacy')
  dist = path.join(fixture.directory, 'dist')
  report = path.join(fixture.directory, 'REPORT.md')
  await fs.mkdir(path.join(dist, 'server'), { recursive: true })
  await fs.mkdir(path.join(dist, 'static', 'chunks'), { recursive: true })
})

afterEach(async () => { await fixture?.cleanup() })

async function sample({
  files = ['../../node_modules/react/index.js'],
  client = 'console.log("synthetic client fixture")',
  manifest = true,
  chunk = true,
}: { files?: string[]; client?: string; manifest?: boolean; chunk?: boolean } = {}) {
  if (manifest) await fs.writeFile(path.join(dist, 'server', 'page.js.nft.json'), JSON.stringify({ version: 1, files }))
  if (chunk) await fs.writeFile(path.join(dist, 'static', 'chunks', 'page.js'), client)
}

function inspect(marker = canary) {
  return execute(process.execPath, [inspector, dist, report], {
    env: { ...process.env, BULLA_BUILD_SECRET_CANARY: marker },
    windowsHide: true,
    timeout: 10_000,
  })
}

describe('deployment artifact privacy evidence', () => {
  it('accepts nonempty public artifacts and records counts without revealing the marker', async () => {
    await sample()
    const result = await inspect()
    const markdown = await fs.readFile(report, 'utf8')
    expect(markdown).toContain('Result: Passed')
    expect(markdown).toContain('trace manifests inspected | 1')
    expect(markdown).toContain('Client chunk/map files inspected | 1')
    expect(markdown).not.toContain(canary)
    expect(result.stdout).not.toContain(canary)
  })

  it.each(['../../.env.local', '../../data/local.json', '../../credentials/admin.txt'])(
    'rejects a deployment trace containing the private path %s',
    async (privatePath) => {
      await sample({ files: [privatePath] })
      await expect(inspect()).rejects.toMatchObject({ code: 1 })
      const markdown = await fs.readFile(report, 'utf8')
      expect(markdown).toContain('Result: Failed')
      expect(markdown).toContain(privatePath)
    },
  )

  it('rejects a server-key marker in client output without copying its value into evidence', async () => {
    await sample({ client: `console.log("${canary}")` })
    const failure = await inspect().then(
      () => { throw new Error('Unsafe client artifact was accepted') },
      error => error as { code: number; stdout: string },
    )
    expect(failure.code).toBe(1)
    const markdown = await fs.readFile(report, 'utf8')
    expect(markdown).toContain('canary matches in client output | 1')
    expect(markdown).not.toContain(canary)
    expect(failure.stdout).not.toContain(canary)
  })

  it.each(['manifest', 'client'] as const)('does not pass a vacuous %s inventory', async (missing) => {
    await sample({ manifest: missing !== 'manifest', chunk: missing !== 'client' })
    await expect(inspect()).rejects.toMatchObject({ code: 1 })
    expect(await fs.readFile(report, 'utf8')).toContain('Result: Failed')
  })

  it('refuses an empty marker rather than claiming an empty-secret scan passed', async () => {
    await sample()
    await expect(inspect('')).rejects.toMatchObject({ code: 1 })
    await expect(fs.readFile(report, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not replace an existing evidence file', async () => {
    await sample()
    await fs.writeFile(report, 'preserve-existing-evidence')
    await expect(inspect()).rejects.toMatchObject({ code: 1 })
    expect(await fs.readFile(report, 'utf8')).toBe('preserve-existing-evidence')
  })

  it('does not follow a nested junction into another artifact directory', async () => {
    await sample()
    const outsideDist = path.join(fixture.directory, 'other-owned-fixture')
    await fs.mkdir(outsideDist)
    await fs.writeFile(path.join(outsideDist, 'private.nft.json'), JSON.stringify({ files: ['../../data/local.json'] }))
    await fs.symlink(outsideDist, path.join(dist, 'nested-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await inspect()
    expect(await fs.readFile(report, 'utf8')).toContain('Result: Passed')
  })
})

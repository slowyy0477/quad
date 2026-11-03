import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
const sdk = createRequire(import.meta.url)('@supabase/supabase-js/package.json')
const hosting = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'))
const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const uploadIgnore = (await readFile(new URL('../../.vercelignore', import.meta.url), 'utf8'))
  .split(/\r?\n/).map(line => line.trim())

describe('current application runtime contract, not host acceptance', () => {
  it('pins the tested Node major instead of letting the host silently select a newer major', () => {
    expect(manifest.engines.node).toBe('24.x')
    expect(sdk.engines.node).toBe('>=22.0.0')
  })

  it('keeps the root lockfile runtime requirement aligned without changing dependency versions', () => {
    expect(lock.packages[''].engines).toEqual(manifest.engines)
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies)
  })

  it('runs this local/CI test in a compatible Node runtime with native WebSocket support', () => {
    expect(Number(process.versions.node.split('.')[0])).toBe(24)
    expect(typeof globalThis.WebSocket).toBe('function')
  })

  it('keeps CI on the pinned major and uses the selected single-region Next host', () => {
    expect(ci).toMatch(/node-version:\s*24(?:\s|$)/)
    expect(hosting.framework).toBe('nextjs')
    expect(hosting.regions).toEqual(['arn1'])
  })

  it('excludes only the root local store, not the admin data explanation route', () => {
    expect(uploadIgnore).toContain('/data/')
    expect(uploadIgnore).not.toContain('data')
    expect(uploadIgnore).toContain('/credentials/')
    expect(uploadIgnore).toContain('.env.*')
  })
})

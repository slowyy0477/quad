import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
const sdk = createRequire(import.meta.url)('@supabase/supabase-js/package.json')

describe('current application runtime contract, not host acceptance', () => {
  it('does not advertise a Node runtime older than the pinned SDK supports', () => {
    expect(manifest.engines.node).toBe('>=22.0.0')
    expect(sdk.engines.node).toBe('>=22.0.0')
  })

  it('keeps the root lockfile runtime requirement aligned without changing dependency versions', () => {
    expect(lock.packages[''].engines).toEqual(manifest.engines)
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies)
  })

  it('runs this local/CI test in a compatible Node runtime with native WebSocket support', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22)
    expect(typeof globalThis.WebSocket).toBe('function')
  })
})

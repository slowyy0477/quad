import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const workerPath = path.join(process.cwd(), 'public', 'sw.js')

describe('privacy-safe PWA', () => {
  it('shows only public offline help when a document navigation loses the network', async () => {
    const { listeners } = workerHarness(async () => { throw new Error('offline') })
    expect(listeners.has('fetch')).toBe(true)
    let response: Promise<Response> | undefined
    listeners.get('fetch')!({
      request: { url: 'https://quad.example/messages', method: 'GET', mode: 'navigate', headers: new Headers() },
      respondWith(value: Promise<Response>) { response = value },
    })
    expect(await (await response!).text()).toBe('offline-help')
  })

  it('never intercepts account POSTs or private RSC payloads', () => {
    const { listeners } = workerHarness(fetch)
    for (const request of [
      { url: 'https://quad.example/login', method: 'POST', mode: 'navigate', headers: new Headers() },
      { url: 'https://quad.example/messages?_rsc=private', method: 'GET', mode: 'cors', headers: new Headers({ RSC: '1' }) },
    ]) {
      let intercepted = false
      listeners.get('fetch')!({ request, respondWith() { intercepted = true } })
      expect(intercepted).toBe(false)
    }
  })

  it('keeps the precache strictly public and contains no messages or auth screens', async () => {
    const { listeners, cached } = workerHarness(fetch)
    let installed: Promise<unknown> | undefined
    listeners.get('install')!({ waitUntil(value: Promise<unknown>) { installed = value } })
    await installed
    expect(cached.sort()).toEqual(['/icons/bulla-192.png', '/icons/bulla-512.png', '/icons/bulla-maskable-512.png', '/offline.html'])
    for (const asset of cached) expect(existsSync(path.join(process.cwd(), 'public', asset))).toBe(true)
  })

  it('ships an installable service worker', () => {
    expect(existsSync(workerPath)).toBe(true)
  })
})

// Later tests exercise the real worker in a minimal service-worker environment.
export function workerHarness(fetchImpl: typeof fetch) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const cached: string[] = []
  const scope = {
    addEventListener(name: string, cb: (event: Record<string, unknown>) => void) { listeners.set(name, cb) },
    location: { origin: 'https://quad.example' },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
  }
  vm.runInNewContext(readFileSync(workerPath, 'utf8'), {
    self: scope, URL, Request, Response, fetch: fetchImpl,
    caches: {
      open: async () => ({ addAll: async (items: string[]) => { cached.push(...items) }, match: async (url: string) => url === '/offline.html' ? new Response('offline-help') : undefined }),
      keys: async () => [], delete: async () => true,
      match: async (url: string) => url === '/offline.html' ? new Response('offline-help') : undefined,
    },
  })
  return { listeners, cached }
}

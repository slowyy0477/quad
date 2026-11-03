import { afterEach, describe, expect, it, vi } from 'vitest'
import type { APIResponse, Page, Request, Response, Route } from '@playwright/test'
import { finiteJsonResponse } from '../e2e/helpers/finite-json-response'

const origin = 'http://127.0.0.1:3307'
const endpoint = `${origin}/api/uploads/avatar`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function uploadRequest(url = endpoint, method = 'POST') {
  const headers = {
    origin, 'content-type': 'image/png',
    cookie: 'quad_local_session=synthetic-unit-cookie',
    authorization: 'Bearer synthetic-unit-only',
  }
  const bytes = Buffer.from('synthetic-unit-raster-bytes')
  const raw = {
    url: () => url,
    method: () => method,
    allHeaders: vi.fn(async () => headers),
    postDataBuffer: () => bytes,
  }
  return { raw, headers, bytes, request: raw as unknown as Request }
}

function otherRoute(url = endpoint, method = 'POST') {
  const request = uploadRequest(url, method)
  const raw = {
    request: () => request.request,
    fetch: vi.fn(), fulfill: vi.fn(),
    abort: vi.fn(async () => undefined), fallback: vi.fn(async () => undefined),
  }
  return { raw, request, route: raw as unknown as Route }
}

/** Promise-only transport doubles, never browser acceptance or provider proof. */
function fixture(options: {
  text?: string; status?: number; browserStatus?: number; upstreamURL?: string; pendingBody?: boolean
} = {}) {
  const status = options.status ?? 201
  const bytes = Buffer.from(options.text ?? ' \n{"ok":true,"image":{"id":"synthetic-unit-observation"}}\n')
  const request = uploadRequest()
  const observed = deferred<Response>()
  const click = deferred<unknown>()
  const started = deferred<void>()
  const bodyStarted = deferred<void>()
  const body = deferred<Buffer>()
  if (!options.pendingBody) body.resolve(bytes)
  const order: string[] = []
  const headers = {
    'content-type': 'application/json', 'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization', 'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  }
  const upstream = {
    url: () => options.upstreamURL ?? endpoint,
    status: () => status,
    headers: () => headers,
    body: vi.fn(() => { order.push('body'); bodyStarted.resolve(undefined); return body.promise }),
    dispose: vi.fn(async () => { order.push('dispose') }),
  }
  const apiResponse = upstream as unknown as APIResponse
  const browser = {
    url: () => endpoint,
    status: () => options.browserStatus ?? status,
    request: () => request.request,
    // Simulate the actual failure: CDP is evicted as soon as delivery refreshes.
    json: vi.fn(async () => { throw new Error('Synthetic CDP body eviction') }),
    body: vi.fn(async () => { throw new Error('Synthetic CDP body eviction') }),
  }
  const browserResponse = browser as unknown as Response
  let urlMatches!: (url: URL) => boolean
  let handler!: (route: Route) => Promise<void>
  let responseMatches!: (response: Response) => boolean | Promise<boolean>
  let routing!: Promise<void>
  const route = {
    request: () => request.request,
    fetch: vi.fn<Route['fetch']>(async () => { order.push('fetch'); return apiResponse }),
    fulfill: vi.fn(async (value: { response?: APIResponse; body?: string | Buffer }) => {
      order.push('fulfill')
      expect(value).toEqual({ response: apiResponse, body: bytes })
      if (await responseMatches(browserResponse)) observed.resolve(browserResponse)
    }),
    abort: vi.fn(async () => { order.push('abort') }),
    fallback: vi.fn(async () => undefined),
  }
  const page = {
    route: vi.fn(async (matches: typeof urlMatches, callback: typeof handler) => {
      order.push('route')
      urlMatches = matches
      handler = callback
    }),
    unroute: vi.fn(async () => { order.push('unroute') }),
    waitForResponse: vi.fn((matches: typeof responseMatches, options: { timeout?: number; signal?: AbortSignal }) => {
      order.push('observe')
      responseMatches = matches
      options.signal?.addEventListener('abort', () => observed.reject(options.signal?.reason), { once: true })
      return observed.promise
    }),
  }
  const trigger = vi.fn(() => {
    order.push('click')
    routing = handler(route as unknown as Route)
    started.resolve(undefined)
    return click.promise
  })
  return {
    page: page as unknown as Pick<Page, 'route' | 'unroute' | 'waitForResponse'>,
    rawPage: page, trigger, observed, click, started, bodyStarted, body, order,
    request, route, upstream, apiResponse, browser, browserResponse, bytes, headers,
    matchesURL: (url: string) => urlMatches(new URL(url)),
    matchesResponse: (response: Response) => responseMatches(response),
    handle: (candidate: Route) => handler(candidate),
    routing: () => routing,
  }
}

function expectOneObservation(current: ReturnType<typeof fixture>) {
  expect(current.rawPage.route).toHaveBeenCalledOnce()
  expect(current.rawPage.waitForResponse).toHaveBeenCalledOnce()
  expect(current.trigger).toHaveBeenCalledOnce()
  expect(current.route.fetch).toHaveBeenCalledOnce()
  expect(current.browser.json).not.toHaveBeenCalled()
  expect(current.browser.body).not.toHaveBeenCalled()
  expect(current.rawPage.unroute).toHaveBeenCalledOnce()
  expect(current.rawPage.unroute).toHaveBeenCalledWith(...current.rawPage.route.mock.calls[0])
}

afterEach(() => { vi.useRealTimers() })

describe('exact real-response finite JSON browser observations', () => {
  it('captures real bytes before unchanged delivery, despite immediate CDP eviction and a pending click', async () => {
    const current = fixture()
    let completed = false
    const result = finiteJsonResponse(current.page, endpoint, current.trigger).then((value) => {
      completed = true
      return value
    })
    await current.started.promise
    await current.routing()
    expect(current.order).toEqual(['route', 'observe', 'click', 'fetch', 'body', 'fulfill', 'dispose'])
    expect(completed).toBe(false)
    expect(current.route.fulfill).toHaveBeenCalledWith({ response: current.apiResponse, body: current.bytes })
    current.click.resolve(undefined)
    const saved = await result
    expect(saved.response).toBe(current.browserResponse)
    expect(saved.body).toEqual({ ok: true, image: { id: 'synthetic-unit-observation' } })
    expect(saved.upstream).toEqual({ url: endpoint, status: 201, headers: current.headers })
    expect(saved.request).toEqual({ headers: current.request.headers, bytes: current.request.bytes })
    expect(current.upstream.body).toHaveBeenCalledOnce()
    expect(current.upstream.dispose).toHaveBeenCalledOnce()
    expectOneObservation(current)
  })

  it('waits for complete finite bytes before delivering or accepting a completed click', async () => {
    const current = fixture({ pendingBody: true })
    let completed = false
    const result = finiteJsonResponse(current.page, endpoint, current.trigger).then((value) => {
      completed = true
      return value
    })
    await current.bodyStarted.promise
    current.click.resolve(undefined)
    expect(current.route.fulfill).not.toHaveBeenCalled()
    expect(completed).toBe(false)
    current.body.resolve(current.bytes)
    expect((await result).body).toEqual(JSON.parse(current.bytes.toString('utf8')))
    expectOneObservation(current)
  })

  it('preserves original cookies/auth/headers and raster bytes without method, URL or body overrides', async () => {
    const current = fixture()
    const result = finiteJsonResponse(current.page, endpoint, current.trigger, { timeout: 12_345 })
    await current.started.promise
    await current.routing()
    expect(current.request.raw.allHeaders).toHaveBeenCalledOnce()
    expect(current.route.fetch).toHaveBeenCalledWith({
      headers: current.request.headers, timeout: 12_345, maxRedirects: 0, maxRetries: 0,
      signal: expect.any(AbortSignal),
    })
    expect(current.rawPage.waitForResponse.mock.calls[0][1]).toEqual({
      timeout: 12_345, signal: expect.any(AbortSignal),
    })
    current.click.resolve(undefined)
    expect((await result).request.bytes).toBe(current.request.bytes)
    expectOneObservation(current)
  })

  it.each([401, 403, 413, 415, 429, 503, 307])('preserves genuine rejected/redirect status %s, JSON and headers without fallback success', async (status) => {
    const refused = { ok: false, error: { code: `synthetic_refusal_${status}` } }
    const current = fixture({ status, text: ` \n${JSON.stringify(refused)}\n` })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    const saved = await result
    expect(saved.response.status()).toBe(status)
    expect(saved.upstream.status).toBe(status)
    expect(saved.body).toEqual(refused)
    expect(saved.upstream.headers).toEqual(current.headers)
    expect(current.route.fulfill).toHaveBeenCalledWith({ response: current.apiResponse, body: current.bytes })
    expectOneObservation(current)
  })

  it('uses an exact URL/POST observer and falls back only for unrelated requests', async () => {
    const current = fixture()
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    await current.started.promise
    for (const [url, method] of [
      [endpoint, 'GET'],
      ['https://remote.example.test/api/uploads/avatar', 'POST'],
      [`${origin}/api/uploads/projects/prj_other/cover`, 'POST'],
      [`${endpoint}?unrelated=1`, 'POST'],
      [`${endpoint}#unrelated`, 'POST'],
    ]) {
      const other = otherRoute(url, method)
      const response = { url: () => url, request: () => other.request.request } as unknown as Response
      expect(await current.matchesResponse(response)).toBe(false)
      expect(current.matchesURL(url)).toBe(url === endpoint)
      await current.handle(other.route)
      expect(other.raw.fallback).toHaveBeenCalledOnce()
      expect(other.raw.fetch).not.toHaveBeenCalled()
      expect(other.raw.fulfill).not.toHaveBeenCalled()
    }
    await current.routing()
    current.click.resolve(undefined)
    expect((await result).response).toBe(current.browserResponse)
    expectOneObservation(current)
  })

  it('rejects a faulty waiter that supplies another POST even at the same endpoint', async () => {
    const current = fixture({ pendingBody: true })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toThrow('does not match the captured real POST')
    await current.bodyStarted.promise
    const other = uploadRequest()
    current.observed.resolve({
      url: () => endpoint, status: () => 201, request: () => other.request,
    } as unknown as Response)
    current.body.resolve(current.bytes)
    current.click.resolve(undefined)
    await rejected
    expectOneObservation(current)
  })

  it('rejects changed browser status rather than accepting captured success alone', async () => {
    const current = fixture({ browserStatus: 503 })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toThrow('does not match the captured real POST')
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    await rejected
    expectOneObservation(current)
  })

  it('refuses a faulty upstream URL before fulfillment and disposes the real response', async () => {
    const current = fixture({ upstreamURL: 'https://remote.example.test/api/uploads/avatar' })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toThrow('upstream endpoint changed')
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    await rejected
    expect(current.route.fulfill).not.toHaveBeenCalled()
    expect(current.route.abort).toHaveBeenCalledOnce()
    expect(current.upstream.dispose).toHaveBeenCalledOnce()
    expectOneObservation(current)
  })

  it('delivers malformed real bytes unchanged but propagates JSON failure, never a retry or success substitute', async () => {
    const current = fixture({ text: ' \nnot-json\n' })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toBeInstanceOf(SyntaxError)
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    await rejected
    expect(current.route.fulfill).toHaveBeenCalledWith({ response: current.apiResponse, body: current.bytes })
    expect(current.route.abort).not.toHaveBeenCalled()
    expect(current.upstream.dispose).toHaveBeenCalledOnce()
    expectOneObservation(current)
  })

  it.each(['fetch', 'body', 'fulfill', 'dispose'] as const)('propagates %s failure without another POST or invented response', async (stage) => {
    const current = fixture()
    const failure = new Error(`Synthetic ${stage} failure`)
    if (stage === 'fetch') current.route.fetch.mockRejectedValueOnce(failure)
    if (stage === 'body') current.upstream.body.mockRejectedValueOnce(failure)
    if (stage === 'fulfill') current.route.fulfill.mockRejectedValueOnce(failure)
    if (stage === 'dispose') current.upstream.dispose.mockRejectedValueOnce(failure)
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toBe(failure)
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    await rejected
    if (stage === 'fetch' || stage === 'body') expect(current.route.fulfill).not.toHaveBeenCalled()
    expectOneObservation(current)
  })

  it('propagates the actual response-wait timeout and prevents late body delivery', async () => {
    const current = fixture({ pendingBody: true })
    const failure = new Error('Synthetic finite response timeout')
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toBe(failure)
    await current.bodyStarted.promise
    current.observed.reject(failure)
    current.click.resolve(undefined)
    await rejected
    current.body.resolve(current.bytes)
    await current.routing()
    expect(current.route.fulfill).not.toHaveBeenCalled()
    expect(current.route.abort).toHaveBeenCalledOnce()
    expectOneObservation(current)
  })

  it('does not accept committed JSON when the real gesture fails', async () => {
    const current = fixture()
    const failure = new Error('Synthetic click failure')
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toBe(failure)
    await current.started.promise
    await current.routing()
    current.click.reject(failure)
    await rejected
    expectOneObservation(current)
  })

  it('propagates a synchronous gesture throw as a rejection', async () => {
    const current = fixture()
    const failure = new Error('Synthetic synchronous click failure')
    const trigger = vi.fn(() => { throw failure })
    await expect(finiteJsonResponse(current.page, endpoint, trigger)).rejects.toBe(failure)
    expect(trigger).toHaveBeenCalledOnce()
    expect(current.rawPage.waitForResponse).toHaveBeenCalledOnce()
    expect(current.route.fetch).not.toHaveBeenCalled()
    expect(current.rawPage.unroute).toHaveBeenCalledOnce()
  })

  it.each(['body', 'gesture'] as const)('bounds a stuck %s with a deadline and removes only its own route', async (stage) => {
    vi.useFakeTimers()
    const current = fixture({ pendingBody: stage === 'body' })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger, { timeout: 17 })
    const rejected = expect(result).rejects.toThrow('bounded deadline')
    await current.bodyStarted.promise
    if (stage === 'body') current.click.resolve(undefined)
    else await current.routing()
    await vi.advanceTimersByTimeAsync(17)
    await rejected
    if (stage === 'body') {
      current.body.resolve(current.bytes)
      await current.routing()
      expect(current.route.fulfill).not.toHaveBeenCalled()
    } else current.click.resolve(undefined)
    expect(current.route.fetch.mock.calls[0][0]?.signal?.aborted).toBe(true)
    expectOneObservation(current)
  })

  it('aborts a duplicate exact POST without fetching it or accepting the first response as sufficient', async () => {
    const current = fixture({ pendingBody: true })
    const result = finiteJsonResponse(current.page, endpoint, current.trigger)
    const rejected = expect(result).rejects.toThrow('only one exact POST')
    await current.bodyStarted.promise
    const duplicate = otherRoute()
    await current.handle(duplicate.route)
    await rejected
    current.body.resolve(current.bytes)
    current.click.resolve(undefined)
    await current.routing()
    expect(duplicate.raw.abort).toHaveBeenCalledOnce()
    expect(duplicate.raw.fetch).not.toHaveBeenCalled()
    expect(current.route.fulfill).not.toHaveBeenCalled()
    expectOneObservation(current)
  })

  it('refuses an over-budget finite body without inventing a smaller successful response', async () => {
    const current = fixture()
    const result = finiteJsonResponse(current.page, endpoint, current.trigger, { maxBytes: 1 })
    const rejected = expect(result).rejects.toThrow('observation byte limit')
    await current.started.promise
    await current.routing()
    current.click.resolve(undefined)
    await rejected
    expect(current.route.fulfill).not.toHaveBeenCalled()
    expect(current.route.abort).toHaveBeenCalledOnce()
    expect(current.upstream.dispose).toHaveBeenCalledOnce()
    expectOneObservation(current)
  })

  it('requires an exact endpoint and gesture before installing a route', async () => {
    const current = fixture()
    await expect(finiteJsonResponse(current.page, undefined as never, current.trigger))
      .rejects.toThrow('endpoint URL and one explicit gesture are required')
    await expect(finiteJsonResponse(current.page, endpoint, undefined as never))
      .rejects.toThrow('endpoint URL and one explicit gesture are required')
    expect(current.rawPage.route).not.toHaveBeenCalled()
    expect(current.trigger).not.toHaveBeenCalled()
  })

  it.each([
    'https://remote.example.test/api/uploads/avatar',
    'http://127.0.0.1:3000/api/uploads/avatar',
    'http://127.0.0.1/api/uploads/avatar',
    'http://user:pass@127.0.0.1:3307/api/uploads/avatar',
    'https://127.0.0.1:3307/api/uploads/avatar',
    `${endpoint}?unrelated=1`, `${endpoint}#unrelated`,
    `${origin}/storage/raw`, '/api/uploads/avatar',
  ])('refuses an unsafe/nonexact target %s before any gesture or network operation', async (url) => {
    const current = fixture()
    await expect(finiteJsonResponse(current.page, url, current.trigger)).rejects.toThrow()
    expect(current.rawPage.route).not.toHaveBeenCalled()
    expect(current.route.fetch).not.toHaveBeenCalled()
    expect(current.trigger).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, Infinity, 0.5, 2_147_483_648])('refuses a nonfinite/nonpositive/timer-unsafe timeout (%s)', async (timeout) => {
    const current = fixture()
    await expect(finiteJsonResponse(current.page, endpoint, current.trigger, { timeout }))
      .rejects.toThrow('finite positive timer-safe integer')
    expect(current.rawPage.route).not.toHaveBeenCalled()
    expect(current.trigger).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, Infinity, 0.5])('refuses an invalid finite-byte limit (%s)', async (maxBytes) => {
    const current = fixture()
    await expect(finiteJsonResponse(current.page, endpoint, current.trigger, { maxBytes }))
      .rejects.toThrow('byte limit must be a finite positive integer')
    expect(current.rawPage.route).not.toHaveBeenCalled()
    expect(current.trigger).not.toHaveBeenCalled()
  })
})

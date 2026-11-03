import type { APIResponse, Page, Request, Response, Route } from '@playwright/test'

type Capture = {
  body: unknown
  upstream: { url: string; status: number; headers: Record<string, string> }
  request: { headers: Record<string, string>; bytes: Buffer | null }
  browserRequest: Request
}

/**
 * One exact local POST is fetched once with its original headers/cookies/body.
 * Capture the real finite response before delivering it unchanged to the UI;
 * an automatic refresh can then evict CDP's body without losing our evidence.
 * No retries, redirect following, manufactured response or alternate GET proof.
 * This is not a helper for open Server Action/RSC streams. The caller still
 * validates accepted/rejected status, JSON, privacy and durable associations.
 */
export async function finiteJsonResponse(
  page: Pick<Page, 'route' | 'unroute' | 'waitForResponse'>,
  endpoint: string,
  trigger: () => Promise<unknown>,
  options: { timeout?: number; maxBytes?: number } = {},
): Promise<Omit<Capture, 'browserRequest'> & { response: Response }> {
  if (typeof endpoint !== 'string' || typeof trigger !== 'function') {
    throw new Error('An exact finite JSON endpoint URL and one explicit gesture are required.')
  }
  const target = new URL(endpoint)
  if (target.href !== endpoint || target.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !target.port || target.port === '3000' || target.username || target.password ||
      !target.pathname.startsWith('/api/') || target.search || target.hash) {
    throw new Error('Finite JSON capture requires an exact isolated loopback API URL, never an owner or remote endpoint.')
  }
  const timeout = options.timeout ?? 40_000
  const maxBytes = options.maxBytes ?? 64 * 1024
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('The finite JSON timeout must be a finite positive timer-safe integer.')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('The finite JSON byte limit must be a finite positive integer.')
  }
  const controller = new AbortController()
  let accept!: (capture: Capture) => void
  let refuse!: (error: unknown) => void
  const captured = new Promise<Capture>((resolve) => { accept = resolve })
  const failure = new Promise<never>((_, reject) => { refuse = reject })
  const exactURL = (url: URL) => url.href === endpoint
  let browserRequest: Request | undefined
  const handler = async (route: Route) => {
    const request = route.request()
    if (request.url() !== endpoint || request.method() !== 'POST') {
      await route.fallback() // Preserve existing context routing for other requests.
      return
    }
    if (browserRequest) {
      refuse(new Error('Finite JSON capture permits only one exact POST.'))
      await route.abort('failed')
      return
    }
    browserRequest = request
    let upstream: APIResponse | undefined
    let delivered = false
    try {
      let saved: Capture
      try {
        // allHeaders includes the actual Cookie/Authorization headers; do not
        // replace the original method, URL, raster bytes or session context.
        const headers = await request.allHeaders()
        upstream = await route.fetch({
          headers, maxRedirects: 0, maxRetries: 0, timeout, signal: controller.signal,
        })
        const bytes = await upstream.body()
        if (controller.signal.aborted) throw controller.signal.reason
        if (upstream.url() !== endpoint) throw new Error('Finite JSON upstream endpoint changed.')
        if (bytes.length > maxBytes) throw new Error('Finite JSON response exceeds the observation byte limit.')
        const server = { url: upstream.url(), status: upstream.status(), headers: upstream.headers() }
        // Preserve status/headers and exact captured bytes, including refusals.
        // Do not reserialize JSON or inject a successful envelope.
        await route.fulfill({ response: upstream, body: bytes })
        delivered = true
        saved = {
          body: JSON.parse(bytes.toString('utf8')) as unknown, upstream: server,
          request: { headers, bytes: request.postDataBuffer() }, browserRequest: request,
        }
      } finally {
        await upstream?.dispose()
      }
      accept(saved)
    } catch (error) {
      refuse(error) // Observation errors fail the helper, never become success.
      if (!delivered) await route.abort('failed')
    }
  }
  await page.route(exactURL, handler)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observed = page.waitForResponse((response) => response.url() === endpoint &&
      response.request().method() === 'POST', { timeout, signal: controller.signal })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Finite JSON observation exceeded its bounded deadline.')
        reject(error)
        controller.abort(error)
      }, timeout)
    })
    const [response, saved] = await Promise.race([
      Promise.all([observed, captured, Promise.resolve().then(trigger)]),
      failure,
      deadline,
    ])
    if (response.request() !== saved.browserRequest || response.url() !== saved.upstream.url ||
        response.status() !== saved.upstream.status) {
      throw new Error('Finite JSON browser response does not match the captured real POST.')
    }
    return { response, body: saved.body, upstream: saved.upstream, request: saved.request }
  } finally {
    clearTimeout(timer)
    controller.abort(new Error('Finite JSON observation ended.'))
    await page.unroute(exactURL, handler) // Remove only this observer, including on failure.
  }
}

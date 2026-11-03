import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { readBoundedImageBody, requireSameOriginWrite, validateImageHeaders } from '../../src/features/uploads/body'
import { IMAGE_UPLOAD_LIMITS } from '../../src/features/uploads/contracts'

function request(body: BodyInit, headers: Record<string, string | undefined> = {}, signal?: AbortSignal) {
  const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) as Record<string, string>
  return new Request('http://127.0.0.1:3999/api/uploads/avatar', {
    method: 'POST', body, signal,
    headers: { origin: 'http://127.0.0.1:3999', 'content-type': 'image/png', ...cleanHeaders },
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('image write origin and raw-body boundary', () => {
  it('accepts the actual loopback authority rather than rewriting 127.0.0.1', () => {
    expect(() => requireSameOriginWrite(request('test', { host: '127.0.0.1:3999' }))).not.toThrow()
  })

  it.each([
    { origin: '' },
    { origin: 'null' },
    { origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'attacker.example', 'x-forwarded-host': '127.0.0.1:3999' },
  ])('rejects missing/cross-origin origins and forged forwarding: %o', headers => {
    expect(() => requireSameOriginWrite(request('test', headers))).toThrow('same-origin')
  })

  it('uses a valid configured production origin and fails closed on malformed configuration', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://bulla.example')
    expect(() => requireSameOriginWrite(request('test', { origin: 'https://bulla.example', host: 'internal:3000' }))).not.toThrow()
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://bulla.example/evil')
    expect(() => requireSameOriginWrite(request('test', { origin: 'https://bulla.example' }))).toThrow()
  })

  it.each([
    { 'content-type': 'image/svg+xml' },
    { 'content-type': 'text/html' },
    { 'content-type': 'image/gif' },
    { 'content-type': 'multipart/form-data; boundary=bad' },
    { 'content-type': 'image/png; charset=utf-8' },
    { 'content-encoding': 'gzip' },
  ])('rejects non-raster/enveloped/encoded inputs: %o', headers => {
    expect(() => validateImageHeaders(request('test', headers))).toThrow('PNG, JPEG')
  })

  it('checks declared size early, but never trusts it as the actual bound', async () => {
    expect(() => validateImageHeaders(request('test', { 'content-length': String(IMAGE_UPLOAD_LIMITS.inputBytes + 1) }))).toThrow('5 MiB')
    expect(() => validateImageHeaders(request('test', { 'content-length': '-1' }))).toThrow('length')
    expect(() => validateImageHeaders(request('test', { 'content-length': 'NaN' }))).toThrow('length')
    const cancel = vi.fn()
    let chunks = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(1024 * 1024)) },
      cancel,
    })
    const input = request(stream, { 'content-length': '1' })
    expect(validateImageHeaders(input)).toBe('image/png')
    await expect(readBoundedImageBody(input)).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalledOnce()
    expect(chunks).toBeLessThanOrEqual(7)
  })

  it('counts chunked bodies without Content-Length and accepts the exact limit', async () => {
    const input = request(new Uint8Array(IMAGE_UPLOAD_LIMITS.inputBytes))
    expect(input.headers.has('content-length')).toBe(false)
    expect(await readBoundedImageBody(input)).toHaveLength(IMAGE_UPLOAD_LIMITS.inputBytes)
  })

  it('copies accepted chunks instead of retaining producer-owned mutable views', async () => {
    const chunk = new Uint8Array([1, 2, 3])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.close() },
    })
    const result = await readBoundedImageBody(request(stream))
    chunk.fill(0)
    expect([...result]).toEqual([1, 2, 3])
  })

  it('times out even when the underlying cancellation promise never resolves', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const pending = readBoundedImageBody(request(new ReadableStream<Uint8Array>({ cancel })))
    const assertion = expect(pending).rejects.toMatchObject({ status: 408, code: 'upload_timeout' })
    await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_LIMITS.bodyTimeoutMs)
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('handles aborted, empty and failed streams without accepting partial bytes', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(readBoundedImageBody(request('partial', {}, abort.signal))).rejects.toMatchObject({ status: 408 })
    await expect(readBoundedImageBody(request(new Uint8Array()))).rejects.toMatchObject({ status: 400 })
    await expect(readBoundedImageBody(request(new ReadableStream({ start(controller) { controller.error(new Error('fixture')) } }))))
      .rejects.toMatchObject({ status: 400 })
  })
})

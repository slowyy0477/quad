import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Locator, Page, Request, Response } from '@playwright/test'

vi.mock('@playwright/test', async () => ({ expect: (await import('vitest')).expect }))

import { completeAction } from '../e2e/helpers/complete-action'

function request(url = 'http://127.0.0.1:3301/signup', method = 'POST') {
  return { url: () => url, method: () => method } as unknown as Request
}

function fixture(options: { status?: number; responseRequest?: Request } = {}) {
  const actionRequest = options.responseRequest ?? request()
  const actionResponse = {
    request: () => actionRequest,
    status: () => options.status ?? 200,
    finished: vi.fn(() => new Promise(() => {})),
  } as unknown as Response
  const order: string[] = []
  let responsePredicate!: (response: Response) => boolean
  const page = {
    url: () => 'http://127.0.0.1:3301/signup',
    waitForResponse: vi.fn((predicate: typeof responsePredicate) => {
      order.push('response-listener')
      responsePredicate = predicate
      return Promise.resolve(actionResponse)
    }),
    waitForEvent: vi.fn(() => new Promise(() => {})),
  }
  const control = { click: vi.fn(async () => { order.push('click') }) }
  return {
    page: page as unknown as Page, control: control as unknown as Locator,
    actionRequest, actionResponse, order,
    predicate: () => responsePredicate,
  }
}

afterEach(() => vi.useRealTimers())

describe('bounded real browser action outcomes', () => {
  it('registers the exact response listener before clicking, then requires the visible outcome', async () => {
    const current = fixture()
    const outcome = vi.fn(async () => { current.order.push('visible-outcome') })
    expect(await completeAction(current.page, current.control, outcome)).toBe(current.actionResponse)
    expect(current.order).toEqual(['response-listener', 'click', 'visible-outcome'])
    expect(outcome).toHaveBeenCalledOnce()
  })

  it('does not block a proved redirect on an indefinitely open development stream', async () => {
    const current = fixture()
    await completeAction(current.page, current.control, async () => {})
    expect(current.page.waitForEvent).not.toHaveBeenCalled()
    expect(current.actionResponse.finished).not.toHaveBeenCalled()
  })

  it('does not treat response headers alone as an accepted write', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const current = fixture()
    let resolved = false
    const result = completeAction(current.page, current.control, () => pending).then(value => {
      resolved = true
      return value
    })
    await vi.waitFor(() => expect(current.control.click).toHaveBeenCalledOnce())
    expect(resolved).toBe(false)
    finish()
    expect(await result).toBe(current.actionResponse)
  })

  it('keeps a domain assertion failure instead of accepting headers', async () => {
    const current = fixture()
    await expect(completeAction(current.page, current.control, async () => {
      throw new Error('The stored result was not accepted.')
    })).rejects.toThrow('The stored result was not accepted.')
  })

  it('rejects a server failure without invoking the success outcome', async () => {
    const current = fixture({ status: 503 })
    const outcome = vi.fn(async () => {})
    await expect(completeAction(current.page, current.control, outcome)).rejects.toThrow()
    expect(outcome).not.toHaveBeenCalled()
  })

  it('refuses an unrelated response even if a faulty listener returns it', async () => {
    const current = fixture({ responseRequest: request('http://127.0.0.1:3301/login') })
    const outcome = vi.fn(async () => {})
    await expect(completeAction(current.page, current.control, outcome)).rejects.toThrow()
    expect(outcome).not.toHaveBeenCalled()
  })

  it('bounds an outcome that never arrives and clears its timer after failure', async () => {
    vi.useFakeTimers()
    const current = fixture()
    const result = completeAction(current.page, current.control, () => new Promise(() => {}), 12_345)
    const rejection = expect(result).rejects.toThrow('The expected action outcome timed out.')
    await vi.advanceTimersByTimeAsync(12_345)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
    expect(current.page.waitForResponse).toHaveBeenCalledWith(expect.any(Function), { timeout: 12_345 })
  })

  it('clears the outcome timer after success', async () => {
    vi.useFakeTimers()
    const current = fixture()
    await completeAction(current.page, current.control, async () => {})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a missing outcome or unbounded timeout before submitting', async () => {
    const current = fixture()
    await expect(completeAction(current.page, current.control, undefined as never)).rejects.toThrow()
    await expect(completeAction(current.page, current.control, async () => {}, Infinity)).rejects.toThrow()
    expect(current.control.click).not.toHaveBeenCalled()
  })

  it('matches only a POST to the original same-origin action path', async () => {
    const current = fixture()
    await completeAction(current.page, current.control, async () => {})
    for (const candidate of [
      request('https://remote.example.test/signup'),
      request('http://127.0.0.1:3301/login'),
      request('http://127.0.0.1:3301/signup', 'GET'),
    ]) {
      expect(current.predicate()({ request: () => candidate } as unknown as Response)).toBe(false)
    }
    expect(current.predicate()(current.actionResponse)).toBe(true)
  })
})

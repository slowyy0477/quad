import { expect, type Locator, type Page, type Request } from '@playwright/test'

/**
 * Observe the real action response, then require its specific visible outcome.
 * Next's development RSC stream can remain open after a successful redirect:
 * response.finished()/requestfinished are not an application completion signal.
 * The caller must assert the redirect, durable receipt, refusal or cleared draft.
 * No mocking, retries, accepted-error fallback or early reload is allowed here.
 */
export async function completeAction(
  page: Page,
  control: Locator,
  outcome: () => Promise<unknown>,
  timeout = 90_000,
) {
  if (typeof outcome !== 'function' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('A bounded, explicit action outcome is required.')
  }
  const current = new URL(page.url())
  const matchesAction = (request: Request) => {
    const target = new URL(request.url())
    return request.method() === 'POST' &&
      target.origin === current.origin && target.pathname === current.pathname
  }
  const responsePromise = page.waitForResponse((response) => {
    return matchesAction(response.request())
  }, { timeout })
  const [, response] = await Promise.all([
    control.click(), responsePromise,
  ])
  expect(matchesAction(response.request()), 'Response must belong to the requested action').toBe(true)
  expect(response.status(), 'The action endpoint must not return a server error').toBeLessThan(500)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(outcome),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The expected action outcome timed out.')), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return response
}

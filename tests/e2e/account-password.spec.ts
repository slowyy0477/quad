import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { completeAction } from './helpers/complete-action'

/**
 * Run only with the existing loopback/isolated-data Playwright harness. It clears
 * cloud keys, uses a unique D-drive fixture, and must never reuse the owner store.
 */
test('explicit publication, current-password change, two-device revocation and old-password rejection', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  const suffix = randomBytes(6).toString('hex')
  const email = `password-fixture-${suffix}@example.test`
  const oldPassword = randomBytes(24).toString('base64url')
  const newPassword = randomBytes(24).toString('base64url')
  const displayName = 'Bulla Password Fixture'
  const neighborContext = await browser.newContext()
  const otherDevice = await browser.newContext()
  const journeyStarted = Date.now()
  const milestone = (name: string) => console.info(`Password journey: ${name} (${Date.now() - journeyStarted}ms)`)
  try {
    await page.goto('/signup')
    milestone('signup page ready')
    await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
    await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(email)
    await page.getByLabel(/^Password/).fill(oldPassword)
    await page.getByRole('checkbox').check()
    await completeAction(page, page.getByRole('button', { name: 'Create account', exact: true }),
      () => expect(page).toHaveURL(/\/onboarding/))
    milestone('signup action drained')
    await expect(page).toHaveURL(/\/onboarding/)
    const generatedHandle = await page.getByLabel(/^Choose a username/).inputValue()
    await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
    const observer = await neighborContext.newPage()
    milestone('private profile observer navigation started')
    await observer.goto(new URL(`/u/${generatedHandle}`, page.url()).href)
    milestone('private profile observer navigation completed')
    await expect(observer.getByRole('heading', { level: 1, name: displayName })).toHaveCount(0)

    await page.getByLabel(/^Choose a username/).fill(`password${suffix}`)
    await page.getByLabel(/^Who can see your profile/).selectOption('public')
    await completeAction(page, page.getByRole('button', { name: 'Finish and go to my profile' }),
      () => expect(page).toHaveURL(/\/me$/))
    milestone('onboarding action drained')
    await expect(page).toHaveURL(/\/me$/)
    await observer.goto(new URL(`/u/password${suffix}`, page.url()).href)
    await expect(observer.getByRole('heading', { level: 1, name: displayName })).toBeVisible()

    const secondPage = await otherDevice.newPage()
    await secondPage.goto(new URL('/login', page.url()).href)
    await secondPage.getByLabel(/^Email address/).fill(email)
    await secondPage.getByLabel(/^Password/).fill(oldPassword)
    await completeAction(secondPage, secondPage.getByRole('button', { name: 'Sign in', exact: true }),
      () => expect(secondPage).toHaveURL(/\/feed$/))
    milestone('second device signed in')
    await expect(secondPage).toHaveURL(/\/feed$/)
    const primaryCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'quad_local_session')!
    const secondCookie = (await otherDevice.cookies()).find((cookie) => cookie.name === 'quad_local_session')!
    expect(primaryCookie).toBeTruthy()
    expect(secondCookie).toBeTruthy()

    await page.goto('/settings/password')
    await expect(page.getByRole('heading', { level: 1, name: 'Change your password' })).toBeVisible()
    await expect(page.getByLabel(/^Current password/)).toHaveAttribute('autocomplete', 'current-password')
    await expect(page.getByLabel(/^New password/)).toHaveAttribute('autocomplete', 'new-password')
    await page.getByLabel(/^Current password/).fill('incorrect current phrase')
    await page.getByLabel(/^New password/).fill(newPassword)
    await page.getByLabel(/^Repeat new password/).fill(newPassword)
    await completeAction(page, page.getByRole('button', { name: 'Change password', exact: true }),
      () => expect(page.getByRole('alert').filter({ hasText: 'Your current password is incorrect.' }))
        .toHaveText('Your current password is incorrect.'))
    milestone('incorrect password refusal drained')
    await expect(page.getByLabel(/^Current password/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert').filter({ hasText: 'Your current password is incorrect.' }))
      .toHaveText('Your current password is incorrect.')
    await page.getByLabel(/^Current password/).fill(oldPassword)
    // React may reset an uncontrolled form after an action; refill explicitly.
    await page.getByLabel(/^New password/).fill(newPassword)
    await page.getByLabel(/^Repeat new password/).fill(newPassword)
    await completeAction(page, page.getByRole('button', { name: 'Change password', exact: true }),
      () => expect(page).toHaveURL(/\/settings\/password\?changed=1$/))
    milestone('password change drained')
    await expect(page).toHaveURL(/\/settings\/password\?changed=1$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible()
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'quad_local_session')).toBe(false)

    await secondPage.goto(new URL('/settings/password', page.url()).href)
    await expect(secondPage).toHaveURL(/\/login\?next=/)
    await page.context().addCookies([primaryCookie])
    await page.goto('/feed')
    await expect(page).toHaveURL(/\/login/)
    await otherDevice.addCookies([secondCookie])
    await secondPage.goto(new URL('/feed', page.url()).href)
    await expect(secondPage).toHaveURL(/\/login/)
    milestone('old sessions rejected')

    await page.getByLabel(/^Email address/).fill(email)
    await page.getByLabel(/^Password/).fill(oldPassword)
    await completeAction(page, page.getByRole('button', { name: 'Sign in', exact: true }),
      () => expect(page.getByRole('alert').filter({ hasText: 'That email or password is incorrect.' }))
        .toContainText('That email or password is incorrect.'))
    await expect(page.getByRole('alert').filter({ hasText: 'That email or password is incorrect.' }))
      .toContainText('That email or password is incorrect.')
    await page.getByLabel(/^Password/).fill(newPassword)
    await completeAction(page, page.getByRole('button', { name: 'Sign in', exact: true }),
      () => expect(page).toHaveURL(/\/feed$/))
    await expect(page).toHaveURL(/\/feed$/)
    milestone('new password accepted')
    await page.goto('/settings/password')
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode })
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeVisible()
        if (width === 390 || width === 1440) {
          await page.screenshot({ path: testInfo.outputPath(`password-${width}-${mode}.png`), fullPage: true })
        }
      }
    }
    await page.goto('/reset-password')
    await expect(page.getByRole('button', { name: 'Send reset link' })).toBeDisabled()
    await expect(page.getByRole('alert').filter({ hasText: 'Local accounts have no email recovery.' }))
      .toContainText('Local accounts have no email recovery.')
  } finally {
    // Cleanup must not replace the original action/navigation error on timeout.
    await Promise.allSettled([neighborContext.close(), otherDevice.close()])
  }
})

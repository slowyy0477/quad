import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { completeAction } from './helpers/complete-action'

test('Bulla identity, manifest and privacy-safe document headers', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page).toHaveTitle(/Bulla/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your campus.')
  await expect(page.getByRole('link', { name: 'Bulla home' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  const csp = response?.headers()['content-security-policy'] || ''
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1]
  expect(nonce).toBeTruthy()
  expect(await page.locator('script[nonce]').evaluateAll(scripts =>
    scripts.map(script => (script as HTMLScriptElement).nonce),
  )).toContain(nonce)
  const anotherPage = await request.get('/')
  expect(anotherPage.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`)
  const scripts = csp.split(';').find(part => part.trim().startsWith('script-src'))
  expect(scripts).not.toContain("'unsafe-inline'")
  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest.short_name).toBe('Bulla')
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true)
  const crossOriginWrite = await request.post('/signup', {
    headers: { origin: 'https://unrelated.example.test' },
  })
  expect(crossOriginWrite.status()).toBe(403)
  expect(errors).toEqual([])
})

test('signed-out private routes require authentication', async ({ page }) => {
  await page.goto('/feed')
  await expect(page).toHaveURL(/\/login\?next=/)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toHaveCount(0)
})

test('public entry screens reflow in light and dark without horizontal overflow', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode })
    for (const width of [320, 360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const route of ['/', '/login', '/signup', '/setup']) {
        await page.goto(route)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /dark/ : /^(?!.*\bdark\b)/)
        if (route === '/') {
          const ordinals = page.locator('[aria-labelledby="student-life-heading"] article > span')
          await expect(ordinals).toHaveCount(3)
          expect(await ordinals.evaluateAll(elements => elements.every(element => {
            const range = document.createRange()
            range.selectNodeContents(element)
            return range.getClientRects().length === 1
          }))).toBe(true)
        }
        if (route === '/' && [390, 1440].includes(width)) {
          await page.screenshot({ path: testInfo.outputPath(`bulla-home-${width}-${mode}.png`), fullPage: true, caret: 'initial' })
        }
        if (route === '/setup') {
          await expect(page.getByRole('heading', { name: 'Local mode (private preview)' })).toBeVisible()
          await expect(page.getByText(/Local accounts and saved content work without Supabase keys/)).toBeVisible()
          if (width === 390) {
            await page.screenshot({ path: testInfo.outputPath(`bulla-setup-${width}-${mode}.png`), fullPage: true, caret: 'initial' })
          }
        }
      }
    }
  }
})

test('legacy appearance preference survives the Bulla rebrand', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('bulla-theme')
    localStorage.setItem('quad-theme', 'dark')
  })
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('new isolated account can onboard, edit, post, reload and sign out', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const suffix = randomBytes(6).toString('hex')
  const email = `bulla-e2e-${suffix}@example.test`
  const password = randomBytes(24).toString('base64url')
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill('Bulla Browser Fixture')
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(email)
  // Label-text matching includes the visual required marker; password inputs
  // have no dependable implicit textbox role. Keep the real label association.
  await page.getByLabel(/^Password/).fill(password)
  await page.getByRole('checkbox').check()
  await completeAction(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL(/\/onboarding/))
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByRole('textbox', { name: 'Choose a username (required)', exact: true }).fill(`fixture${suffix}`)
  await completeAction(page, page.getByRole('button', { name: 'Finish and go to my profile' }),
    () => expect(page).toHaveURL(/\/me$/))
  await expect(page).toHaveURL(/\/me$/)
  await page.getByRole('link', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill('Bulla Edited Fixture')
  await completeAction(page, page.getByRole('button', { name: 'Save changes', exact: true }),
    () => expect(page.getByText('Saved.', { exact: true })).toBeVisible())
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await page.goto('/me')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bulla Edited Fixture')
  await page.goto('/feed')
  await page.getByRole('textbox', { name: 'Post body' }).fill(`Isolated browser post ${suffix}`)
  await page.getByLabel('Visible to').selectOption('public')
  await completeAction(page, page.getByRole('button', { name: 'Post', exact: true }),
    () => expect(page.getByRole('textbox', { name: 'Post body' })).toHaveValue(''))
  await expect(page.getByText(`Isolated browser post ${suffix}`, { exact: true })).toBeVisible()
  // Streamed content can appear before the action response finishes. Wait for
  // the success effect, otherwise reload cancels it and resurrects the draft.
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveValue('')
  await page.reload()
  await expect(page.getByText(`Isolated browser post ${suffix}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveValue('')
  await page.screenshot({ path: testInfo.outputPath('bulla-feed-desktop-light.png'), fullPage: true, caret: 'initial' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('bulla-feed-mobile-light.png'), fullPage: true, caret: 'initial' })
  const trigger = page.locator('header.app-header').getByRole('button', { name: 'Open campus menu', exact: true })
  const beforeMenuUrl = page.url()
  await trigger.click()
  const campus = page.getByRole('dialog', { name: 'Campus workspace', exact: true })
  await expect(campus).toBeVisible()
  await expect(campus).toHaveAttribute('aria-modal', 'false')
  await expect(campus).toHaveAttribute('data-header-menu', 'campus')
  await expect(page.locator('[data-header-menu]')).toHaveCount(1)
  await expect(page).toHaveURL(beforeMenuUrl)
  await page.keyboard.press('Escape')
  await expect(campus).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(campus).toBeVisible()
  const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === 'quad_local_session')
  expect(Boolean(sessionCookie)).toBe(true)
  await completeAction(page, campus.getByRole('button', { name: 'Sign out', exact: true }),
    () => expect(page).toHaveURL('/'))
  // A click does not await a Server Action. Let its redirect and cookie change
  // finish instead of cancelling the logout with an immediate page.goto.
  await expect(page).toHaveURL('/')
  expect((await page.context().cookies()).some(cookie => cookie.name === 'quad_local_session')).toBe(false)
  await page.goto('/feed')
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toHaveCount(0)
  // Revocation must be server-side, not just deletion of a browser cookie.
  await page.context().addCookies([sessionCookie!])
  await page.goto('/feed')
  await expect(page).toHaveURL(/\/login/)
})

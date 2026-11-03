import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Run this spec ALONE through the fresh loopback harness, with one worker and a
 * new run ID. No accounts/reference rows are seeded and no budgets are reset.
 * All account/content writes use the actual forms and their session cookies.
 *
 * These are reflow/interaction checks and review captures, not golden-image
 * comparisons, WCAG certification, hosted acceptance or capacity evidence.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const widths = [320, 360, 390, 768, 1024, 1440] as const
const themes = ['light', 'dark'] as const
type Theme = (typeof themes)[number]
type RouteCase = { pathname: string; heading: string; capture?: boolean; disclosure?: string }

const displayName = 'عائشہ نور・学生開発者・Bulla International Research Collective 50%_LongDisplayName'
const longToken = 'CampusNotebook_'.repeat(8)
const headline = 'طالب علم・Distributed systems and international campus collaboration 50%_LongLabel'
const bio = `Private synthetic student portfolio — اردو・日本語・English.\n${longToken}`
const postBody = `A private campus notebook update — طلبہの学習記録・English.\n${longToken}`
const projectTitle = `VisualNotebook_${'LongCampusName_'.repeat(5)}日本語`
const ideaTitle = `Explore multilingual campus notebooks — اردو・日本語 ${longToken.slice(0, 60)}`
const ideaPitch = `A private idea for accessible campus research notes — اردو・日本語.\n${longToken}`
const goalTitle = `Read campus research notes — اردو・日本語 ${longToken.slice(0, 64)}`
const logSummary = `Private study record — تحقیقと学習・English.\n${longToken}`
const institutionName = 'Synthetic international campus research university — اردو・日本語・LongInstitutionName'

const routes: readonly RouteCase[] = [
  { pathname: '/feed', heading: 'Campus feed', capture: true, disclosure: 'Add context' },
  { pathname: '/me', heading: displayName, capture: true },
  { pathname: '/me/edit', heading: 'Edit your profile' },
  { pathname: '/projects', heading: 'Projects', capture: true },
  { pathname: '/ideas', heading: 'Ideas', disclosure: 'Post an idea' },
  { pathname: '/messages', heading: 'Messages', capture: true },
  { pathname: '/goals', heading: 'Goals', capture: true, disclosure: 'Add a goal' },
  { pathname: '/log', heading: 'Study log' },
  { pathname: '/universities', heading: 'Find your university.', capture: true, disclosure: 'Missing your university? Request it.' },
  { pathname: '/connections', heading: 'People' },
  { pathname: '/opportunities', heading: 'Opportunities' },
  { pathname: '/events', heading: 'Events' },
  { pathname: '/notifications', heading: 'Notifications' },
  { pathname: '/settings', heading: 'Settings', capture: true },
  { pathname: '/settings/password', heading: 'Change your password' },
  { pathname: '/settings/security', heading: 'Account security' },
  { pathname: '/settings/account', heading: 'Account data and deletion' },
]

const expectedNotFoundDocuments = new WeakMap<Page, Set<string>>()

// Do not record signup passwords, email input or session-bearing traces/videos.
// Only the explicit, credential-masked signed-in captures below are generated.
test.use({ trace: 'off', video: 'off', screenshot: 'off', colorScheme: 'light', contextOptions: { reducedMotion: 'no-preference' } })

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Visual artifacts must stay inside their dedicated isolated harness directory.')
  }
}

async function missingOnly(error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  return null
}

async function requireFreshHarness(baseURL: string | undefined, info: TestInfo) {
  if (!baseURL) throw new Error('Workspace visual checks require the configured loopback baseURL.')
  const origin = new URL(baseURL)
  if (origin.protocol !== 'http:' || origin.username || origin.password ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    !origin.port || origin.port === '3000' || origin.pathname !== '/' || origin.search || origin.hash ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Use a fresh loopback webServer on a dedicated port, never an owner preview or reused server.')
  }
  if (info.config.workers !== 1 || info.retry !== 0 || info.repeatEachIndex !== 0 || info.config.projects.length !== 1) {
    throw new Error('Run only workspace-visual.spec.ts, with one project, --workers=1 --retries=0 and a fresh run ID.')
  }
  const artifactRoot = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(artifactRoot) || !run || !/^[a-zA-Z0-9-]+$/.test(run)) {
    throw new Error('Workspace visual checks require an absolute artifact root and a fresh harness run ID.')
  }
  const runRoot = path.resolve(artifactRoot, run)
  const fixtureRoot = path.join(runRoot, 'fixture')
  const fixtureFile = path.join(fixtureRoot, 'local.json')
  assertInside(artifactRoot, runRoot)
  assertInside(runRoot, fixtureFile)
  assertInside(runRoot, info.outputDir)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)

  // Verify that the shared config actually starts the server against THIS store.
  // An environment flag alone is not evidence of isolation.
  const server = info.config.webServer
  if (!server || server.reuseExistingServer !== false || server.env?.NEXT_PUBLIC_DATA_MODE !== 'local' ||
    !server.env.LOCAL_DATA_PATH || path.resolve(server.env.LOCAL_DATA_PATH) !== fixtureFile ||
    server.env.NEXT_PUBLIC_SITE_URL !== origin.origin ||
    ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
      .some((key) => Boolean(server.env?.[key]))) {
    throw new Error('The visual spec needs the fresh local-only Playwright webServer and its matching isolated store.')
  }

  await fs.mkdir(fixtureRoot, { recursive: true })
  const directory = await fs.lstat(fixtureRoot)
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('The visual fixture directory must be a real, dedicated directory.')
  }
  const realRun = await fs.realpath(runRoot)
  assertInside(await fs.realpath(artifactRoot), realRun)
  assertInside(realRun, await fs.realpath(fixtureRoot))
  if (process.platform === 'win32') assertInside(await fs.realpath(recoveryRoot), realRun)

  if (await fs.lstat(`${fixtureFile}.lock`).catch(missingOnly)) {
    throw new Error('The isolated store is busy. No stale-lock removal or reset is permitted.')
  }
  const store = await fs.lstat(fixtureFile).catch(missingOnly)
  if (store) {
    if (!store.isFile() || store.isSymbolicLink()) throw new Error('Expected an ordinary isolated fixture file.')
    assertInside(await fs.realpath(fixtureRoot), await fs.realpath(fixtureFile))
    // Read only for freshness BEFORE signup. Never inspect/inject account rows,
    // sessions, private content or budget counters after UI actions.
    const snapshot: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Object.values(snapshot).some((rows) => !Array.isArray(rows) || rows.length !== 0)) {
      throw new Error('The visual spec refuses a malformed or nonempty store. Use a new run ID; never reset it.')
    }
  }
  // Retain the exclusive marker on failure too. Retrying requires a NEW run ID.
  const marker = await fs.open(path.join(fixtureRoot, 'workspace-visual.marker'), 'wx', 0o600)
  await marker.close()
  await fs.mkdir(info.outputDir, { recursive: true })
  assertInside(realRun, await fs.realpath(info.outputDir))
  return origin.origin
}

/** Require the exact POST and a bounded domain outcome, never RSC closure. */
async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const current = new URL(page.url())
  const response = await completeAction(page, control, outcome)
  expect(response.status(), `Action on ${current.pathname} returned an HTTP error`).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

async function rendered(page: Page) {
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 })
  // Observe actual render frames, not a guessed delay or network-idle timer.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function visit(page: Page, pathname: string, heading: string) {
  const response = await page.goto(pathname, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  expect(response?.status(), `Document request failed for ${pathname}`).toBe(200)
  await expect(page).toHaveURL((url) => url.pathname === pathname && !url.search && !url.hash)
  await expect(page.locator('#main').getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open campus menu', exact: true })).toBeVisible()
  await rendered(page)
}

function disclosure(page: Page, label: string) {
  return page.locator('#main details').filter({
    has: page.locator('summary').filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }),
  })
}

async function openDisclosure(page: Page, label: string) {
  const details = disclosure(page, label)
  await expect(details).toHaveCount(1)
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await details.locator('summary').click()
  }
  await expect(details).toHaveAttribute('open', '')
  return details
}

async function privateAddress(observer: Page, pathname: string, withheldNames: readonly string[] = [displayName]) {
  const expected = expectedNotFoundDocuments.get(observer) ?? new Set<string>()
  expected.add(pathname)
  expectedNotFoundDocuments.set(observer, expected)
  const response = await observer.goto(pathname, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  // Next can send a streamed not-found UI with 200 rather than a late 404.
  expect(response).not.toBeNull()
  expect([200, 404]).toContain(response!.status())
  await expect(observer.getByRole('heading', {
    level: 1, name: 'There is nothing at this address', exact: true,
  })).toBeVisible()
  await expect(observer.getByText(displayName, { exact: true })).toHaveCount(0)
  const serialized = await response!.text()
  for (const name of withheldNames) {
    expect(serialized.includes(name), 'Private identity/content was serialized to a signed-out visitor').toBe(false)
  }
}

async function signupPrivately(page: Page, observer: Page, credentials: { handle: string; email: string; password: string }) {
  await page.goto('/signup', { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(credentials.email)
  await page.getByLabel(/^Password/).fill(credentials.password)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL((url) => url.pathname === '/onboarding'))
  await expect(page).toHaveURL((url) => url.pathname === '/onboarding')
  const username = page.getByLabel(/^Choose a username/)
  const generated = await username.inputValue()
  expect(generated.length > 0, 'Signup did not provide an onboarding handle').toBe(true)
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await privateAddress(observer, `/u/${encodeURIComponent(generated)}`)
  await username.fill(credentials.handle)
  await page.getByLabel(/^Headline/).fill(headline)
  await page.getByLabel(/^Degree or programme/).fill('BSc Computer Science — تحقیق・計算機科学 International Campus Programme')
  await page.getByLabel(/^About you/).fill(bio)
  await page.getByLabel(/^Who can see your profile/).selectOption('private') // Explicitly KEEP private; never publish this account.
  await submit(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL((url) => url.pathname === '/me')
    await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
    await expect(page.locator('#main')).toContainText('Only you can see this profile.')
  })
  await expect(page).toHaveURL((url) => url.pathname === '/me')
  await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  await expect(page.locator('#main')).toContainText('Only you can see this profile.')
  await privateAddress(observer, `/u/${credentials.handle}`)
  await visit(page, '/me/edit', 'Edit your profile')
  await expect(page.getByRole('combobox', { name: 'Profile visibility', exact: true })).toHaveValue('private')
}

async function createPrivateContent(page: Page, observer: Page) {
  await test.step('real private feed content persists after a completed action and reload', async () => {
    await visit(page, '/feed', 'Campus feed')
    await page.getByRole('textbox', { name: 'Post body', exact: true }).fill(postBody)
    await page.getByRole('combobox', { name: 'Visible to', exact: true }).selectOption('private')
    await submit(page, page.getByRole('button', { name: 'Post', exact: true }), async () => {
      await expect(page.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
      await expect(page.locator('article').filter({ has: page.getByText(postBody, { exact: true }) })).toHaveCount(1)
    })
    await expect(page.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
    const card = page.locator('article').filter({ has: page.getByText(postBody, { exact: true }) })
    await expect(card).toHaveCount(1)
    await page.reload()
    await expect(card).toHaveCount(1)
    await expect(page.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
  })
  await test.step('a form-created project inherits the private owner ceiling', async () => {
    await visit(page, '/projects/new', 'Create a project')
    await page.getByLabel(/^Title/).fill(projectTitle)
    await page.getByRole('textbox', { name: 'One-line purpose', exact: true }).fill(`Private campus collaboration — اردو・日本語 ${longToken.slice(0, 90)}`)
    const audience = page.getByRole('combobox', { name: 'Who can see it', exact: true })
    await expect(audience).toHaveValue('private')
    await audience.selectOption('public') // A real public request, not a modified hidden input.
    // This student remains private. The server must clamp this explicit public
    // project choice to the owner's audience, which the reload/observer prove.
    await submit(page, page.getByRole('button', { name: 'Create project', exact: true }), async () => {
      await expect(page).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname))
      await expect(page.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toBeVisible()
      await expect(page.getByText('Only me', { exact: true }).first()).toBeVisible()
    })
    await expect(page).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname))
    const pathname = new URL(page.url()).pathname
    await expect(page.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toBeVisible()
    await expect(page.getByText('Only me', { exact: true }).first()).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toBeVisible()
    await privateAddress(observer, pathname, [displayName, projectTitle])
  })
  await test.step('an explicitly private idea is authored through the actual disclosure form', async () => {
    await visit(page, '/ideas', 'Ideas')
    const form = await openDisclosure(page, 'Post an idea')
    await form.getByLabel(/^Title/).fill(ideaTitle)
    await form.getByLabel(/^The pitch/).fill(ideaPitch)
    await form.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('private')
    await submit(page, form.getByRole('button', { name: 'Post the idea', exact: true }), async () => {
      await expect(page).toHaveURL((url) => /^\/ideas\/[^/]+$/.test(url.pathname))
      await expect(page.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
    })
    await expect(page).toHaveURL((url) => /^\/ideas\/[^/]+$/.test(url.pathname))
    const pathname = new URL(page.url()).pathname
    await expect(page.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
    await privateAddress(observer, pathname, [displayName, ideaTitle])
  })
  await test.step('a private goal and real UTC-day log provide populated learning layouts', async () => {
    await visit(page, '/goals', 'Goals')
    const form = await openDisclosure(page, 'Add a goal')
    await form.getByLabel(/^The goal/).fill(goalTitle)
    await form.getByRole('textbox', { name: 'What counts as done', exact: true }).fill(`Read five chapters; this is a plan, not a mastery claim.\n${longToken}`)
    await form.getByRole('spinbutton', { name: 'Target (required)', exact: true }).fill('5')
    await form.getByRole('textbox', { name: 'Unit', exact: true }).fill('chapters')
    await form.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('private')
    await submit(page, form.getByRole('button', { name: 'Add the goal', exact: true }),
      () => expect(page.getByRole('heading', { level: 3, name: goalTitle, exact: true })).toBeVisible())
    await expect(page.getByRole('heading', { level: 3, name: goalTitle, exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { level: 3, name: goalTitle, exact: true })).toBeVisible()
    await visit(page, '/log', 'Study log')
    const day = await page.getByLabel(/^Day/).inputValue()
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await page.getByRole('spinbutton', { name: 'Hours studied', exact: true }).fill('1.5')
    await page.getByRole('textbox', { name: 'What you did', exact: true }).fill(logSummary)
    await page.getByRole('textbox', { name: 'What went well', exact: true }).fill(`A useful research note — 学習・تحقیق ${longToken.slice(0, 70)}`)
    await submit(page, page.getByRole('button', { name: 'Save the day', exact: true }),
      () => expect(page.getByText('Entry saved.', { exact: true })).toBeVisible())
    await expect(page.getByText('Entry saved.', { exact: true })).toBeVisible()
    await page.reload()
    const recent = page.locator('section[aria-labelledby="recent-heading"]')
    await expect(recent).toContainText(logSummary)
    // A run that crosses UTC midnight can show a new, legitimately empty TODAY form.
    if (await page.getByLabel(/^Day/).inputValue() === day) {
      await expect(page.getByRole('textbox', { name: 'What you did', exact: true })).toHaveValue(logSummary)
      await expect(page.getByRole('spinbutton', { name: 'Hours studied', exact: true })).toHaveValue('1.5')
    }
  })
  await test.step('a long institution request stays pending, never fixture-approved', async () => {
    await visit(page, '/universities', 'Find your university.')
    const form = await openDisclosure(page, 'Missing your university? Request it.')
    await form.getByLabel(/^Institution name/).fill(institutionName)
    await form.getByRole('textbox', { name: 'City', exact: true }).fill('Islamabad・東京')
    await form.getByRole('textbox', { name: 'Country', exact: true }).fill('Pakistan')
    await submit(page, form.getByRole('button', { name: 'File for review', exact: true }),
      () => expect(form.getByText('Filed', { exact: true })).toBeVisible())
    await expect(form.getByText('Filed', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.locator('#main').getByText(institutionName, { exact: true })).toBeVisible()
    await expect(page.locator('#main')).toContainText('Waiting for review')
    await expect(page.getByRole('region', { name: 'University directory', exact: true })).toContainText('No institutions are listed yet')
  })
}

async function rootTheme(page: Page, theme: Theme) {
  const root = page.locator('html')
  if (theme === 'dark') await expect(root).toHaveClass(/(?:^|\s)dark(?:\s|$)/)
  else await expect(root).not.toHaveClass(/(?:^|\s)dark(?:\s|$)/)
  await expect(root).toHaveCSS('color-scheme', theme)
}

async function chooseTheme(page: Page, theme: Theme) {
  await visit(page, '/settings', 'Settings')
  const group = page.locator('#main').getByRole('group', { name: 'Theme', exact: true })
  await group.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click()
  await expect(group.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await rootTheme(page, theme)
  await rendered(page)
}

async function measureLayout(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const availableWidth = root.clientWidth
    const offenders = Array.from(document.body.querySelectorAll('*')).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !element.getClientRects().length || element.matches('.skip-link') ||
        getComputedStyle(element).visibility === 'hidden' || (rect.right <= availableWidth + 1 && rect.left >= -1)) return []
      return [{
        tag: element.tagName.toLowerCase(),
        classes: (element.getAttribute('class') ?? '').slice(0, 120),
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
      }]
    }).slice(0, 12)
    return {
      viewportWidth: innerWidth, availableWidth,
      documentWidth: root.scrollWidth, bodyWidth: document.body.scrollWidth,
      rootOverflowX: getComputedStyle(root).overflowX, bodyOverflowX: getComputedStyle(document.body).overflowX,
      offenders,
    }
  })
}

type Layout = Awaited<ReturnType<typeof measureLayout>>
function assertReflow(layout: Layout, label: string, modal = false) {
  expect.soft(Math.max(layout.documentWidth, layout.bodyWidth), `${label}: document overflow; ${JSON.stringify(layout.offenders)}`)
    .toBeLessThanOrEqual(layout.availableWidth + 1)
  if (!modal) {
    // Document-level clipping must not turn a genuine reflow bug into a pass.
    expect.soft([layout.rootOverflowX, layout.bodyOverflowX], `${label}: document overflow is masked`).not.toContain('hidden')
    expect.soft([layout.rootOverflowX, layout.bodyOverflowX], `${label}: document overflow is clipped`).not.toContain('clip')
  }
}

async function capture(page: Page, info: TestInfo, label: string, email: string, fullPage = true) {
  const file = info.outputPath(`workspace-visual-${label}.png`)
  assertInside(info.outputDir, file)
  await page.screenshot({
    path: file, fullPage, scale: 'css', timeout: 20_000, caret: 'hide',
    // Capture stabilization only; reduced-motion acceptance inspects REAL CSS separately.
    animations: 'disabled',
    mask: [page.getByText(email, { exact: true }), page.locator('input[type="email"], input[type="password"]')],
  })
  await info.attach(`workspace-visual-${label}`, { path: file, contentType: 'image/png' })
  return path.basename(file)
}

async function inspectMotion(page: Page) {
  return page.locator('#main .page-enter, #main button, #main select, #main summary, #main .interactive-card, #main .campus-route, .dialog-panel[data-state="open"], .dialog-overlay[data-state="open"]')
    .evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).flatMap((element) =>
      [null, '::before', '::after'].map((pseudo) => {
        const style = getComputedStyle(element, pseudo)
        return {
          target: `${element.tagName.toLowerCase()}.${(element.getAttribute('class') ?? '').slice(0, 100)}`,
          pseudo, animationName: style.animationName, animationDuration: style.animationDuration,
          animationDelay: style.animationDelay, animationIterationCount: style.animationIterationCount,
          transitionDuration: style.transitionDuration, transitionDelay: style.transitionDelay,
        }
      })))
}

function maxSeconds(value: string) {
  return Math.max(...value.split(',').map((time) => {
    const trimmed = time.trim()
    return trimmed.endsWith('ms') ? Number.parseFloat(trimmed) / 1000 : Number.parseFloat(trimmed)
  }))
}

test('fresh private student workspace: bounded reflow, actual themes, motion and keyboard controls', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(600_000) // One bounded test; 34 matrix navigations, not 204.
  const origin = await requireFreshHarness(baseURL, info)
  const suffix = randomBytes(8).toString('hex')
  const credentials = {
    handle: `visual_${suffix}`,
    email: `visual_${suffix}@example.test`,
    password: `Campus-${randomBytes(24).toString('base64url')}-9Aa!`,
  }
  const observerContext = await browser.newContext({ baseURL: origin })
  const observer = await observerContext.newPage()
  const clientErrors: string[] = []
  let expectedRefusalConsoleCount = 0
  const redact = (value: string) => [credentials.email, credentials.password, credentials.handle]
    .reduce((text, secret) => text.split(secret).join('[redacted]'), value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]').slice(0, 1200)
  for (const [label, current] of [['student', page], ['signed-out observer', observer]] as const) {
    const record = (message: string) => clientErrors.push(redact(`${label} ${new URL(current.url()).pathname}: ${message}`))
    current.on('pageerror', (error) => record(`client exception: ${error.message}`))
    current.on('console', (message) => {
      if (message.type() !== 'error') return
      // Chromium can log an ordinary document 404 as a resource console error.
      // Exempt only the observer's exact, deliberately refused document URL.
      // App exceptions, hydration errors, asset 404s and all student errors fail.
      if (label === 'signed-out observer' &&
        /^Failed to load resource: the server responded with a status of 404\b/.test(message.text()) &&
        message.location().url) {
        try {
          const location = new URL(message.location().url)
          if (location.origin === origin && expectedNotFoundDocuments.get(current)?.has(location.pathname)) {
            expectedRefusalConsoleCount++
            return
          }
        } catch { /* A malformed diagnostic URL is not a confirmed document refusal. */ }
      }
      record(`console error: ${message.text()}`)
    })
    current.on('crash', () => record('page crashed'))
  }
  const cells: Array<{ pathname: string; theme: Theme; width: number; layout: Layout }> = []
  const screenshots: string[] = []
  const systemStates: Array<{ media: Theme; root: Theme; background: string; reloaded: boolean }> = []
  const motion: Array<{ preference: string; styles: Awaited<ReturnType<typeof inspectMotion>> }> = []
  const keyboard: Array<{ theme: Theme; width: number; skipLink: boolean; dialogTrapAndRestore: boolean }> = []
  info.annotations.push({
    type: 'coverage-limit',
    description: 'Synthetic private owner, empty peer threads/connections/boards; pending institution only. Captures are review artifacts, not WCAG/hosted/load proof.',
  })
  try {
    await test.step('fresh signup and onboarding explicitly retain private publication', async () => {
      await signupPrivately(page, observer, credentials)
    })
    await createPrivateContent(page, observer)

    await test.step('System follows live OS changes and persists the actual root state after reload', async () => {
      await visit(page, '/settings', 'Settings')
      const group = page.locator('#main').getByRole('group', { name: 'Theme', exact: true })
      await page.emulateMedia({ colorScheme: 'light' })
      await group.getByRole('button', { name: 'System', exact: true }).click()
      await expect(group.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await rendered(page)
      for (const media of ['light', 'dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: media })
        await rootTheme(page, media)
        systemStates.push({ media, root: media, background: await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), reloaded: false })
        await page.reload()
        await expect(group.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await rootTheme(page, media)
        systemStates.push({ media, root: media, background: await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), reloaded: true })
      }
      expect(systemStates[0].background).not.toBe(systemStates[2].background)
    })

    for (const theme of themes) {
      await chooseTheme(page, theme) // Actual controls; never inject localStorage or root classes.
      for (const route of routes) {
        await test.step(`${theme} ${route.pathname}: six viewport widths`, async () => {
          await visit(page, route.pathname, route.heading)
          if (route.disclosure) await openDisclosure(page, route.disclosure)
          if (route.pathname === '/me/edit') {
            await expect(page.getByRole('combobox', { name: 'Profile visibility', exact: true })).toHaveValue('private')
          }
          if (route.pathname === '/settings') {
            await expect(page.getByRole('radio', { name: /^Only me/ })).toBeChecked()
          }
          for (const width of widths) {
            await page.setViewportSize({ width, height: width < 768 ? 844 : 960 })
            await rendered(page)
            await rootTheme(page, theme)
            const layout = await measureLayout(page)
            cells.push({ pathname: route.pathname, theme, width, layout })
            assertReflow(layout, `${theme} ${route.pathname} @${width}`)
            if (route.capture && (width === 390 || width === 1440)) {
              screenshots.push(await capture(page, info, `${route.pathname.slice(1).replaceAll('/', '-')}-${theme}-${width}`, credentials.email))
            }
          }
        })
      }
    }
    expect(cells).toHaveLength(routes.length * widths.length * themes.length)

    await test.step('reduced motion suppresses real page/dialog animation and control transitions', async () => {
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await visit(page, '/feed', 'Campus feed')
      await expect(page.locator('#main .page-enter')).toBeVisible()
      await page.getByRole('button', { name: 'Open campus menu', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Campus workspace', exact: true })).toBeVisible()
      const normal = await inspectMotion(page)
      expect(normal.some((style) => style.target.includes('page-enter') && style.animationName !== 'none' && maxSeconds(style.animationDuration) >= 0.1)).toBe(true)
      expect(normal.some((style) => style.target.includes('dialog-panel') && style.animationName !== 'none' && maxSeconds(style.animationDuration) >= 0.1)).toBe(true)
      motion.push({ preference: 'no-preference', styles: normal })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Campus workspace', exact: true })).toBeHidden()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await visit(page, '/feed', 'Campus feed')
      await page.getByRole('button', { name: 'Open campus menu', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Campus workspace', exact: true })).toBeVisible()
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
      const reduced = await inspectMotion(page)
      expect(reduced.length).toBeGreaterThan(0)
      for (const style of reduced) {
        expect(maxSeconds(style.animationDuration), `${style.target} ${style.pseudo}: reduced animation`).toBeLessThanOrEqual(0.001)
        expect(maxSeconds(style.transitionDuration), `${style.target} ${style.pseudo}: reduced transition`).toBeLessThanOrEqual(0.001)
        expect(maxSeconds(style.animationDelay)).toBe(0)
        expect(maxSeconds(style.transitionDelay)).toBe(0)
        expect(style.animationIterationCount.split(',').every((count) => Number(count.trim()) <= 1)).toBe(true)
      }
      await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
      motion.push({ preference: 'reduce', styles: reduced })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Campus workspace', exact: true })).toBeHidden()
    })

    for (const theme of themes) {
      await chooseTheme(page, theme)
      for (const width of [390, 1440]) {
        await test.step(`${theme} @${width}: keyboard skip link and modal focus wrap/return`, async () => {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
          await visit(page, '/feed', 'Campus feed')
          const skip = page.getByRole('link', { name: 'Skip to content', exact: true })
          await page.keyboard.press('Tab')
          await expect(skip).toBeFocused()
          const box = await skip.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
          await page.keyboard.press('Enter')
          await expect(page).toHaveURL((url) => url.pathname === '/feed' && url.hash === '#main')
          const main = page.getByRole('main')
          await expect(main).toHaveCount(1)
          await expect(main).toHaveAttribute('id', 'main')
          await expect(main).toHaveAttribute('tabindex', '-1')
          await expect(main).toBeFocused()
          // The workspace sidebar is outside main. The very next Tab must enter
          // page content, not restart the header/sidebar sequence.
          await page.keyboard.press('Tab')
          expect(await page.evaluate(() => {
            const main = document.querySelector('#main')
            return document.activeElement !== main && Boolean(main?.contains(document.activeElement)) &&
              !document.querySelector('.workspace-sidebar')?.contains(document.activeElement)
          })).toBe(true)

          await visit(page, '/feed', 'Campus feed') // Reset sequential keyboard focus via a real document navigation.
          const trigger = page.getByRole('button', { name: 'Open campus menu', exact: true })
          for (let tabs = 0; tabs < 16 && !await trigger.evaluate((element) => element === document.activeElement); tabs++) {
            await page.keyboard.press('Tab')
          }
          await expect(trigger).toBeFocused()
          await page.keyboard.press('Enter')
          const dialog = page.getByRole('dialog', { name: 'Campus workspace', exact: true })
          await expect(dialog).toBeVisible()
          const close = dialog.getByRole('button', { name: 'Close', exact: true })
          await expect(close).toBeFocused()
          await page.keyboard.press('Shift+Tab')
          await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused() // Focus only; NEVER submit.
          await page.keyboard.press('Tab')
          await expect(close).toBeFocused()
          const layout = await measureLayout(page)
          assertReflow(layout, `${theme} campus menu @${width}`, true) // Modal scroll-lock is intentional.
          const panel = await dialog.boundingBox()
          expect(panel).not.toBeNull()
          expect(panel!.x).toBeGreaterThanOrEqual(-1)
          expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1)
          screenshots.push(await capture(page, info, `campus-menu-${theme}-${width}`, credentials.email, false))
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          await expect(trigger).toBeFocused()
          keyboard.push({ theme, width, skipLink: true, dialogTrapAndRestore: true })
        })
      }
    }
    await privateAddress(observer, `/u/${credentials.handle}`)
    expect(clientErrors, 'Uncaught client exceptions, crashes or console errors were observed').toEqual([])
  } finally {
    // Preserve partial failed cells too; no credentials/content bodies are attached.
    await info.attach('workspace-visual-observations', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({
        expectedCells: routes.length * widths.length * themes.length, completedCells: cells.length,
        cells, screenshots, systemStates, motion, keyboard, clientErrors, expectedRefusalConsoleCount,
        limits: 'Private synthetic owner; empty peer states and boards; pending campus only; no WCAG/hosted/capacity claim.',
      }, null, 2)),
    })
    await observerContext.close()
  }
})

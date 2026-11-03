import { test, expect, type Response } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Only the existing loopback harness with a fresh, dedicated synthetic run. */
const university = '77777777-7777-4777-8777-777777777777'
const createdAt = '2026-10-20T00:00:00.000Z'
const token = randomBytes(32).toString('base64url')
let fixtureFile: string

test.beforeAll(async () => {
  const root = process.env.BULLA_E2E_ARTIFACT_DIR
  const run = process.env.BULLA_E2E_RUN_ID
  if (!root || !path.isAbsolute(root) || !run || !/^[a-zA-Z0-9-]+$/.test(run) ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Discovery browser tests require a fresh isolated harness, never a reused owner server')
  }
  const runRoot = path.resolve(root, run)
  const relative = path.relative(path.resolve(root), runRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid isolated browser directory')
  const fixtureRoot = path.join(runRoot, 'fixture')
  await fs.mkdir(fixtureRoot, { recursive: true })
  // Do not overwrite another invocation's fixture. The webServer may have seeded
  // its own NEW demo data during readiness; this marker still belongs only to us.
  const marker = await fs.open(path.join(fixtureRoot, 'people-fixture.marker'), 'wx')
  await marker.close()
  fixtureFile = path.join(fixtureRoot, 'local.json')
  const profiles = [{
    id: 'prf_viewer', user_id: 'usr_viewer', username: 'discovery_viewer',
    display_name: 'Synthetic Discovery Viewer', bio: null, avatar_url: null,
    university_id: university, department: 'Computer Science', programme: null,
    semester: null, website: null, github: null, visibility: 'public', searchable: false,
    onboarding_completed: true, created_at: createdAt,
  }]
  for (let index = 1; index <= 25; index++) {
    const key = String(index).padStart(2, '0')
    profiles.push({
      ...profiles[0], id: `prf_student${key}`, user_id: `usr_student${key}`, username: `discovery${key}`,
      display_name: index === 25 ? 'Discovery 100%_\\literal,("A")' : `Discovery Student ${key}`,
      searchable: true,
    })
  }
  for (const name of ['private', 'unlisted', 'blocked']) profiles.push({
    ...profiles[0], id: `prf_${name}`, user_id: `usr_${name}`, username: `secret_${name}`,
    display_name: `SECRET ${name.toUpperCase()} PROFILE`, searchable: name !== 'unlisted',
    visibility: name === 'private' ? 'private' : 'public',
  })
  await fs.writeFile(fixtureFile, JSON.stringify({
    users: profiles.map((row) => ({
      id: row.user_id, email: `${row.username}@synthetic.example.test`, password_hash: '', created_at: createdAt,
    })),
    profiles,
    sessions: [{
      id: 'ses_viewer', user_id: 'usr_viewer', token_hash: createHash('sha256').update(token).digest('hex'),
      created_at: createdAt, expires_at: '2099-01-01T00:00:00.000Z',
    }],
    universities: [{
      id: university, name: 'Synthetic Discovery University', short_name: 'SDU', city: null,
      country: 'Pakistan', student_count: 99999, project_count: 99999, created_at: createdAt,
    }],
    skills: [{
      id: 'skl_typescript', name: 'TypeScript', slug: 'typescript', category: 'language', is_approved: true,
      usage_count: 99999, created_by: null, created_at: createdAt,
    }],
    profile_skills: profiles.map((row, index) => ({
      id: `psk_${index}`, profile_id: row.id, skill_id: 'skl_typescript', level: 'familiar',
      is_learning: true, display_order: 0, endorsement_count: 99999, created_at: createdAt,
    })),
    blocks: [{ id: 'blk_viewer', blocker_id: 'prf_viewer', blocked_id: 'prf_blocked', reason: null, created_at: createdAt }],
  }), { mode: 0o600 })
})

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'quad_local_session', value: token, url: baseURL!, httpOnly: true, sameSite: 'Lax' }])
})

test('canonical filters, stable paging, reload, literal queries and truthful empty states', async ({ page }, testInfo) => {
  test.setTimeout(180000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const initial = `/search?type=people&university=${university}&department=Science&skill=script`
  const response = await page.goto(initial)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Search Bulla' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(20)
  await expect(page.getByText(/Showing 20 readable profiles on this page/)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Department contains' })).toHaveValue('Science')
  await expect(page.getByRole('textbox', { name: 'Skill contains' })).toHaveValue('script')
  await expect(page.getByRole('combobox', { name: 'University' })).toHaveValue(university)
  const first = await page.getByRole('link', { name: 'Open profile', exact: true })
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  await expect(page.getByText(/SECRET .* PROFILE|99999|only person|Nobody else/i)).toHaveCount(0)
  await page.getByRole('link', { name: 'Next page', exact: true }).click()
  await expect(page).toHaveURL(/cursor=/)
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(5)
  const second = await page.getByRole('link', { name: 'Open profile', exact: true })
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  expect(second.every((href) => !first.includes(href))).toBe(true)
  await expect(page.getByRole('link', { name: 'Next page', exact: true })).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get('department')).toBe('Science')
  expect(new URL(page.url()).searchParams.get('skill')).toBe('script')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(5)
  await page.goBack()
  await expect(page).toHaveURL(initial)
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(20)
  await page.getByRole('searchbox', { name: 'Name or username' }).fill('100%_\\literal,("A")')
  await page.getByRole('button', { name: 'Find people', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
  expect(new URL(page.url()).searchParams.get('q')).toBe('100%_\\literal,("A")')
  expect(new URL(page.url()).searchParams.get('type')).toBe('people')
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false)
  await page.getByRole('searchbox', { name: 'Name or username' }).fill('SECRET PRIVATE PROFILE')
  await page.getByRole('button', { name: 'Find people', exact: true }).click()
  await expect(page.getByText('No readable people match this view', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(0)
  await expect(page.getByText(/only person|has no profile|0 students/i)).toHaveCount(0)
  await page.goto(`/feed/people?university=${university}&department=Science&skill=script`)
  await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(20)
  await expect(page.getByRole('link', { name: 'Next people', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Name or username' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: 'University' })).toBeFocused()
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode })
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (width === 390) await page.screenshot({
        path: testInfo.outputPath(`people-${width}-${mode}.png`), fullPage: true,
      })
    }
  }
  expect(errors).toEqual([])
  expect(fixtureFile).toContain('fixture')
})

test('discovery GET filters still submit with JavaScript disabled', async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const context = await browser.newContext({ javaScriptEnabled: false })
  function expectPrivateHtml(response: Response | null) {
    expect(response?.status()).toBe(200)
    expect(response!.request().method()).toBe('GET')
    expect(response!.request().isNavigationRequest()).toBe(true)
    const url = new URL(response!.url())
    expect(url.origin).toBe(origin)
    expect(url.pathname).toBe('/search')
    const headers = response!.headers()
    expect(headers['content-type']).toMatch(/^text\/html(?:;|$)/)
    // Next's installed base-server replaces document Cache-Control with
    // no-store in development. That forbids storage by shared AND private
    // caches; requiring the redundant literal "private" rejects valid HTML.
    for (const name of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control']) {
      if (name !== 'cache-control' && headers[name] === undefined) continue
      const directives = (headers[name] || '').toLowerCase().split(',').map((value) => value.trim())
      expect(directives).toContain('no-store')
      expect(directives.filter((value) =>
        /^(?:public|s-maxage|stale-while-revalidate|stale-if-error|immutable)(?:\s*=|$)/.test(value)))
        .toEqual([])
      for (const value of directives.filter((directive) => /^max-age(?:\s*=|$)/.test(directive))) {
        expect(value).toMatch(/^max-age\s*=\s*"?0"?$/)
      }
    }
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toContain("form-action 'self'")
    expect(headers.location).toBeUndefined()
  }
  try {
    await context.addCookies([{ name: 'quad_local_session', value: token, url: baseURL!, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const isSearchDocument = (candidate: Response) => {
      const request = candidate.request()
      const url = new URL(candidate.url())
      return request.method() === 'GET' && request.isNavigationRequest() &&
        request.frame() === page.mainFrame() && url.origin === origin && url.pathname === '/search'
    }
    expectPrivateHtml(await page.goto(`${baseURL}/search?type=people&university=${university}`))
    await expect(page.getByRole('heading', { level: 1, name: 'Search Bulla', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(20)
    await expect(page.getByText(/SECRET .* PROFILE|99999|only person|Nobody else/i)).toHaveCount(0)
    const form = page.getByRole('form', { name: 'Filter people', exact: true })
    await expect(form).toHaveAttribute('action', '/search')
    await expect(form).toHaveAttribute('method', 'get')
    await expect(form.locator('input[name="type"]')).toHaveValue('people')
    await expect(form.locator('[name="cursor"]')).toHaveCount(0)

    // Submit from a real native second page, so cursor removal is not vacuous.
    const [nextDocument] = await Promise.all([
      page.waitForResponse(isSearchDocument),
      page.getByRole('link', { name: 'Next page', exact: true }).click(),
    ])
    expectPrivateHtml(nextDocument)
    await expect(page).toHaveURL((url) => url.origin === origin && url.pathname === '/search' &&
      Boolean(url.searchParams.get('cursor')))
    await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(5)
    await page.getByRole('searchbox', { name: 'Name or username' }).fill('Student 01')
    await page.getByRole('textbox', { name: 'Department contains' }).fill('Science')
    await page.getByRole('textbox', { name: 'Skill contains' }).fill('script')
    const [submittedDocument] = await Promise.all([
      page.waitForResponse(isSearchDocument),
      page.getByRole('button', { name: 'Find people', exact: true }).click(),
    ])
    expectPrivateHtml(submittedDocument)
    await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
    expect(new URL(page.url()).searchParams.get('q')).toBe('Student 01')
    expect(new URL(page.url()).searchParams.get('university')).toBe(university)
    const query = new URL(page.url()).searchParams
    expect(query.get('type')).toBe('people')
    expect(query.get('department')).toBe('Science')
    expect(query.get('skill')).toBe('script')
    expect(query.has('cursor')).toBe(false)
    expect([...query.keys()].sort()).toEqual(['department', 'q', 'skill', 'type', 'university'])
    await expect(page.getByText(/SECRET .* PROFILE|99999|only person|Nobody else/i)).toHaveCount(0)
    expectPrivateHtml(await page.reload())
    await expect(page.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
    await expect(page.getByRole('searchbox', { name: 'Name or username' })).toHaveValue('Student 01')
    await expect(page.getByRole('combobox', { name: 'University' })).toHaveValue(university)
    await expect(page.getByRole('textbox', { name: 'Department contains' })).toHaveValue('Science')
    await expect(page.getByRole('textbox', { name: 'Skill contains' })).toHaveValue('script')
  } finally {
    await context.close()
  }
})

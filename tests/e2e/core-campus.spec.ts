import { test, expect, type Browser, type Locator, type Page } from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalUniversity, Tables } from '../../src/lib/local/db'
import type { LocalCatalogueEntry, LocalDepartment } from '../../src/lib/local/domain-tables'

/**
 * Run this file ALONE with a fresh run ID and the loopback Playwright webServer.
 * Other specs can replace their fixture; this spec refuses a nonempty/reused one.
 *
 * The only setup exception is reference data: one university, one curated
 * department and one approved catalogue skill. Students cannot approve these
 * through their controls. Every
 * account, session, publication, skill claim and domain write below uses real UI.
 * No server actions, storageState/cookie injection, request mocks or budget edits.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
const createdAt = new Date().toISOString()
const university: LocalUniversity = {
  id: randomUUID(),
  name: 'Core Campus Synthetic University',
  short_name: 'CCSU',
  city: null,
  country: 'Pakistan',
  student_count: 0,
  project_count: 0,
  created_at: createdAt,
}
const department: LocalDepartment = {
  id: randomUUID(),
  university_id: university.id,
  name: 'Core Campus Research Systems',
  slug: 'core-campus-research-systems',
  is_verified: true,
  created_by: null,
  created_at: createdAt,
}
const skill: LocalCatalogueEntry = {
  id: randomUUID(),
  name: 'Core Campus 50%_ TypeScript',
  slug: 'core-campus-typescript',
  category: 'language',
  is_approved: true,
  usage_count: 0,
  created_by: null,
  created_at: createdAt,
}
let fixtureRoot: string
let fixtureFile: string

type Student = { handle: string; displayName: string; profileId: string }
type Students = {
  alice: Student
  bob: Student
  alicePage: Page
  bobPage: Page
  observer: Page
  suffix: string
}

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Core campus fixtures must stay inside their dedicated harness directory.')
  }
}

function assertFreshLoopback(baseURL: string | undefined) {
  if (!baseURL) throw new Error('Core campus acceptance requires the configured loopback baseURL.')
  const origin = new URL(baseURL)
  if (origin.protocol !== 'http:' || origin.username || origin.password ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    !origin.port || origin.port === '3000' ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
    throw new Error('Use a fresh loopback webServer on a dedicated port, never the owner preview or a reused server.')
  }
  return origin.origin
}

async function readFixture(): Promise<Partial<Tables>> {
  assertInside(fixtureRoot, fixtureFile)
  const stat = await fs.lstat(fixtureFile)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular isolated local fixture.')
  assertInside(await fs.realpath(fixtureRoot), await fs.realpath(fixtureFile))
  const parsed: unknown = JSON.parse(await fs.readFile(fixtureFile, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some((rows) => !Array.isArray(rows))) {
    throw new Error('Invalid isolated fixture; refusing setup.')
  }
  return parsed as Partial<Tables>
}

test.beforeAll(async () => {
  assertFreshLoopback(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
  const root = process.env.BULLA_E2E_ARTIFACT_DIR ||
    (process.platform === 'win32' ? path.join(recoveryRoot, 'e2e') : path.join(os.tmpdir(), 'bulla-e2e'))
  const run = process.env.BULLA_E2E_RUN_ID
  if (!path.isAbsolute(root) || !run || !/^[a-zA-Z0-9-]+$/.test(run)) {
    throw new Error('Core campus acceptance requires a fresh isolated Playwright run identifier.')
  }
  const runRoot = path.resolve(root, run)
  assertInside(root, runRoot)
  if (process.platform === 'win32') assertInside(recoveryRoot, runRoot)
  fixtureRoot = path.join(runRoot, 'fixture')
  fixtureFile = path.join(fixtureRoot, 'local.json')
  await fs.mkdir(fixtureRoot, { recursive: true })
  assertInside(await fs.realpath(root), await fs.realpath(fixtureRoot))
  if (process.platform === 'win32') {
    assertInside(await fs.realpath(recoveryRoot), await fs.realpath(fixtureRoot))
  }

  // Retain this exclusive marker even on failure: retry with a NEW run ID.
  const marker = await fs.open(path.join(fixtureRoot, 'core-campus-fixture.marker'), 'wx', 0o600)
  await marker.close()
  const lock = `${fixtureFile}.lock`
  const temp = `${fixtureFile}.core-campus.${randomUUID()}.tmp`
  assertInside(fixtureRoot, lock)
  assertInside(fixtureRoot, temp)
  try {
    // Same exact lock as the store. No sleeps, stale-lock removal or retry loop.
    await fs.mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('The isolated fixture is busy; core campus setup did not write anything.')
    }
    throw error
  }
  let ownsTemp = false
  try {
    let snapshot: Partial<Tables> = {}
    try {
      snapshot = await readFixture()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Object.values(snapshot).some((rows) => rows.length !== 0)) {
      throw new Error('Core campus requires an empty store. Never reset another spec, account or budget.')
    }
    const handle = await fs.open(temp, 'wx', 0o600)
    ownsTemp = true
    try {
      await handle.writeFile(JSON.stringify({
        ...snapshot,
        universities: [university],
        departments: [department],
        skills: [skill],
      }, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, fixtureFile)
    ownsTemp = false
  } finally {
    try {
      if (ownsTemp) await fs.unlink(temp)
    } finally {
      // Only this invocation's validated, empty lock directory; no recursive cleanup.
      await fs.rmdir(lock)
    }
  }
})

test.beforeEach(async ({ baseURL }, testInfo) => {
  assertFreshLoopback(baseURL)
  if (testInfo.config.workers !== 1 || testInfo.retry !== 0) {
    throw new Error('Run core campus alone with --workers=1 --retries=0 and a fresh run ID.')
  }
})

/** Require the exact POST and a bounded domain outcome, never RSC closure. */
async function submit(page: Page, control: Locator, outcome: () => Promise<unknown>) {
  const current = new URL(page.url())
  const response = await completeAction(page, control, outcome)
  expect(response.status(), `Action on ${current.pathname} returned an HTTP error`).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

function section(page: Page, title: string) {
  return page.locator('section').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  })
}

function personRow(container: Locator, page: Page, student: Student) {
  return container.locator('li').filter({
    has: page.getByRole('link', { name: student.displayName, exact: true }),
  })
}

function roleBadge(row: Locator, role: 'Owner' | 'Member' | 'Maintainer') {
  // Do not accidentally match the same text in a role select's hidden options.
  return row.locator('span').filter({ hasText: new RegExp(`^${role}$`) })
}

function post(page: Page, body: string) {
  return page.locator('article').filter({ has: page.getByText(body, { exact: true }) })
}

async function signup(
  page: Page, observer: Page, handle: string, displayName: string, departmentId?: string,
): Promise<Student> {
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(`${handle}@example.test`)
  await page.getByLabel(/^Password/).fill(`Campus-${randomBytes(24).toString('base64url')}-9Aa!`)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submit(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL((url) => url.pathname === '/onboarding'))
  await expect(page).toHaveURL((url) => url.pathname === '/onboarding')
  const generatedHandle = await page.getByLabel(/^Choose a username/).inputValue()
  expect(generatedHandle).not.toBe('')
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  expect((await readFixture()).profiles?.find((row) => row.username === generatedHandle)).toMatchObject({
    visibility: 'private', onboarding_completed: false,
  })
  const privateResponse = await observer.goto(`/u/${encodeURIComponent(generatedHandle)}`)
  expect(privateResponse).not.toBeNull()
  // Installed Next docs allow 200 after streaming begins. The refusal UI,
  // serialized response and identity are the contract, not a guessed status.
  expect([200, 404]).toContain(privateResponse!.status())
  await expect(observer.getByRole('heading', {
    level: 1, name: 'There is nothing at this address', exact: true,
  })).toBeVisible()
  await expect(observer.getByText(displayName, { exact: true })).toHaveCount(0)
  expect(await privateResponse!.text()).not.toContain(displayName)

  await page.getByLabel(/^Choose a username/).fill(handle)
  await page.getByRole('combobox', { name: 'University', exact: true }).selectOption(university.id)
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('')
  await page.getByLabel(/^Degree or programme/).fill('Computer Science')
  // Degree text is not a department claim. Alice's people journey explicitly
  // selects a reference at onboarding; Bob later selects one through profile edit.
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('')
  if (departmentId) await page.getByRole('combobox', { name: 'Department', exact: true }).selectOption(departmentId)
  await page.getByLabel(/^Who can see your profile/).selectOption('public') // Explicit consent, not a setup write.
  await submit(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL((url) => url.pathname === '/me')
    await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  })
  await expect(page).toHaveURL((url) => url.pathname === '/me')
  await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  const publicResponse = await observer.goto(`/u/${handle}`)
  expect(publicResponse?.status()).toBe(200)
  await expect(observer.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  const snapshot = await readFixture() // Read-only validation of the real signup/session.
  const profile = snapshot.profiles?.find((row) => row.username === handle)
  expect(profile).toMatchObject({ visibility: 'public', university_id: university.id, onboarding_completed: true })
  expect(profile).toMatchObject({
    department_id: departmentId ?? null,
    department: departmentId ? department.name : null,
    degree: 'Computer Science',
  })
  const cookie = (await page.context().cookies()).find((row) => row.name === 'quad_local_session')
  expect(cookie?.httpOnly).toBe(true)
  expect(snapshot.sessions?.some((row) => row.user_id === profile!.user_id &&
    row.token_hash === createHash('sha256').update(cookie!.value).digest('hex'))).toBe(true)
  return { handle, displayName, profileId: profile!.id }
}

async function withStudents(
  browser: Browser, alicePage: Page, baseURL: string | undefined, flow: string,
  journey: (students: Students) => Promise<void>,
) {
  const origin = assertFreshLoopback(baseURL)
  const bobContext = await browser.newContext({ baseURL: origin })
  const observerContext = await browser.newContext({ baseURL: origin })
  const errors: string[] = []
  try {
    const bobPage = await bobContext.newPage()
    const observer = await observerContext.newPage()
    for (const [name, current] of [['Alice', alicePage], ['Bob', bobPage], ['Observer', observer]] as const) {
      current.on('pageerror', (error) => errors.push(`${name}: ${error.message}`))
    }
    const suffix = randomBytes(6).toString('hex')
    const alice = await signup(alicePage, observer, `campus_${flow}_a_${suffix}`, `Core Alice ${suffix}`,
      flow === 'people' ? department.id : undefined)
    const bob = await signup(bobPage, observer, `campus_${flow}_b_${suffix}`, `Core Bob 50%_ ${suffix}`)
    await journey({ alice, bob, alicePage, bobPage, observer, suffix })
    expect(errors).toEqual([])
  } finally {
    await bobContext.close()
    await observerContext.close()
  }
}

async function findPeople(page: Page, query: string, skillName: string, department = '') {
  const form = page.getByRole('form', { name: 'Filter people', exact: true })
  await form.getByRole('searchbox', { name: 'Name or username', exact: true }).fill(query)
  await form.getByRole('combobox', { name: 'University', exact: true }).selectOption(university.id)
  await form.getByRole('textbox', { name: 'Department contains', exact: true }).fill(department)
  await form.getByRole('textbox', { name: 'Skill contains', exact: true }).fill(skillName)
  await form.getByRole('button', { name: 'Find people', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/search' &&
    url.searchParams.get('q') === query && url.searchParams.get('type') === 'people' &&
    url.searchParams.get('university') === university.id &&
    (url.searchParams.get('department') ?? '') === department &&
    (url.searchParams.get('skill') ?? '') === skillName && !url.searchParams.has('cursor'))
}

async function createGoal(page: Page, title: string, description: string, visibility: 'private' | 'public') {
  await page.goto('/goals')
  const disclosure = page.locator('details').filter({
    has: page.locator('summary').filter({ hasText: /^Add a goal$/ }),
  })
  await disclosure.locator('summary').click()
  await disclosure.getByLabel(/^The goal/).fill(title)
  await disclosure.getByLabel(/^What counts as done/).fill(description)
  await disclosure.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('reading')
  await disclosure.getByRole('combobox', { name: 'Term', exact: true }).selectOption('')
  await disclosure.getByRole('spinbutton', { name: 'Target (required)', exact: true }).fill('5')
  await disclosure.getByRole('textbox', { name: 'Unit', exact: true }).fill('chapters')
  await expect(disclosure.getByRole('combobox', { name: 'Who can see it', exact: true })).toHaveValue('private')
  await disclosure.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption(visibility)
  await submit(page, disclosure.getByRole('button', { name: 'Add the goal', exact: true }),
    () => expect(page.getByRole('heading', { level: 3, name: title, exact: true })).toBeVisible())
  const card = page.locator('article').filter({
    has: page.getByRole('heading', { level: 3, name: title, exact: true }),
  })
  await expect(card).toBeVisible()
  await expect(card).toContainText(description)
  await page.reload()
  await expect(card).toBeVisible()
  return card
}

test('real student publication, durable feed interactions and an owner-only saved list', async ({ page, browser, baseURL }) => {
  test.setTimeout(360_000)
  await withStudents(browser, page, baseURL, 'feed', async ({ alice, bob, alicePage, bobPage, observer, suffix }) => {
    await test.step('signed-out saved-list access asks for authentication', async () => {
      await observer.goto('/saved')
      await expect(observer).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('next') === '/saved')
      await expect(observer.getByRole('heading', { level: 1, name: 'Saved posts', exact: true })).toHaveCount(0)
    })
    const body = `Core campus public feed post ${suffix}`
    const comment = `Core campus peer comment ${suffix}`
    let postId: string
    let permalink: string
    await test.step('publish from the composer, await draft clearing, then reload', async () => {
      await alicePage.goto('/feed')
      await expect(alicePage.getByRole('heading', { level: 1, name: 'Campus feed', exact: true })).toBeVisible()
      await alicePage.getByRole('textbox', { name: 'Post body', exact: true }).fill(body)
      await alicePage.getByRole('combobox', { name: 'Visible to', exact: true }).selectOption('public')
      await submit(alicePage, alicePage.getByRole('button', { name: 'Post', exact: true }), async () => {
        await expect(alicePage.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
        await expect(post(alicePage, body)).toHaveCount(1)
      })
      await expect(alicePage.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
      await expect(post(alicePage, body)).toHaveCount(1)
      const storedPost = (await readFixture()).posts?.find(row => row.author_id === alice.profileId && row.body === body)
      expect(storedPost?.visibility).toBe('public')
      postId = storedPost!.id
      await alicePage.reload()
      await expect(post(alicePage, body)).toHaveCount(1)
      await expect(alicePage.getByRole('textbox', { name: 'Post body', exact: true })).toHaveValue('')
    })
    await test.step('a peer likes and privately saves the readable post; both survive reload', async () => {
      await bobPage.goto('/feed')
      const card = post(bobPage, body)
      await expect(card).toHaveCount(1)
      await submit(bobPage, card.getByRole('button', { name: 'Like this post', exact: true }), async () => {
        await expect.poll(async () => (await readFixture()).post_likes?.some(row =>
          row.post_id === postId && row.profile_id === bob.profileId)).toBe(true)
        await expect(card.getByRole('button', { name: 'Remove your like', exact: true })).toHaveAttribute('aria-pressed', 'true')
      })
      await expect(card.getByRole('button', { name: 'Remove your like', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(card.getByRole('status').filter({ hasText: 'Saving your change' })).toHaveCount(0)
      await submit(bobPage, card.getByRole('button', { name: 'Save this post to your private list', exact: true }), async () => {
        await expect.poll(async () => (await readFixture()).post_saves?.some(row =>
          row.post_id === postId && row.profile_id === bob.profileId)).toBe(true)
        await expect(card.getByRole('button', { name: 'Remove from your saved posts', exact: true })).toHaveAttribute('aria-pressed', 'true')
      })
      await expect(card.getByRole('button', { name: 'Remove from your saved posts', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(card.getByRole('status').filter({ hasText: 'Saving your change' })).toHaveCount(0)
      await expect(card.getByRole('alert')).toHaveCount(0)
      await bobPage.reload()
      await expect(card.getByRole('button', { name: 'Remove your like', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(card.getByRole('button', { name: 'Remove from your saved posts', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const comments = card.getByRole('link', { name: /^\d+\s*comments$/ })
      const href = await comments.getAttribute('href')
      expect(href).toMatch(/^\/post\/[^/?#]+#comments$/)
      permalink = new URL(href!, bobPage.url()).pathname
      await comments.click()
      await expect(bobPage).toHaveURL((url) => url.pathname === permalink && url.hash === '#comments')
    })
    await test.step('the permalink records the peer comment once and reloads it for the author', async () => {
      await bobPage.getByRole('textbox', { name: 'Your comment', exact: true }).fill(comment)
      await submit(bobPage, bobPage.getByRole('button', { name: 'Comment', exact: true }), async () => {
        await expect(bobPage.getByRole('textbox', { name: 'Your comment', exact: true })).toHaveValue('')
        await expect(bobPage.getByText(comment, { exact: true })).toHaveCount(1)
      })
      await expect(bobPage.getByRole('textbox', { name: 'Your comment', exact: true })).toHaveValue('')
      await expect(bobPage.getByText(comment, { exact: true })).toHaveCount(1)
      await bobPage.reload()
      await expect(bobPage.getByText(comment, { exact: true })).toHaveCount(1)
      await expect(bobPage.getByRole('heading', { name: 'Comments (1)', exact: true })).toBeVisible()
      await alicePage.goto(permalink)
      await expect(alicePage.getByText(comment, { exact: true })).toHaveCount(1)
      await expect(post(alicePage, body).getByRole('button', { name: 'Like this post', exact: true })).toHaveText('1')
    })
    await test.step('/saved is private; removing a bookmark leaves the post readable', async () => {
      await bobPage.goto('/saved')
      await expect(bobPage.getByRole('heading', { level: 1, name: 'Saved posts', exact: true })).toBeVisible()
      await expect(post(bobPage, body)).toHaveCount(1)
      await bobPage.reload()
      await expect(post(bobPage, body)).toHaveCount(1)
      await alicePage.goto('/saved')
      await expect(post(alicePage, body)).toHaveCount(0)
      await expect(alicePage.getByText('Nothing saved in this view', { exact: true })).toBeVisible()
      await submit(bobPage, post(bobPage, body).getByRole('button', { name: 'Remove from your saved posts', exact: true }), async () => {
        await expect.poll(async () => (await readFixture()).post_saves?.some(row =>
          row.post_id === postId && row.profile_id === bob.profileId)).toBe(false)
        await expect(post(bobPage, body)).toHaveCount(0)
      })
      await expect(post(bobPage, body)).toHaveCount(0)
      await bobPage.reload()
      await expect(bobPage.getByText('Nothing saved in this view', { exact: true })).toBeVisible()
      await bobPage.goto(permalink)
      await expect(post(bobPage, body)).toHaveCount(1)
      await expect(post(bobPage, body).getByRole('link', { name: alice.displayName, exact: true })).toBeVisible()
      await expect(post(bobPage, body).getByRole('button', { name: 'Save this post to your private list', exact: true })).toHaveAttribute('aria-pressed', 'false')
    })
  })
})

test('campus links, literal people/skill filters, proposal privacy and mutual connections', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  await withStudents(browser, page, baseURL, 'people', async ({ alice, bob, alicePage, bobPage, suffix }) => {
    const pendingSkill = `Core private proposal ${suffix}`
    await test.step('claim an approved skill and propose an owner-only unapproved one through controls', async () => {
      await bobPage.goto('/me/skills')
      const editor = bobPage.getByRole('region', { name: 'Your skills', exact: true })
      await editor.getByRole('combobox', { name: 'Add a skill', exact: true }).selectOption(skill.id)
      await editor.getByRole('combobox', { name: 'Level', exact: true }).selectOption('familiar')
      await editor.getByRole('checkbox', { name: 'I am learning this now', exact: true }).check()
      await submit(bobPage, editor.getByRole('button', { name: 'Add skill', exact: true }),
        () => expect(editor.getByRole('combobox', { name: `${skill.name} level`, exact: true })).toHaveValue('familiar'))
      await expect(editor.getByRole('combobox', { name: `${skill.name} level`, exact: true })).toHaveValue('familiar')
      await editor.getByRole('textbox', { name: 'Skill', exact: true }).fill(pendingSkill)
      await submit(bobPage, editor.getByRole('button', { name: 'Add as new', exact: true }),
        () => expect(editor.locator('li').filter({ hasText: pendingSkill })).toContainText('waiting for review'))
      await expect(editor.locator('li').filter({ hasText: pendingSkill })).toContainText('waiting for review')
      await bobPage.reload()
      await expect(editor.getByRole('combobox', { name: `${skill.name} level`, exact: true })).toHaveValue('familiar')
      await expect(editor.locator('li').filter({ hasText: pendingSkill })).toContainText('waiting for review')
    })
    await test.step('the real university card opens canonical, URL-addressed results', async () => {
      await alicePage.goto('/universities')
      const directory = alicePage.getByRole('region', { name: 'University directory', exact: true })
      const card = directory.locator('li').filter({
        has: alicePage.getByRole('heading', { level: 3, name: university.name, exact: true }),
      })
      const link = card.getByRole('link', { name: 'Find people', exact: true })
      await expect(link).toHaveAttribute('href', `/search?type=people&university=${university.id}`)
      await link.click()
      await expect(alicePage).toHaveURL((url) => url.pathname === '/search' &&
        url.searchParams.get('type') === 'people' && url.searchParams.get('university') === university.id)
      await expect(alicePage.getByRole('form', { name: 'Filter people', exact: true })).toBeVisible()
      await findPeople(alicePage, `50%_ ${suffix}`, skill.name)
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
      await expect(alicePage.getByRole('link', { name: bob.displayName, exact: true })).toBeVisible()
      const response = await alicePage.reload()
      expect(response?.status()).toBe(200)
      expect(await response!.text()).not.toContain(pendingSkill)
      await expect(alicePage.getByRole('combobox', { name: 'University', exact: true })).toHaveValue(university.id)
      await expect(alicePage.getByRole('textbox', { name: 'Skill contains', exact: true })).toHaveValue(skill.name)
      await expect(alicePage.getByRole('searchbox', { name: 'Name or username', exact: true })).toHaveValue(`50%_ ${suffix}`)
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
    })
    await test.step('degree text is not a department; a private proposal is not a searchable public skill', async () => {
      await findPeople(alicePage, `50%_ ${suffix}`, skill.name, 'Computer Science')
      await expect(alicePage.getByText('No readable people match this view', { exact: true })).toBeVisible()
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(0)
      await findPeople(alicePage, `50%_ ${suffix}`, pendingSkill)
      await expect(alicePage.getByText('No readable people match this view', { exact: true })).toBeVisible()
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(0)
      // The submitted filter is intentionally reflected in its input; check
      // withheld result rows here, and withheld serialized names on the profile.
      await findPeople(alicePage, `50%_ ${suffix}`, skill.name)
      await alicePage.getByRole('link', { name: 'Open profile', exact: true }).click()
      await expect(alicePage).toHaveURL((url) => url.pathname === `/u/${bob.handle}`)
      const response = await alicePage.reload()
      expect(response?.status()).toBe(200)
      expect(await response!.text()).not.toContain(pendingSkill)
      await expect(alicePage.getByRole('heading', { level: 1, name: bob.displayName, exact: true })).toBeVisible()
      await expect(alicePage.getByText(pendingSkill, { exact: true })).toHaveCount(0)
      await expect(alicePage.getByText(skill.name, { exact: true })).toBeVisible()
    })
    await test.step('onboarding and profile edit persist genuine departments and real filtered results reload', async () => {
      await alicePage.goto('/me/edit')
      await expect(alicePage.getByRole('combobox', { name: 'University', exact: true })).toHaveValue(university.id)
      await expect(alicePage.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue(department.id)
      await alicePage.reload()
      await expect(alicePage.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue(department.id)

      await bobPage.goto('/me/edit')
      await expect(bobPage.getByRole('combobox', { name: 'University', exact: true })).toHaveValue(university.id)
      await expect(bobPage.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('')
      await expect(bobPage.getByRole('textbox', { name: 'Degree or programme', exact: true })).toHaveValue('Computer Science')
      await bobPage.getByRole('combobox', { name: 'Department', exact: true }).selectOption(department.id)
      await submit(bobPage, bobPage.getByRole('button', { name: 'Save changes', exact: true }),
        () => expect(bobPage.getByText('Saved.', { exact: true })).toBeVisible())
      await expect(bobPage.getByText('Saved.', { exact: true })).toBeVisible()
      await bobPage.reload()
      await expect(bobPage.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue(department.id)
      await expect(bobPage.getByRole('textbox', { name: 'Degree or programme', exact: true })).toHaveValue('Computer Science')

      await alicePage.goto(`/search?type=people&university=${university.id}`)
      await findPeople(alicePage, `50%_ ${suffix}`, skill.name, department.name)
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
      await expect(alicePage.getByRole('link', { name: bob.displayName, exact: true })).toBeVisible()
      await alicePage.reload()
      await expect(alicePage.getByRole('textbox', { name: 'Department contains', exact: true })).toHaveValue(department.name)
      await expect(alicePage.getByRole('link', { name: 'Open profile', exact: true })).toHaveCount(1)
      await alicePage.getByRole('link', { name: 'Open profile', exact: true }).click()
      await expect(alicePage).toHaveURL((url) => url.pathname === `/u/${bob.handle}`)
    })
    await test.step('following is one-way; a separately accepted request becomes a mutual connection', async () => {
      await submit(alicePage, alicePage.getByRole('button', { name: 'Follow', exact: true }),
        () => expect(alicePage.getByRole('button', { name: 'Following', exact: true })).toBeVisible())
      await expect(alicePage.getByRole('button', { name: 'Following', exact: true })).toBeVisible()
      await alicePage.reload()
      await expect(alicePage.getByRole('button', { name: 'Following', exact: true })).toBeVisible()
      await submit(alicePage, alicePage.getByRole('button', { name: 'Connect', exact: true }), async () => {
        await expect(alicePage.getByText('Request sent', { exact: true })).toBeVisible()
        await expect(alicePage.getByRole('button', { name: 'Withdraw request', exact: true })).toBeVisible()
      })
      await expect(alicePage.getByText('Request sent', { exact: true })).toBeVisible()
      await expect(alicePage.getByRole('button', { name: 'Withdraw request', exact: true })).toBeVisible()
      await bobPage.goto('/connections/requests')
      const incoming = bobPage.getByRole('region', { name: 'Requests waiting for you', exact: true })
      const request = personRow(incoming, bobPage, alice)
      await expect(request).toHaveCount(1)
      await submit(bobPage, request.getByRole('button', { name: /^Accept the connection request from/ }), async () => {
        await expect.poll(async () => (await readFixture()).connections?.some(row =>
          row.requester_id === alice.profileId && row.addressee_id === bob.profileId && row.status === 'accepted')).toBe(true)
        await expect(request).toHaveCount(0)
      })
      await expect(request).toHaveCount(0)
      await bobPage.reload()
      await expect(request).toHaveCount(0)
      await bobPage.goto(`/u/${alice.handle}`)
      await expect(bobPage.getByText('Connected', { exact: true })).toBeVisible()
      await expect(bobPage.getByRole('button', { name: 'Remove connection', exact: true })).toBeVisible()
      await expect(bobPage.getByRole('button', { name: 'Follow', exact: true })).toBeVisible()
      await alicePage.reload()
      await expect(alicePage.getByText('Connected', { exact: true })).toBeVisible()
      await expect(alicePage.getByRole('button', { name: 'Following', exact: true })).toBeVisible()
      await expect(alicePage.getByRole('button', { name: 'Withdraw request', exact: true })).toHaveCount(0)
    })
  })
})

test('project join/review, member-manager roles and one-time idea conversion through real controls', async ({ page, browser, baseURL }) => {
  test.setTimeout(360_000)
  test.info().annotations.push({
    type: 'coverage-gap',
    description: 'Local conversion has no project invitations. Convert an idea with zero offers; do not claim invitation delivery or acceptance.',
  })
  await withStudents(browser, page, baseURL, 'work', async ({ alice, bob, alicePage, bobPage, suffix }) => {
    const title = `Core campus team project ${suffix}`
    const note = `Core peer application note ${suffix}`
    let projectPath: string
    await test.step('create a public, seeking project and apply as the other student', async () => {
      await alicePage.goto('/projects/new')
      await alicePage.getByLabel(/^Title/).fill(title)
      await alicePage.getByRole('textbox', { name: 'One-line purpose', exact: true }).fill('Build a small campus timetable together')
      const audience = alicePage.getByRole('combobox', { name: 'Who can see it', exact: true })
      await expect(audience).toHaveValue('private')
      await audience.selectOption('public') // Explicit collaboration publication via the real control.
      await alicePage.getByRole('checkbox', { name: /^This project is looking for people/ }).check()
      await alicePage.getByRole('spinbutton', { name: 'Team size you are aiming for', exact: true }).fill('3')
      await submit(alicePage, alicePage.getByRole('button', { name: 'Create project', exact: true }), async () => {
        await expect(alicePage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.get('welcome') === '1')
        await expect(alicePage.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
      })
      await expect(alicePage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.get('welcome') === '1')
      projectPath = new URL(alicePage.url()).pathname
      await expect(alicePage.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
      await expect(roleBadge(personRow(section(alicePage, 'Team'), alicePage, alice), 'Owner')).toBeVisible()
      await bobPage.goto(projectPath)
      await expect(bobPage.getByRole('tab', { name: 'Requests', exact: true })).toHaveCount(0)
      await expect(bobPage.getByRole('tab', { name: 'Seeking members', exact: true })).toHaveCount(0)
      await expect(bobPage.getByRole('combobox', { name: /^Role for / })).toHaveCount(0)
      await bobPage.getByRole('textbox', { name: 'What you would like to do', exact: true }).fill('Frontend')
      await bobPage.getByRole('textbox', { name: 'Note to the owners', exact: true }).fill(note)
      await submit(bobPage, bobPage.getByRole('button', { name: 'Ask to join', exact: true }),
        () => expect(bobPage.getByText('Your request is with the project', { exact: true })).toBeVisible())
      await expect(bobPage.getByText('Your request is with the project', { exact: true })).toBeVisible()
      await bobPage.reload()
      await expect(bobPage.getByRole('button', { name: 'Withdraw my request', exact: true })).toBeVisible()
    })
    await test.step('accepting removes the pending request and adds a durable member who can publish updates', async () => {
      await alicePage.reload()
      const requestsTab = alicePage.getByRole('tab', { name: 'Requests', exact: true })
      await requestsTab.click()
      await expect(alicePage).toHaveURL((url) =>
        url.pathname === projectPath && url.searchParams.get('tab') === 'requests')
      await expect(requestsTab).toHaveAttribute('aria-selected', 'true')
      const requests = alicePage.getByRole('tabpanel', { name: 'Requests', exact: true })
      await expect(requests).toBeVisible()
      const application = personRow(requests, alicePage, bob)
      await expect(application).toContainText(note)
      await submit(alicePage, application.getByRole('button', { name: 'Accept', exact: true }), async () => {
        await expect(application).toHaveCount(0)
        await expect(roleBadge(personRow(section(alicePage, 'Team'), alicePage, bob), 'Member')).toBeVisible()
      })
      await expect(application).toHaveCount(0)
      await expect(roleBadge(personRow(section(alicePage, 'Team'), alicePage, bob), 'Member')).toBeVisible()
      await bobPage.reload()
      await expect(bobPage.getByRole('button', { name: 'Withdraw my request', exact: true })).toHaveCount(0)
      await expect(bobPage.getByRole('tab', { name: 'Requests', exact: true })).toHaveCount(0)
      const update = `Core accepted member project update ${suffix}`
      await bobPage.getByRole('textbox', { name: 'Project update', exact: true }).fill(update)
      await bobPage.getByRole('checkbox', { name: /^Post to the feed as well/ }).check()
      await submit(bobPage, bobPage.getByRole('button', { name: 'Post update', exact: true }), async () => {
        await expect(bobPage.getByRole('textbox', { name: 'Project update', exact: true })).toHaveValue('')
        await expect(bobPage.getByText(update, { exact: true })).toHaveCount(1)
      })
      await expect(bobPage.getByRole('textbox', { name: 'Project update', exact: true })).toHaveValue('')
      await expect(bobPage.getByText(update, { exact: true })).toHaveCount(1)
      await bobPage.reload()
      await expect(bobPage.getByText(update, { exact: true })).toHaveCount(1)
      await bobPage.goto('/feed')
      await expect(post(bobPage, update)).toHaveCount(1)
      await expect(post(bobPage, update).getByRole('link', { name: title, exact: true })).toHaveAttribute('href', projectPath)
    })
    await test.step('owner promotion/demotion changes manager controls, not ownership', async () => {
      await alicePage.reload()
      const member = personRow(section(alicePage, 'Team'), alicePage, bob)
      await member.getByRole('combobox', { name: `Role for ${bob.displayName}`, exact: true }).selectOption('maintainer')
      await submit(alicePage, member.getByRole('button', { name: 'Save role', exact: true }), async () => {
        await expect(member.getByRole('status')).toHaveText('Role updated.')
        await expect(roleBadge(member, 'Maintainer')).toBeVisible()
      })
      await expect(member.getByRole('status')).toHaveText('Role updated.')
      await expect(roleBadge(member, 'Maintainer')).toBeVisible()
      await bobPage.goto(projectPath)
      await expect(bobPage.getByRole('tab', { name: 'Requests', exact: true })).toBeVisible()
      await expect(bobPage.getByRole('tab', { name: 'Seeking members', exact: true })).toBeVisible()
      await expect(bobPage.getByRole('button', { name: 'Make owner', exact: true })).toHaveCount(0)
      await member.getByRole('combobox', { name: `Role for ${bob.displayName}`, exact: true }).selectOption('member')
      await submit(alicePage, member.getByRole('button', { name: 'Save role', exact: true }),
        () => expect(roleBadge(member, 'Member')).toBeVisible())
      await expect(roleBadge(member, 'Member')).toBeVisible()
      await alicePage.reload()
      await expect(member.getByRole('combobox', { name: `Role for ${bob.displayName}`, exact: true })).toHaveValue('member')
      await expect(roleBadge(personRow(section(alicePage, 'Team'), alicePage, alice), 'Owner')).toBeVisible()
      await bobPage.reload()
      await expect(bobPage.getByRole('tab', { name: 'Requests', exact: true })).toHaveCount(0)
      await expect(bobPage.getByRole('tab', { name: 'Seeking members', exact: true })).toHaveCount(0)
      await expect(bobPage.getByRole('combobox', { name: /^Role for / })).toHaveCount(0)
    })
    await test.step('only the idea author converts; the source idea links back to its one real project', async () => {
      const ideaTitle = `Core campus converted idea ${suffix}`
      const pitch = `Core campus conversion pitch ${suffix}: build a useful synthetic timetable for our two student accounts.`
      await alicePage.goto('/ideas')
      await alicePage.locator('summary').filter({ hasText: /^Post an idea$/ }).click()
      await alicePage.getByLabel(/^Title/).fill(ideaTitle)
      await alicePage.getByLabel(/^The pitch/).fill(pitch)
      await alicePage.getByRole('combobox', { name: 'Category', exact: true }).selectOption('other')
      await alicePage.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('public')
      await submit(alicePage, alicePage.getByRole('button', { name: 'Post the idea', exact: true }), async () => {
        await expect(alicePage).toHaveURL((url) => /^\/ideas\/[^/]+$/.test(url.pathname))
        await expect(alicePage.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
      })
      await expect(alicePage).toHaveURL((url) => /^\/ideas\/[^/]+$/.test(url.pathname))
      const ideaPath = new URL(alicePage.url()).pathname
      await bobPage.goto(ideaPath)
      await expect(bobPage.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
      await expect(bobPage.getByRole('button', { name: 'Create the project from this idea', exact: true })).toHaveCount(0)
      await expect(alicePage.getByText('No offers are currently recorded. Invitation eligibility is checked when you convert.', { exact: true })).toBeVisible()
      await submit(alicePage, alicePage.getByRole('button', { name: 'Create the project from this idea', exact: true }), async () => {
        await expect(alicePage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.get('converted') === '1')
        await expect(alicePage.getByText('The idea is a project now', { exact: true })).toBeVisible()
      })
      await expect(alicePage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) && url.searchParams.get('converted') === '1')
      const convertedPath = new URL(alicePage.url()).pathname
      await expect(alicePage.getByText('The idea is a project now', { exact: true })).toBeVisible()
      await expect(alicePage.getByRole('heading', { level: 1, name: ideaTitle, exact: true })).toBeVisible()
      await expect(alicePage.getByText(pitch, { exact: true })).toBeVisible()
      await expect(roleBadge(personRow(section(alicePage, 'Team'), alicePage, alice), 'Owner')).toBeVisible()
      await alicePage.goto(ideaPath)
      await expect(alicePage.getByRole('button', { name: 'Create the project from this idea', exact: true })).toHaveCount(0)
      await expect(alicePage.getByText('This idea is a project now', { exact: true })).toBeVisible()
      const convertedLink = alicePage.getByRole('link', { name: convertedPath, exact: true })
      await expect(convertedLink).toHaveAttribute('href', convertedPath)
      await convertedLink.click()
      await expect(alicePage).toHaveURL((url) => url.pathname === convertedPath)
      await bobPage.reload()
      await expect(bobPage.getByRole('link', { name: 'See the project', exact: true })).toHaveAttribute('href', convertedPath)
      await expect(bobPage.getByRole('button', { name: 'I would help build this', exact: true })).toHaveCount(0)
    })
  })
})

test('private learning, date-bound log updates, capacity-safe RSVPs and readable-event reporting', async ({ page, browser, baseURL }) => {
  test.setTimeout(360_000)
  test.info().annotations.push({
    type: 'coverage-gap',
    description: 'No event bookmark control; interested is an RSVP, not a private bookmark. Only event reporting is mounted in these content journeys.',
  })
  await withStudents(browser, page, baseURL, 'learn', async ({ alice, bob, alicePage, bobPage, observer, suffix }) => {
    const privateGoal = `Core private learning goal ${suffix}`
    const privateDescription = `Core private goal definition ${suffix}`
    const publicGoal = `Core explicitly shared goal ${suffix}`
    const logSummary = `Core private study log ${suffix}`
    const updatedSummary = `Core private updated study log ${suffix}`
    const wins = `Core private study win ${suffix}`
    const blockers = `Core private study blocker ${suffix}`
    await test.step('explicitly private and public goals persist progress/status without implying mastery', async () => {
      const card = await createGoal(alicePage, privateGoal, privateDescription, 'private')
      await card.getByRole('spinbutton', { name: 'How many chapters so far', exact: true }).fill('2')
      await submit(alicePage, card.getByRole('button', { name: 'Update', exact: true }),
        () => expect(card.getByRole('status')).toHaveText('Progress updated.'))
      await expect(card.getByRole('status')).toHaveText('Progress updated.')
      await alicePage.reload()
      await expect(card.getByRole('spinbutton', { name: 'How many chapters so far', exact: true })).toHaveValue('2')
      await submit(alicePage, card.getByRole('button', { name: 'Mark as done', exact: true }),
        () => expect(card.getByText('Done', { exact: true })).toBeVisible())
      await expect(card.getByText('Done', { exact: true })).toBeVisible()
      await alicePage.reload()
      await expect(card.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()
      await createGoal(alicePage, publicGoal, 'An intentionally shared reading plan, not measured ability.', 'public')
    })
    await test.step('the UTC day is captured from the form; a second save updates one durable entry', async () => {
      await alicePage.goto('/log')
      await expect(alicePage.getByRole('heading', { level: 1, name: 'Study log', exact: true })).toBeVisible()
      const logDay = await alicePage.getByLabel(/^Day/).inputValue()
      expect(logDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      await alicePage.getByRole('spinbutton', { name: 'Hours studied', exact: true }).fill('2.5')
      await alicePage.getByRole('combobox', { name: 'How the day felt', exact: true }).selectOption('4')
      await alicePage.getByRole('combobox', { name: 'How much got done', exact: true }).selectOption('3')
      await alicePage.getByRole('textbox', { name: 'What you did', exact: true }).fill(logSummary)
      await alicePage.getByRole('textbox', { name: 'What went well', exact: true }).fill(wins)
      await alicePage.getByRole('textbox', { name: 'What got in the way', exact: true }).fill(blockers)
      await submit(alicePage, alicePage.getByRole('button', { name: 'Save the day', exact: true }),
        () => expect(alicePage.getByText('Entry saved.', { exact: true })).toBeVisible())
      await expect(alicePage.getByText('Entry saved.', { exact: true })).toBeVisible()
      const entries = section(alicePage, 'Recent entries')
      const entry = entries.locator('li').filter({ has: alicePage.getByText(logDay, { exact: true }) })
      await expect(entry).toHaveCount(1)
      await expect(entry).toContainText(logSummary)
      await alicePage.reload()
      await expect(entry).toHaveCount(1)
      await expect(entry).toContainText('2.5 h')
      if (await alicePage.getByLabel(/^Day/).inputValue() === logDay) {
        await expect(alicePage.getByRole('spinbutton', { name: 'Hours studied', exact: true })).toHaveValue('2.5')
        await expect(alicePage.getByRole('textbox', { name: 'What you did', exact: true })).toHaveValue(logSummary)
        await expect(alicePage.getByRole('button', { name: 'Update this day', exact: true })).toBeVisible()
      }
      // If midnight UTC crossed, use the real Day control to update the captured
      // date, not the new "today"; no fake clocks or inferred device time.
      await alicePage.getByLabel(/^Day/).fill(logDay)
      await alicePage.getByRole('spinbutton', { name: 'Hours studied', exact: true }).fill('3')
      await alicePage.getByRole('textbox', { name: 'What you did', exact: true }).fill(updatedSummary)
      await alicePage.getByRole('textbox', { name: 'What went well', exact: true }).fill(wins)
      await alicePage.getByRole('textbox', { name: 'What got in the way', exact: true }).fill(blockers)
      await submit(alicePage, alicePage.getByRole('button', { name: /^(Update this day|Save the day)$/ }),
        () => expect(alicePage.getByText('Entry updated.', { exact: true })).toBeVisible())
      await expect(alicePage.getByText('Entry updated.', { exact: true })).toBeVisible()
      await alicePage.reload()
      await expect(entry).toHaveCount(1)
      await expect(entry).toContainText(updatedSummary)
      await expect(entry).toContainText('3 h')
      await expect(entries.getByText(logSummary, { exact: true })).toHaveCount(0)
    })
    await test.step('readable public profiles withhold private goals and every log field from peer and anonymous HTML', async () => {
      await alicePage.goto('/me')
      await expect(alicePage.locator('#portfolio-goals').getByText(privateGoal, { exact: true })).toBeVisible()
      await expect(alicePage.locator('#portfolio-goals').getByText(publicGoal, { exact: true })).toBeVisible()
      for (const viewer of [bobPage, observer]) {
        const response = await viewer.goto(`/u/${alice.handle}`)
        expect(response?.status()).toBe(200)
        await expect(viewer.locator('#portfolio-goals').getByText(publicGoal, { exact: true })).toBeVisible()
        const html = await response!.text()
        for (const withheld of [privateGoal, privateDescription, logSummary, updatedSummary, wins, blockers]) {
          expect(html).not.toContain(withheld)
          await expect(viewer.getByText(withheld, { exact: true })).toHaveCount(0)
        }
      }
      const goalsResponse = await bobPage.goto('/goals')
      expect(goalsResponse?.status()).toBe(200)
      await expect(bobPage.getByRole('heading', { level: 1, name: 'Goals', exact: true })).toBeVisible()
      expect(await goalsResponse!.text()).not.toContain(privateGoal)
      await expect(bobPage.getByText(publicGoal, { exact: true })).toHaveCount(0)
      const logResponse = await bobPage.goto('/log')
      expect(logResponse?.status()).toBe(200)
      await expect(bobPage.getByRole('heading', { level: 1, name: 'Study log', exact: true })).toBeVisible()
      expect(await logResponse!.text()).not.toContain(updatedSummary)
      await expect(bobPage.getByRole('textbox', { name: 'What you did', exact: true })).toHaveValue('')
      await expect(bobPage.getByText(updatedSummary, { exact: true })).toHaveCount(0)
    })
    const eventTitle = `Core campus one-place event ${suffix}`
    let eventPath: string
    await test.step('create a future public event with a real UTC wall-clock choice', async () => {
      const starts = new Date(Date.now() + 7 * 86_400_000)
      starts.setUTCMinutes(0, 0, 0)
      const ends = new Date(starts.getTime() + 90 * 60_000)
      await alicePage.goto('/events/new')
      await alicePage.getByLabel(/^Title/).fill(eventTitle)
      await alicePage.getByRole('textbox', { name: 'Description', exact: true }).fill('Synthetic two-student workshop with one available place.')
      await alicePage.getByLabel(/^Kind of event/).selectOption('workshop')
      await alicePage.getByLabel(/^How to attend/).selectOption('onsite')
      await alicePage.getByLabel(/^Time zone/).selectOption('UTC')
      await alicePage.getByRole('spinbutton', { name: 'Capacity', exact: true }).fill('1')
      await alicePage.getByLabel(/^Starts/).fill(starts.toISOString().slice(0, 16))
      await alicePage.getByLabel(/^Ends/).fill(ends.toISOString().slice(0, 16))
      await alicePage.getByRole('textbox', { name: 'Where', exact: true }).fill('Synthetic campus room A')
      await alicePage.getByRole('combobox', { name: 'Who can see it', exact: true }).selectOption('public')
      await submit(alicePage, alicePage.getByRole('button', { name: 'Create the event', exact: true }), async () => {
        await expect(alicePage).toHaveURL((url) => /^\/events\/[^/]+$/.test(url.pathname) && url.searchParams.get('created') === '1')
        await expect(alicePage.getByText('The event is on the calendar', { exact: true })).toBeVisible()
      })
      await expect(alicePage).toHaveURL((url) => /^\/events\/[^/]+$/.test(url.pathname) && url.searchParams.get('created') === '1')
      eventPath = new URL(alicePage.url()).pathname
      await expect(alicePage.getByText('The event is on the calendar', { exact: true })).toBeVisible()
      await expect(section(alicePage, 'Your answer').getByRole('button', { name: 'Going', exact: true })).toBeVisible()
    })
    await test.step('a filled place rejects an already-open control; cancellation releases it; interested does not take it', async () => {
      await bobPage.goto(eventPath)
      const bobAnswer = section(bobPage, 'Your answer')
      const aliceAnswer = section(alicePage, 'Your answer')
      await submit(bobPage, bobAnswer.getByRole('button', { name: 'Going', exact: true }),
        () => expect(bobAnswer.getByText('You are down as going. That takes one of the places.', { exact: true })).toBeVisible())
      await expect(bobAnswer.getByText('You are down as going. That takes one of the places.', { exact: true })).toBeVisible()
      await bobPage.reload()
      await expect(section(bobPage, 'Who is going').getByRole('link', { name: bob.displayName, exact: true })).toBeVisible()
      // Alice has not reloaded since creation: submit the genuine stale control.
      await submit(alicePage, aliceAnswer.getByRole('button', { name: 'Going', exact: true }),
        () => expect(aliceAnswer.getByRole('alert').filter({ hasText: 'Every place is taken' })).toBeVisible())
      await expect(aliceAnswer.getByRole('alert').filter({ hasText: 'Every place is taken' })).toBeVisible()
      await expect(aliceAnswer.getByRole('button', { name: 'Cancel my answer', exact: true })).toHaveCount(0)
      await alicePage.reload()
      await expect(aliceAnswer.getByRole('button', { name: 'Mark me interested instead', exact: true })).toBeVisible()
      await expect(section(alicePage, 'Who is going').getByRole('link', { name: bob.displayName, exact: true })).toBeVisible()
      await expect(section(alicePage, 'Who is going').getByRole('link', { name: alice.displayName, exact: true })).toHaveCount(0)
      await submit(bobPage, bobAnswer.getByRole('button', { name: 'Cancel my answer', exact: true }),
        () => expect(bobAnswer.getByRole('button', { name: 'Cancel my answer', exact: true })).toHaveCount(0))
      await expect(bobAnswer.getByRole('button', { name: 'Cancel my answer', exact: true })).toHaveCount(0)
      await alicePage.reload()
      await submit(alicePage, aliceAnswer.getByRole('button', { name: 'Going', exact: true }),
        () => expect(aliceAnswer.getByText('You are down as going. That takes one of the places.', { exact: true })).toBeVisible())
      await expect(aliceAnswer.getByText('You are down as going. That takes one of the places.', { exact: true })).toBeVisible()
      await bobPage.reload()
      await submit(bobPage, bobAnswer.getByRole('button', { name: 'Mark me interested instead', exact: true }),
        () => expect(bobAnswer.getByText('You are down as interested. That does not take a place.', { exact: true })).toBeVisible())
      await expect(bobAnswer.getByText('You are down as interested. That does not take a place.', { exact: true })).toBeVisible()
      await submit(bobPage, bobAnswer.getByRole('button', { name: 'Switch to going', exact: true }),
        () => expect(bobAnswer.getByRole('alert').filter({ hasText: 'Every place is taken' })).toBeVisible())
      await expect(bobAnswer.getByRole('alert').filter({ hasText: 'Every place is taken' })).toBeVisible()
      await bobPage.reload()
      await expect(bobAnswer.getByText('You are down as interested. That does not take a place.', { exact: true })).toBeVisible()
      const attendees = section(bobPage, 'Who is going')
      await expect(attendees.getByRole('link', { name: alice.displayName, exact: true })).toBeVisible()
      await expect(attendees.getByRole('link', { name: bob.displayName, exact: true })).toHaveCount(0)
    })
    await test.step('report a readable peer event, retain a real receipt, refuse a duplicate and hide report detail from the host', async () => {
      const detail = `Core private event report detail ${suffix}`
      await bobPage.getByRole('button', { name: 'Report event', exact: true }).click()
      const dialog = bobPage.getByRole('dialog', { name: 'Report this event', exact: true })
      await expect(dialog).toBeVisible()
      const targetId = await dialog.locator('input[name="targetId"]').inputValue() // Read, never replace.
      await dialog.getByRole('radio', { name: 'Something else', exact: true }).check()
      await dialog.getByLabel(/^Anything else a moderator should know/).fill(detail)
      await submit(bobPage, dialog.getByRole('button', { name: 'Send report', exact: true }),
        () => expect(dialog.getByText('Report received', { exact: true })).toBeVisible())
      await expect(dialog.getByText('Report received', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: /^Close$/ }).click()
      await bobPage.reload()
      // There is no reporter receipt-list page. Inspect only the already committed
      // synthetic store; do not manufacture a report or staff review.
      const reports = (await readFixture()).reports?.filter((row) =>
        row.event_id === targetId && row.reporter_id === bob.profileId) ?? []
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        event_id: targetId, reporter_id: bob.profileId, status: 'open',
        reason: 'Something else', detail,
        post_id: null, comment_id: null, project_id: null, idea_id: null,
        message_id: null, reported_profile_id: null, opportunity_id: null,
      })
      await bobPage.getByRole('button', { name: 'Report event', exact: true }).click()
      await dialog.getByRole('radio', { name: 'Something else', exact: true }).check()
      await submit(bobPage, dialog.getByRole('button', { name: 'Send report', exact: true }),
        () => expect(dialog.getByRole('alert')).toContainText('You have already reported this.'))
      await expect(dialog.getByRole('alert')).toContainText('You have already reported this.')
      expect((await readFixture()).reports?.filter((row) =>
        row.event_id === targetId && row.reporter_id === bob.profileId)).toHaveLength(1)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      const hostResponse = await alicePage.reload()
      expect(hostResponse?.status()).toBe(200)
      expect(await hostResponse!.text()).not.toContain(detail)
      await expect(alicePage.getByText(detail, { exact: true })).toHaveCount(0)
    })
  })
})

import {
  test, expect, type APIResponse, type Browser, type BrowserContext,
  type Locator, type Page, type TestInfo,
} from '@playwright/test'
import { completeAction } from './helpers/complete-action'
import { finiteJsonResponse } from './helpers/finite-json-response'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

/**
 * LOCAL acceptance only: Windows/D-drive or an explicit Linux CI/temp task
 * root. No store seeds, auth bypass, owner files, reused server or provider
 * calls. The per-spec runner provisions the fresh run and empty fixture/media.
 * Successful writes use the real server; only the last UI refusal step injects
 * responses. This is raster normalization coverage, not attachment scanning.
 */
const recoveryRoot = 'D:/All tasks + Automations/Bulla-Recovery'
// The runner launches from its checkout. assertHarness also checks the actual
// spec/config paths, so neither a drive literal nor ESM-only import.meta is needed.
const repositoryRoot = path.resolve(process.cwd())
const configPath = path.join(repositoryRoot, 'playwright.config.mts')
const specPath = path.join(repositoryRoot, 'tests', 'e2e', 'private-images.spec.ts')
const inputLimit = 5 * 1024 * 1024
const dimensions = { width: 32, height: 24 }
const metadataMarker = 'synthetic-private-image-metadata-only'
const imageId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const coverEndpoint = /^\/api\/uploads\/projects\/prj_[a-z0-9]+\/cover$/
const clientRefusal = 'Choose a PNG, JPEG or static WebP image, 5 MiB or smaller.'
type Kind = 'avatar' | 'project-cover'
type ImageRecord = {
  id: string; url: string; kind: Kind; width: number; height: number
  bytes: number; contentType: 'image/webp'
}
type Audit = { unsafe: string[]; uploadPosts: string[]; pageErrors: string[] }

function samePath(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function atOrInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function inside(root: string, target: string) {
  if (samePath(root, target) || !atOrInside(root, target)) {
    throw new Error('Private-image fixtures and artifacts must stay inside their exact fresh isolated task run.')
  }
}

function configuredTaskRoot() {
  const configured = process.env.BULLA_E2E_ARTIFACT_DIR
  if (!['win32', 'linux'].includes(process.platform) || !configured || !path.isAbsolute(configured)) {
    throw new Error('Use an explicit dedicated task artifact root: D-drive recovery on Windows or a configured Linux CI/temp directory.')
  }
  const root = path.resolve(configured)
  // The explicit root is the runner's dedicated per-spec parent, not a broad
  // home/temp/checkout directory. Do not require /tmp ancestry: runner.temp may
  // be /home/runner/work/_temp and is not forwarded to the Playwright child.
  if ([path.parse(root).root, os.homedir(), os.tmpdir(), repositoryRoot]
    .some((protectedRoot) => atOrInside(root, protectedRoot)) || atOrInside(repositoryRoot, root)) {
    throw new Error('Private-image artifacts require a dedicated directory outside the checkout, never a broad home or temp root.')
  }
  if (process.platform === 'win32') inside(recoveryRoot, root)
  return root
}

function loopbackOrigin(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || url.port === '3000' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Private-image acceptance requires an explicit loopback test port, never owner port 3000.')
  }
  return url.origin
}

// Collection-time fences, repeated against the resolved harness below.
const origin = loopbackOrigin(process.env.BULLA_E2E_BASE_URL || 'http://127.0.0.1:3301')
const taskRoot = configuredTaskRoot()
const runId = process.env.BULLA_E2E_RUN_ID
if (!runId || !/^[a-zA-Z0-9-]{1,128}$/.test(runId) ||
    process.env.BULLA_E2E_USE_RUNNING_SERVER === '1') {
  throw new Error('Use the fresh per-spec Playwright harness with a new run ID; server reuse is forbidden.')
}
const runRoot = path.resolve(taskRoot, runId)
inside(taskRoot, runRoot)
if (process.platform === 'win32') inside(recoveryRoot, runRoot)
const fixtureRoot = path.join(runRoot, 'fixture')
const storePath = path.join(fixtureRoot, 'local.json')
const inputRoot = path.join(fixtureRoot, 'private-images-inputs')
// An explicit value also prevents Next's .env files from selecting an owner
// media directory when the harness has isolated only LOCAL_DATA_PATH.
const configuredMediaRoot = process.env.BULLA_LOCAL_MEDIA_ROOT
if (!configuredMediaRoot || !path.isAbsolute(configuredMediaRoot)) {
  throw new Error('The runner must set BULLA_LOCAL_MEDIA_ROOT to the absolute fixture/media directory in this fresh run.')
}
const mediaRoot = path.resolve(configuredMediaRoot)
inside(runRoot, mediaRoot)
if (!samePath(mediaRoot, path.join(fixtureRoot, 'media')) ||
    atOrInside(mediaRoot, storePath) || atOrInside(mediaRoot, inputRoot) || atOrInside(inputRoot, mediaRoot)) {
  throw new Error('Only this fresh run\'s exact fixture/media directory is allowed; never datastore or input directories.')
}

/** Check every existing ancestor BEFORE mkdir can follow a junction/symlink. */
async function plainDirectoryPath(target: string) {
  const absolute = path.resolve(target)
  const directories: string[] = []
  for (let current = absolute; ; current = path.dirname(current)) {
    directories.unshift(current)
    if (current === path.dirname(current)) break
  }
  for (const directory of directories) {
    let stat
    try { stat = await fs.lstat(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(directory, await fs.realpath(directory))) {
      throw new Error('Refusing a linked or non-directory private-image fixture ancestor.')
    }
  }
}

async function requireAbsentRuntimePath(target: string) {
  try { await fs.lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('This spec requires an initially absent datastore and no stale lock; never reuse or clear existing runtime data.')
}

async function requireEmptyMediaDirectory() {
  await plainDirectoryPath(mediaRoot)
  const before = await fs.lstat(mediaRoot) // ENOENT also refuses a missing runner fixture.
  if (!before.isDirectory() || before.isSymbolicLink() ||
      !samePath(mediaRoot, await fs.realpath(mediaRoot))) {
    throw new Error('The runner media fixture must be an existing ordinary directory with a matching real path.')
  }
  const entries = await fs.readdir(mediaRoot)
  const after = await fs.lstat(mediaRoot)
  await plainDirectoryPath(mediaRoot)
  if (entries.length !== 0 || !after.isDirectory() || after.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      !samePath(mediaRoot, await fs.realpath(mediaRoot))) {
    throw new Error('This spec accepts only an unchanged empty media fixture; never reuse, overwrite or reset media.')
  }
}

async function assertHarness(baseURL: string | undefined, info: TestInfo) {
  const server = info.config.webServer
  if (!baseURL || loopbackOrigin(baseURL) !== origin ||
      info.config.workers !== 1 || info.retry !== 0 ||
      !server || server.reuseExistingServer !== false || !server.url ||
      loopbackOrigin(server.url) !== origin ||
      server.command !== `npm run dev -- --hostname 127.0.0.1 --port ${new URL(origin).port}` ||
      !info.config.configFile ||
      !samePath(info.config.configFile, configPath) || !samePath(info.file, specPath)) {
    throw new Error('Run only the existing isolated harness, one worker, zero retries, with no running-server reuse.')
  }
  const env = server.env
  if (!env || env.NEXT_PUBLIC_DATA_MODE !== 'local' ||
      !env.LOCAL_DATA_PATH || !samePath(env.LOCAL_DATA_PATH, storePath) ||
      env.NEXT_PUBLIC_SITE_URL !== origin ||
      ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
        .some((key) => env[key] !== '') ||
      !env.BULLA_LOCAL_MEDIA_ROOT || !samePath(env.BULLA_LOCAL_MEDIA_ROOT, mediaRoot)) {
    throw new Error('The harness must use only its isolated datastore/media root and explicitly blank cloud keys.')
  }
  inside(runRoot, info.project.outputDir)
  inside(runRoot, info.outputDir)
  await plainDirectoryPath(repositoryRoot)
  await plainDirectoryPath(taskRoot)
  await plainDirectoryPath(fixtureRoot)
  await plainDirectoryPath(inputRoot)
  await plainDirectoryPath(info.outputDir)
  // Current readStore() returns EMPTY on ENOENT without persisting a file.
  // Before real signup there must be no existing data for tests to mutate.
  await requireAbsentRuntimePath(storePath)
  await requireAbsentRuntimePath(`${storePath}.lock`)
  // The runner already creates fixture/media. Inspect it; never mkdir/reset it.
  await requireEmptyMediaDirectory()
  // Never overwrite inputs or silently rerun this spec in an already used run.
  const marker = await fs.open(path.join(fixtureRoot, 'private-images-spec.marker'), 'wx', 0o600)
  await marker.close()
  await fs.mkdir(inputRoot, { mode: 0o700 })
  await plainDirectoryPath(inputRoot)
}

/** A tiny deterministic RGB PNG built without sharp/native fixture generation. */
function syntheticPng() {
  function chunk(type: string, data: Buffer) {
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data])
    let crc = 0xffffffff
    for (const byte of payload) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length, 0)
    payload.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(dimensions.width, 0)
  header.writeUInt32BE(dimensions.height, 4)
  header[8] = 8
  header[9] = 2 // RGB, no animation or exotic decoder.
  const stride = 1 + dimensions.width * 3
  const pixels = Buffer.alloc(stride * dimensions.height)
  for (let y = 0; y < dimensions.height; y++) {
    for (let x = 0; x < dimensions.width; x++) {
      const offset = y * stride + 1 + x * 3
      pixels[offset] = x * 7
      pixels[offset + 1] = y * 9
      pixels[offset + 2] = 96
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`fixture-note\0${metadataMarker}`, 'utf8')),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function syntheticFixtures() {
  const png = syntheticPng()
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>')
  const oversize = Buffer.alloc(inputLimit + 1)
  png.copy(oversize)
  expect(png.length).toBeLessThan(4096)
  expect(svg.length).toBeLessThan(4096)
  expect(oversize.length).toBe(inputLimit + 1)
  const files = { png: 'bounded-rgb.png', svg: 'rejected-vector.svg', oversize: 'over-budget.png' }
  for (const [name, data] of [['png', png], ['svg', svg], ['oversize', oversize]] as const) {
    const target = path.join(inputRoot, files[name])
    inside(inputRoot, target)
    const file = await fs.open(target, 'wx', 0o600)
    try { await file.writeFile(data) } finally { await file.close() }
    const stat = await fs.lstat(target)
    expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true)
    expect(stat.size).toBe(data.length)
    expect(samePath(target, await fs.realpath(target))).toBe(true)
  }
  return {
    png, svg, oversize,
    pngPath: path.join(inputRoot, files.png),
    svgPath: path.join(inputRoot, files.svg),
    oversizePath: path.join(inputRoot, files.oversize),
  }
}

function unsafeMediaPath(url: URL) {
  return url.pathname.startsWith('/storage/') || url.pathname.includes('bulla-private-images') ||
    (url.pathname === '/_next/image' && /\/api\/images\/|\/storage\//.test(url.searchParams.get('url') || ''))
}

async function freshContext(browser: Browser, audit: Audit, owned: BrowserContext[]) {
  const context = await browser.newContext({
    baseURL: origin, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block',
    viewport: { width: 1440, height: 960 },
  })
  owned.push(context) // Register before routing/assertions so failures still close it.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || unsafeMediaPath(url)) {
      // Omit query strings/bearer tokens even from attempted requests.
      audit.unsafe.push(`${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  await context.routeWebSocket(/.*/, async (socket) => {
    const url = new URL(socket.url())
    const allowed = new URL(origin)
    if (url.protocol !== 'ws:' || url.host !== allowed.host || url.username || url.password) {
      audit.unsafe.push(`${url.protocol}//${url.host}${url.pathname}`)
      await socket.close()
      return
    }
    socket.connectToServer() // Only same-origin local Next HMR.
  })
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.startsWith('/api/uploads/')) {
      audit.uploadPosts.push(url.pathname)
    }
  })
  context.on('page', (page) => page.on('pageerror', (error) => audit.pageErrors.push(error.message)))
  expect(await context.cookies()).toEqual([])
  return context
}

function apiURL(endpoint: string) {
  const url = new URL(endpoint, origin)
  if (!endpoint.startsWith('/api/') || url.origin !== origin || url.search || url.hash || unsafeMediaPath(url)) {
    throw new Error('Private-image API checks must stay on the isolated same-origin guarded routes.')
  }
  return url.href
}

function privateHeaders(headers: Record<string, string>) {
  expect(headers['cache-control']).toContain('private')
  expect(headers['cache-control']).toContain('no-store')
  expect(headers.vary.toLowerCase()).toContain('cookie')
  expect(headers.vary.toLowerCase()).toContain('authorization')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers.location).toBeUndefined()
}

function imageRecord(value: unknown, kind: Kind): ImageRecord {
  expect(value).toBeTruthy()
  const image = value as ImageRecord
  expect(image.id).toMatch(imageId)
  expect(image.url).toBe(`/api/images/${image.id}`)
  expect(image.kind).toBe(kind)
  expect(image.contentType).toBe('image/webp')
  for (const number of [image.width, image.height, image.bytes]) {
    expect(Number.isSafeInteger(number)).toBe(true)
    expect(number).toBeGreaterThan(0)
  }
  expect(image.width).toBeLessThanOrEqual(kind === 'avatar' ? 512 : 1600)
  expect(image.height).toBeLessThanOrEqual(kind === 'avatar' ? 512 : 900)
  expect(image.bytes).toBeLessThanOrEqual(kind === 'avatar' ? 512 * 1024 : 2 * 1024 * 1024)
  return image
}

async function currentImage(context: BrowserContext, endpoint: string, kind: Kind) {
  const response = await context.request.get(apiURL(endpoint), { maxRedirects: 0 })
  try {
    expect(response.status()).toBe(200)
    privateHeaders(response.headers())
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.limits.inputBytes).toBe(inputLimit)
    return body.image === null ? null : imageRecord(body.image, kind)
  } finally { await response.dispose() }
}

async function expectFailure(response: APIResponse, status: number, code: string) {
  try {
    expect(response.status()).toBe(status)
    privateHeaders(response.headers())
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(code)
    expect(body.image).toBeUndefined()
  } finally { await response.dispose() }
}

async function postImage(context: BrowserContext, endpoint: string, data: Buffer, contentType: string) {
  expect(data.length).toBeLessThanOrEqual(inputLimit + 1)
  return context.request.post(apiURL(endpoint), {
    headers: { Origin: origin, 'Content-Type': contentType, 'Sec-Fetch-Site': 'same-origin' },
    data, maxRedirects: 0,
  })
}

async function expectWebP(context: BrowserContext, image: ImageRecord) {
  const response = await context.request.get(apiURL(image.url), { maxRedirects: 0 })
  try {
    expect(response.status()).toBe(200)
    privateHeaders(response.headers())
    expect(response.headers()['content-type']).toBe('image/webp')
    const bytes = await response.body()
    expect(bytes.length).toBe(image.bytes)
    expect(Number(response.headers()['content-length'])).toBe(bytes.length)
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length)
    expect(bytes.includes(Buffer.from(metadataMarker))).toBe(false)
  } finally { await response.dispose() }
}

async function decode(image: Locator, saved: ImageRecord) {
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', saved.url)
  await expect(image).not.toHaveAttribute('srcset', /.+/)
  await expect.poll(async () => {
    try {
      return await image.evaluate(async (element) => {
        const native = element as HTMLImageElement
        await native.decode()
        return { width: native.naturalWidth, height: native.naturalHeight }
      })
    } catch { return null } // router.refresh() can replace a decoding element.
  }).toEqual({ width: saved.width, height: saved.height })
  expect({ width: saved.width, height: saved.height }).toEqual(dimensions)
}

function imageControl(page: Page, label: string) {
  const input = page.getByLabel(label, { exact: true })
  const root = page.locator('div[aria-busy]').filter({ has: input })
  return {
    input, root, button: root.getByRole('button', { name: 'Upload image', exact: true }),
    preview: root.getByRole('img', { name: `Current ${label.toLowerCase()}`, exact: true }),
  }
}

async function openProjectSettings(page: Page) {
  await page.getByRole('tab', { name: 'Seeking members', exact: true }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'settings')
  await expect(page.getByRole('tab', { name: 'Seeking members', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Seeking members', exact: true })).toBeVisible()
}

async function submitAction(page: Page, button: Locator, outcome: () => Promise<unknown>) {
  const response = await completeAction(page, button, outcome)
  expect(new URL(response.url()).origin).toBe(origin)
  expect(response.status()).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(400)
  return response
}

async function signup(page: Page, handle: string, displayName: string) {
  await page.goto('/signup')
  await page.getByRole('textbox', { name: 'Your name (required)', exact: true }).fill(displayName)
  await page.getByRole('textbox', { name: 'Email address (required)', exact: true }).fill(`${handle}@example.test`)
  await page.getByLabel(/^Password/).fill(`Image-${randomBytes(24).toString('base64url')}-9Aa!`)
  await page.getByRole('checkbox', { name: /^I agree to the/ }).check()
  await submitAction(page, page.getByRole('button', { name: 'Create account', exact: true }),
    () => expect(page).toHaveURL((url) => url.pathname === '/onboarding'))
  await expect(page).toHaveURL((url) => url.pathname === '/onboarding')
  await expect(page.getByLabel(/^Who can see your profile/)).toHaveValue('private')
  await page.getByLabel(/^Choose a username/).fill(handle)
  // Retain the real private default; never publish a profile to simplify reads.
  await submitAction(page, page.getByRole('button', { name: 'Finish and go to my profile', exact: true }), async () => {
    await expect(page).toHaveURL((url) => url.pathname === '/me')
    await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
  })
  await expect(page).toHaveURL((url) => url.pathname === '/me')
  const cookie = (await page.context().cookies()).find((row) => row.name === 'quad_local_session')
  expect(cookie?.httpOnly).toBe(true)
  expect(Boolean(cookie?.value)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: displayName, exact: true })).toBeVisible()
}

async function uploadControl(page: Page, label: string, kind: Kind, file: string, endpoint: string, audit: Audit) {
  const control = imageControl(page, label)
  await expect(control.input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp')
  await expect(control.button).toHaveAttribute('type', 'button')
  await expect(control.preview).toHaveCount(0)
  await control.input.setInputFiles(file)
  await expect(control.button).toBeEnabled()
  await expect(control.preview).toHaveCount(0) // Selection is not a saved image.
  const postsBefore = audit.uploadPosts.length
  // Fetch this original POST once, capture its finite real response before
  // unchanged delivery, and let the actual onUploaded/router.refresh run.
  const { response, body, upstream, request } = await finiteJsonResponse(
    page, apiURL(endpoint), () => control.button.click({ timeout: 40_000 }),
  )
  expect(response.status()).toBe(201)
  expect(upstream.status).toBe(201)
  expect(upstream.url).toBe(apiURL(endpoint))
  privateHeaders(upstream.headers)
  privateHeaders(response.headers())
  expect(upstream.headers['content-type']).toMatch(/^application\/json(?:;|$)/)
  expect(response.headers()['content-type']).toMatch(/^application\/json(?:;|$)/)
  expect(request.headers.origin).toBe(origin)
  expect(request.headers['content-type']).toBe('image/png')
  expect(/(?:^|;\s*)quad_local_session=/.test(request.headers.cookie || '')).toBe(true)
  expect(request.bytes?.equals(await fs.readFile(file))).toBe(true)
  expect(body).not.toBeNull()
  expect(typeof body).toBe('object')
  expect(Array.isArray(body)).toBe(false)
  const envelope = body as Record<string, unknown>
  expect(envelope.ok).toBe(true)
  const image = imageRecord(envelope.image, kind)
  const actualEndpoint = new URL(response.url()).pathname
  expect(actualEndpoint).toBe(endpoint)
  apiURL(actualEndpoint)
  await decode(control.preview, image)
  await expect(control.root).toHaveAttribute('aria-busy', 'false')
  await expect(control.button).toBeDisabled()
  expect(await control.input.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0)
  expect(audit.uploadPosts.slice(postsBefore)).toEqual([endpoint])
  // ManagedImageControl may remount after router.refresh(), clearing the receipt.
  // The real 201, decoded private preview and persisted association are the proof.
  return { image, endpoint: actualEndpoint }
}

test('isolated private avatar/cover uploads persist, reject unsafe input and deny the other account', async ({ browser, baseURL }, info) => {
  test.setTimeout(300_000)
  await assertHarness(baseURL, info)
  const fixture = await syntheticFixtures()
  const audit: Audit = { unsafe: [], uploadPosts: [], pageErrors: [] }
  const contexts: BrowserContext[] = []
  try {
    for (let index = 0; index < 3; index++) await freshContext(browser, audit, contexts)
    const [ownerContext, neighborContext, signedOutContext] = contexts
    const ownerPage = await ownerContext.newPage()
    const neighborPage = await neighborContext.newPage()
    const suffix = randomBytes(6).toString('hex')
    const ownerHandle = `image_owner_${suffix}`
    const neighborHandle = `image_peer_${suffix}`
    const ownerName = `Private Image Owner ${suffix}`
    const projectTitle = `Private image project ${suffix}`

    await test.step('two new private accounts establish genuine isolated signup/session cookies', async () => {
      await ownerPage.goto('/me/edit')
      await expect(ownerPage).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('next') === '/me/edit')
      expect((await ownerContext.cookies()).some((row) => row.name === 'quad_local_session')).toBe(false)
      await signup(ownerPage, ownerHandle, ownerName)
      await signup(neighborPage, neighborHandle, `Private Image Peer ${suffix}`)
      const ownerCookie = (await ownerContext.cookies()).find((row) => row.name === 'quad_local_session')!
      const peerCookie = (await neighborContext.cookies()).find((row) => row.name === 'quad_local_session')!
      expect(ownerCookie.value === peerCookie.value).toBe(false)
      expect(await signedOutContext.cookies()).toEqual([])
    })

    await ownerPage.goto('/me/edit')
    await expect(ownerPage.getByLabel('Profile visibility', { exact: true })).toHaveValue('private')
    expect(await currentImage(ownerContext, '/api/uploads/avatar', 'avatar')).toBeNull()
    const avatar = await uploadControl(ownerPage, 'Profile image', 'avatar', fixture.pngPath, '/api/uploads/avatar', audit)
    await test.step('a committed avatar survives reload and is a decoded, private/no-store WebP', async () => {
      expect(await currentImage(ownerContext, avatar.endpoint, 'avatar')).toEqual(avatar.image)
      await expectWebP(ownerContext, avatar.image)
      await ownerPage.reload()
      await decode(imageControl(ownerPage, 'Profile image').preview, avatar.image)
      await ownerPage.goto('/me')
      await decode(ownerPage.locator(`img[src="${avatar.image.url}"]`).first(), avatar.image)
      await ownerPage.screenshot({ path: info.outputPath('private-avatar-after-reload.png'), fullPage: true })
    })

    await test.step('create a real owner project; the private profile clamps its visibility', async () => {
      await ownerPage.goto('/projects/new')
      await ownerPage.getByLabel(/^Title/).fill(projectTitle)
      await ownerPage.getByRole('textbox', { name: 'One-line purpose', exact: true })
        .fill('Synthetic bounded image acceptance; no owner files.')
      const visibility = ownerPage.getByRole('combobox', { name: 'Who can see it', exact: true })
      await expect(visibility).toBeVisible()
      await expect(visibility).toHaveValue('private')
      await visibility.selectOption('public')
      await expect(visibility).toHaveValue('public')
      await submitAction(ownerPage, ownerPage.getByRole('button', { name: 'Create project', exact: true }), async () => {
        await expect(ownerPage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) &&
          url.searchParams.get('welcome') === '1' && url.searchParams.get('clamped') === '1')
        await expect(ownerPage.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toBeVisible()
        await expect(ownerPage.locator('header').getByText('Only me', { exact: true })).toBeVisible()
      })
      await expect(ownerPage).toHaveURL((url) => /^\/projects\/[^/]+$/.test(url.pathname) &&
        url.searchParams.get('welcome') === '1' && url.searchParams.get('clamped') === '1')
      await expect(ownerPage.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toBeVisible()
      await expect(ownerPage.locator('header').getByText('Only me', { exact: true })).toBeVisible()
    })
    const projectPath = new URL(ownerPage.url()).pathname
    await openProjectSettings(ownerPage)
    // The existing project Star form carries the current project's exact ID.
    // Do not intercept a wildcard cover endpoint for some other association.
    const starForm = ownerPage.locator('form').filter({
      has: ownerPage.getByRole('button', { name: /^(?:Star|Starred)$/ }),
    })
    await expect(starForm).toHaveCount(1)
    const projectId = await starForm.locator('input[type="hidden"][name="projectId"]').inputValue()
    expect(projectId).toMatch(/^prj_[a-z0-9]+$/)
    const cover = await uploadControl(ownerPage, 'Project cover', 'project-cover', fixture.pngPath,
      `/api/uploads/projects/${projectId}/cover`, audit)
    expect(cover.endpoint).toMatch(coverEndpoint)
    expect(cover.image.id).not.toBe(avatar.image.id)
    await test.step('the cover persists in manager controls and the authorized project detail', async () => {
      expect(await currentImage(ownerContext, cover.endpoint, 'project-cover')).toEqual(cover.image)
      await expectWebP(ownerContext, cover.image)
      await ownerPage.reload()
      await decode(ownerPage.getByRole('img', { name: `${projectTitle} cover`, exact: true }), cover.image)
      await openProjectSettings(ownerPage)
      await decode(imageControl(ownerPage, 'Project cover').preview, cover.image)
      await ownerPage.screenshot({ path: info.outputPath('private-cover-after-reload.png'), fullPage: true })
    })

    await neighborPage.goto('/me/edit')
    expect(await currentImage(neighborContext, '/api/uploads/avatar', 'avatar')).toBeNull()
    const peerAvatar = await uploadControl(neighborPage, 'Profile image', 'avatar', fixture.pngPath, '/api/uploads/avatar', audit)
    await expectWebP(neighborContext, peerAvatar.image)
    await test.step('signed-in neighbor and anonymous requests cannot read or replace private owner images', async () => {
      for (const context of [neighborContext, signedOutContext]) {
        for (const saved of [avatar.image, cover.image]) {
          await expectFailure(await context.request.get(apiURL(saved.url), { maxRedirects: 0 }), 404, 'image_not_found')
          const head = await context.request.head(apiURL(saved.url), { maxRedirects: 0 })
          try {
            expect(head.status()).toBe(404)
            privateHeaders(head.headers())
            expect(await head.body()).toHaveLength(0)
          } finally { await head.dispose() }
        }
      }
      await expectFailure(await ownerContext.request.get(apiURL(peerAvatar.image.url), { maxRedirects: 0 }), 404, 'image_not_found')
      await expectFailure(await postImage(neighborContext, cover.endpoint, fixture.png, 'image/png'), 403, 'upload_denied')
      await expectFailure(await neighborContext.request.get(apiURL(cover.endpoint), { maxRedirects: 0 }), 403, 'upload_denied')
      await expectFailure(await postImage(signedOutContext, avatar.endpoint, fixture.png, 'image/png'), 401, 'sign_in_required')
      expect(await currentImage(ownerContext, cover.endpoint, 'project-cover')).toEqual(cover.image)
      expect(await currentImage(neighborContext, peerAvatar.endpoint, 'avatar')).toEqual(peerAvatar.image)
      const profileResponse = await neighborPage.goto(`/u/${ownerHandle}`)
      await expect(neighborPage.getByRole('heading', { level: 1, name: ownerName, exact: true })).toHaveCount(0)
      expect(await profileResponse!.text()).not.toContain(avatar.image.url)
      const projectResponse = await neighborPage.goto(projectPath)
      await expect(neighborPage.getByRole('heading', { level: 1, name: projectTitle, exact: true })).toHaveCount(0)
      await expect(neighborPage.getByLabel('Project cover', { exact: true })).toHaveCount(0)
      expect(await projectResponse!.text()).not.toContain(cover.image.url)
      // Native browser delivery is denied too, not merely a management GET.
      expect(await neighborPage.evaluate(async (url) => {
        const image = new Image()
        image.src = url
        try { await image.decode(); return false } catch { return true }
      }, cover.image.url)).toBe(true)
    })

    for (const target of [
      { label: 'Profile image', saved: avatar.image, endpoint: avatar.endpoint, pagePath: '/me/edit' },
      { label: 'Project cover', saved: cover.image, endpoint: cover.endpoint, pagePath: projectPath },
    ]) {
      await test.step(`${target.label}: client and real server rejections preserve the committed image`, async () => {
        await ownerPage.goto(target.pagePath)
        if (target.saved.kind === 'project-cover') {
          await openProjectSettings(ownerPage)
        }
        const control = imageControl(ownerPage, target.label)
        await decode(control.preview, target.saved)
        for (const file of [fixture.svgPath, fixture.oversizePath]) {
          const postsBefore = audit.uploadPosts.length
          await control.input.setInputFiles(file)
          await expect(control.root.getByRole('alert')).toHaveText(clientRefusal)
          await expect(control.input).toHaveAttribute('aria-invalid', 'true')
          await expect(control.button).toBeDisabled()
          await decode(control.preview, target.saved)
          expect(audit.uploadPosts.length).toBe(postsBefore)
          expect(await currentImage(ownerContext, target.endpoint, target.saved.kind)).toEqual(target.saved)
        }
        // Bypass ONLY the client picker, never auth/CSRF, to test real server guards.
        await expectFailure(await postImage(ownerContext, target.endpoint, fixture.svg, 'image/svg+xml'), 415, 'unsupported_image')
        expect(await currentImage(ownerContext, target.endpoint, target.saved.kind)).toEqual(target.saved)
        await expectFailure(await postImage(ownerContext, target.endpoint, fixture.svg, 'image/png'), 415, 'invalid_raster')
        expect(await currentImage(ownerContext, target.endpoint, target.saved.kind)).toEqual(target.saved)
        await expectFailure(await postImage(ownerContext, target.endpoint, fixture.oversize, 'image/png'), 413, 'image_too_large')
        expect(await currentImage(ownerContext, target.endpoint, target.saved.kind)).toEqual(target.saved)
        await ownerPage.reload()
        if (target.saved.kind === 'project-cover') {
          await openProjectSettings(ownerPage)
        }
        await decode(imageControl(ownerPage, target.label).preview, target.saved)
        await expectWebP(ownerContext, target.saved)
      })
    }

    await test.step('UI fault injection: a 503 or unsafe 201 cannot replace the image or trigger raw-bucket fallback', async () => {
      await ownerPage.goto('/me/edit')
      const control = imageControl(ownerPage, 'Profile image')
      for (const scenario of [
        {
          status: 503,
          body: { ok: false, error: { code: 'uploads_unavailable', message: 'Synthetic isolated storage outage.' } },
          message: 'Synthetic isolated storage outage.',
        },
        {
          status: 201,
          body: { ok: true, image: { ...avatar.image, url: '/storage/v1/object/public/bulla-private-images/unsafe.webp' } },
          message: 'The image upload could not be confirmed. Refresh before retrying.',
        },
      ]) {
        // ONLY these negative UI responses are synthetic; no provider is invoked
        // and no real success/denial/normalization response above was mocked.
        await ownerPage.route(apiURL(avatar.endpoint), async (route) => {
          expect(route.request().method()).toBe('POST')
          await route.fulfill({ status: scenario.status, contentType: 'application/json', body: JSON.stringify(scenario.body) })
        }, { times: 1 })
        await control.input.setInputFiles(fixture.pngPath)
        await expect(control.button).toBeEnabled()
        const [response] = await Promise.all([
          ownerPage.waitForResponse((candidate) => candidate.request().method() === 'POST' &&
            candidate.url() === apiURL(avatar.endpoint)),
          control.button.click(),
        ])
        expect(response.status()).toBe(scenario.status)
        await expect(control.root.getByRole('alert')).toHaveText(scenario.message)
        await expect(control.button).toBeEnabled()
        await decode(control.preview, avatar.image)
        expect(await currentImage(ownerContext, avatar.endpoint, 'avatar')).toEqual(avatar.image)
        expect(audit.unsafe).toEqual([])
      }
      await ownerPage.reload()
      await decode(imageControl(ownerPage, 'Profile image').preview, avatar.image)
      expect(await currentImage(ownerContext, cover.endpoint, 'project-cover')).toEqual(cover.image)
      expect(await currentImage(neighborContext, peerAvatar.endpoint, 'avatar')).toEqual(peerAvatar.image)
      await expectWebP(ownerContext, avatar.image)
      await expectWebP(ownerContext, cover.image)
      await expectWebP(neighborContext, peerAvatar.image)
    })
    expect(audit.pageErrors).toEqual([])
    expect(audit.unsafe).toEqual([])
  } finally {
    try {
      await info.attach('private-images-local-audit', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({
          scope: 'local-only; browser/API observations, not provider cleanup proof',
          syntheticUiResponses: [503, '201 with forbidden raw-bucket URL'],
          ...audit,
        }, null, 2)),
      })
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
    // Keep only this run's synthetic fixture/report files for main to inspect.
    // Do not delete accounts, touch real stores, clear locks or sweep media.
  }
})

import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const origin = new URL(process.env.BULLA_PREVIEW_URL || 'http://127.0.0.1:3000')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username || origin.password || origin.pathname !== '/' ||
    origin.search || origin.hash) {
  throw new Error('UI inspection must use a plain loopback origin.')
}
const taskRoot = process.env.BULLA_TASK_DIR || 'D:/All tasks + Automations/Bulla-Recovery'
if (!path.isAbsolute(taskRoot) || path.parse(taskRoot).root === path.resolve(taskRoot)) {
  throw new Error('Use an absolute, dedicated task directory.')
}
const runRoot = path.join(taskRoot, 'screenshots', `inspect-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(runRoot, { recursive: true })
const channel = process.env.BULLA_E2E_BROWSER ||
  (existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'msedge' :
    existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'chrome' : undefined)
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
const results = []
try {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
    const page = await context.newPage()
    for (const route of ['/', '/login', '/universities', '/projects', '/search']) {
      const errors = []
      const onError = error => errors.push(error.message.slice(0, 500))
      page.on('pageerror', onError)
      const response = await page.goto(new URL(route, origin).href, { waitUntil: 'networkidle', timeout: 60_000 })
      const file = `${route === '/' ? 'home' : route.slice(1)}-${viewport.width}.png`
      await page.screenshot({ path: path.join(runRoot, file), fullPage: true })
      results.push({
        route, width: viewport.width, status: response?.status(), finalPath: new URL(page.url()).pathname,
        title: await page.title(), screenshot: file, errors,
        layout: await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          headings: [...document.querySelectorAll('h1, h2')].map(element => element.textContent?.trim()).slice(0, 20),
        })),
      })
      page.off('pageerror', onError)
    }
    await context.close()
  }
  await writeFile(path.join(runRoot, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ runRoot, results }, null, 2))
} finally {
  await browser.close()
}

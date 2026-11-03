import type { ComponentProps } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const diagnostics = vi.hoisted(() => ({
  deny: vi.fn(() => { throw new Error('DIAGNOSTICS_NOT_FOUND') }),
  inspect: vi.fn(() => { throw new Error('Diagnostic data must not be read') }),
}))

vi.mock('next/navigation', () => ({ notFound: diagnostics.deny }))
vi.mock('next/link', () => ({
  default: function Link({ href, ...props }: ComponentProps<'a'>) {
    return <a href={href} {...props} />
  },
}))
vi.mock('@/lib/env', () => ({
  isSupabaseConfigured: diagnostics.inspect,
  describeEnvProblems: diagnostics.inspect,
  hasServiceRoleKey: diagnostics.inspect,
}))
vi.mock('@/lib/mode', () => ({ isLocalMode: diagnostics.inspect }))
vi.mock('@/lib/build-status', () => ({
  FEATURES: [],
  LAST_REVIEWED: 'internal-review-marker',
  STATUS_LABELS: {},
  statusCounts: diagnostics.inspect,
  featuresByArea: diagnostics.inspect,
}))
vi.mock('@/components/ui/theme-toggle', () => ({
  ThemeToggle: () => <span aria-hidden="true">Appearance</span>,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('internal diagnostics are development-only', () => {
  it.each(['production', 'test', 'unknown', undefined])(
    'refuses build and setup details when NODE_ENV is %s before inspecting data',
    async environment => {
      vi.stubEnv('NODE_ENV', environment)
      const { default: StatusPage, metadata: statusMetadata } = await import('@/app/status/page')
      const { default: SetupPage, metadata: setupMetadata } = await import('@/app/setup/page')

      expect(() => StatusPage()).toThrow('DIAGNOSTICS_NOT_FOUND')
      expect(() => SetupPage()).toThrow('DIAGNOSTICS_NOT_FOUND')
      expect(diagnostics.deny).toHaveBeenCalledTimes(2)
      expect(diagnostics.inspect).not.toHaveBeenCalled()
      expect(statusMetadata).toEqual({ robots: { index: false, follow: false } })
      expect(setupMetadata).toEqual({ robots: { index: false, follow: false } })
    },
  )

  it('allows the diagnostic guard only in explicit development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { requireDevelopmentDiagnostics } = await import('@/lib/diagnostics')
    expect(() => requireDevelopmentDiagnostics()).not.toThrow()
    expect(diagnostics.deny).not.toHaveBeenCalled()
  })
})

describe('public surfaces do not advertise the internal ledger', () => {
  it('limits diagnostic links to development tools and private-local surfaces', () => {
    const allowed = new Set([
      'app/status/page.tsx',
      'app/setup/page.tsx',
      'app/admin/data/page.tsx',
      'components/layout/local-mode-banner.tsx',
    ])
    const sourceRoot = path.resolve('src')
    const unexpected: string[] = []
    function inspectDirectory(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) inspectDirectory(file)
        else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
          const relative = path.relative(sourceRoot, file).split(path.sep).join('/')
          if (/href=["']\/(?:status|setup)["']/.test(readFileSync(file, 'utf8')) &&
              !allowed.has(relative)) unexpected.push(relative)
        }
      }
    }
    inspectDirectory(sourceRoot)
    expect(unexpected).toEqual([])
  })

  it.each([false, true])('removes the build link from the compact=%s footer', async compact => {
    const { SiteFooter } = await import('@/components/layout/site-footer')
    const { container } = render(<SiteFooter compact={compact} />)
    expect(container.querySelector('a[href="/status"], a[href="/setup"]')).toBeNull()
    expect(screen.queryByText(/build status/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('keeps the 404 useful without linking to diagnostics', async () => {
    const { default: NotFound } = await import('@/app/not-found')
    const { container } = render(<NotFound />)
    expect(container.querySelector('a[href="/status"], a[href="/setup"]')).toBeNull()
    expect(screen.queryByText(/build status/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('keeps early-preview disclosure without the implementation inventory', async () => {
    const { default: AboutPage } = await import('@/app/about/page')
    const { container } = render(<AboutPage />)
    expect(screen.getByRole('heading', { name: 'An early campus preview' })).toBeInTheDocument()
    expect(container.querySelector('a[href="/status"], a[href="/setup"]')).toBeNull()
    expect(container).not.toHaveTextContent(/database with enforced permissions|build status/i)
    expect(screen.getByRole('link', { name: 'report a bug' })).toHaveAttribute('href', '/report-a-bug')
  })

  it('labels unavailable tools without rendering internal feature notes', async () => {
    const { PlannedFeature } = await import('@/components/layout/planned-feature')
    const { container } = render(<PlannedFeature title="Coming soon" featureName="Internal feature" />)
    expect(container).toHaveTextContent('This tool is not available in this preview yet.')
    expect(container.querySelector('a[href="/status"], a[href="/setup"]')).toBeNull()
    expect(container).not.toHaveTextContent(/Current status|internal-review-marker/)
    expect(screen.getByRole('link', { name: 'Get help' })).toHaveAttribute('href', '/help')
    expect(diagnostics.inspect).not.toHaveBeenCalled()
  })
})

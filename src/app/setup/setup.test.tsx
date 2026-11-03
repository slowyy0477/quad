import type { ComponentProps } from 'react'
import { randomUUID } from 'node:crypto'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Navigation is not under test; keep this page isolated from router prefetching.
vi.mock('next/link', () => ({
  default: function Link({ href, ...props }: ComponentProps<'a'>) {
    return <a href={href} {...props} />
  },
}))

const hostedConfiguration = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://setup-provider.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: randomUUID(),
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_DATA_MODE', 'supabase')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
  vi.stubEnv('LOCAL_DATA_PATH', '')
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Setup rendering must not probe a provider.')
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function renderSetup(values: Record<string, string | undefined> = {}) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
  // env.ts validates at module scope; import only after the isolated settings.
  const { default: SetupPage } = await import('./page')
  return render(<SetupPage />)
}

function row(name: string) {
  const element = screen.getByText(name, { selector: 'p' }).closest('li')
  if (!element) throw new Error('Configuration row not found.')
  return within(element)
}

describe('setup provider selection and configuration truthfulness', () => {
  it('local accounts stay available without hosted keys', async () => {
    const { container } = await renderSetup({ NEXT_PUBLIC_DATA_MODE: 'local' })

    expect(screen.getByRole('heading', { name: 'Local mode (private preview)' })).toBeInTheDocument()
    expect(screen.getByText(/Local accounts and saved content work without Supabase keys/)).toBeInTheDocument()
    expect(screen.getByText(/Keep this mode private and loopback-bound/)).toBeInTheDocument()
    expect(screen.getByText('Hosted configuration notes (not required for local mode)')).toBeInTheDocument()
    expect(container).not.toHaveTextContent(/every feature that needs data is switched off/i)
    expect(screen.queryByText('Hosted configuration needs attention')).not.toBeInTheDocument()
  })

  it('hosted values do not switch an explicitly selected local provider', async () => {
    await renderSetup({ ...hostedConfiguration, NEXT_PUBLIC_DATA_MODE: 'local' })

    expect(screen.getByRole('heading', { name: 'Local mode (private preview)' })).toBeInTheDocument()
    expect(row('NEXT_PUBLIC_SUPABASE_URL').getByText('set')).toBeInTheDocument()
    expect(row('NEXT_PUBLIC_SUPABASE_ANON_KEY').getByText('set')).toBeInTheDocument()
    expect(screen.getByText(/Supabase settings below do not switch this preview to hosted mode/)).toBeInTheDocument()
    expect(screen.queryByText('Hosted configuration present')).not.toBeInTheDocument()
  })

  it('malformed hosted settings are informational in local mode', async () => {
    await renderSetup({
      NEXT_PUBLIC_DATA_MODE: 'local',
      NEXT_PUBLIC_SUPABASE_URL: 'invalid-setup-url',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'short',
    })

    expect(screen.getByText('Hosted configuration notes (not required for local mode)')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/Local accounts and saved content work without Supabase keys/)).toBeInTheDocument()
  })

  it('missing hosted browser settings are not reported as usable', async () => {
    await renderSetup()

    expect(screen.getByRole('heading', { name: 'Hosted mode (Supabase)' })).toBeInTheDocument()
    expect(screen.getByText('Hosted configuration needs attention')).toBeInTheDocument()
    expect(screen.getByText('NEXT_PUBLIC_SUPABASE_URL is not set.')).toBeInTheDocument()
    expect(screen.getByText('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.')).toBeInTheDocument()
    expect(row('NEXT_PUBLIC_SUPABASE_URL').getByText('missing')).toBeInTheDocument()
    expect(screen.queryByText('Hosted configuration present')).not.toBeInTheDocument()
  })

  it('valid hosted values report format checks, not a verified connection', async () => {
    const { container } = await renderSetup(hostedConfiguration)

    expect(screen.getByText('Hosted configuration present')).toBeInTheDocument()
    expect(screen.getByText(/No connection or migration check has been run here/)).toBeInTheDocument()
    expect(screen.queryByText('Hosted configuration problems')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent(/Accounts, the feed and everything else.*will work/i)
    expect(container).not.toHaveTextContent('Supabase is configured')
  })

  it.each([undefined, 'LOCAL', 'unsupported'])(
    'follows the actual hosted fallback when data mode is %s',
    async (mode) => {
      await renderSetup({ ...hostedConfiguration, NEXT_PUBLIC_DATA_MODE: mode })

      expect(screen.getByRole('heading', { name: 'Hosted mode (Supabase)' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Local mode (private preview)' })).not.toBeInTheDocument()
    },
  )

  it.each([
    { name: 'malformed project URL', field: 'NEXT_PUBLIC_SUPABASE_URL', value: 'invalid-setup-url' },
    { name: 'project URL trailing slash', field: 'NEXT_PUBLIC_SUPABASE_URL', value: `${hostedConfiguration.NEXT_PUBLIC_SUPABASE_URL}/` },
    { name: 'short browser key', field: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', value: 'short' },
    { name: 'malformed site origin', field: 'NEXT_PUBLIC_SITE_URL', value: 'invalid-setup-origin' },
  ])('reports $name without claiming hosted readiness', async ({ field, value }) => {
    await renderSetup({ ...hostedConfiguration, [field]: value })

    expect(screen.getByText('Hosted configuration needs attention')).toBeInTheDocument()
    expect(screen.getByText('Hosted configuration problems')).toBeInTheDocument()
    expect(row(field).getByText('set')).toBeInTheDocument()
    expect(screen.queryByText('Hosted configuration present')).not.toBeInTheDocument()
  })

  it.each([false, true])('treats service-role presence (%s) as optional, not browser readiness', async (present) => {
    await renderSetup({
      ...hostedConfiguration,
      SUPABASE_SERVICE_ROLE_KEY: present ? randomUUID() : '',
    })

    expect(screen.getByText('Hosted configuration present')).toBeInTheDocument()
    expect(row('SUPABASE_SERVICE_ROLE_KEY').getByText(present ? 'set' : 'not set (optional)')).toBeInTheDocument()
    expect(row('SUPABASE_SERVICE_ROLE_KEY').getByText(/not required for browser configuration/)).toBeInTheDocument()
    expect(row('SUPABASE_SERVICE_ROLE_KEY').getByText(/never expose it to the browser/)).toBeInTheDocument()
  })

  it.each(['local', 'supabase'])('never renders environment values in %s mode', async (mode) => {
    const settings = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${randomUUID()}.invalid`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: randomUUID(),
      SUPABASE_SERVICE_ROLE_KEY: randomUUID(),
      NEXT_PUBLIC_SITE_URL: `invalid-origin-${randomUUID()}`,
      LOCAL_DATA_PATH: `unread-local-store-marker-${randomUUID()}`,
    }
    const { container } = await renderSetup({ ...settings, NEXT_PUBLIC_DATA_MODE: mode })

    for (const value of Object.values(settings)) expect(container.innerHTML).not.toContain(value)
    expect(container.innerHTML).not.toContain('data/local.json')
  })

  it.each(['local', 'supabase'])('keeps integration and launch limits explicit in %s mode', async (mode) => {
    const { container } = await renderSetup({ ...hostedConfiguration, NEXT_PUBLIC_DATA_MODE: mode })

    expect(container).toHaveTextContent(/Email delivery, OAuth sign-in, hosted Realtime and cloud file storage are not established by local mode/)
    expect(container).toHaveTextContent(/does not verify a successful connection, applied migrations/)
    expect(container).toHaveTextContent(/staging, security, backup\/restore and measured load-test evidence/)
    expect(container).toHaveTextContent('50,000-user capacity has not been verified')
  })

  it('provides safe setup guidance without overwrite or provisioning commands', async () => {
    const { container } = await renderSetup()
    const instructions = screen.getByRole('region', { name: 'How to configure hosted mode safely' })

    expect(instructions).toHaveTextContent(/If .env.local already exists, preserve its values/)
    expect(instructions).toHaveTextContent(/If it does not exist, use .env.example as a starting template/)
    expect(instructions).toHaveTextContent(/confirm the target project, backups and a recovery plan/)
    expect(instructions).toHaveTextContent(/NEXT_PUBLIC_\* values are embedded at build time/)
    expect(instructions).not.toHaveTextContent(/(?:cp|copy|Copy-Item)\s+\.env\.example\s+\.env\.local/i)
    expect(container).not.toHaveTextContent(/npx supabase link|npm run db:push|free tier is enough|\b\d+\s+tables/i)
    expect(screen.getByRole('link', { name: 'Review build status and remaining work' })).toHaveAttribute('href', '/status')
  })

  it('does not probe services while rendering configuration', async () => {
    await renderSetup(hostedConfiguration)
    expect(fetch).not.toHaveBeenCalled()
  })
})

import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMfaSettings } from '@/features/auth/staff-mfa-state'
import SecurityPage, { dynamic, metadata } from './page'

const mocks = vi.hoisted(() => ({
  local: false, settings: vi.fn(), redirect: vi.fn(), form: vi.fn(),
  enroll: vi.fn(), verify: vi.fn(), requireAssurance: vi.fn(),
}))
vi.mock('@/features/auth/staff-mfa', () => ({
  getStaffMfaSettings: mocks.settings,
  enrollStaffAuthenticator: mocks.enroll,
  verifyStaffAuthenticator: mocks.verify,
  requireStaffAssurance: mocks.requireAssurance,
}))
vi.mock('@/features/auth/components/staff-mfa-form', () => ({ StaffMfaForm: mocks.form }))
vi.mock('@/lib/mode', () => ({ isLocalMode: () => mocks.local }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('next/link', () => ({
  default: function Link({ href, children, className }: ComponentProps<'a'>) {
    return <a href={href} className={className}>{children}</a>
  },
}))

const FACTOR = '55555555-5555-4555-8555-555555555555'
const cloud: Extract<StaffMfaSettings, { state: 'cloud' }> = {
  state: 'cloud', assured: false, assuranceUnavailable: false, canEnroll: true, hasOtherFactors: false,
  factors: [{ id: FACTOR, name: 'Fixture unfinished app', status: 'unverified' }],
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.local = false
  mocks.settings.mockResolvedValue(cloud)
  mocks.redirect.mockImplementation(() => { throw new Error('Synthetic sign-in redirect') })
  mocks.form.mockImplementation(() => <section aria-label="Fixture staff MFA form" />)
})
afterEach(() => { cleanup() })

describe('security route truthfulness and read-only states', () => {
  it('uses dynamic request rendering and no-referrer metadata', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(metadata.referrer).toBe('no-referrer')
  })

  it('redirects signed-out accounts to the exact safe security destination without a form', async () => {
    mocks.settings.mockResolvedValue({ state: 'signed_out' })
    await expect(SecurityPage()).rejects.toThrow('Synthetic sign-in redirect')
    expect(mocks.redirect).toHaveBeenCalledWith('/login?next=/settings/security')
    expect(mocks.form).not.toHaveBeenCalled()
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('hides controls when the provider or permissions cannot be verified', async () => {
    mocks.settings.mockResolvedValue({ state: 'unavailable' })
    render(await SecurityPage())
    expect(screen.getByRole('alert')).toHaveTextContent('MFA controls and staff assurance are unavailable.')
    expect(screen.getByRole('alert')).toHaveTextContent('No authenticator was created by opening this page.')
    expect(screen.getByRole('link', { name: 'View configuration information' })).toHaveAttribute('href', '/setup')
    expect(mocks.form).not.toHaveBeenCalled()
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it.each(['local_unsupported', 'not_staff'] as const)(
    'reports private-local MFA and provider recovery unavailable for %s without a fake cloud control', async state => {
      mocks.local = true
      mocks.settings.mockResolvedValue({ state })
      render(await SecurityPage())
      expect(screen.getByRole('status')).toHaveTextContent('no multi-factor authentication, provider recovery or AAL2 assurance')
      expect(screen.getByRole('status')).toHaveTextContent('private, loopback-bound preview')
      expect(screen.getByRole('link', { name: 'change your password with your current password' }))
        .toHaveAttribute('href', '/settings/password')
      expect(screen.queryByRole('region', { name: 'Fixture staff MFA form' })).not.toBeInTheDocument()
      expect(mocks.form).not.toHaveBeenCalled()
      expect(mocks.requireAssurance).not.toHaveBeenCalled()
    },
  )

  it('does not mask a public-local guard refusal with the private-preview explanation', async () => {
    mocks.local = true
    mocks.settings.mockResolvedValue({ state: 'unavailable' })
    render(await SecurityPage())
    expect(screen.getByRole('alert')).toHaveTextContent('staff permissions could not be verified')
    expect(screen.queryByText(/Local staff tools are only a private/)).not.toBeInTheDocument()
    expect(mocks.form).not.toHaveBeenCalled()
  })

  it('does not enroll ordinary cloud users or gate their normal account routes behind MFA', async () => {
    mocks.settings.mockResolvedValue({ state: 'not_staff' })
    render(await SecurityPage())
    expect(screen.getByRole('status')).toHaveTextContent('currently for staff accounts')
    expect(screen.getByRole('status')).toHaveTextContent('does not grant a staff role or restrict ordinary account routes')
    expect(screen.getByRole('link', { name: 'manage your password' })).toHaveAttribute('href', '/settings/password')
    expect(mocks.form).not.toHaveBeenCalled()
    expect(mocks.requireAssurance).not.toHaveBeenCalled()
  })

  it('renders first enrollment for verified cloud staff without claiming existing AAL2 or mutating on GET', async () => {
    render(await SecurityPage())
    expect(screen.getByRole('alert')).toHaveTextContent('Staff access remains blocked until fresh live session assurance is confirmed')
    expect(screen.getByRole('region', { name: 'Fixture staff MFA form' })).toBeInTheDocument()
    const props = mocks.form.mock.calls[0][0]
    expect(props).toEqual({ factors: cloud.factors, canEnroll: true })
    expect(Object.keys(props).sort()).toEqual(['canEnroll', 'factors'])
    expect(mocks.settings).toHaveBeenCalledTimes(1)
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.requireAssurance).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('describes live assurance as expiring and request-bound rather than a permanent role', async () => {
    mocks.settings.mockResolvedValue({ ...cloud, assured: true })
    render(await SecurityPage())
    expect(screen.getByRole('status')).toHaveTextContent('Access is checked again on every request and expires five minutes')
    expect(screen.getByRole('link', { name: 'Back to settings' })).toHaveAttribute('href', '/settings')
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('keeps staff blocked on missing live assurance while preserving a way to challenge an owned factor', async () => {
    mocks.settings.mockResolvedValue({ ...cloud, assuranceUnavailable: true, canEnroll: false })
    render(await SecurityPage())
    expect(screen.getByRole('alert')).toHaveTextContent('Staff access remains blocked even if your provider shows MFA enabled')
    expect(mocks.form.mock.calls[0][0]).toMatchObject({ canEnroll: false })
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('states exactly which existing factor features are unsupported without offering removal or recovery bypass', async () => {
    mocks.settings.mockResolvedValue({ ...cloud, hasOtherFactors: true })
    render(await SecurityPage())
    expect(screen.getByText(/Other provider factors are preserved/)).toHaveTextContent('TOTP authenticator apps only')
    expect(screen.getByText(/Other provider factors are preserved/)).toHaveTextContent(
      'security-key challenges, phone factors and factor-removal recovery are not implemented',
    )
    expect(screen.queryByRole('button', { name: /remove|delete|bypass/i })).not.toBeInTheDocument()
    expect(mocks.enroll).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  })
})

import type { ComponentProps } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffMfaForm } from './staff-mfa-form'
import type { StaffMfaActionState, StaffMfaEnrollmentResult, StaffMfaFactor } from '../staff-mfa-state'

const actions = vi.hoisted(() => ({ enroll: vi.fn(), verify: vi.fn() }))
vi.mock('@/features/auth/staff-mfa-actions', () => ({
  enrollStaffMfaAction: actions.enroll,
  verifyStaffMfaAction: actions.verify,
}))
vi.mock('next/link', () => ({
  default: function Link({ href, children, className }: ComponentProps<'a'>) {
    return <a href={href} className={className}>{children}</a>
  },
}))

const FACTOR = '55555555-5555-4555-8555-555555555555'
const NEW_FACTOR = '66666666-6666-4666-8666-666666666666'
// An inert fixture image, not an authenticator or real setup key.
const QR = 'data:image/svg+xml;base64,PHN2Zy8+'
const verified: StaffMfaFactor = { id: FACTOR, name: 'Fixture phone', status: 'verified' }
const unfinished: StaffMfaFactor = { id: NEW_FACTOR, name: 'Fixture backup', status: 'unverified' }

beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { cleanup() })

async function createSetup() {
  actions.enroll.mockResolvedValue({ status: 'enrolled', factorId: NEW_FACTOR, qrCode: QR })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Create setup QR' }))
  await screen.findByRole('img', { name: 'Private QR for setting up your Bulla authenticator' })
  return user
}

describe('explicit, transient staff MFA controls', () => {
  it('does not enroll or challenge while rendering and labels password-manager OTP controls', () => {
    render(<StaffMfaForm factors={[verified]} canEnroll={false} />)
    const code = screen.getByLabelText(/^Authenticator code/)
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('pattern', '[0-9]{6}')
    expect(code).not.toHaveAttribute('value')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(actions.enroll).not.toHaveBeenCalled()
    expect(actions.verify).not.toHaveBeenCalled()
  })

  it('creates a private QR only after explicit submission and never posts it or previous state back', async () => {
    const { container } = render(<StaffMfaForm factors={[]} canEnroll />)
    const user = await createSetup()
    expect(screen.getByRole('img')).toHaveAttribute('src', QR)
    expect(screen.getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getByText(/Setup is not complete until your code is verified/)).toBeInTheDocument()
    const enrollmentCall = actions.enroll.mock.calls[0]
    expect(enrollmentCall).toHaveLength(1)
    expect((enrollmentCall[0] as FormData).get('friendlyName')).toBe('Bulla authenticator')

    actions.verify.mockResolvedValue({ status: 'verified', message: 'Fixture session verified.' })
    await user.type(screen.getByLabelText(/^Authenticator code/), '654321')
    await user.click(screen.getByRole('button', { name: 'Verify and finish setup' }))
    await screen.findByText('Fixture session verified.')
    const verificationCall = actions.verify.mock.calls[0]
    expect(verificationCall).toHaveLength(1)
    const posted = verificationCall[0] as FormData
    expect(posted.get('factorId')).toBe(NEW_FACTOR)
    expect(posted.get('code')).toBe('654321')
    expect(posted.has('qrCode')).toBe(false)
    expect(posted.has('secret')).toBe(false)
    expect(posted.has('userId')).toBe(false)
    expect(posted.has('challengeId')).toBe(false)
    expect(container.innerHTML).not.toContain('654321')
    expect(container.innerHTML).not.toContain(QR)
    expect(screen.getByRole('link', { name: 'Continue to staff tools' })).toHaveAttribute('href', '/admin')
  })

  it.each(['verified', 'verified_unassured'] as const)(
    'clears setup material after %s and links to staff tools only for confirmed assurance', async status => {
      render(<StaffMfaForm factors={[]} canEnroll />)
      const user = await createSetup()
      actions.verify.mockResolvedValue({ status, message: `Fixture outcome: ${status}` })
      await user.type(screen.getByLabelText(/^Authenticator code/), '654321')
      await user.click(screen.getByRole('button', { name: 'Verify and finish setup' }))
      await screen.findByText(`Fixture outcome: ${status}`)
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      if (status === 'verified') {
        expect(screen.getByRole('link', { name: 'Continue to staff tools' })).toBeInTheDocument()
      } else {
        expect(screen.queryByRole('link', { name: 'Continue to staff tools' })).not.toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('verified_unassured')
      }
    },
  )

  it('connects server OTP and factor errors to their controls without echoing a code', async () => {
    actions.verify.mockResolvedValue({
      status: 'error',
      fieldErrors: { code: 'Fixture code was not accepted.', factorId: 'Fixture authenticator was removed.' },
    })
    const { container } = render(<StaffMfaForm factors={[verified]} canEnroll={false} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/^Authenticator code/), '654321')
    await user.click(screen.getByRole('button', { name: 'Verify staff session' }))
    await screen.findByText('Fixture code was not accepted.')
    expect(screen.getByLabelText(/^Authenticator code/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/^Authenticator code/)).toHaveAttribute(
      'aria-describedby', 'staff-mfa-code-hint staff-mfa-code-error',
    )
    expect(screen.getByRole('combobox', { name: /^Authenticator/ })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-describedby', 'staff-mfa-factor-error')
    expect(container.innerHTML).not.toContain('654321')
    expect(screen.queryByRole('link', { name: 'Continue to staff tools' })).not.toBeInTheDocument()
  })

  it('links enrollment errors to the name field', async () => {
    actions.enroll.mockResolvedValue({ status: 'error', fieldErrors: { friendlyName: 'Fixture name is already in use.' } })
    render(<StaffMfaForm factors={[]} canEnroll />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create setup QR' }))
    await screen.findByText('Fixture name is already in use.')
    expect(screen.getByLabelText(/^Authenticator name/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/^Authenticator name/)).toHaveAttribute(
      'aria-describedby', 'staff-mfa-name-hint staff-mfa-name-error',
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('disables enrollment fields while the provider request is pending', async () => {
    let finish!: (result: StaffMfaEnrollmentResult) => void
    actions.enroll.mockImplementation(() => new Promise<StaffMfaEnrollmentResult>(resolve => { finish = resolve }))
    render(<StaffMfaForm factors={[]} canEnroll />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create setup QR' }))
    expect(await screen.findByRole('button', { name: 'Creating private setup…' })).toBeDisabled()
    expect(screen.getByLabelText(/^Authenticator name/)).toBeDisabled()
    expect(screen.getByLabelText(/^Authenticator name/).closest('form')).toHaveAttribute('aria-busy', 'true')
    await act(async () => { finish({ status: 'error', message: 'Fixture provider is unavailable.' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Fixture provider is unavailable.')
    expect(screen.getByRole('button', { name: 'Create setup QR' })).toBeEnabled()
  })

  it('disables the factor, code and verification submit during a challenge', async () => {
    let finish!: (result: StaffMfaActionState) => void
    actions.verify.mockImplementation(() => new Promise<StaffMfaActionState>(resolve => { finish = resolve }))
    render(<StaffMfaForm factors={[verified]} canEnroll={false} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/^Authenticator code/), '654321')
    await user.click(screen.getByRole('button', { name: 'Verify staff session' }))
    expect(await screen.findByRole('button', { name: 'Verifying authenticator…' })).toBeDisabled()
    expect(screen.getByLabelText(/^Authenticator code/)).toBeDisabled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    await act(async () => { finish({ status: 'error', message: 'Fixture challenge expired.' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Fixture challenge expired.')
    expect(screen.getByRole('button', { name: 'Verify staff session' })).toBeEnabled()
  })

  it('hides unfinished replacements and backup enrollment when fresh assurance is absent', () => {
    render(<StaffMfaForm factors={[verified, unfinished]} canEnroll={false} />)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveValue(FACTOR)
    expect(screen.queryByText(/Fixture backup/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create setup QR' })).not.toBeInTheDocument()
    expect(screen.getByText(/Verify an existing authenticator before adding another/)).toBeInTheDocument()
    expect(screen.getByText(/does not remove verified factors or offer an MFA bypass/)).toBeInTheDocument()
  })

  it('hiding the QR only clears its render and does not remove or verify a factor', async () => {
    render(<StaffMfaForm factors={[unfinished]} canEnroll />)
    const user = await createSetup()
    expect(screen.getByText(/Hiding the QR does not delete the provider’s unfinished setup/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide setup QR' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Fixture backup (unfinished setup)' })).toHaveValue(NEW_FACTOR)
    expect(actions.enroll).toHaveBeenCalledTimes(1)
    expect(actions.verify).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /remove|delete|unenroll/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Verified authenticators are not removed by this form/)).toBeInTheDocument()
  })

  it('sanitizes an interrupted server action instead of rendering provider details or a setup', async () => {
    actions.enroll.mockRejectedValue(new Error('synthetic-sensitive-provider-detail'))
    const { container } = render(<StaffMfaForm factors={[]} canEnroll />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create setup QR' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The request was not confirmed.')
    expect(container.innerHTML).not.toContain('synthetic-sensitive-provider-detail')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

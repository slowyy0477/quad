import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordChangeForm } from './password-change-form'
import type { PasswordFormState } from '@/features/auth/password-state'

const actions = vi.hoisted(() => ({ change: vi.fn(), recover: vi.fn(), revoke: vi.fn() }))
vi.mock('@/features/auth/password-actions', () => ({
  changePasswordAction: actions.change,
  recoverPasswordAction: actions.recover,
  revokePasswordSessionsAction: actions.revoke,
}))

beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { cleanup() })

async function fillPasswords(recovery = false) {
  const user = userEvent.setup()
  if (!recovery) await user.type(screen.getByLabelText(/^Current password/), 'current secret phrase')
  await user.type(screen.getByLabelText(/^New password/), 'new private secret phrase')
  await user.type(screen.getByLabelText(/^Repeat new password/), 'new private secret phrase')
  return user
}

describe('accessible functional password change/recovery forms', () => {
  it('labels password-manager fields and does not render credential values into HTML', () => {
    const { container } = render(<PasswordChangeForm email="owner@example.test" />)
    expect(screen.getByLabelText(/^Current password/)).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText(/^Repeat new password/)).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Account email')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText(/^New password/)).not.toHaveAttribute('value')
    expect(container.innerHTML).not.toContain('password_hash')
  })

  it('wires accessible field errors to the control after an actual submit', async () => {
    actions.change.mockResolvedValue({ status: 'error', fieldErrors: { currentPassword: 'Your current password is incorrect.' } })
    const { container } = render(<PasswordChangeForm />)
    const user = await fillPasswords()
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is incorrect.')
    const field = screen.getByLabelText(/^Current password/)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAttribute('aria-describedby', 'currentPassword-error')
    expect(actions.change).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).not.toContain('current secret phrase')
    expect(container.innerHTML).not.toContain('new private secret phrase')
  })

  it('disables inputs and submit while pending, then displays the returned error', async () => {
    let resolve!: (state: PasswordFormState) => void
    actions.change.mockImplementation(() => new Promise<PasswordFormState>((finish) => { resolve = finish }))
    render(<PasswordChangeForm />)
    const user = await fillPasswords()
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('button', { name: 'Changing password…' })).toBeDisabled()
    expect(screen.getByLabelText(/^Current password/)).toBeDisabled()
    expect(screen.getByLabelText(/^New password/)).toBeDisabled()
    await act(async () => { resolve({ status: 'error', message: 'Fixture retry required' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Fixture retry required')
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled()
  })

  it('uses the recovery action without a fake current-password or identity input', async () => {
    actions.recover.mockResolvedValue({ status: 'error', recoveryInvalid: true, message: 'That recovery link expired.' })
    render(<PasswordChangeForm recovery />)
    expect(screen.queryByLabelText(/^Current password/)).not.toBeInTheDocument()
    const user = await fillPasswords(true)
    await user.click(screen.getByRole('button', { name: 'Verify link and set new password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('expired')
    expect(screen.getByRole('link', { name: 'Request a new recovery link' })).toHaveAttribute('href', '/reset-password')
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
    expect(actions.change).not.toHaveBeenCalled()
    expect(actions.recover).toHaveBeenCalledTimes(1)
  })

  it('offers only session-revocation retry after partial success, not another password update', async () => {
    actions.change.mockResolvedValue({
      status: 'changed_unrevoked', message: 'Password changed; all-device sign-out was not confirmed.',
    })
    actions.revoke.mockResolvedValue(undefined)
    render(<PasswordChangeForm />)
    const user = await fillPasswords()
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByRole('button', { name: 'Retry sign-out on all devices' })
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry sign-out on all devices' }))
    expect(actions.revoke).toHaveBeenCalledTimes(1)
    expect(actions.change).toHaveBeenCalledTimes(1)
  })
})

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingForm } from './onboarding-form'

const submit = vi.hoisted(() => vi.fn())
vi.mock('@/features/profiles/actions', () => ({ completeOnboardingAction: submit }))
beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { cleanup() })

describe('onboarding publication consent control', () => {
  it('defaults private, labels all four audiences, and never preselects publication', () => {
    render(<OnboardingForm universities={[]} suggestedUsername="student" defaultDisplayName="Student" />)
    expect(screen.getByLabelText(/^Who can see your profile/)).toHaveValue('private')
    expect(screen.getByRole('option', { name: /Public — everyone/ })).toHaveValue('public')
    expect(screen.getByRole('option', { name: 'My accepted connections' })).toHaveValue('connections')
    expect(screen.getByRole('option', { name: 'People at my university' })).toHaveValue('university')
  })

  it('submits only the audience the user explicitly selects and announces server errors', async () => {
    submit.mockResolvedValue({
      status: 'error', fieldErrors: { visibility: 'Choose who can see your profile' },
      values: { visibility: 'public' },
    })
    render(<OnboardingForm universities={[]} suggestedUsername="student" defaultDisplayName="Student" />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText(/^Who can see your profile/), 'public')
    await user.click(screen.getByRole('button', { name: 'Finish and go to my profile' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose who can see your profile')
    const data = submit.mock.calls[0][1] as FormData
    expect(data.get('visibility')).toBe('public')
    expect(screen.getByLabelText(/^Who can see your profile/)).toHaveAttribute('aria-invalid', 'true')
  })
})

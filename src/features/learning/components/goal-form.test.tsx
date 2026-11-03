import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GoalForm } from './goal-form'

const actions = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/features/learning/actions', () => ({ createGoalAction: actions.create }))

beforeEach(() => {
  vi.resetAllMocks()
  actions.create.mockResolvedValue({ status: 'success', message: 'Goal saved.' })
})

describe('learning publication is a deliberate choice', () => {
  it('starts private, matching the database default, without hiding other audiences', async () => {
    render(<GoalForm semesters={[]} defaultSemesterId={null} />)
    const audience = screen.getByRole('combobox', { name: 'Who can see it' })
    expect(audience).toHaveValue('private')
    await userEvent.setup().selectOptions(audience, 'public')
    expect(audience).toHaveValue('public')
  })

  it('submits the private default through the real form', async () => {
    const user = userEvent.setup()
    render(<GoalForm semesters={[]} defaultSemesterId={null} />)
    await user.type(screen.getByLabelText(/^The goal/), 'Read five chapters')
    await user.type(screen.getByRole('spinbutton', { name: /^Target/ }), '5')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'course')
    await user.click(screen.getByRole('button', { name: 'Add the goal' }))
    await waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1))
    const data = actions.create.mock.calls[0][1] as FormData
    expect(data.get('visibility')).toBe('private')
    expect(data.has('profileId')).toBe(false)
  })

  it('keeps an explicitly chosen audience when a write is refused', async () => {
    actions.create.mockImplementation(async (_previous: unknown, data: FormData) => ({
      status: 'error',
      message: 'Please wait before adding another goal.',
      values: Object.fromEntries(data),
    }))
    const user = userEvent.setup()
    render(<GoalForm semesters={[]} defaultSemesterId={null} />)
    await user.type(screen.getByLabelText(/^The goal/), 'Read five chapters')
    await user.type(screen.getByRole('spinbutton', { name: /^Target/ }), '5')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'course')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Who can see it' }), 'public')
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue('course')
    await user.click(screen.getByRole('button', { name: 'Add the goal' }))
    await screen.findByText('Please wait before adding another goal.')
    expect(screen.getByRole('combobox', { name: 'Who can see it' })).toHaveValue('public')
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue('course')
    expect(screen.getByRole('textbox', { name: /^The goal/ })).toHaveValue('Read five chapters')
  })

  it('shows an accepted receipt and resets only when the author explicitly starts another goal', async () => {
    const user = userEvent.setup()
    render(<GoalForm semesters={[]} defaultSemesterId={null} />)
    await user.type(screen.getByLabelText(/^The goal/), 'Read five chapters')
    await user.type(screen.getByRole('spinbutton', { name: /^Target/ }), '5')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Who can see it' }), 'public')
    await user.click(screen.getByRole('button', { name: 'Add the goal' }))
    expect(await screen.findByText('Goal saved.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add the goal' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add another goal' }))
    expect(screen.getByLabelText(/^The goal/)).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Who can see it' })).toHaveValue('private')
    expect(actions.create).toHaveBeenCalledTimes(1)
  })
})

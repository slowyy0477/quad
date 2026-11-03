import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GoalCard, type GoalCardData } from './goal-card'

const actions = vi.hoisted(() => ({
  add: vi.fn(), progress: vi.fn(), status: vi.fn(), toggle: vi.fn(),
}))
vi.mock('@/features/learning/actions', () => ({
  addMilestoneAction: actions.add,
  updateGoalProgressAction: actions.progress,
  setGoalStatusAction: actions.status,
  toggleMilestoneAction: actions.toggle,
}))

const goal: GoalCardData = {
  id: 'gol_ui_fixture', title: 'Read ten chapters', description: null,
  category: 'academic', status: 'active', target_value: 10, current_value: 2,
  unit: 'chapters', progress_percent: 20, target_date: null, completed_at: null,
  milestone_count: 0, completed_milestone_count: 0, milestones: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const action of Object.values(actions)) action.mockResolvedValue({ status: 'success', message: 'Saved.' })
})

describe('calmer goal controls retain drafts and expose real write state', () => {
  it('keeps step creation in a disclosure and exposes actual progress', () => {
    render(<GoalCard goal={goal} />)
    expect(screen.getByRole('heading', { name: goal.title })).toBeVisible()
    expect(screen.getByLabelText('How many chapters so far')).toHaveValue(2)
    const summary = screen.getByText('Add a step', { selector: 'summary' })
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Mark as done' })).toBeVisible()
  })

  it('preserves a typed number when the server refuses it', async () => {
    actions.progress.mockResolvedValue({ status: 'error', message: 'Please wait before updating again.' })
    const user = userEvent.setup()
    render(<GoalCard goal={goal} />)
    const input = screen.getByLabelText('How many chapters so far')
    await user.clear(input)
    await user.type(input, '7')
    await user.click(screen.getByRole('button', { name: 'Update' }))
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('Please wait before updating again.')
    expect(input).toHaveValue(7)
  })

  it('disables an in-flight progress write instead of submitting it twice', async () => {
    let finish!: (value: { status: string; message: string }) => void
    actions.progress.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const user = userEvent.setup()
    render(<GoalCard goal={goal} />)
    const button = screen.getByRole('button', { name: 'Update' })
    await user.click(button)
    expect(button).toBeDisabled()
    await user.click(button)
    expect(actions.progress).toHaveBeenCalledTimes(1)
    finish({ status: 'success', message: 'Saved.' })
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('keeps progress drafts on an unrelated refresh and reconciles a changed stored value', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GoalCard goal={goal} />)
    const input = screen.getByLabelText('How many chapters so far')
    await user.clear(input)
    await user.type(input, '7')
    rerender(<GoalCard goal={{ ...goal, title: 'Updated title' }} />)
    expect(input).toHaveValue(7)
    rerender(<GoalCard goal={{ ...goal, current_value: 6, progress_percent: 60 }} />)
    expect(input).toHaveValue(6)
  })

  it('retains a refused step draft and clears it only after an accepted step', async () => {
    actions.add.mockResolvedValueOnce({ status: 'error', message: 'Please wait before adding another step.' })
    const user = userEvent.setup()
    render(<GoalCard goal={goal} />)
    await user.click(screen.getByText('Add a step', { selector: 'summary' }))
    const input = screen.getByRole('textbox', { name: /Step title/ })
    await user.type(input, 'Finish chapter three')
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('Please wait before adding another step.')
    expect(input).toHaveValue('Finish chapter three')
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(actions.add).toHaveBeenCalledTimes(2)
    expect(actions.add.mock.calls[1][1].get('title')).toBe('Finish chapter three')
  })

  it('does not imply completion from a percentage or display creation controls on a completed goal', () => {
    render(<GoalCard goal={{ ...goal, status: 'completed', current_value: 10, progress_percent: 100 }} />)
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add a step', { selector: 'summary' })).not.toBeInTheDocument()
  })
})

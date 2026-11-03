import { useActionState, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useRetainedForm } from './use-retained-form'

function Fixture({ save }: { save: () => Promise<string> }) {
  const ref = useRetainedForm()
  const [state, action] = useActionState(save, '')
  const [choice, setChoice] = useState('private')
  return (
    <form ref={ref} action={action}>
      <label>Draft<input name="draft" defaultValue="" /></label>
      <label>Audience<select value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
        <option value="private">Private</option>
        <option value="public">Public</option>
      </select></label>
      <button type="submit">Save</button>
      {state ? <p role="alert">{state}</p> : null}
    </form>
  )
}

describe('native non-secret draft retention', () => {
  it('retains uncontrolled text and a selected audience after a resolved refusal without echo values', async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => 'Not saved')
    render(<Fixture save={save} />)
    await user.type(screen.getByRole('textbox', { name: 'Draft' }), 'Retain this synthetic draft')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Audience' }), 'public')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved')
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Retain this synthetic draft')
    expect(screen.getByRole('combobox', { name: 'Audience' })).toHaveValue('public')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('cancels the native reset and removes the listener on unmount', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Fixture save={async () => 'Not saved'} />)
    const input = screen.getByRole('textbox', { name: 'Draft' })
    const form = input.closest('form')!
    await user.type(input, 'Retain this synthetic draft')
    act(() => form.reset())
    expect(input).toHaveValue('Retain this synthetic draft')
    unmount()
    form.reset()
    expect(input).toHaveValue('')
  })
})

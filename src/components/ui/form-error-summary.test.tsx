import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormErrorSummary } from './form-error-summary'

const fields = { title: { id: 'test-title', label: 'Title' } }

describe('linked form error summaries', () => {
  it('is absent for idle/success and focuses a real refusal without echoing values', () => {
    const { rerender } = render(<FormErrorSummary state={{ status: 'idle' }} fields={fields} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<FormErrorSummary state={{ status: 'success', message: 'Saved' }} fields={fields} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<FormErrorSummary state={{ status: 'error', message: 'Nothing was saved.' }} fields={fields} />)
    expect(screen.getByRole('alert')).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was saved.')
  })

  it('opens enclosing disclosures and focuses only the field in its own form', () => {
    render(
      <>
        <form><input id="test-title" aria-label="Unrelated title" /></form>
        <form>
          <FormErrorSummary state={{ status: 'error', fieldErrors: { title: 'Write a title.' } }} fields={fields} />
          <details data-testid="optional"><summary>Optional details</summary>
            <input id="test-title" aria-label="This title" />
          </details>
        </form>
      </>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Title: Write a title.' }))
    expect(screen.getByTestId('optional')).toHaveAttribute('open')
    expect(screen.getByLabelText('This title')).toHaveFocus()
    expect(screen.getByLabelText('Unrelated title')).not.toHaveFocus()
  })

  it('keeps unknown field errors readable without inventing a broken link', () => {
    render(<FormErrorSummary state={{ status: 'error', fieldErrors: { form: 'The date combination is invalid.' } }} fields={fields} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The date combination is invalid.')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

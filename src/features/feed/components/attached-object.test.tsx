import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AttachedObject } from './attached-object'

describe('project update navigation', () => {
  it('links a visible attached project to its implemented route', () => {
    render(<AttachedObject project={{ id: 'project', slug: 'campus-garden', title: 'Campus garden', tagline: null, status: 'active' }} goal={null} />)
    expect(screen.getByRole('link', { name: 'Campus garden' })).toHaveAttribute('href', '/projects/campus-garden')
  })

  it('does not invent an attachment for hidden or missing data', () => {
    const { container } = render(<AttachedObject project={null} goal={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})

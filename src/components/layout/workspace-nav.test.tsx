import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceNav } from './workspace-nav'

const location = vi.hoisted(() => ({ pathname: '/feed' }))
vi.mock('next/navigation', () => ({ usePathname: () => location.pathname }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) =>
    <a href={href} {...props}>{children}</a>,
}))

describe('Bulla workspace navigation hierarchy', () => {
  it('keeps core destinations visible and campus extras in one native disclosure on desktop', () => {
    location.pathname = '/feed'
    render(<WorkspaceNav compact />)
    const nav = screen.getByRole('navigation', { name: 'Campus workspace' })
    expect(within(nav).getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Messages' })).toBeVisible()
    expect(within(nav).getByRole('link', { name: 'Saved posts' })).toBeVisible()
    const summary = screen.getByText('Around campus')
    expect(summary.tagName).toBe('SUMMARY')
    expect(summary.parentElement).not.toHaveAttribute('open')
    expect(screen.getByRole('link', { name: 'Universities', hidden: true })).toHaveAttribute('href', '/universities')
  })

  it('opens the campus group for its current destination without marking Feed active', () => {
    location.pathname = '/feed/people'
    render(<WorkspaceNav compact />)
    expect(screen.getByText('Around campus').parentElement).toHaveAttribute('open')
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Feed' })).not.toHaveAttribute('aria-current')
  })

  it('exposes the complete real route map in the campus menu', () => {
    location.pathname = '/settings'
    render(<WorkspaceNav />)
    expect(screen.getByText('Around campus').tagName).toBe('H2')
    expect(screen.getByRole('link', { name: 'Opportunities' })).toHaveAttribute('href', '/opportunities')
    expect(screen.getByRole('link', { name: 'Learning' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '/connections')
  })
})

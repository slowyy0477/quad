import type { ComponentProps } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FullProfile } from '@/features/profiles/queries'
import { ProfileView } from './profile-view'

vi.mock('next/link', () => ({
  default: function Link({
    href, children, className, rel, 'aria-label': ariaLabel, 'aria-current': ariaCurrent,
  }: ComponentProps<'a'>) {
    return <a href={href} className={className} rel={rel}
      aria-label={ariaLabel} aria-current={ariaCurrent}>{children}</a>
  },
}))

afterEach(cleanup)

function profile(overrides: Partial<FullProfile> = {}): FullProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'synthetic_owner', display_name: 'Synthetic Profile', avatar_url: null,
    headline: null, bio: null, degree: null, semester: null, graduation_year: null,
    location: null, website: null, github_username: null, linkedin_url: null,
    twitter_username: null, visibility: 'public', onboarding_completed: true,
    follower_count: 11, following_count: 13, connection_count: 17,
    post_count: 19, project_count: 23, created_at: '2026-11-02T07:45:29.205123Z',
    university_id: null, university: null,
    ...overrides,
  }
}

function expectStat(label: string, value: number) {
  const stat = screen.getByText(label, { exact: true }).parentElement
  expect(stat).not.toBeNull()
  expect(within(stat!).getByText(String(value), { exact: true })).toBeInTheDocument()
  if (stat!.matches('a[href]')) {
    expect(stat).toHaveAccessibleName(`${value} ${label}`)
  }
}

function expectNoGraphMetrics() {
  for (const label of ['Followers', 'Following', 'Connections']) {
    expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: new RegExp(`\\b${label}\\b`, 'i') }))
      .not.toBeInTheDocument()
  }
}

describe('ProfileView graph destinations and privacy', () => {
  it.each(['public', 'private', 'university', 'connections'])(
    'owners can open their three actual lists from a %s profile', visibility => {
      render(<ProfileView profile={profile({ visibility })} isSelf />)
      expect(screen.getByRole('link', { name: /\bFollowers\b/i }))
        .toHaveAttribute('href', '/connections/followers')
      expect(screen.getByRole('link', { name: /\bFollowing\b/i }))
        .toHaveAttribute('href', '/connections/following')
      expect(screen.getByRole('link', { name: /\bConnections\b/i }))
        .toHaveAttribute('href', '/connections')
      expectStat('Followers', 11)
      expectStat('Following', 13)
      expectStat('Connections', 17)
      expectStat('Posts', 19)
      expectStat('Projects', 23)
    },
  )

  it.each([0, 987_654])(
    'foreign public follow lists use an encoded handle and suppress hostile connection count %s',
    connectionCount => {
      const username = 'synthetic+handle/notes?part#one'
      render(<ProfileView profile={profile({ username, connection_count: connectionCount })} />)
      const base = `/u/${encodeURIComponent(username)}`
      expect(screen.getByRole('link', { name: /\bFollowers\b/i }))
        .toHaveAttribute('href', `${base}/followers`)
      expect(screen.getByRole('link', { name: /\bFollowing\b/i }))
        .toHaveAttribute('href', `${base}/following`)
      expectStat('Followers', 11)
      expectStat('Following', 13)
      expectStat('Posts', 19)
      expectStat('Projects', 23)
      expect(screen.queryByText('Connections', { exact: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /\bConnections\b/i })).not.toBeInTheDocument()
      expect(screen.queryByText(String(connectionCount), { exact: true })).not.toBeInTheDocument()
      const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href'))
      expect(hrefs).not.toContain(`${base}/connections`)
      expect(hrefs).not.toContain('/connections')
    },
  )

  it.each(['university', 'connections', 'private', 'unknown'])(
    'foreign %s profiles expose no graph metrics or destinations even with numeric counts',
    visibility => {
      render(<ProfileView profile={profile({ visibility })} />)
      expectNoGraphMetrics()
      for (const value of [11, 13, 17]) {
        expect(screen.queryByText(String(value), { exact: true })).not.toBeInTheDocument()
      }
      expectStat('Posts', 19)
      expectStat('Projects', 23)
    },
  )
})

describe('ProfileView count truthfulness', () => {
  it.each([true, false])('null counts never become zero (isSelf=%s)', isSelf => {
    render(<ProfileView isSelf={isSelf} profile={profile({
      follower_count: null, following_count: null, connection_count: null,
    })} />)
    expect(screen.queryByText('0', { exact: true })).not.toBeInTheDocument()
    expect(screen.getAllByText('Count unavailable')).toHaveLength(isSelf ? 3 : 2)
    for (const label of isSelf ? ['Followers', 'Following', 'Connections'] : ['Followers', 'Following']) {
      expect(screen.getByRole('link', { name: `Count unavailable ${label}` }))
        .toBeInTheDocument()
    }
    expectStat('Posts', 19)
    expectStat('Projects', 23)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([true, false])('reports an explicit graph-count error without inventing zero (isSelf=%s)', isSelf => {
    const error = 'Relationship counts could not be loaded. Please try again.'
    render(<ProfileView isSelf={isSelf} profile={profile({
      follower_count: null, following_count: null, connection_count: null,
      graph_counts_error: error,
    })} />)
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(screen.queryByText('0', { exact: true })).not.toBeInTheDocument()
    expectStat('Posts', 19)
    expectStat('Projects', 23)
  })

  it.each([true, false])('preserves genuine authorized zero counts and distinct content counts (isSelf=%s)', isSelf => {
    render(<ProfileView isSelf={isSelf} profile={profile({
      follower_count: 0, following_count: 0, connection_count: isSelf ? 0 : null,
      graph_counts_error: null,
    })} />)
    expectStat('Followers', 0)
    expectStat('Following', 0)
    expect(screen.getByRole('link', { name: /\bFollowers\b/i })).toHaveAttribute(
      'href', isSelf ? '/connections/followers' : '/u/synthetic_owner/followers',
    )
    expect(screen.getByRole('link', { name: /\bFollowing\b/i })).toHaveAttribute(
      'href', isSelf ? '/connections/following' : '/u/synthetic_owner/following',
    )
    if (isSelf) {
      expectStat('Connections', 0)
      expect(screen.getByRole('link', { name: /\bConnections\b/i })).toHaveAttribute('href', '/connections')
    } else {
      expect(screen.queryByText('Connections', { exact: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /\bConnections\b/i })).not.toBeInTheDocument()
    }
    expectStat('Posts', 19)
    expectStat('Projects', 23)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

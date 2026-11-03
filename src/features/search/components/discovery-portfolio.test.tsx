import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  getUser: vi.fn(async () => null), createClient: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { PeopleFilterForm } from './people-filters'
import { PeopleResults } from './people-results'
import { SearchResults } from './search-results'
import { PortfolioSections } from '@/features/profiles/components/portfolio-sections'
import type { ProfilePortfolio } from '@/features/profiles/portfolio'
import type { DiscoveryPerson } from '@/features/search/people'

afterEach(cleanup)

const filters = {
  query: 'Ayesha', universityId: 'uni_one', department: 'Computer Science', skill: 'TypeScript',
}
const PORTFOLIO_SECTIONS = ['projects', 'ideas', 'goals', 'posts'] as const
const universities = [{ id: 'uni_one', name: 'Synthetic University', short_name: 'SU' }]
const person: DiscoveryPerson = {
  id: 'prf_ayesha', username: 'ayesha', display_name: 'Ayesha', headline: null,
  avatar_url: null, created_at: '2026-10-20T00:00:00.000Z',
  university: universities[0], department: 'Computer Science',
  skills: [{ id: 'skl_typescript', name: 'TypeScript', level: 'familiar', is_learning: true }],
}

function portfolio(isSelf = false): ProfilePortfolio {
  const data = { profileId: 'prf_ayesha', username: 'ayesha', isSelf } as ProfilePortfolio
  for (const section of PORTFOLIO_SECTIONS) data[section] = {
    cursor: null, nextCursor: null, error: null,
    items: [{
      id: `${section}_one`, title: `Readable ${section}`, excerpt: 'Shared with this reader',
      href: section === 'goals' ? null : `/${section === 'posts' ? 'post' : section}/${section}_one`,
      status: section === 'posts' ? null : 'active',
      visibility: 'public', created_at: '2026-10-20T00:00:00.000Z',
      target_date: section === 'goals' ? '2026-12-01' : null,
    }],
  }
  return data
}

describe('people filters and direct destinations', () => {
  it('GET forms preserve all canonical filters, drop the cursor and work without client state', () => {
    render(<PeopleFilterForm filters={filters} universities={universities} />)
    const form = screen.getByRole('form', { name: 'Filter people' })
    expect(form).toHaveAttribute('action', '/search')
    expect(form).toHaveAttribute('method', 'get')
    expect(screen.getByRole('searchbox', { name: 'Name or username' })).toHaveValue('Ayesha')
    expect(screen.getByRole('combobox', { name: 'University' })).toHaveValue('uni_one')
    expect(screen.getByRole('textbox', { name: 'Department contains' })).toHaveValue('Computer Science')
    expect(screen.getByRole('textbox', { name: 'Skill contains' })).toHaveValue('TypeScript')
    expect(form.querySelector('[name=type]')).toHaveAttribute('value', 'people')
    expect(form.querySelector('[name=cursor]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Find people' })).toHaveAttribute('type', 'submit')
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/search?type=people')
  })

  it('URL changes reset native field values and preserve a bounded-picker selection without inventing its name', () => {
    const view = render(<PeopleFilterForm filters={filters} universities={universities} />)
    view.rerender(<PeopleFilterForm filters={{ ...filters, query: 'New name', universityId: 'uni_absent' }}
      universities={universities} hasMoreUniversities />)
    expect(screen.getByRole('searchbox')).toHaveValue('New name')
    expect(screen.getByRole('combobox')).toHaveValue('uni_absent')
    expect(screen.getByRole('option', { name: 'Selected institution' })).toHaveValue('uni_absent')
    expect(screen.getByRole('link', { name: 'Open the institution directory' })).toHaveAttribute('href', '/universities')
  })

  it('people show self-declared labels and links to real profiles, with no activity/mastery metric', () => {
    render(<PeopleResults people={[person]} />)
    expect(screen.getByRole('link', { name: 'Open profile' })).toHaveAttribute('href', '/u/ayesha')
    expect(screen.getByRole('list', { name: 'Self-declared skills' })).toHaveTextContent('TypeScript · familiar · learning')
    expect(screen.getByText('Synthetic University · Computer Science')).toBeInTheDocument()
    expect(screen.queryByText(/mastery score|recently active|endorsements/i)).not.toBeInTheDocument()
  })

  it('opportunity/event results link to their implemented detail routes, not planned placeholders', () => {
    render(<SearchResults results={[
      {
        kind: 'opportunity', id: 'opp_one', created_at: person.created_at,
        opportunity: {
          id: 'opp_one', slug: 'campus-work', title: 'Campus work', organisation: 'Synthetic lab',
          type: 'research', status: 'open', deadline: null, created_at: person.created_at, author: null,
        },
      },
      {
        kind: 'event', id: 'evt_one', created_at: person.created_at,
        event: {
          id: 'evt_one', slug: 'campus-talk', title: 'Campus talk', type: 'talk',
          location: 'Synthetic room', starts_at: person.created_at, created_at: person.created_at, author: null,
        },
      },
    ]} />)
    expect(screen.getByRole('link', { name: 'Campus work' })).toHaveAttribute('href', '/opportunities/campus-work')
    expect(screen.getByRole('link', { name: 'Campus talk' })).toHaveAttribute('href', '/events/campus-talk')
    expect(screen.queryByText('Page planned')).not.toBeInTheDocument()
  })
})

describe('readable portfolio rendering', () => {
  it('shows permission-approved entries and direct links, with shared goals inline and no owner controls for visitors', () => {
    render(<PortfolioSections portfolio={portfolio()} />)
    expect(screen.getByRole('link', { name: 'Readable projects' })).toHaveAttribute('href', '/projects/projects_one')
    expect(screen.getByRole('link', { name: 'Readable ideas' })).toHaveAttribute('href', '/ideas/ideas_one')
    expect(screen.getByRole('link', { name: 'Readable posts' })).toHaveAttribute('href', '/post/posts_one')
    expect(screen.getByRole('heading', { name: 'Readable goals' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Readable goals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage your goals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Start a project' })).not.toBeInTheDocument()
  })

  it('owner actions go to implemented creation/workspace routes only', () => {
    render(<PortfolioSections portfolio={portfolio(true)} />)
    expect(screen.getByRole('link', { name: 'Start a project' })).toHaveAttribute('href', '/projects/new')
    expect(screen.getByRole('link', { name: 'Share an idea' })).toHaveAttribute('href', '/ideas')
    expect(screen.getByRole('link', { name: 'Manage your goals' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Write a post' })).toHaveAttribute('href', '/feed')
  })

  it('empty views do not infer whether private work/learning exists', () => {
    const data = portfolio()
    for (const section of PORTFOLIO_SECTIONS) data[section].items = []
    render(<PortfolioSections portfolio={data} />)
    expect(screen.getByText('No readable goals in this view')).toBeInTheDocument()
    expect(screen.getAllByText('Nothing is shared with you in this view. This does not describe private work or learning.')).toHaveLength(4)
    expect(screen.queryByText(/has no goals|has not learned|only person|0 goals/i)).not.toBeInTheDocument()
  })

  it('errors never pretend to be empty lists, and hidden portfolios render nothing', () => {
    const data = portfolio()
    data.goals = { items: null, cursor: null, nextCursor: null, error: 'These goals could not be loaded.' }
    const view = render(<PortfolioSections portfolio={data} />)
    expect(screen.getByRole('alert')).toHaveTextContent('These goals could not be loaded.')
    expect(screen.queryByText('No readable goals in this view')).not.toBeInTheDocument()
    view.rerender(<PortfolioSections portfolio={null} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('independent next-page links keep the other section positions on the same profile', () => {
    const data = portfolio()
    data.projects.cursor = 'current_projects'
    data.projects.nextCursor = 'next_projects'
    data.goals.cursor = 'current_goals'
    render(<PortfolioSections portfolio={data} basePath="/u/ayesha" />)
    const link = screen.getByRole('link', { name: 'Next projects' })
    const url = new URL(link.getAttribute('href')!, 'https://bulla.test')
    expect(url.pathname).toBe('/u/ayesha')
    expect(url.searchParams.get('portfolio_projects')).toBe('next_projects')
    expect(url.searchParams.get('portfolio_goals')).toBe('current_goals')
    expect(url.hash).toBe('#portfolio-projects')
    expect(url.searchParams.has('total')).toBe(false)
  })
})

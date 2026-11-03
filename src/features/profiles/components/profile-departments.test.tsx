import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingForm } from './onboarding-form'
import { ProfileEditForm } from './profile-edit-form'
import type { FullProfile, UniversityOption } from '../queries'

const actions = vi.hoisted(() => ({ onboarding: vi.fn(), edit: vi.fn() }))
vi.mock('@/features/profiles/actions', () => ({
  completeOnboardingAction: actions.onboarding, updateProfileAction: actions.edit,
}))

const universities: UniversityOption[] = [
  { id: 'uni_one', name: 'Synthetic University One', short_name: null, country: null,
    departments: [{ id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems' }] },
  { id: 'uni_two', name: 'Synthetic University Two', short_name: null, country: null,
    departments: [{ id: 'dept_two', university_id: 'uni_two', name: 'Design Engineering' }] },
]
const profile: FullProfile = {
  id: 'prf_synthetic', username: 'synthetic_student', display_name: 'Synthetic Student', avatar_url: null,
  headline: null, bio: null, degree: 'Computer Science', semester: null, graduation_year: null,
  location: null, website: null, github_username: null, linkedin_url: null, twitter_username: null,
  visibility: 'private', onboarding_completed: true, follower_count: 0, following_count: 0,
  connection_count: 0, post_count: 0, project_count: 0, created_at: '2026-10-31T00:00:00.000Z',
  university_id: 'uni_one', university: { id: 'uni_one', name: 'Synthetic University One', short_name: null, slug: 'synthetic-one' },
  department_id: 'dept_one', department: { id: 'dept_one', university_id: 'uni_one', name: 'Computing Systems' },
}

beforeEach(() => {
  vi.resetAllMocks()
  const rejected = async (_previous: unknown, data: FormData) => ({
    status: 'error', fieldErrors: { departmentId: 'Synthetic reference refusal' },
    values: Object.fromEntries(Array.from(data.entries()).filter((entry) => typeof entry[1] === 'string')),
  })
  actions.onboarding.mockImplementation(rejected)
  actions.edit.mockImplementation(rejected)
})
afterEach(() => { cleanup() })

describe('onboarding and edit department controls', () => {
  it('requires an actual campus-bound selection, never department inference from degree', async () => {
    render(<OnboardingForm universities={universities} defaultDisplayName="Synthetic Student" suggestedUsername="synthetic_student" />)
    const user = userEvent.setup()
    const department = screen.getByRole('combobox', { name: 'Department' })
    expect(department).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Degree or programme' }), 'Computer Science')
    expect(department).toHaveValue('')
    await user.selectOptions(screen.getByRole('combobox', { name: 'University' }), 'uni_one')
    expect(screen.getByRole('option', { name: 'Computing Systems' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Design Engineering' })).not.toBeInTheDocument()
    await user.selectOptions(department, 'dept_one')
    await user.click(screen.getByRole('button', { name: 'Finish and go to my profile' }))
    expect(await screen.findByText('Synthetic reference refusal')).toBeVisible()
    const data = actions.onboarding.mock.calls[0][1] as FormData
    expect(data.get('departmentId')).toBe('dept_one')
    expect(data.get('degree')).toBe('Computer Science')
    expect(data.get('visibility')).toBe('private')
    expect(department).toHaveValue('dept_one')
    expect(department).toHaveAttribute('aria-invalid', 'true')
  })

  it('clears the department visibly on a campus change and permits explicit reselection', async () => {
    render(<ProfileEditForm profile={profile} universities={universities} />)
    const user = userEvent.setup()
    const department = screen.getByRole('combobox', { name: 'Department' })
    expect(department).toHaveValue('dept_one')
    await user.selectOptions(screen.getByRole('combobox', { name: 'University' }), 'uni_two')
    expect(department).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('department selection was cleared')
    expect(screen.queryByRole('option', { name: 'Computing Systems' })).not.toBeInTheDocument()
    await user.selectOptions(department, 'dept_two')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const errorLink = await screen.findByRole('link', { name: /^Department: Synthetic reference refusal/ })
    const data = actions.edit.mock.calls[0][1] as FormData
    expect(data.get('universityId')).toBe('uni_two')
    expect(data.get('departmentId')).toBe('dept_two')
    expect(data.get('degree')).toBe('Computer Science')
    expect(data.get('visibility')).toBe('private')
    await user.click(errorLink)
    expect(department).toHaveFocus()
    expect(department).toHaveValue('dept_two')
  })

  it('preserves a text-only legacy department without converting its name into a reference ID', async () => {
    render(<ProfileEditForm profile={{ ...profile, department_id: null, department: null, legacy_department: 'Computing Systems' }} universities={universities} />)
    const user = userEvent.setup()
    const department = screen.getByRole('combobox', { name: 'Department' })
    expect(department).not.toHaveAttribute('name')
    expect(screen.getByRole('option', { name: 'Keep existing — Computing Systems' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('link', { name: /^Department: Synthetic reference refusal/ })
    const data = actions.edit.mock.calls[0][1] as FormData
    expect(data.has('departmentId')).toBe(false)
    expect(data.get('degree')).toBe('Computer Science')
  })

  it.each([
    profile,
    { ...profile, department_id: null, department: null, legacy_department: 'Legacy Department' },
  ])('an explicit clear posts a blank department, even without reference options', async (current) => {
    render(<ProfileEditForm profile={current} universities={[]} />)
    const user = userEvent.setup()
    const department = screen.getByRole('combobox', { name: 'Department' })
    await user.selectOptions(department, '')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('link', { name: /^Department: Synthetic reference refusal/ })
    const data = actions.edit.mock.calls[0][1] as FormData
    expect(data.has('departmentId')).toBe(true)
    expect(data.get('departmentId')).toBe('')
    expect(data.get('universityId')).toBe('uni_one')
  })

  it('offers a useful empty state while preserving an unlisted current affiliation', () => {
    render(<ProfileEditForm profile={profile} universities={[]} />)
    expect(screen.getByRole('combobox', { name: 'University' })).toHaveValue('uni_one')
    expect(screen.getByRole('combobox', { name: 'Department' })).not.toHaveAttribute('name')
    expect(screen.getByText(/No approved department references are listed/)).toBeVisible()
    expect(screen.getByText(/not converted into a new directory selection/)).toBeVisible()
  })
})

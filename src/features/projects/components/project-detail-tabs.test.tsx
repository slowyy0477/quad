import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ProjectDetailTabs } from './project-detail-tabs'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation }))

afterEach(() => {
  cleanup()
  navigation.push.mockReset()
})

function contents() {
  return (
    <>
      <TabsList aria-label="Project detail">
        <TabsTrigger value="updates">Updates</TabsTrigger>
        <TabsTrigger value="requests">Requests</TabsTrigger>
        <TabsTrigger value="settings">Seeking members</TabsTrigger>
      </TabsList>
      <TabsContent value="updates">Public updates</TabsContent>
      <TabsContent value="requests">Own team requests</TabsContent>
      <TabsContent value="settings">Own team settings</TabsContent>
    </>
  )
}

describe('project sections keep server-authorized URL state', () => {
  it('navigates on activation and renders the subsequently returned server section', async () => {
    const user = userEvent.setup()
    const view = render(
      <ProjectDetailTabs slug="campus-team" activeTab="updates" canManage>
        {contents()}
      </ProjectDetailTabs>,
    )
    await user.click(screen.getByRole('tab', { name: 'Requests' }))
    expect(navigation.push).toHaveBeenCalledWith('/projects/campus-team?tab=requests', { scroll: false })
    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true')
    view.rerender(
      <ProjectDetailTabs slug="campus-team" activeTab="requests" canManage>
        {contents()}
      </ProjectDetailTabs>,
    )
    expect(screen.getByRole('tab', { name: 'Requests' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Requests' })).toHaveTextContent('Own team requests')
  })

  it('does not navigate to private sections when the server has not offered management', async () => {
    const user = userEvent.setup()
    render(
      <ProjectDetailTabs slug="campus-team" activeTab="updates" canManage={false}>
        {contents()}
      </ProjectDetailTabs>,
    )
    await user.click(screen.getByRole('tab', { name: 'Requests' }))
    await user.click(screen.getByRole('tab', { name: 'Seeking members' }))
    expect(navigation.push).not.toHaveBeenCalled()
    expect(screen.getByRole('tabpanel', { name: 'Updates' })).toHaveTextContent('Public updates')
  })
})

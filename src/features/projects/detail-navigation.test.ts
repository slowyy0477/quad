import { describe, expect, it } from 'vitest'
import { projectDetailHref, projectDetailTab } from './detail-navigation'

describe('project section URL state', () => {
  it('resolves the manager’s explicit Requests and settings sections', () => {
    expect(projectDetailTab('requests', true)).toBe('requests')
    expect(projectDetailTab('settings', true)).toBe('settings')
    expect(projectDetailTab(['requests', 'settings'], true)).toBe('requests')
  })

  it('never treats a URL as permission for a non-manager section', () => {
    for (const requested of ['requests', 'settings', ['settings'], undefined]) {
      expect(projectDetailTab(requested, false)).toBe('updates')
    }
  })

  it('defaults absent, malformed and unknown sections to Updates', () => {
    for (const requested of [undefined, '', 'admin', 'REQUESTS', '../requests', []]) {
      expect(projectDetailTab(requested, true)).toBe('updates')
    }
  })

  it('generates bounded application links for native navigation and reload', () => {
    expect(projectDetailHref('campus-team', 'updates')).toBe('/projects/campus-team')
    expect(projectDetailHref('campus-team', 'requests')).toBe('/projects/campus-team?tab=requests')
    expect(projectDetailHref('campus-team', 'settings')).toBe('/projects/campus-team?tab=settings')
    expect(projectDetailHref('//outside.example/#x', 'requests'))
      .toBe('/projects/%2F%2Foutside.example%2F%23x?tab=requests')
  })
})

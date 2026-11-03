import { describe, expect, it } from 'vitest'
import { FEATURES, featuresByArea, statusCounts } from './build-status'

describe('current feature ledger', () => {
  it('has unique feature identities and consistent counts', () => {
    expect(new Set(FEATURES.map(feature => feature.name)).size).toBe(FEATURES.length)
    expect(Object.values(statusCounts()).reduce((sum, value) => sum + value, 0)).toBe(FEATURES.length)
    expect(featuresByArea().flatMap(([, entries]) => entries)).toHaveLength(FEATURES.length)
  })

  it.each([
    'Onboarding (username, university, programme)', 'Profiles', 'Search',
    'Direct and group conversations', 'Projects, collaborators and applications',
    'Reports, moderation and admin tools', 'Bug reporting',
  ])('does not label the implemented %s interface database-only or absent', name => {
    expect(['working', 'partial']).toContain(FEATURES.find(feature => feature.name === name)?.status)
  })

  it('does not claim unmeasured production capacity', () => {
    expect(FEATURES.find(feature => feature.name === '50,000-user capacity and recovery')?.status).toBe('planned')
  })

  it('distinguishes implemented password controls from unverified hosted email delivery', () => {
    const recovery = FEATURES.find(feature => feature.name === 'Password reset by email')
    expect(recovery?.status).toBe('partial')
    expect(recovery?.note).toContain('/settings/password')
    expect(recovery?.note).toContain('implemented')
    expect(recovery?.note).toContain('unverified')
    expect(recovery?.note).not.toContain('not implemented')
  })

  it('does not call implemented account/image controls absent or claim hosted upload readiness', () => {
    const images = FEATURES.find(feature => feature.name === 'File uploads (avatars, project images)')
    const account = FEATURES.find(feature => feature.name === 'Account export and deletion')
    expect(images?.status).toBe('partial')
    expect(images?.note).toContain('disabled')
    expect(account?.status).toBe('partial')
    expect(account?.note).toContain('/settings/account')
    expect(account?.note).toContain('unverified')
  })
})

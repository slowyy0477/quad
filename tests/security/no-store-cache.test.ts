import { describe, expect, it } from 'vitest'
import { hasNoStoreCachePolicy } from '../e2e/helpers/no-store-cache'

describe('private Server Action cache acceptance', () => {
  it.each([
    'no-store',
    'private, no-store, max-age=0',
    'no-cache, no-store, max-age=0, must-revalidate',
    'NO-STORE, max-age=0',
  ])('accepts cache suppression without requiring a redundant private token: %s', policy => {
    expect(hasNoStoreCachePolicy(policy)).toBe(true)
  })

  it.each([
    undefined,
    '',
    'private',
    'no-cache',
    'max-age=0, must-revalidate',
    'x-no-store',
    'public, no-store',
  ])('refuses absent, cacheable or contradictory policies: %s', policy => {
    expect(hasNoStoreCachePolicy(policy)).toBe(false)
  })
})

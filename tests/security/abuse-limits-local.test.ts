import { describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS, type RateLimitBucket } from '../../src/lib/rate-limit/budgets'

vi.mock('server-only', () => ({}))

const { enforceMutationLimits, MutationLimitError } = await import('../../src/lib/local/mutation-limits')
type Window = import('../../src/lib/local/mutation-limits').LocalMutationLimitWindow
const nowMs = Date.parse('2026-10-31T12:30:15.000Z')
const context = { actorUserId: 'usr_verified_fixture', nowMs }

function window(bucket: RateLimitBucket, hits: number, subject = context.actorUserId): Window {
  const windowMs = RATE_LIMITS[bucket].windowSeconds * 1000
  const start = Math.floor(nowMs / windowMs) * windowMs
  return { id: `${bucket}:${subject}:${start}`, bucket, subject, window_start_ms: start, hits }
}

function snapshot(bucket: RateLimitBucket, hits: number) {
  return { mutation_limit_windows: [window(bucket, hits)] }
}

const INSERTS: [string, RateLimitBucket][] = [
  ['posts', 'post:write'], ['comments', 'comment:write'], ['idea_comments', 'comment:write'],
  ['post_likes', 'reaction:write'], ['idea_votes', 'reaction:write'], ['project_stars', 'reaction:write'],
  ['post_saves', 'save:write'], ['opportunity_saves', 'save:write'],
  ['messages', 'message:write'], ['projects', 'project:write'], ['ideas', 'idea:write'],
  ['opportunities', 'opportunity:write'], ['events', 'event:write'], ['event_attendees', 'event:rsvp'],
  ['reports', 'report:file'], ['university_requests', 'university:request'], ['bug_reports', 'bug:file'],
]

const DERIVED_REFERENCES = [
  { table: 'posts', column: 'project_id', targetTable: 'projects', editField: 'body', bucket: 'post:write' },
  { table: 'posts', column: 'goal_id', targetTable: 'goals', editField: 'body', bucket: 'post:write' },
  { table: 'comments', column: 'parent_id', targetTable: 'comments', editField: 'body', bucket: 'comment:write' },
  { table: 'ideas', column: 'converted_project_id', targetTable: 'projects', editField: 'title', bucket: 'idea:write' },
  { table: 'messages', column: 'reply_to_id', targetTable: 'messages', editField: 'body', bucket: 'message:write' },
  { table: 'university_requests', column: 'reviewed_by', targetTable: 'profiles', editField: 'name', bucket: 'moderation:university' },
] as const
type ReferenceSpec = typeof DERIVED_REFERENCES[number]
type ReferenceSnapshot = Record<string, ({ id: string } & Record<string, unknown>)[]>

function referenceFixture(spec: ReferenceSpec): ReferenceSnapshot {
  const survivor = { id: 'survivor_fixture', [spec.column]: 'target_fixture', [spec.editField]: 'Unchanged' }
  const target = { id: 'target_fixture' }
  return spec.table === spec.targetTable
    ? { [spec.table]: [survivor, target] }
    : { [spec.table]: [survivor], [spec.targetTable]: [target] }
}

function clearReference(spec: ReferenceSpec, before: ReferenceSnapshot, removeTarget = true): ReferenceSnapshot {
  const after = structuredClone(before)
  if (removeTarget) after[spec.targetTable] = after[spec.targetTable].filter(row => row.id !== 'target_fixture')
  after[spec.table] = after[spec.table].map(row =>
    row.id === 'survivor_fixture' ? { ...row, [spec.column]: null } : row,
  )
  return after
}

describe('deterministic local mutation-limit commit hook', () => {
  it.each(INSERTS)('gates %s at the fixed %s budget', (table, bucket) => {
    const before = snapshot(bucket, RATE_LIMITS[bucket].limit - 1)
    const proposed = { ...before, [table]: [{ id: 'synthetic_row', body: 'Fixture' }] }
    const saved = enforceMutationLimits(before, proposed, context)
    expect(saved.find(row => row.bucket === bucket)!.hits).toBe(RATE_LIMITS[bucket].limit)
    const nextBefore = { ...proposed, mutation_limit_windows: saved }
    const denied = { ...nextBefore, [table]: [{ id: 'synthetic_row', body: 'Fixture' }, { id: 'next_row', body: 'Next fixture' }] }
    expect(() => enforceMutationLimits(nextBefore, denied, context)).toThrow(MutationLimitError)
    // The caller can safely abort: the hook did not mutate either snapshot.
    expect(proposed.mutation_limit_windows[0].hits).toBe(RATE_LIMITS[bucket].limit - 1)
    expect(nextBefore.mutation_limit_windows[0].hits).toBe(RATE_LIMITS[bucket].limit)
  })

  it('charges edits to the verified actor, not a row owner supplied by the callback', () => {
    const before = { posts: [{ id: 'post_fixture', author_id: 'other_profile', body: 'Before' }] }
    const after = { posts: [{ id: 'post_fixture', author_id: 'forged_profile', body: 'After' }] }
    const ledger = enforceMutationLimits(before, after, context)
    expect(ledger).toEqual([window('post:write', 1)])
  })

  it('ignores reordering, timestamps and trigger-maintained counters without skipping real edits', () => {
    const before = { posts: [
      { id: 'first', body: 'Fixture', like_count: 0, comment_count: 0, updated_at: 'old' },
      { id: 'second', body: 'Another' },
    ] }
    const after = { posts: [
      { id: 'second', body: 'Another' },
      { id: 'first', body: 'Fixture', like_count: 2, comment_count: 1, updated_at: 'new' },
    ] }
    expect(enforceMutationLimits(before, after, context)).toEqual([])
    after.posts[1].body = 'A real edit'
    expect(enforceMutationLimits(before, after, context)).toEqual([window('post:write', 1)])
  })

  it('charges reactions but not their derived post counters', () => {
    const before = { posts: [{ id: 'post', body: 'Fixture', like_count: 0 }] }
    const after = {
      posts: [{ id: 'post', body: 'Fixture', like_count: 1 }],
      post_likes: [{ id: 'like', post_id: 'post', profile_id: 'profile' }],
    }
    expect(enforceMutationLimits(before, after, context)).toEqual([window('reaction:write', 1)])
  })

  it.each(DERIVED_REFERENCES)('permits only derived $table.$column nulling after its target is absent, with no session', spec => {
    const before = {
      ...referenceFixture(spec),
      sessions: [{ id: 'revoked_session' }],
    }
    const after = { ...clearReference(spec, before), sessions: [] }
    const originalBefore = structuredClone(before)
    const originalAfter = structuredClone(after)
    expect(enforceMutationLimits(before, after, { ...context, actorUserId: null })).toEqual([])
    expect(before).toEqual(originalBefore)
    expect(after).toEqual(originalAfter)
    // Cleanup does not erase an exhausted ledger either.
    const full = snapshot(spec.bucket, RATE_LIMITS[spec.bucket].limit)
    expect(enforceMutationLimits({ ...before, ...full }, { ...after, ...full }, { ...context, actorUserId: null })).toEqual(full.mutation_limit_windows)
  })

  it.each(DERIVED_REFERENCES)('charges $table.$column nulling while the referenced object still exists', spec => {
    const before = referenceFixture(spec)
    const after = clearReference(spec, before, false)
    expect(enforceMutationLimits(before, after, context)).toEqual([window(spec.bucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it.each(DERIVED_REFERENCES)('charges $table.$column nulling while the referenced object is merely soft-deleted', spec => {
    const before = referenceFixture(spec)
    before[spec.targetTable] = before[spec.targetTable].map(row =>
      row.id === 'target_fixture' ? { ...row, deleted_at: '2026-10-30T12:00:00Z' } : row,
    )
    const after = clearReference(spec, before, false)
    expect(enforceMutationLimits(before, after, context)).toEqual([window(spec.bucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it.each(DERIVED_REFERENCES)('charges reattachment through $table.$column even if both referenced targets are absent', spec => {
    const before = referenceFixture(spec)
    const after = clearReference(spec, before)
    after[spec.table] = after[spec.table].map(row =>
      row.id === 'survivor_fixture' ? { ...row, [spec.column]: 'different_absent_target' } : row,
    )
    expect(enforceMutationLimits(before, after, context)).toEqual([window(spec.bucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it.each(DERIVED_REFERENCES)('charges a fresh $table.$column attachment to a missing target', spec => {
    const before = referenceFixture(spec)
    before[spec.table] = before[spec.table].map(row =>
      row.id === 'survivor_fixture' ? { ...row, [spec.column]: null } : row,
    )
    const after = clearReference(spec, before)
    after[spec.table] = after[spec.table].map(row =>
      row.id === 'survivor_fixture' ? { ...row, [spec.column]: 'target_fixture' } : row,
    )
    expect(enforceMutationLimits(before, after, context)).toEqual([window(spec.bucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it.each(DERIVED_REFERENCES)('does not hide a real $table edit behind derived $column cleanup', spec => {
    const before = referenceFixture(spec)
    const after = clearReference(spec, before)
    after[spec.table] = after[spec.table].map(row =>
      row.id === 'survivor_fixture' ? { ...row, [spec.editField]: 'Actual user edit' } : row,
    )
    const ordinaryBucket = spec.table === 'university_requests' ? 'university:request' : spec.bucket
    expect(enforceMutationLimits(before, after, context)).toEqual([window(ordinaryBucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it.each(DERIVED_REFERENCES)('requires explicit null, not dropped $table.$column data, for derived cleanup', spec => {
    const before = referenceFixture(spec)
    const after = clearReference(spec, before)
    after[spec.table] = after[spec.table].map(row => {
      if (row.id !== 'survivor_fixture') return row
      const copy = { ...row }
      delete copy[spec.column]
      return copy
    })
    expect(enforceMutationLimits(before, after, context)).toEqual([window(spec.bucket, 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it('requires a present proposed target table and never ignores arbitrary association fields', () => {
    const spec = DERIVED_REFERENCES[0]
    const before = referenceFixture(spec)
    const incomplete = clearReference(spec, before)
    delete incomplete.projects
    expect(enforceMutationLimits(before, incomplete, context)).toEqual([window('post:write', 1)])
    expect(() => enforceMutationLimits(before, incomplete, { ...context, actorUserId: null })).toThrow(/verified session user/)
    const unsupportedBefore = { posts: [{ id: 'survivor_fixture', other_association_id: 'target_fixture' }], projects: [{ id: 'target_fixture' }] }
    const unsupportedAfter = { posts: [{ id: 'survivor_fixture', other_association_id: null }], projects: [] }
    expect(enforceMutationLimits(unsupportedBefore, unsupportedAfter, context)).toEqual([window('post:write', 1)])
    expect(() => enforceMutationLimits(unsupportedBefore, unsupportedAfter, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it('keeps a university correction in the smaller request budget when only its deleted reviewer is derived', () => {
    const spec = DERIVED_REFERENCES[5]
    const before = referenceFixture(spec)
    const after = clearReference(spec, before)
    after.university_requests[0].name = 'Actual institution correction'
    const full = snapshot('university:request', RATE_LIMITS['university:request'].limit)
    try {
      enforceMutationLimits({ ...before, ...full }, { ...after, ...full }, context)
      throw new Error('Expected the ordinary request-budget refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(MutationLimitError)
      expect(error).toMatchObject({ bucket: 'university:request' })
    }
  })

  it('detects each row in a batch and leaves all snapshots unchanged on refusal', () => {
    const before = { ...snapshot('bug:file', 4), notifications: [] }
    const after = { ...before, bug_reports: [{ id: 'bug1' }, { id: 'bug2' }], notifications: [{ id: 'not_committed' }] }
    const copy = structuredClone(after)
    expect(() => enforceMutationLimits(before, after, context)).toThrow(MutationLimitError)
    expect(after).toEqual(copy)
    expect(before.mutation_limit_windows[0].hits).toBe(4)
  })

  it('keeps the ledger after delete and rejects reinsert at capacity', () => {
    const before = { ...snapshot('save:write', RATE_LIMITS['save:write'].limit), post_saves: [{ id: 'save_fixture' }] }
    const deleted = { ...before, post_saves: [] }
    const ledger = enforceMutationLimits(before, deleted, context)
    expect(ledger[0].hits).toBe(RATE_LIMITS['save:write'].limit)
    const committed = { ...deleted, mutation_limit_windows: ledger }
    expect(() => enforceMutationLimits(committed, { ...committed, post_saves: [{ id: 'save_fixture' }] }, context)).toThrow(MutationLimitError)
  })

  it.each([
    ['reports', 'moderation:decide'],
    ['bug_reports', 'bug:triage'],
    ['university_requests', 'moderation:university'],
  ] as const)('charges %s review to %s once despite audit/notification side effects', (table, bucket) => {
    const before = { [table]: [{ id: 'review', status: 'pending' }] }
    const after = {
      [table]: [{ id: 'review', status: 'approved', reviewed_by: 'staff_profile' }],
      moderation_actions: [{ id: 'audit', actor_id: 'staff_profile' }],
      notifications: [{ id: 'notification' }],
      universities: [{ id: 'review', name: 'Derived catalogue entry' }],
    }
    expect(enforceMutationLimits(before, after, context)).toEqual([window(bucket, 1)])
  })

  it('charges a reported hide once even with exhausted ordinary post-write budget', () => {
    const before = {
      ...snapshot('post:write', RATE_LIMITS['post:write'].limit),
      posts: [{ id: 'post_fixture', body: 'Unchanged content', moderation_status: 'active' }],
      reports: [{ id: 'report_fixture', post_id: 'post_fixture', status: 'open' }],
      moderation_actions: [],
    }
    const after = {
      ...before,
      posts: [{ ...before.posts[0], moderation_status: 'hidden' }],
      reports: [{ ...before.reports[0], status: 'actioned' }],
      moderation_actions: [{ id: 'decision_fixture', report_id: 'report_fixture', action: 'hide_content' }],
      content_moderation: [{ id: 'mod_fixture', kind: 'post', target_id: 'post_fixture', status: 'hidden' }],
      notifications: [{ id: 'notification_fixture' }],
    }
    expect(enforceMutationLimits(before, after, context)).toEqual([
      window('moderation:decide', 1), window('post:write', RATE_LIMITS['post:write'].limit),
    ])
  })

  it('refuses a reported hide at the decision limit without mutating content/audit/notifications', () => {
    const before = {
      ...snapshot('moderation:decide', RATE_LIMITS['moderation:decide'].limit),
      posts: [{ id: 'post_fixture', body: 'Unchanged content', moderation_status: 'active' }],
      reports: [{ id: 'report_fixture', post_id: 'post_fixture', status: 'open' }],
      moderation_actions: [],
      notifications: [],
    }
    const after = {
      ...before,
      posts: [{ ...before.posts[0], moderation_status: 'hidden' }],
      reports: [{ ...before.reports[0], status: 'actioned' }],
      moderation_actions: [{ id: 'decision_fixture', report_id: 'report_fixture', action: 'hide_content' }],
      notifications: [{ id: 'notification_fixture' }],
    }
    const originalBefore = structuredClone(before)
    const originalAfter = structuredClone(after)
    expect(() => enforceMutationLimits(before, after, context)).toThrow(MutationLimitError)
    expect(before).toEqual(originalBefore)
    expect(after).toEqual(originalAfter)
  })

  it('charges every new restore audit when report status is already actioned', () => {
    const before = {
      ...snapshot('moderation:decide', RATE_LIMITS['moderation:decide'].limit - 1),
      posts: [{ id: 'post_fixture', body: 'Unchanged content', moderation_status: 'hidden' }],
      reports: [{ id: 'report_fixture', post_id: 'post_fixture', status: 'actioned' }],
      moderation_actions: [{ id: 'old_decision', report_id: 'report_fixture', action: 'hide_content' }],
    }
    const after = {
      ...before,
      posts: [{ ...before.posts[0], moderation_status: 'active' }],
      moderation_actions: [...before.moderation_actions, { id: 'restore_decision', report_id: 'report_fixture', action: 'restore_content' }],
    }
    const saved = enforceMutationLimits(before, after, context)
    expect(saved).toEqual([window('moderation:decide', RATE_LIMITS['moderation:decide'].limit)])
    const committed = { ...after, mutation_limit_windows: saved }
    // Even a redundant restore can produce an audit/notification side effect.
    expect(() => enforceMutationLimits(committed, {
      ...committed,
      moderation_actions: [...committed.moderation_actions, { id: 'redundant_restore', report_id: 'report_fixture', action: 'restore_content' }],
    }, context)).toThrow(MutationLimitError)
  })

  it('never skips ordinary edits or an unrelated target while charging a decision', () => {
    const before = {
      ...snapshot('post:write', RATE_LIMITS['post:write'].limit),
      posts: [
        { id: 'reported_post', body: 'Original', moderation_status: 'active' },
        { id: 'other_post', body: 'Other', moderation_status: 'active' },
      ],
      reports: [{ id: 'report_fixture', post_id: 'reported_post', status: 'open' }],
    }
    const reviewed = {
      ...before,
      reports: [{ ...before.reports[0], status: 'actioned' }],
      moderation_actions: [{ id: 'decision_fixture', report_id: 'report_fixture' }],
    }
    expect(() => enforceMutationLimits(before, {
      ...reviewed,
      posts: [{ ...before.posts[0], body: 'Real edit', moderation_status: 'hidden' }, before.posts[1]],
    }, context)).toThrow(MutationLimitError)
    expect(() => enforceMutationLimits(before, {
      ...reviewed,
      posts: [before.posts[0], { ...before.posts[1], moderation_status: 'hidden' }],
    }, context)).toThrow(MutationLimitError)
  })

  it('gates orphan moderation changes and requires a verified actor for decision effects', () => {
    const before = { posts: [{ id: 'post_fixture', moderation_status: 'active' }] }
    const after = { posts: [{ id: 'post_fixture', moderation_status: 'hidden' }] }
    expect(enforceMutationLimits(before, after, context)).toEqual([window('post:write', 1)])
    expect(() => enforceMutationLimits(before, after, { ...context, actorUserId: null })).toThrow(/verified session user/)
    expect(() => enforceMutationLimits({
      reports: [{ id: 'report_fixture', status: 'actioned' }],
    }, {
      reports: [{ id: 'report_fixture', status: 'actioned' }],
      moderation_actions: [{ id: 'decision_fixture', report_id: 'report_fixture' }],
    }, { ...context, actorUserId: null })).toThrow(/verified session user/)
  })

  it('counts multiple decision audits instead of collapsing them into one report update', () => {
    const before = {
      reports: [{ id: 'report_fixture', post_id: 'post_fixture', status: 'open' }],
    }
    const after = {
      reports: [{ ...before.reports[0], status: 'actioned' }],
      moderation_actions: [
        { id: 'decision_fixture', report_id: 'report_fixture', action: 'hide_content' },
        { id: 'restore_fixture', report_id: 'report_fixture', action: 'restore_content' },
      ],
    }
    expect(enforceMutationLimits(before, after, context)).toEqual([window('moderation:decide', 2)])
  })

  it('shares a subject budget across fresh snapshots/modules and isolates a second user', () => {
    const first = enforceMutationLimits({}, { messages: [{ id: 'first' }] }, context)
    const before = { mutation_limit_windows: first, messages: [{ id: 'first' }] }
    const after = { ...before, messages: [{ id: 'first' }, { id: 'second' }] }
    const saved = enforceMutationLimits(before, after, { ...context, actorUserId: 'usr_other' })
    expect(saved.find(row => row.subject === context.actorUserId)?.hits).toBe(1)
    expect(saved.find(row => row.subject === 'usr_other')?.hits).toBe(1)
  })

  it('has stable ledger ordering without consulting the host locale', () => {
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Ambient locale must not affect a deterministic commit hook')
    })
    try {
      expect(enforceMutationLimits({}, {
        posts: [{ id: 'post' }], messages: [{ id: 'message' }],
      }, context)).toEqual([window('message:write', 1), window('post:write', 1)])
    } finally {
      locale.mockRestore()
    }
  })

  it('opens the next fixed window with an exact retry interval and never resets the old one', () => {
    const before = snapshot('message:write', RATE_LIMITS['message:write'].limit)
    const after = { ...before, messages: [{ id: 'next_message' }] }
    try {
      enforceMutationLimits(before, after, context)
      throw new Error('Expected a refusal')
    } catch (error) {
      expect(error).toMatchObject({ code: 'rate_limit_exceeded', bucket: 'message:write', retryAfterSeconds: 45 })
    }
    const saved = enforceMutationLimits(before, after, { ...context, nowMs: nowMs + 45_000 })
    expect(saved.filter(row => row.bucket === 'message:write').map(row => row.hits).sort((a, b) => a - b)).toEqual([1, 60])
  })

  it('allows unprotected signup/session tables without inventing an authenticated actor', () => {
    expect(enforceMutationLimits({}, {
      users: [{ id: 'signup' }], profiles: [{ id: 'profile' }], sessions: [{ id: 'session' }],
    }, { actorUserId: null, nowMs })).toEqual([])
    expect(() => enforceMutationLimits({}, { posts: [{ id: 'post' }] }, { actorUserId: null, nowMs })).toThrow(/verified session user/)
  })

  it('refuses domain attempts to edit/drop the ledger instead of resetting budget', () => {
    const before = snapshot('bug:file', 5)
    expect(() => enforceMutationLimits(before, { mutation_limit_windows: [], bug_reports: [{ id: 'next' }] }, context)).toThrow(/Invalid local mutation-limit state/)
    expect(() => enforceMutationLimits(before, { bug_reports: [{ id: 'next' }] }, context)).toThrow(/Invalid local mutation-limit state/)
  })

  it.each([
    { mutation_limit_windows: [{ ...window('bug:file', 5), hits: -1 }] },
    { mutation_limit_windows: [{ ...window('bug:file', 5), hits: Number.NaN }] },
    { mutation_limit_windows: [{ ...window('bug:file', 5), window_start_ms: nowMs + 100000 }] },
    { mutation_limit_windows: [window('bug:file', 5), window('bug:file', 5)] },
    { mutation_limit_windows: [{ ...window('bug:file', 5), bucket: 'attacker:budget' }] },
    { posts: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { posts: [null] },
  ])('fails closed on corrupt state: %j', before => {
    expect(() => enforceMutationLimits(before, structuredClone(before), context)).toThrow(/Invalid local mutation-limit state/)
  })

  it('prunes expired windows deterministically and preserves a live one', () => {
    const expired = window('bug:file', 5)
    expired.window_start_ms -= 2 * 24 * 60 * 60_000
    expired.id = `${expired.bucket}:${expired.subject}:${expired.window_start_ms}`
    const before = { mutation_limit_windows: [expired, window('message:write', 3)] }
    expect(enforceMutationLimits(before, structuredClone(before), context)).toEqual([window('message:write', 3)])
  })

  it('refuses capacity exhaustion without evicting another user’s live budget', () => {
    const before = {
      mutation_limit_windows: Array.from({ length: 10_000 }, (_, index) =>
        window('bug:file', 5, `usr_capacity_${index}`),
      ),
    }
    const after = { ...before, bug_reports: [{ id: 'new_subject_fixture' }] }
    expect(() => enforceMutationLimits(before, after, context)).toThrow(/Invalid local mutation-limit state/)
    expect(before.mutation_limit_windows).toHaveLength(10_000)
    expect(before.mutation_limit_windows.every(row => row.hits === 5)).toBe(true)
  })
})

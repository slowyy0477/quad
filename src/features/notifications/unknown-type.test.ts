import { describe, expect, it } from 'vitest'
import { emptyTargetIndex, resolveTarget, toNotificationView } from './plan'
import type { NotificationInput, TargetIndex } from './plan'

// Pure presentation-contract tests only: no query, action, component, auth,
// environment or storage boundary is opened.
function activity(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    id: 'ntf_fixture', type: 'follow', body: null, is_read: false,
    created_at: '2026-11-02T00:00:00.000Z',
    post_id: null, comment_id: null, project_id: null, idea_id: null,
    event_id: null, opportunity_id: null, conversation_id: null,
    actor: {
      id: 'prf_peer', username: 'fixture-peer', display_name: 'Fixture Peer', avatar_url: null,
    },
    ...overrides,
  }
}

function readableTargets(): TargetIndex {
  return {
    posts: new Set(['post_fixture']),
    comments: new Set(['comment_fixture']),
    projects: new Map([['project_fixture', 'fixture-project']]),
    ideas: new Set(['idea_fixture']),
    events: new Set(['event_fixture']),
    opportunities: new Set(['opportunity_fixture']),
    conversations: new Set(['conversation_fixture']),
  }
}

const namedTargets: Partial<NotificationInput> = {
  post_id: 'post_fixture', comment_id: 'comment_fixture', project_id: 'project_fixture',
  idea_id: 'idea_fixture', event_id: 'event_fixture', opportunity_id: 'opportunity_fixture',
  conversation_id: 'conversation_fixture',
}

const supportedTypes = [
  'post_like', 'post_comment', 'comment_reply', 'comment_like', 'content_hidden', 'content_removed',
  'project_star', 'project_application', 'project_application_accepted', 'project_application_rejected',
  'project_invite', 'project_invite_accepted', 'project_invite_declined', 'project_member_joined',
  'project_ownership_received',
  'idea_vote', 'idea_interest', 'idea_comment',
  'event_cancelled', 'event_rescheduled', 'event_reminder',
  'opportunity_deadline', 'message', 'follow', 'connection_request', 'connection_accepted',
  'skill_endorsement', 'achievement_awarded',
]

describe('supported notification families stay distinct from unknown types', () => {
  it.each(supportedTypes.map(type => ({ type })))('does not flag supported "$type" as unknown', ({ type }) => {
    const view = toNotificationView(activity({ ...namedTargets, type }), readableTargets())
    expect(view.unknownType).toBe(false)
    expect(view.type).toBe(type)
  })

  it.each([
    { type: 'post_like', target: { post_id: 'post_fixture' } },
    { type: 'project_star', target: { project_id: 'project_fixture' } },
    { type: 'idea_vote', target: { idea_id: 'idea_fixture' } },
    { type: 'event_reminder', target: { event_id: 'event_fixture' } },
    { type: 'opportunity_deadline', target: { opportunity_id: 'opportunity_fixture' } },
    { type: 'message', target: { conversation_id: 'conversation_fixture' } },
  ])('keeps known "$type" known when its named target is unavailable', ({ type, target }) => {
    const view = toNotificationView(activity({ type, ...target }), emptyTargetIndex())
    expect(view).toMatchObject({
      unknownType: false, target: null, targetUnavailable: true,
    })
  })

  it('does not turn a supported follow with an unreadable actor into an unknown or unavailable target', () => {
    expect(toNotificationView(activity({ type: 'follow', actor: null }), emptyTargetIndex()))
      .toMatchObject({ unknownType: false, target: null, targetUnavailable: false })
  })
})

const unknownTypes = [
  { label: 'empty', type: '' },
  { label: 'whitespace-only', type: ' ' },
  { label: 'new nonempty activity', type: 'future_notification' },
  { label: 'unsupported post prefix', type: 'post_future' },
  { label: 'unsupported project prefix', type: 'project_future' },
  { label: 'unsupported idea prefix', type: 'idea_future' },
  { label: 'unsupported event prefix', type: 'event_future' },
  { label: 'unsupported opportunity prefix', type: 'opportunity_future' },
  { label: 'unsupported message prefix', type: 'message_future' },
  { label: 'unsupported follow prefix', type: 'follow_future' },
  { label: 'unsupported connection prefix', type: 'connection_future' },
  { label: 'unsupported skill prefix', type: 'skill_future' },
  { label: 'unsupported achievement prefix', type: 'achievement_future' },
  { label: 'wrong-case supported word', type: 'MESSAGE' },
  { label: 'supported word with trailing space', type: 'post_like ' },
]

describe.each([
  { label: 'no named target returned', makeIndex: emptyTargetIndex },
  { label: 'all named targets returned', makeIndex: readableTargets },
])('unknown types with $label', ({ makeIndex }) => {
  it.each(unknownTypes)('flags $label type without inferring a destination or unsupported unavailability', ({ type }) => {
    // Even readable actors, target IDs and familiar string prefixes cannot
    // authorize the plan to invent a family for a type this build does not know.
    const body = 'SYNTHETIC_UNCLASSIFIED_NOTIFICATION_BODY'
    const row = activity({ ...namedTargets, type, body })
    const index = makeIndex()
    expect(resolveTarget(row, index)).toEqual({ target: null, unavailable: false })
    expect(toNotificationView(row, index)).toMatchObject({
      id: row.id, type, is_read: row.is_read, created_at: row.created_at,
      unknownType: true, target: null, targetUnavailable: false,
      detail: null,
    })
    expect(JSON.stringify(toNotificationView(row, index))).not.toContain(body)
    expect(row.body).toBe(body)
  })
})

describe('message-body suppression is retained independently of type classification', () => {
  it.each([
    { label: 'readable conversation', conversationId: 'conversation_fixture', makeIndex: readableTargets, unavailable: false },
    { label: 'unavailable conversation', conversationId: 'conversation_fixture', makeIndex: emptyTargetIndex, unavailable: true },
    { label: 'no named conversation', conversationId: null, makeIndex: emptyTargetIndex, unavailable: false },
  ])('suppresses an unsanitized original message body with $label', ({ conversationId, makeIndex, unavailable }) => {
    const originalBody = 'SYNTHETIC_PRIVATE_MESSAGE_BODY'
    const row = activity({ type: 'message', body: originalBody, conversation_id: conversationId })
    const view = toNotificationView(row, makeIndex())
    expect(view).toMatchObject({
      unknownType: false,
      detail: null,
      text: 'Fixture Peer sent you a message.',
      targetUnavailable: unavailable,
    })
    expect(JSON.stringify(view)).not.toContain(originalBody)
    // The pure guard protects callers even when the query did not sanitize the
    // input; it does not need to rewrite or mutate that input to hide the body.
    expect(row.body).toBe(originalBody)
  })

  it.each([{ type: 'content_hidden' }, { type: 'content_removed' }])(
    'still retains the intended moderation detail for "$type"', ({ type }) => {
      const row = activity({ type, body: 'Synthetic moderation explanation.' })
      expect(toNotificationView(row, emptyTargetIndex()))
        .toMatchObject({ unknownType: false, detail: row.body })
    },
  )
})

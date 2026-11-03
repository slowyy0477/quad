import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { notFound, redirect } from 'next/navigation'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyTargetIndex, toNotificationView } from '@/features/notifications/plan'
import type {
  getNotifications,
  getTargetIndex,
  NotificationRow,
} from '@/features/notifications/queries'
import {
  loadNotificationHeaderPreview,
  NotificationHeaderPreviewContent,
} from './notification-header-preview'

const readers = vi.hoisted(() => ({
  list: vi.fn<typeof getNotifications>(),
  targets: vi.fn<typeof getTargetIndex>(),
}))
const actions = vi.hoisted(() => ({
  markOneReadAction: vi.fn(async (data: FormData) => { void data }),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/features/notifications/queries', () => ({
  getNotifications: readers.list,
  getTargetIndex: readers.targets,
}))
vi.mock('@/features/notifications/actions', () => ({
  // The marker retains the original FormData-only spy seam. The production
  // progressive action also returns a server-confirmed outcome; this mock is
  // presentation coverage, not proof of a database write.
  markOneReadFormAction: async (_previous: unknown, data: FormData) => {
    await actions.markOneReadAction(data)
    return { ok: true, marked: 1 }
  },
}))
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) => (
    <a {...props} href={href} data-prefetch={prefetch === false ? 'off' : undefined}>{children}</a>
  ),
}))

type ListResult = Awaited<ReturnType<typeof getNotifications>>
type TargetResult = Awaited<ReturnType<typeof getTargetIndex>>

const BODY_CANARY = 'SYNTHETIC_PRIVATE_NOTIFICATION_BODY_DO_NOT_PREVIEW'
const ERROR_CANARY = 'SYNTHETIC_PRIVATE_PROVIDER_ERROR_DO_NOT_RENDER'
const EXTRA_CANARY = 'SYNTHETIC_UNREQUESTED_ROW_FIELD_DO_NOT_FORWARD'

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'ntf_headerone',
    type: 'post_like',
    body: null,
    is_read: false,
    created_at: '2026-11-02T07:45:00.000Z',
    post_id: 'post_headerone',
    comment_id: null,
    project_id: null,
    idea_id: null,
    event_id: null,
    opportunity_id: null,
    conversation_id: null,
    actor: { id: 'profile_actor', username: 'bob', display_name: 'Bob', avatar_url: null },
    ...overrides,
  }
}

beforeEach(() => {
  readers.list.mockReset()
  readers.targets.mockReset()
  actions.markOneReadAction.mockClear()
  readers.list.mockResolvedValue({ notifications: [row()], nextCursor: null, error: null })
  readers.targets.mockResolvedValue({ index: emptyTargetIndex(), error: null })
})

afterEach(cleanup)

async function ready() {
  const model = await loadNotificationHeaderPreview()
  expect(model.status).toBe('ready')
  if (model.status !== 'ready') throw new Error('Expected a real ready preview, not a skipped assertion.')
  return model
}

function frameworkFailure(cause: () => never): unknown {
  try { cause() } catch (error) { return error }
  throw new Error('The framework call did not throw its control-flow exception.')
}

describe('notification header preparation — boundary unit coverage, not hosted acceptance', () => {
  it('bounds authorized rows to five before target reads and strips bodies/unrequested fields', async () => {
    const rows = Array.from({ length: 7 }, (_, index) => row({
      id: `ntf_header${index}`,
      post_id: `post_header${index}`,
      body: `${BODY_CANARY}_${index}`,
    }))
    const enriched = rows.map((notification) => ({
      ...notification,
      owner_payload: EXTRA_CANARY,
      actor: notification.actor ? { ...notification.actor, unrequested_note: EXTRA_CANARY } : null,
    }))
    readers.list.mockResolvedValue({ notifications: enriched, nextCursor: null, error: null })
    const model = await ready()
    expect(readers.list).toHaveBeenCalledExactlyOnceWith({ limit: 5 })
    expect(readers.targets).toHaveBeenCalledExactlyOnceWith(
      rows.slice(0, 5).map((notification) => ({ ...notification, body: null })),
    )
    expect(model.views.map((view) => view.id)).toEqual(rows.slice(0, 5).map((notification) => notification.id))
    expect(model.views.every((view) => view.detail === null)).toBe(true)
    expect(JSON.stringify(model)).not.toContain(BODY_CANARY)
    expect(JSON.stringify(model)).not.toContain(EXTRA_CANARY)
    expect(JSON.stringify(readers.targets.mock.calls)).not.toContain(EXTRA_CANARY)
    expect(enriched.every((notification) => notification.body?.startsWith(BODY_CANARY))).toBe(true)
    expect(enriched.every((notification) => notification.owner_payload === EXTRA_CANARY)).toBe(true)
    const { container } = render(<NotificationHeaderPreviewContent model={model} />)
    expect(within(screen.getByRole('list', { name: 'Recent notifications' })).getAllByRole('listitem')).toHaveLength(5)
    expect(container.innerHTML).not.toContain(BODY_CANARY)
    expect(container.innerHTML).not.toContain(EXTRA_CANARY)
    expect(container.innerHTML).not.toContain('ntf_header5')
    expect(container.innerHTML).not.toContain('ntf_header6')
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('keeps readable resolved destinations and a bodyless message activity sentence', async () => {
    const rows = [
      row({ id: 'ntf_post', type: 'post_comment', comment_id: 'comment_readable' }),
      row({ id: 'ntf_project', type: 'project_application', post_id: null, project_id: 'project_readable' }),
      row({ id: 'ntf_message', type: 'message', post_id: null, conversation_id: 'conversation_readable', body: BODY_CANARY }),
      row({ id: 'ntf_follow', type: 'follow', post_id: null, actor: null }),
    ]
    readers.list.mockResolvedValue({ notifications: rows, nextCursor: null, error: null })
    readers.targets.mockResolvedValue({
      index: {
        ...emptyTargetIndex(),
        posts: new Set(['post_headerone']),
        comments: new Set(['comment_readable']),
        projects: new Map([['project_readable', 'campus-garden']]),
        conversations: new Set(['conversation_readable']),
      },
      error: null,
    })
    const model = await ready()
    expect(model.linksResolved).toBe(true)
    const { container } = render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('link', { name: 'Open the post' })).toHaveAttribute('href', '/post/post_headerone#comment-comment_readable')
    expect(screen.getByRole('link', { name: 'Open the project' })).toHaveAttribute('href', '/projects/campus-garden')
    expect(screen.getByRole('link', { name: 'Open the conversation' })).toHaveAttribute('href', '/messages?c=conversation_readable')
    expect(screen.getByText('Bob sent you a message.')).toBeVisible()
    expect(screen.getByText('Someone started following you.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Open their profile' })).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain(BODY_CANARY)
    expect(JSON.stringify(model)).not.toContain(BODY_CANARY)
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('retains the private invitation inbox without inferring private project access', async () => {
    readers.list.mockResolvedValue({
      notifications: [row({ type: 'project_invite', post_id: null, project_id: 'project_private' })],
      nextCursor: null,
      error: null,
    })
    const model = await ready()
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('link', { name: 'Review invitation' })).toHaveAttribute('href', '/projects/invitations')
    expect(screen.queryByRole('link', { name: 'Open the project' })).not.toBeInTheDocument()
    expect(screen.queryByText('That is no longer available to you.')).not.toBeInTheDocument()
  })

  it.each([
    { label: 'reported failure', notifications: null, error: ERROR_CANARY },
    { label: 'missing rows', notifications: null, error: null },
    { label: 'error alongside rows', notifications: [row()], error: ERROR_CANARY },
  ])('shows an error, never an empty preview, for $label', async ({ notifications, error }) => {
    readers.list.mockResolvedValue({ notifications, nextCursor: null, error })
    const model = await loadNotificationHeaderPreview()
    expect(model).toEqual({ status: 'error' })
    expect(readers.targets).not.toHaveBeenCalled()
    const { container } = render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Your notification preview could not be loaded.')
    expect(screen.queryByText('No notifications yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Recent notifications' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all notifications' })).toHaveAttribute('href', '/notifications')
    expect(container.innerHTML).not.toContain(ERROR_CANARY)
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'null result', result: null },
    { label: 'undefined result', result: undefined },
    { label: 'missing rows member', result: { error: null, nextCursor: null } },
    { label: 'non-array rows', result: { notifications: {}, error: null, nextCursor: null } },
    { label: 'missing explicit success status', result: { notifications: [], nextCursor: null } },
    { label: 'null row', result: { notifications: [null], error: null, nextCursor: null } },
    { label: 'missing id', result: { notifications: [{ ...row(), id: undefined }], error: null, nextCursor: null } },
    { label: 'empty id', result: { notifications: [{ ...row(), id: '' }], error: null, nextCursor: null } },
    { label: 'missing type', result: { notifications: [{ ...row(), type: undefined }], error: null, nextCursor: null } },
    { label: 'non-boolean read state', result: { notifications: [{ ...row(), is_read: 'false' }], error: null, nextCursor: null } },
    { label: 'missing timestamp', result: { notifications: [{ ...row(), created_at: undefined }], error: null, nextCursor: null } },
    { label: 'missing target member', result: { notifications: [{ ...row(), project_id: undefined }], error: null, nextCursor: null } },
    { label: 'malformed actor', result: { notifications: [{ ...row(), actor: [] }], error: null, nextCursor: null } },
    { label: 'malformed actor identity', result: { notifications: [{ ...row(), actor: { ...row().actor, username: 42 } }], error: null, nextCursor: null } },
  ])('rejects $label as a provider error without partial rows, fallbacks or hidden read controls', async ({ result }) => {
    // Deliberately violate the reader type at its runtime boundary. This is not
    // a hosted/provider acceptance simulation and no SQL/auth seam is mocked.
    readers.list.mockResolvedValue(result as unknown as ListResult)
    const model = await loadNotificationHeaderPreview()
    expect(model).toEqual({ status: 'error' })
    expect(readers.targets).not.toHaveBeenCalled()
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.queryByText('No notifications yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument()
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('rejects a malformed row instead of silently keeping a valid partial preview', async () => {
    readers.list.mockResolvedValue({
      notifications: [row(), { ...row(), id: '' }],
      nextCursor: null,
      error: null,
    })
    expect(await loadNotificationHeaderPreview()).toEqual({ status: 'error' })
    expect(readers.targets).not.toHaveBeenCalled()
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('shows a genuine empty result without target lookups or invented read controls', async () => {
    readers.list.mockResolvedValue({ notifications: [], nextCursor: null, error: null })
    const model = await loadNotificationHeaderPreview()
    expect(model).toEqual({ status: 'empty' })
    expect(readers.targets).not.toHaveBeenCalled()
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByText('No notifications yet.')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all notifications' })).toHaveAttribute('href', '/notifications')
    expect(screen.getByRole('link', { name: 'View all notifications' })).toHaveAttribute('data-prefetch', 'off')
  })

  it('handles a thrown reader error without rendering private diagnostic text', async () => {
    readers.list.mockRejectedValue(new Error(ERROR_CANARY))
    const model = await loadNotificationHeaderPreview()
    expect(model).toEqual({ status: 'error' })
    expect(readers.targets).not.toHaveBeenCalled()
    const { container } = render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('alert')).toBeVisible()
    expect(container.innerHTML).not.toContain(ERROR_CANARY)
  })

  it.each(['reported', 'thrown'])('distinguishes a %s target failure from an unavailable target in model and markup', async (kind) => {
    const partialIndex = { ...emptyTargetIndex(), posts: new Set(['post_headerone']) }
    if (kind === 'reported') readers.targets.mockResolvedValue({ index: partialIndex, error: ERROR_CANARY })
    else readers.targets.mockRejectedValue(new Error(ERROR_CANARY))
    const model = await ready()
    expect(model.linksResolved).toBe(false)
    expect(model.views.every((view) => view.target === null && view.targetUnavailable === false)).toBe(true)
    const { container } = render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('status')).toHaveTextContent('Notification links could not be resolved just now.')
    expect(screen.queryByRole('link', { name: 'Open the post' })).not.toBeInTheDocument()
    expect(screen.queryByText('That is no longer available to you.')).not.toBeInTheDocument()
    expect(screen.queryByText('No notifications yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeVisible()
    expect(container.innerHTML).not.toContain(ERROR_CANARY)
  })

  it.each([
    { label: 'null result', result: null },
    { label: 'missing explicit success status', result: { index: emptyTargetIndex() } },
    { label: 'missing index', result: { error: null } },
    { label: 'null index', result: { index: null, error: null } },
    { label: 'array instead of Set', result: { index: { ...emptyTargetIndex(), posts: ['post_headerone'] }, error: null } },
    { label: 'invalid selected id', result: { index: { ...emptyTargetIndex(), posts: new Set([42]) }, error: null } },
    { label: 'invalid selected slug', result: { index: { ...emptyTargetIndex(), projects: new Map([['project_readable', null]]) }, error: null } },
  ])('treats $label as unresolved targets, never a successful unavailable conclusion', async ({ result }) => {
    readers.targets.mockResolvedValue(result as unknown as TargetResult)
    const model = await ready()
    expect(model.linksResolved).toBe(false)
    expect(model.views.every((view) => view.target === null && view.targetUnavailable === false)).toBe(true)
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.queryByText('That is no longer available to you.')).not.toBeInTheDocument()
    expect(screen.queryByText('No notifications yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeVisible()
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('does not retain inferred actor/inbox destinations when the whole target lookup failed', async () => {
    readers.list.mockResolvedValue({
      notifications: [
        row({ id: 'ntf_follow', type: 'follow', post_id: null }),
        row({ id: 'ntf_invite', type: 'project_invite', post_id: null, project_id: 'project_private' }),
      ],
      nextCursor: null,
      error: null,
    })
    readers.targets.mockResolvedValue({ index: emptyTargetIndex(), error: ERROR_CANARY })
    const model = await ready()
    expect(model.linksResolved).toBe(false)
    expect(model.views.map((view) => view.target)).toEqual([null, null])
    expect(model.views.map((view) => view.targetUnavailable)).toEqual([false, false])
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.queryByRole('link', { name: 'Open their profile' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Review invitation' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all notifications' })).toBeVisible()
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('reports a successfully resolved but unreadable/deleted target as the same unavailable outcome', async () => {
    const model = await ready()
    expect(model.linksResolved).toBe(true)
    expect(model.views[0]?.targetUnavailable).toBe(true)
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.getByText('That is no longer available to you.')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open the post' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeVisible()
  })

  it.each([
    { where: 'list', kind: 'redirect', cause: () => redirect('/login') },
    { where: 'list', kind: 'not-found', cause: () => notFound() },
    { where: 'targets', kind: 'redirect', cause: () => redirect('/login') },
    { where: 'targets', kind: 'not-found', cause: () => notFound() },
  ])('preserves actual Next $kind control flow from $where', async ({ where, cause }) => {
    const error = frameworkFailure(cause)
    if (where === 'list') readers.list.mockRejectedValue(error)
    else readers.targets.mockRejectedValue(error)
    await expect(loadNotificationHeaderPreview()).rejects.toBe(error)
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })

  it('caps presentation and clears details at the synchronous server seam too', () => {
    const views = Array.from({ length: 7 }, (_, index) => ({
      ...toNotificationView(row({ id: `ntf_seam${index}` }), emptyTargetIndex()),
      detail: BODY_CANARY,
    }))
    const { container } = render(
      <NotificationHeaderPreviewContent model={{ status: 'ready', linksResolved: true, views }} />,
    )
    expect(within(screen.getByRole('list', { name: 'Recent notifications' })).getAllByRole('listitem')).toHaveLength(5)
    expect(container.innerHTML).not.toContain(BODY_CANARY)
    expect(container.innerHTML).not.toContain('ntf_seam5')
    expect(container.innerHTML).not.toContain('ntf_seam6')
  })

  it('retains the existing single-row server action and exact real notification id', async () => {
    const user = userEvent.setup()
    const model = await ready()
    render(<NotificationHeaderPreviewContent model={model} />)
    const list = screen.getByRole('list', { name: 'Recent notifications' })
    const item = within(list).getByRole('listitem')
    const mark = within(item).getByRole('button', { name: 'Mark as read' })
    expect(mark).toHaveAttribute('type', 'submit')
    expect(item.querySelector('input[name="id"]')).toHaveValue('ntf_headerone')
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
    await user.click(mark)
    await waitFor(() => expect(actions.markOneReadAction).toHaveBeenCalledTimes(1))
    expect(actions.markOneReadAction.mock.calls[0]?.[0].get('id')).toBe('ntf_headerone')
  })

  it('does not render a read form for already-read activity', async () => {
    readers.list.mockResolvedValue({ notifications: [row({ is_read: true })], nextCursor: null, error: null })
    const model = await ready()
    render(<NotificationHeaderPreviewContent model={model} />)
    expect(screen.queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument()
    expect(actions.markOneReadAction).not.toHaveBeenCalled()
  })
})

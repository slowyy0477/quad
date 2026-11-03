import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountControls } from './account-controls'
import { DeletionReceiptPanel } from './deletion-receipt'
import type { AccountSummary } from '../types'

const fetchMock = vi.fn<typeof fetch>()
const createObjectURL = vi.fn(() => 'blob:s10-synthetic-export')
const revokeObjectURL = vi.fn()
const summary: AccountSummary = {
  mode: 'local', hostedCleanupEnabled: false,
  blockers: { projects: [], moreProjects: false, inconsistentOwnerRole: false, lastAdministrator: false, sharedMedia: false, ownedStorageBucket: false },
}
const receiptId = '72ad2518-0067-40a9-bb23-834dc5b2573e'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  createObjectURL.mockReturnValue('blob:s10-synthetic-export')
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function exportSection() { return screen.getByRole('region', { name: 'Export your data' }) }
function deletionSection() { return screen.getByRole('region', { name: 'Delete your account' }) }
function response(body: unknown, status = 200) { return Response.json(body, { status }) }

async function fillDeletion() {
  const user = userEvent.setup()
  const region = within(deletionSection())
  await user.type(region.getByLabelText('Current password'), 's10 private current password')
  await user.type(region.getByLabelText('Type DELETE MY ACCOUNT exactly'), 'DELETE MY ACCOUNT')
  await user.click(region.getByRole('checkbox'))
  return user
}

describe('S10 accessible account settings controls', () => {
  it('labels sensitive fields, states bounded/privacy exclusions, and exposes no stored credential values', () => {
    const { container } = render(<AccountControls summary={summary} />)
    for (const field of screen.getAllByLabelText('Current password')) {
      expect(field).toHaveAttribute('type', 'password')
      expect(field).toHaveAttribute('autocomplete', 'current-password')
      expect(field).toHaveAttribute('aria-describedby')
      expect(field).not.toHaveAttribute('value')
    }
    expect(screen.getByLabelText('Rows per section')).toHaveAttribute('max', '100')
    expect(screen.getByLabelText('Next-page cursor (optional)')).toBeDisabled()
    expect(screen.getByText(/2 MiB per response/)).toBeInTheDocument()
    expect(screen.getByText(/Other senders’ messages/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeRequired()
    expect(container.innerHTML).not.toContain('password_hash')
  })

  it('downloads actual JSON with POST-only credentials, then clears password fields and offers verified next pages', async () => {
    fetchMock.mockResolvedValue(response({
      schema_version: 1, sections: { posts: { records: [{ id: 's10_a', body: 'own synthetic body' }], next_cursor: 's10_a' } },
    }))
    render(<AccountControls summary={summary} />)
    const user = userEvent.setup()
    const region = within(exportSection())
    await user.type(region.getByLabelText('Current password'), 's10 export credential')
    await user.click(region.getByRole('button', { name: 'Download own data' }))
    expect(await region.findByRole('status')).toHaveTextContent('Export downloaded')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/export')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect(JSON.parse(String(init!.body))).toEqual({ password: 's10 export credential', totpCode: '', limit: 25 })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:s10-synthetic-export')
    expect(region.getByLabelText('Current password')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Next page: Own posts' }))
    expect(region.getByLabelText('Data section')).toHaveValue('posts')
    expect(region.getByLabelText('Next-page cursor (optional)')).toHaveValue('s10_a')
    expect(region.getByLabelText('Current password')).toHaveFocus()
  })

  it('disables both sensitive actions while verification is pending and announces safe errors', async () => {
    let finish!: (value: Response) => void
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<AccountControls summary={summary} />)
    const user = userEvent.setup()
    const region = within(exportSection())
    await user.type(region.getByLabelText('Current password'), 's10 export credential')
    await user.click(region.getByRole('button', { name: 'Download own data' }))
    expect(region.getByRole('status')).toHaveTextContent('Verifying')
    expect(screen.getByRole('button', { name: 'Confirm account deletion' })).toBeDisabled()
    expect(region.getByLabelText('Current password')).toBeDisabled()
    await act(async () => { finish(response({ ok: false, code: 'invalid_password', privateProviderError: 'S10-NOT-RENDERED' }, 403)) })
    expect(await region.findByRole('alert')).toHaveTextContent('current password could not be verified')
    expect(screen.queryByText('S10-NOT-RENDERED')).not.toBeInTheDocument()
    expect(region.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Confirm account deletion' })).toBeEnabled()
  })

  it('requires exact confirmation and acknowledgement even when a form submit bypasses browser validation', async () => {
    render(<AccountControls summary={summary} />)
    const region = within(deletionSection())
    const form = region.getByRole('button', { name: 'Confirm account deletion' }).closest('form')!
    fireEvent.submit(form)
    expect(await region.findByRole('alert')).toHaveTextContent('Type DELETE MY ACCOUNT exactly')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits an explicit confirmed request once and treats a queued receipt as incomplete', async () => {
    fetchMock.mockResolvedValue(response({ ok: true, value: { id: receiptId, state: 'queued', phase: 'media', subject_id: 'S10-NOT-PUBLIC' } }, 202))
    render(<AccountControls summary={summary} />)
    const user = await fillDeletion()
    await user.click(screen.getByRole('button', { name: 'Confirm account deletion' }))
    expect(await screen.findByRole('status')).toHaveTextContent('durably queued')
    expect(screen.getByRole('status')).toHaveTextContent('has not completed')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/deletion')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect(JSON.parse(String(init!.body))).toMatchObject({
      password: 's10 private current password', confirmation: 'DELETE MY ACCOUNT', acknowledge: true,
      idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })
    expect(screen.getByRole('textbox', { name: 'Deletion receipt' })).toHaveValue(receiptId)
    expect(screen.getByRole('button', { name: 'Download own data' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Confirm account deletion' })).not.toBeInTheDocument()
    expect(screen.queryByText('S10-NOT-PUBLIC')).not.toBeInTheDocument()
  })

  it('keeps one request key on interrupted retries without claiming that the request was not queued', async () => {
    fetchMock.mockRejectedValue(new Error('Synthetic response interrupted'))
    render(<AccountControls summary={summary} />)
    const user = await fillDeletion()
    await user.click(screen.getByRole('button', { name: 'Confirm account deletion' }))
    expect(await within(deletionSection()).findByRole('alert')).toHaveTextContent('lost response does not prove')
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]!.body))
    await user.type(within(deletionSection()).getByLabelText('Current password'), 's10 private current password')
    await user.click(screen.getByRole('button', { name: 'Confirm account deletion' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]!.body)).idempotencyKey).toBe(first.idempotencyKey)
  })

  it('blocks unresolved ownership with a working project link and no deletion request', async () => {
    render(<AccountControls summary={{
      ...summary, blockers: { ...summary.blockers, projects: [{ id: 's10_project', slug: 's10-project', title: 'Synthetic shared project', deleted: true }] },
    }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('No deletion has been queued')
    expect(screen.getByRole('link', { name: 'Synthetic shared project' })).toHaveAttribute('href', '/projects/s10-project')
    expect(screen.getByRole('alert')).toHaveTextContent('soft-deleted')
    expect(screen.getByRole('button', { name: 'Confirm account deletion' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download own data' })).toBeEnabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains provider/MFA assurance and never implies an enabled worker was deployed', () => {
    render(<AccountControls summary={{ ...summary, mode: 'supabase', hostedCleanupEnabled: true }} />)
    expect(screen.getAllByLabelText('Authenticator code (if enrolled)')).toHaveLength(2)
    expect(screen.getAllByText(/email\/recovery links alone are not enough/i)).toHaveLength(2)
    expect(screen.getByText(/does not verify that a worker is running or deployed/)).toBeInTheDocument()
  })
})

describe('S10 anonymous status-only receipt control', () => {
  it('checks a receipt only on explicit submit, sends it in POST JSON, and announces retry/completion truthfully', async () => {
    render(<DeletionReceiptPanel initial={{ id: receiptId, state: 'retry', phase: 'auth' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('not complete yet')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(response({ ok: true, value: { id: receiptId, state: 'completed', phase: 'complete' } }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check cleanup status' }))
    expect(await screen.findByRole('status')).toHaveTextContent('cleanup is complete in this data store')
    expect(fetchMock.mock.calls[0]).toEqual(['/api/account/deletion/status', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ receipt: receiptId }),
    })])
  })

  it('reports an invalid/unavailable receipt without rendering provider details', async () => {
    fetchMock.mockResolvedValue(response({ ok: false, code: 'not_found', message: 'S10-PRIVATE-PROVIDER-DETAIL' }, 404))
    render(<DeletionReceiptPanel initial={{ id: receiptId, state: 'failed', phase: 'media' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('not a completed deletion')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check cleanup status' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('receipt could not be checked')
    expect(screen.queryByText('S10-PRIVATE-PROVIDER-DETAIL')).not.toBeInTheDocument()
  })
})

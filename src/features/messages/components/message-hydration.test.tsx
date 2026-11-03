import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('@/features/messages/actions', () => ({ sendMessageAction: send }))

import { MessageComposer } from './message-composer'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  send.mockReset()
  send.mockResolvedValue({ status: 'error', message: 'Synthetic refused send.' })
  window.sessionStorage.clear()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  cleanup()
})

describe('message composer draft hydration boundary', () => {
  it('keeps server-rendered editing and sending disabled until the tab draft can be restored', () => {
    const id = randomUUID()
    const body = 'Synthetic private kept message'
    window.sessionStorage.setItem(`quad.messages.draft.${id}`,
      JSON.stringify({ body, clientNonce: randomUUID() }))
    container = document.createElement('div')
    container.innerHTML = renderToString(<MessageComposer conversationId={id} />)
    document.body.append(container)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your draft…')
    expect(container.textContent).not.toContain(body)
    expect(send).not.toHaveBeenCalled()
  })

  it('restores body and nonce before enabling input, then replaces rather than appends to the kept text', async () => {
    const user = userEvent.setup()
    const id = randomUUID()
    const kept = { body: 'Synthetic original restored message', clientNonce: randomUUID() }
    window.sessionStorage.setItem(`quad.messages.draft.${id}`, JSON.stringify(kept))
    container = document.createElement('div')
    container.innerHTML = renderToString(<MessageComposer conversationId={id} />)
    document.body.append(container)
    const recoverable = vi.fn()
    await act(async () => {
      root = hydrateRoot(container!, <MessageComposer conversationId={id} />,
        { onRecoverableError: recoverable })
    })
    const textbox = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(textbox).toBeEnabled())
    expect(textbox).toHaveValue(kept.body)
    expect(container.querySelector('input[name="clientNonce"]')).toHaveValue(kept.clientNonce)
    expect(screen.queryByText('Loading your draft…')).not.toBeInTheDocument()
    await user.clear(textbox)
    await user.type(textbox, 'Synthetic replacement message')
    expect(textbox).toHaveValue('Synthetic replacement message')
    const replacement = JSON.parse(window.sessionStorage.getItem(`quad.messages.draft.${id}`)!) as typeof kept
    expect(replacement.body).toBe('Synthetic replacement message')
    expect(replacement.clientNonce).not.toBe(kept.clientNonce)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Synthetic refused send.')
    expect(textbox).toHaveValue(replacement.body)
    expect(container.querySelector('input[name="clientNonce"]')).toHaveValue(replacement.clientNonce)
    expect(recoverable).not.toHaveBeenCalled()
  })
})

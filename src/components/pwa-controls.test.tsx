import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PwaControls } from './pwa-controls'

afterEach(() => { vi.restoreAllMocks() })

describe('PWA connection status', () => {
  it('warns immediately when opened while the browser is already offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<PwaControls />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Offline'))
  })
  it('updates the connection warning after offline and online events', async () => {
    render(<PwaControls />)
    fireEvent(window, new Event('offline'))
    expect(screen.getByRole('status')).toHaveTextContent('Offline')
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
})

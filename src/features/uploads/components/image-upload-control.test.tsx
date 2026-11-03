import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImageUploadControl } from './image-upload-control'

const id = '1a78d764-a076-4b6c-84f2-8d15bb9d21df'
const saved = {
  id, url: `/api/images/${id}`, kind: 'avatar', width: 120, height: 80,
  bytes: 900, contentType: 'image/webp',
}
const file = () => new File([new Uint8Array([137, 80, 78, 71])], 'synthetic-only.png', { type: 'image/png' })
const result = (status: number, json: unknown) => ({ status, json: async () => json })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function choose(selected = file()) {
  fireEvent.change(screen.getByLabelText('Profile image'), { target: { files: [selected] } })
}

describe('reusable image upload control', () => {
  it('does not nest/submit its parent form or claim selection is a saved image', () => {
    const submit = vi.fn()
    render(<form onSubmit={submit}><ImageUploadControl target={{ kind: 'avatar' }} /></form>)
    choose()
    expect(screen.getByRole('button', { name: 'Upload image' })).toHaveAttribute('type', 'button')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveTextContent('saved')
    expect(submit).not.toHaveBeenCalled()
  })

  it('disables empty/oversized/non-raster uploads before fetch', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<ImageUploadControl target={{ kind: 'avatar' }} />)
    expect(screen.getByRole('button')).toBeDisabled()
    choose(new File(['<svg/>'], 'synthetic.svg', { type: 'image/svg+xml' }))
    expect(screen.getByRole('alert')).toHaveTextContent('PNG, JPEG')
    expect(screen.getByRole('button')).toBeDisabled()
    choose(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'synthetic.png', { type: 'image/png' }))
    expect(screen.getByRole('alert')).toHaveTextContent('5 MiB')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uploads only raw bytes to the guarded API and calls integration only after a committed 201', async () => {
    const onUploaded = vi.fn()
    const fetch = vi.fn().mockResolvedValue(result(201, { ok: true, image: saved }))
    vi.stubGlobal('fetch', fetch)
    render(<ImageUploadControl target={{ kind: 'avatar' }} onUploaded={onUploaded} />)
    const selected = file()
    choose(selected)
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }))
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(saved))
    expect(fetch).toHaveBeenCalledWith('/api/uploads/avatar', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: selected, headers: { 'Content-Type': 'image/png' },
    }))
    expect(screen.getByRole('img')).toHaveAttribute('src', saved.url)
    expect(screen.getByRole('status')).toHaveTextContent('Image saved')
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('shows pending state and prevents duplicate clicks', async () => {
    let resolve: (value: unknown) => void = () => undefined
    const fetch = vi.fn().mockReturnValue(new Promise(value => { resolve = value }))
    vi.stubGlobal('fetch', fetch)
    render(<ImageUploadControl target={{ kind: 'avatar' }} />)
    choose()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button', { name: 'Checking image…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button'))
    expect(fetch).toHaveBeenCalledOnce()
    resolve(result(201, { ok: true, image: saved }))
    await screen.findByText(/Image saved/)
  })

  it.each([
    result(503, { ok: false, error: { message: 'Private image uploads are not configured.' } }),
    result(200, { ok: true, image: saved }),
    result(201, { ok: true }),
    result(201, { ok: true, image: { ...saved, url: 'https://attacker.example/image' } }),
    result(201, { ok: true, image: { ...saved, kind: 'project-cover' } }),
    result(201, { ok: true, image: { ...saved, bytes: 999999999 } }),
  ])('never assumes success or adopts an untrusted/missing response: %o', async response => {
    const onUploaded = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    render(<ImageUploadControl target={{ kind: 'avatar' }} onUploaded={onUploaded} />)
    choose()
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('alert')).not.toHaveTextContent(/^$/))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(onUploaded).not.toHaveBeenCalled()
    expect(screen.getByRole('button')).not.toBeDisabled()
  })

  it('distinguishes a refresh callback failure from a saved upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result(201, { ok: true, image: saved })))
    render(<ImageUploadControl target={{ kind: 'avatar' }} onUploaded={async () => { throw new Error('fixture refresh failed') }} />)
    choose()
    fireEvent.click(screen.getByRole('button'))
    await screen.findByText('Image saved, but the page could not refresh. Reload to see it.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses an encoded project target and never fetches a raw bucket/signed upload URL', async () => {
    const fetch = vi.fn().mockResolvedValue(result(403, { ok: false, error: { message: 'You cannot change that image.' } }))
    vi.stubGlobal('fetch', fetch)
    render(<ImageUploadControl target={{ kind: 'project-cover', projectId: 'prj_test' }} />)
    fireEvent.change(screen.getByLabelText('Project cover'), { target: { files: [file()] } })
    fireEvent.click(screen.getByRole('button'))
    await screen.findByRole('alert')
    expect(fetch).toHaveBeenCalledWith('/api/uploads/projects/prj_test/cover', expect.anything())
  })

  it('keeps legacy/external initial URLs out of the new private-image preview', () => {
    render(<ImageUploadControl target={{ kind: 'avatar' }} currentImageUrl="https://untrusted.example/legacy.svg" disabled />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Profile image')).toBeDisabled()
    expect(screen.getByText(/not general attachment malware scanning/)).toBeInTheDocument()
  })

  it('aborts an in-flight upload when its target changes', async () => {
    const fetch = vi.fn().mockReturnValue(new Promise(() => undefined))
    vi.stubGlobal('fetch', fetch)
    const view = render(<ImageUploadControl target={{ kind: 'avatar' }} />)
    choose()
    fireEvent.click(screen.getByRole('button'))
    const signal = fetch.mock.calls[0][1].signal as AbortSignal
    view.rerender(<ImageUploadControl target={{ kind: 'project-cover', projectId: 'prj_test' }} />)
    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('button')).toBeDisabled()
  })
})

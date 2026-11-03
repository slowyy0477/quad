import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  window.sessionStorage.clear()
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks() })

describe('durable messaging retry drafts', () => {
  it('keeps the nonce for an unchanged body and rotates it when the body changes', async () => {
    const draft = await import('./draft')
    draft.setDraftBody('cnv_nonce', 'synthetic message')
    const first = draft.snapshotReader('cnv_nonce')()
    expect(first.clientNonce).toMatch(/^[0-9a-f-]{36}$/i)
    draft.setDraftBody('cnv_nonce', 'synthetic message')
    expect(draft.snapshotReader('cnv_nonce')()).toBe(first)
    draft.setDraftBody('cnv_nonce', 'synthetic changed message')
    expect(draft.snapshotReader('cnv_nonce')().clientNonce).not.toBe(first.clientNonce)
  })

  it('restores body and nonce as one persisted send after a module/reload boundary', async () => {
    const first = await import('./draft')
    first.setDraftBody('cnv_reload', 'synthetic persisted retry')
    const nonce = first.snapshotReader('cnv_reload')().clientNonce
    expect(JSON.parse(window.sessionStorage.getItem('quad.messages.draft.cnv_reload')!)).toEqual({
      body: 'synthetic persisted retry', clientNonce: nonce,
    })
    vi.resetModules()
    const reloaded = await import('./draft')
    expect(reloaded.snapshotReader('cnv_reload')()).toEqual({
      body: 'synthetic persisted retry', clientNonce: nonce, restored: true,
    })
  })

  it('preserves and upgrades a legacy plain-text draft without changing its text', async () => {
    window.sessionStorage.setItem('quad.messages.draft.cnv_legacy', 'old unfinished message')
    const draft = await import('./draft')
    const restored = draft.snapshotReader('cnv_legacy')()
    expect(restored).toMatchObject({ body: 'old unfinished message', restored: true })
    expect(restored.clientNonce).toMatch(/^[0-9a-f-]{36}$/i)
    expect(JSON.parse(window.sessionStorage.getItem('quad.messages.draft.cnv_legacy')!)).toEqual({
      body: restored.body, clientNonce: restored.clientNonce,
    })
  })

  it('does not mistake an ordinary JSON-looking message for serialized draft state', async () => {
    const text = '{"body":"a message that quotes JSON"}'
    window.sessionStorage.setItem('quad.messages.draft.cnv_json', text)
    const draft = await import('./draft')
    expect(draft.snapshotReader('cnv_json')().body).toBe(text)
  })

  it('clears both retry facts only when explicitly cleared and keeps conversations separate', async () => {
    const draft = await import('./draft')
    draft.setDraftBody('cnv_first', 'first text')
    draft.setDraftBody('cnv_second', 'second text')
    draft.clearDraft('cnv_first')
    expect(draft.snapshotReader('cnv_first')()).toEqual({ body: '', clientNonce: null, restored: false })
    expect(window.sessionStorage.getItem('quad.messages.draft.cnv_first')).toBeNull()
    expect(draft.snapshotReader('cnv_second')().body).toBe('second text')
  })

  it('keeps an in-memory nonce if browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic storage refusal') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic storage refusal') })
    const draft = await import('./draft')
    expect(() => draft.setDraftBody('cnv_private', 'in-memory text')).not.toThrow()
    const current = draft.snapshotReader('cnv_private')()
    expect(current.body).toBe('in-memory text')
    expect(current.clientNonce).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

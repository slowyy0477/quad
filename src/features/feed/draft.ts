/**
 * The composer's draft, as an external store.
 *
 * `sessionStorage` is an external system, and React's rule for reading one is
 * `useSyncExternalStore` — not an effect that copies it into `useState`. That is
 * not a style preference: a `setState` inside an effect renders twice for every
 * mount and, in React 19's own terms, "you might not need an effect". This module
 * owns the storage key, the cache identity `getSnapshot` must return, and the
 * subscription, so the component only reads a value and writes one.
 *
 * `sessionStorage` is the right scope for a draft: it belongs to this tab and this
 * session, not to the device, so a half-written thought does not reappear days
 * later on a shared machine. Every access is wrapped, because storage throws in
 * some privacy modes and a draft is a convenience rather than a guarantee.
 *
 * `getServerSnapshot` returns the empty draft, so the server renders an empty
 * composer and React re-renders once on the client if a draft is found. That is
 * the designed behaviour for a store that only exists in the browser.
 */

const DRAFT_KEY = 'quad.feed.draft'

export type Draft = {
  body: string
  /** True when the body came back from an earlier visit in this session. */
  restored: boolean
}

const EMPTY: Draft = { body: '', restored: false }

let cached: Draft = EMPTY
let loaded = false
const listeners = new Set<() => void>()

function readStorage(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStorage(value: string) {
  try {
    if (value.trim().length > 0) window.sessionStorage.setItem(DRAFT_KEY, value)
    else window.sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // Storage unavailable. The draft is lost on reload and nothing else breaks.
  }
}

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot(): Draft {
  if (!loaded) {
    loaded = true
    const stored = readStorage()
    cached = stored.trim().length > 0 ? { body: stored, restored: true } : EMPTY
  }
  return cached
}

export function getServerSnapshot(): Draft {
  return EMPTY
}

/** Replace the draft. Called from the textarea's change handler, per keystroke. */
export function setDraftBody(body: string) {
  if (cached.body === body) return
  cached = { body, restored: cached.restored }
  writeStorage(body)
  emit()
}

/** Throw the draft away — on a successful post, or when the reader asks. */
export function clearDraft() {
  if (cached === EMPTY) return
  cached = EMPTY
  writeStorage('')
  emit()
}

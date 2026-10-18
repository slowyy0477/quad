/**
 * A message draft per conversation, as an external store.
 *
 * The same reasoning as `features/feed/draft.ts`, with one change: the key is the
 * conversation, so moving between threads does not carry half a sentence into the
 * wrong window. `sessionStorage` is an external system, and React's rule for
 * reading one is `useSyncExternalStore` — not an effect that copies it into
 * `useState`. That is not a style preference here: `react-hooks/set-state-in-effect`
 * is an error in this repository, and a `setState` in an effect also renders twice
 * for every mount, which is exactly what a composer must not do.
 *
 * What the store buys, and why each part of it is load-bearing:
 *
 *   * **A failed send keeps the text.** The draft is cleared on success and only
 *     on success, so a refusal from the database leaves the message written.
 *   * **A refresh or an accidental navigation does not lose it.** It lives in
 *     `sessionStorage`, scoped to this tab and this session — a half-written
 *     message should not reappear days later on a shared machine.
 *   * **When one is restored, the reader is told.** A silently repopulated box
 *     reads like a bug, so `restored` is part of the snapshot.
 *
 * Every storage access is wrapped: storage throws in some privacy modes, and a
 * draft is a convenience rather than a guarantee.
 */

export type Draft = {
  body: string
  /** True when the body came back from an earlier visit in this session. */
  restored: boolean
}

const EMPTY: Draft = { body: '', restored: false }

const cache = new Map<string, Draft>()
const readers = new Map<string, () => Draft>()
const listeners = new Set<() => void>()

function storageKey(conversationId: string): string {
  return `quad.messages.draft.${conversationId}`
}

function readStored(conversationId: string): string {
  try {
    return window.sessionStorage.getItem(storageKey(conversationId)) ?? ''
  } catch {
    return ''
  }
}

function writeStored(conversationId: string, body: string) {
  try {
    if (body.trim().length > 0) window.sessionStorage.setItem(storageKey(conversationId), body)
    else window.sessionStorage.removeItem(storageKey(conversationId))
  } catch {
    // Storage unavailable. The draft is lost on reload and nothing else breaks.
  }
}

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A stable snapshot reader for one conversation.
 *
 * `useSyncExternalStore` compares snapshots by identity, so this must return the
 * *same object* until the draft actually changes — a fresh `{ body }` on every
 * call is an infinite render loop. The `readers` map exists so the function
 * identity is stable per conversation across renders too, which is what lets it be
 * passed as a dependency.
 */
export function snapshotReader(conversationId: string): () => Draft {
  const existing = readers.get(conversationId)
  if (existing) return existing

  const reader = (): Draft => {
    const cached = cache.get(conversationId)
    if (cached) return cached

    const stored = readStored(conversationId)
    const draft: Draft = stored.trim().length > 0 ? { body: stored, restored: true } : EMPTY
    cache.set(conversationId, draft)
    return draft
  }

  readers.set(conversationId, reader)
  return reader
}

/** The server has no draft, so the first paint is an empty composer. */
export function serverSnapshot(): Draft {
  return EMPTY
}

/** Replace the draft. Called from the textarea's change handler, per keystroke. */
export function setDraftBody(conversationId: string, body: string) {
  const current = snapshotReader(conversationId)()
  if (current.body === body) return

  cache.set(conversationId, { body, restored: current.restored })
  writeStored(conversationId, body)
  emit()
}

/** Throw the draft away — on a successful send, or when the reader asks. */
export function clearDraft(conversationId: string) {
  const current = snapshotReader(conversationId)()
  if (current === EMPTY) return

  cache.set(conversationId, EMPTY)
  writeStored(conversationId, '')
  emit()
}

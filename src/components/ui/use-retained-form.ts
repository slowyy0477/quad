'use client'

import { useEffect, useRef } from 'react'

/**
 * Expected refusal is a resolved action, so React schedules a native reset.
 * That reset occurs during its commit, when synthetic reset handlers cannot
 * reliably cancel it. A native listener preserves the live draft instead.
 * Use only for non-secret forms whose accepted receipt/route owns clearing.
 */
export function useRetainedForm() {
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const form = ref.current
    if (!form) return
    const retain = (event: Event) => event.preventDefault()
    form.addEventListener('reset', retain)
    return () => form.removeEventListener('reset', retain)
  }, [])
  return ref
}

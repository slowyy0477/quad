'use client'

import { useEffect, useId, useRef } from 'react'
import type { FormState } from '@/lib/form-state'

type ErrorField = { id: string; label: string }

/** Keep refusal feedback and field navigation in the same form, including disclosures. */
export function FormErrorSummary({
  state,
  fields,
  title = 'Check these details',
}: {
  state: Pick<FormState, 'status' | 'message' | 'fieldErrors'>
  fields: Record<string, ErrorField>
  title?: string
}) {
  const headingId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const errors = Object.entries(state.fieldErrors ?? {}).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].length > 0,
  )
  const visible = state.status === 'error' && Boolean(state.message || errors.length)

  useEffect(() => {
    if (visible) ref.current?.focus()
  }, [state, visible])

  if (!visible) return null

  function focusField(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const form = ref.current?.closest('form')
    const field = form && Array.from(form.elements).find((element) => element.id === id)
    if (!(field instanceof HTMLElement)) return
    event.preventDefault()
    let ancestor = field.parentElement
    while (ancestor && ancestor !== form) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
      ancestor = ancestor.parentElement
    }
    field.focus()
  }

  return (
    <div ref={ref} role="alert" aria-labelledby={headingId} tabIndex={-1}
      className="scroll-mt-24 rounded-md border border-danger-600 bg-danger-50 p-4 text-sm">
      <h2 id={headingId} className="text-base font-semibold text-danger-700">{title}</h2>
      {state.message ? <p className="mt-1 text-ink">{state.message}</p> : null}
      {errors.length ? (
        <ul className="mt-2 space-y-1">
          {errors.map(([name, message]) => {
            const field = fields[name]
            return (
              <li key={name}>
                {field ? (
                  <a href={`#${field.id}`} onClick={(event) => focusField(event, field.id)}
                    className="inline-flex min-h-8 items-center text-danger-700 underline decoration-1 underline-offset-2">
                    {field.label}: {message}
                  </a>
                ) : <span className="text-ink">{message}</span>}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

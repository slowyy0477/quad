'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Textarea that grows with its content.
 *
 * A fixed-height box is the reason long posts get written in a phone-sized keyhole: the
 * user scrolls inside the field, loses their place, and stops. The height is set from
 * `scrollHeight` on every change, capped by `maxHeight` so one pasted essay does not
 * push the submit button off the screen.
 *
 * The counter appears only near the limit. A live "0 / 2000" is noise that teaches
 * nobody anything until it matters.
 */
export function Textarea({
  className,
  value,
  maxLength,
  minRows = 3,
  maxHeight = 420,
  showCountAt = 0.8,
  ...props
}: React.ComponentProps<'textarea'> & {
  minRows?: number
  maxHeight?: number
  /** Fraction of `maxLength` at which the counter appears. */
  showCountAt?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const text = typeof value === 'string' ? value : ''
  const length = text.length

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [text, maxHeight])

  const nearLimit = maxLength ? length >= maxLength * showCountAt : false

  return (
    <div className="space-y-1">
      <textarea
        ref={ref}
        value={value}
        maxLength={maxLength}
        rows={minRows}
        className={cn(
          'w-full resize-none rounded border border-rule bg-paper-raised px-3 py-2.5 text-base text-ink',
          'placeholder:text-ink-faint',
          'aria-[invalid=true]:border-danger-600',
          'disabled:pointer-events-none disabled:opacity-55',
          className,
        )}
        {...props}
      />
      {nearLimit ? (
        <p
          aria-live="polite"
          className={cn(
            'text-right text-xs tabular',
            length >= (maxLength ?? 0) ? 'text-danger-600' : 'text-ink-muted',
          )}
        >
          {length} / {maxLength}
        </p>
      ) : null}
    </div>
  )
}

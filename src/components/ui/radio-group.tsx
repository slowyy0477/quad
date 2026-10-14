'use client'

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '@/lib/utils'

/**
 * RadioGroup — one choice from a short list, visible at once.
 *
 * Preferred to `Select` for the privacy and visibility settings, because the user
 * should be able to see all four options and how they differ without opening anything.
 * Arrow keys move between options, which is what makes a radio group faster than four
 * checkboxes to a keyboard user.
 */
export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('space-y-2', className)} {...props} />
}

export function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-raised',
        'data-[state=checked]:border-accent-700',
        'disabled:pointer-events-none disabled:opacity-55',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2.5 rounded-full bg-accent-600" />
    </RadioGroupPrimitive.Item>
  )
}

/** The clickable row: control plus label, one target, one announcement. */
export function RadioOption({
  value,
  id,
  label,
  description,
}: {
  value: string
  id: string
  label: string
  description?: string
}) {
  return (
    <label
      htmlFor={id}
      className="-mx-2 flex cursor-pointer items-start gap-3 rounded px-2 py-2 hover:bg-paper-sunken"
    >
      <span className="pt-0.5">
        <RadioGroupItem value={value} id={id} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {description ? <span className="block text-xs text-ink-muted">{description}</span> : null}
      </span>
    </label>
  )
}

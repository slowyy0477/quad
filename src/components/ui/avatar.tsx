'use client'

import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Avatar.
 *
 * The fallback is initials, not a generic silhouette, because a wall of identical
 * grey heads is unreadable at feed density while initials are distinguishable at
 * a glance. Radix handles the load/error states: the fallback shows while the
 * image is loading and stays if it fails, so a dead URL never leaves a broken
 * image icon in a comment thread.
 *
 * The fallback tint is derived from the name rather than random, so the same
 * person is the same colour on every visit -- a stable, if weak, recognition cue.
 * It is deliberately not the accent colour: green means "clickable" everywhere
 * else in this interface.
 */
const avatarVariants = cva(
  'relative flex shrink-0 overflow-hidden rounded-full border border-hairline select-none',
  {
    variants: {
      size: {
        xs: 'size-6 text-2xs',
        sm: 'size-8 text-xs',
        default: 'size-10 text-sm',
        lg: 'size-14 text-base',
        xl: 'size-20 text-xl',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

const tints = [
  'bg-accent-100 text-accent-900',
  'bg-highlight-100 text-highlight-700',
  'bg-paper-sunken text-ink-muted',
  'bg-danger-100 text-danger-700',
  'bg-success-50 text-success-600',
] as const

function tintFor(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return tints[Math.abs(hash) % tints.length]
}

/** First letter of the first two words: "Ana Marie Cruz" reads as "AC". */
function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]![0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function Avatar({
  name,
  src,
  size,
  className,
}: VariantProps<typeof avatarVariants> & {
  name: string
  src?: string | null
  className?: string
}) {
  return (
    <AvatarPrimitive.Root className={cn(avatarVariants({ size }), className)}>
      {src ? (
        <AvatarPrimitive.Image
          src={src}
          alt=""
          className="size-full object-cover"
        />
      ) : null}
      <AvatarPrimitive.Fallback
        className={cn('flex size-full items-center justify-center font-medium', tintFor(name))}
        // No delay: the fallback is the intended appearance for most people, not
        // a stand-in worth flashing empty space for.
        delayMs={0}
      >
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

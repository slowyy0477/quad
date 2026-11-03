import { cn } from '@/lib/utils'
import { BRAND } from '@/lib/brand'

/**
 * The wordmark.
 *
 * An original lowercase b with an open conversation-tail detail.
 * This is a code-native vector, not a generated raster or copied brand asset.
 *
 * `aria-hidden` on the mark plus real text beside it means a screen reader gets
 * "Bulla, link" instead of a description of the decorative mark.
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        viewBox="0 0 32 32"
        className="size-8 shrink-0 text-accent-600"
        aria-hidden="true"
        fill="none"
      >
        <path fill="currentColor" fillRule="evenodd" d="M6 2h5v10c1.5-1.8 3.7-2.7 6.2-2.7 5.8 0 9.8 4.1 9.8 9.8S23 29 17.1 29c-3 0-5.4-1.2-7.3-3.1L6 29V2Zm5 17.2c0 3 2.2 5.2 5.1 5.2s5.2-2.2 5.2-5.2-2.2-5.2-5.2-5.2S11 16.2 11 19.2Z" />
      </svg>
      {showWordmark ? (
        <span className="font-sans text-2xl font-bold tracking-[-0.055em] text-ink">{BRAND.name}</span>
      ) : null}
    </span>
  )
}

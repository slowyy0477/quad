import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, resolving Tailwind conflicts in favour of the last one.
 *
 * `clsx` handles the conditionals; `twMerge` handles the fact that
 * `"px-2 px-4"` is not what anyone means. Without it, a component's default
 * padding would silently win over the padding a caller passed in, depending on
 * stylesheet order rather than argument order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

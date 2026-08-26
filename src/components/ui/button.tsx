import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Button.
 *
 * Five intents, and the list is short on purpose. Every additional variant is a
 * decision moved from the design system into the head of whoever is writing the
 * page, and the usual result is three subtly different greys for "secondary".
 *
 *   primary    the one thing this screen is for
 *   secondary  a real alternative, bordered rather than filled
 *   ghost      navigation and toolbar actions, no chrome until hovered
 *   danger     destroys something
 *   link       inline in a sentence
 *
 * `asChild` renders the child element with these classes instead of wrapping it in
 * a <button>. That is how a link gets button styling without becoming a button:
 * `<Button asChild><Link href="…">…</Link></Button>` stays a real anchor, so it
 * middle-clicks, right-click-copies, and reads as a link to a screen reader.
 *
 * Sizes are set with min-height rather than padding alone, so a button holding an
 * icon and a button holding text end up the same height. `min-h-11` on the default
 * size is 44px, which is the smallest comfortable touch target.
 */
const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 rounded border font-medium',
    'transition-colors duration-150 ease-out-soft',
    'disabled:pointer-events-none disabled:opacity-55',
    // Icons inside a button should never be the thing that stretches it.
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: cn(
          'border-accent-700 bg-accent-600 text-white',
          'hover:bg-accent-700 active:bg-accent-900',
        ),
        secondary: cn(
          'border-rule bg-paper-raised text-ink',
          'hover:bg-paper-sunken active:bg-paper-sunken',
        ),
        ghost: cn('border-transparent bg-transparent text-ink-muted', 'hover:bg-paper-sunken hover:text-ink'),
        danger: cn('border-danger-700 bg-danger-600 text-white', 'hover:bg-danger-700'),
        link: cn(
          'h-auto min-h-0 border-transparent bg-transparent p-0 text-accent-700 underline underline-offset-2',
          'hover:text-accent-900',
        ),
      },
      size: {
        sm: 'min-h-8 px-2.5 text-xs',
        default: 'min-h-11 px-4 text-sm sm:min-h-10',
        lg: 'min-h-12 px-6 text-base',
        icon: 'size-10 p-0',
      },
      block: {
        true: 'w-full',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
)

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

export function Button({ className, variant, size, block, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component className={cn(buttonVariants({ variant, size, block }), className)} {...props} />
  )
}

export { buttonVariants }

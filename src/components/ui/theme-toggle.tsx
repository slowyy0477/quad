'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * ThemeToggle — light, dark, or whatever the system says.
 *
 * globals.css defines a class-based dark theme and says a preference the user stated
 * must beat one the OS inferred. This is where that statement is kept: the choice is
 * stored under one key, applied by the inline script in the layout *before* first paint
 * so there is no flash of light content, and "System" stays live rather than being
 * resolved to a value the moment it is chosen.
 *
 * Three buttons rather than a switch, because a switch cannot express "follow the
 * system": it would have to be either on or off, and both would be a lie half the time.
 */
export const THEME_STORAGE_KEY = 'quad-theme'
export type ThemeChoice = 'light' | 'dark' | 'system'

const options: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

function apply(choice: ThemeChoice) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = choice === 'dark' || (choice === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', dark)
}

export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>('system')

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeChoice | null
    if (stored === 'light' || stored === 'dark' || stored === 'system') setChoice(stored)

    // "System" has to keep up with the OS while the page is open, not only at load.
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const current = (window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeChoice | null) ?? 'system'
      if (current === 'system') apply('system')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  function choose(next: ThemeChoice) {
    setChoice(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
    apply(next)
  }

  return (
    <div className={cn('inline-flex rounded border border-rule p-0.5', className)} role="group" aria-label="Theme">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => choose(value)}
          aria-pressed={choice === value}
          className={cn(
            'flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-sm px-2.5 text-sm',
            choice === value ? 'bg-paper-sunken text-ink' : 'text-ink-muted hover:text-ink',
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  )
}

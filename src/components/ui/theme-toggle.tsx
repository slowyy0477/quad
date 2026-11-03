'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY, type ThemeChoice } from './theme-config'

export { THEME_STORAGE_KEY, type ThemeChoice } from './theme-config'

const CHANGE_EVENT = 'bulla-theme-change'
let memoryChoice: ThemeChoice = 'system'
const options: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

function getChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    memoryChoice = stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // Private browsing can deny storage. The choice still works for this visit.
  }
  return memoryChoice
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function getServerChoice(): ThemeChoice { return 'system' }

function apply(choice: ThemeChoice) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', choice === 'dark' || (choice === 'system' && prefersDark))
}

function choose(next: ThemeChoice) {
  memoryChoice = next
  try { window.localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* Use this-visit memory. */ }
  apply(next)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Shared menu/footer controls follow one external preference, with no hydration flash. */
export function ThemeToggle({ className }: { className?: string }) {
  const choice = useSyncExternalStore(subscribe, getChoice, getServerChoice)
  useEffect(() => {
    apply(choice)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if (choice === 'system') apply('system') }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [choice])

  return (
    <div className={cn('inline-flex rounded border border-rule bg-paper-raised p-0.5', className)} role="group" aria-label="Theme">
      {options.map(({ value, label, Icon }) => (
        <button key={value} type="button" onClick={() => choose(value)} aria-pressed={choice === value}
          className={cn('flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-sm px-2.5 text-sm', choice === value ? 'bg-accent-50 font-medium text-accent-700' : 'text-ink-muted hover:text-ink')}>
          <Icon className="size-4" aria-hidden="true" />{label}
        </button>
      ))}
    </div>
  )
}

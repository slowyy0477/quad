'use client'

import { Search } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * SearchInput — a form, not a widget.
 *
 * It submits as a GET to a URL, so a search result is a link that can be shared,
 * bookmarked, reloaded and reached with the back button, and the page works before any
 * JavaScript arrives. Everything clever about search results belongs on the server.
 *
 * `/` focuses the field from anywhere on the page, which is the one keyboard shortcut
 * users of search boxes already expect. It is ignored while the user is typing in
 * another field, and never fires while a modifier key is held.
 */
export function SearchInput({
  defaultValue = '',
  action = '/search',
  placeholder = 'Search people, projects, posts',
  className,
}: {
  defaultValue?: string
  action?: string
  placeholder?: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      ref.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <form action={action} role="search" className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label="Search"
        className={cn(
          'min-h-11 w-full rounded border border-rule bg-paper-raised py-2 pr-3 pl-9 text-sm text-ink',
          'placeholder:text-ink-faint',
          'focus-visible:border-accent-600',
        )}
      />
    </form>
  )
}

'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

/** Re-read the current authorized route without replacing its URL or drafts. */
export function MessageReadRetry({ label }: { label: string }) {
  const router = useRouter()
  const [pending, transition] = useTransition()
  return (
    <Button type="button" variant="secondary" size="sm" disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => transition(() => router.refresh())}>
      {pending ? 'Refreshing…' : label}
    </Button>
  )
}

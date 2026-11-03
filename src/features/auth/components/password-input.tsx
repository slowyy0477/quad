'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'

/** Revealing a password changes presentation only; no value is persisted or copied. */
export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOff : Eye
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={`pr-12 ${className ?? ''}`} />
      <button type="button" aria-label={visible ? 'Hide password' : 'Show password'}
        aria-controls={props.id} aria-pressed={visible} disabled={props.disabled}
        onClick={() => setVisible(!visible)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r text-ink-muted hover:text-ink disabled:cursor-not-allowed">
        <Icon className="size-5" aria-hidden="true" />
      </button>
    </div>
  )
}

'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  IMAGE_INPUT_TYPES, IMAGE_UPLOAD_LIMITS, parseUploadedImage, uploadEndpoint, validPrivateImageUrl,
  type ImageUploadTarget, type UploadedImage,
} from '../contracts'

export type ImageUploadControlProps = {
  target: ImageUploadTarget
  currentImageUrl?: string | null
  label?: string
  disabled?: boolean
  className?: string
  /** Called only after a validated, committed 201 response, never after selection. */
  onUploaded?: (image: UploadedImage) => void | Promise<void>
}

/** Safe to place INSIDE an existing form: no nested form or implicit submit. */
export function ImageUploadControl(props: ImageUploadControlProps) {
  const slot = props.target.kind === 'avatar' ? 'avatar' : `project:${props.target.projectId}`
  const key = `${slot}:${props.currentImageUrl ?? ''}`
  return <ImageUploadControlBody key={key} {...props} />
}

function ImageUploadControlBody({
  target, currentImageUrl, label, disabled = false, className, onUploaded,
}: ImageUploadControlProps) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const alive = useRef(true)
  const [file, setFile] = useState<File | null>(null)
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const preview = savedUrl ?? (validPrivateImageUrl(currentImageUrl) ? currentImageUrl : null)
  const title = label ?? (target.kind === 'avatar' ? 'Profile image' : 'Project cover')

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; controller.current?.abort(); clearTimeout(uploadTimer.current) }
  }, [])

  function selectFile() {
    const selected = input.current?.files?.[0] ?? null
    setMessage('')
    setError(false)
    setFile(null)
    if (!selected) return
    if (!IMAGE_INPUT_TYPES.includes(selected.type as (typeof IMAGE_INPUT_TYPES)[number]) ||
        selected.size < 1 || selected.size > IMAGE_UPLOAD_LIMITS.inputBytes) {
      setMessage('Choose a PNG, JPEG or static WebP image, 5 MiB or smaller.')
      setError(true)
      if (input.current) input.current.value = ''
      return
    }
    setFile(selected)
  }

  async function upload() {
    if (!file || disabled || pending || controller.current) return
    setPending(true)
    setError(false)
    setMessage('Uploading and checking the image…')
    const active = new AbortController()
    controller.current = active
    const timeout = setTimeout(() => active.abort(), 40_000)
    uploadTimer.current = timeout
    try {
      const response = await fetch(uploadEndpoint(target), {
        method: 'POST', credentials: 'same-origin', signal: active.signal,
        headers: { 'Content-Type': file.type },
        body: file, // No original name, owner/association fields or raw bucket URL.
      })
      const result: unknown = await response.json()
      if (!alive.current) return
      const envelope = result && typeof result === 'object' ? result as Record<string, unknown> : null
      const image = parseUploadedImage(envelope?.image)
      if (response.status !== 201 || envelope?.ok !== true || !image || image.kind !== target.kind) {
        const detail = envelope?.error as { message?: unknown } | undefined
        throw new Error(
          response.status !== 201 && typeof detail?.message === 'string'
            ? detail.message.slice(0, 300)
            : 'The image upload could not be confirmed. Refresh before retrying.',
        )
      }
      setSavedUrl(image.url)
      setFile(null)
      if (input.current) input.current.value = ''
      setMessage('Image saved. Metadata was removed and the raster was normalized to WebP.')
      try { await onUploaded?.(image) } catch {
        if (alive.current) setMessage('Image saved, but the page could not refresh. Reload to see it.')
      }
    } catch (caught) {
      if (!alive.current) return
      setError(true)
      setMessage(caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message
        : 'The image upload could not be confirmed. Refresh before retrying.')
    } finally {
      clearTimeout(timeout)
      if (uploadTimer.current === timeout) uploadTimer.current = undefined
      if (alive.current) setPending(false)
      if (controller.current === active) controller.current = null
    }
  }

  return (
    <div className={cn('min-w-0 space-y-3', className)} aria-busy={pending}>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">{title}</label>
      {preview && (
        // The authorized proxy requires browser cookies. next/image optimization
        // does not forward them and must not cache private images.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={`Current ${title.toLowerCase()}`} width={target.kind === 'avatar' ? 96 : 320}
          height={target.kind === 'avatar' ? 96 : 180}
          className={cn('max-w-full rounded border border-rule object-contain', target.kind === 'avatar' ? 'size-24' : 'max-h-48')} />
      )}
      <Input ref={input} id={id} type="file" accept={IMAGE_INPUT_TYPES.join(',')}
        disabled={disabled || pending} onChange={selectFile}
        aria-describedby={`${id}-hint ${id}-status`} aria-invalid={error || undefined} />
      <p id={`${id}-hint`} className="text-sm text-ink-muted">
        PNG, JPEG or static WebP, up to 5 MiB. SVG, GIF and animated images are not accepted.
        This checks and normalizes images; it is not general attachment malware scanning.
      </p>
      <Button type="button" variant="secondary" disabled={disabled || pending || !file} onClick={upload}>
        {pending ? 'Checking image…' : 'Upload image'}
      </Button>
      <p id={`${id}-status`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}
        className={cn('text-sm', error ? 'text-danger-600' : 'text-ink-muted')}>
        {message}
      </p>
    </div>
  )
}

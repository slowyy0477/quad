import 'server-only'

import { createImageBackend } from './backend'
import { readBoundedImageBody, requireSameOriginWrite, validateImageHeaders } from './body'
import { IMAGE_RULES, IMAGE_UPLOAD_LIMITS, validImageId, type ImageUploadTarget } from './contracts'
import { ImageUploadError, imageNotFound, uploadsUnavailable } from './errors'
import { normalizeImage } from './normalize'
import type { ImageBackend, ImageReservation } from './types'

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': 'Cookie, Authorization',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

function failure(error: unknown): Response {
  const known = error instanceof ImageUploadError ? error : uploadsUnavailable()
  return Response.json(
    { ok: false, error: { code: known.code, message: known.message } },
    { status: known.status, headers: { ...privateHeaders, ...(known.retryAfter ? { 'Retry-After': String(known.retryAfter) } : {}) } },
  )
}

export async function uploadImage(request: Request, target: ImageUploadTarget): Promise<Response> {
  let backend: ImageBackend | undefined
  let reservation: ImageReservation | undefined
  let committed = false
  try {
    requireSameOriginWrite(request)
    const inputType = validateImageHeaders(request)
    backend = await createImageBackend(request, true)
    reservation = await backend.reserve(target)
    const input = await readBoundedImageBody(request)
    const normalized = await normalizeImage(input, target.kind, inputType)
    if (request.signal.aborted) throw new ImageUploadError(408, 'upload_interrupted', 'The upload was interrupted.')
    await backend.publish(reservation, normalized)
    const image = await backend.commit(reservation, normalized)
    committed = true
    return Response.json({ ok: true, image }, { status: 201, headers: privateHeaders })
  } catch (error) {
    return failure(error)
  } finally {
    if (backend && reservation && !committed) {
      try { await backend.rollback(reservation) } catch {
        // Pending/retired metadata stays unreadable and charged. Never log
        // secrets, bytes, names or owner content; bounded cleanup retries later.
      }
    }
  }
}

export async function imageUploadState(request: Request, target: ImageUploadTarget): Promise<Response> {
  try {
    const backend = await createImageBackend(request, true)
    const image = await backend.current(target)
    return Response.json(
      { ok: true, image, limits: { inputBytes: IMAGE_UPLOAD_LIMITS.inputBytes, ...IMAGE_RULES[target.kind] } },
      { headers: privateHeaders },
    )
  } catch (error) { return failure(error) }
}

export async function servePrivateImage(request: Request, id: string, head = false): Promise<Response> {
  try {
    if (!validImageId(id)) throw imageNotFound()
    const backend = await createImageBackend(request)
    const result = await backend.read(id)
    if (!result) throw imageNotFound()
    // No redirects/signed-URL bearer tokens, caching, range or 304 shortcuts.
    // Native img must be used by callers: Next's optimizer does not forward cookies.
    return new Response(head ? null : new Uint8Array(result.data), {
      headers: {
        ...privateHeaders,
        'Content-Type': 'image/webp',
        'Content-Length': String(result.image.bytes),
        'Content-Disposition': `inline; filename="image-${id}.webp"`,
      },
    })
  } catch (error) {
    const response = failure(error)
    return head ? new Response(null, { status: response.status, headers: response.headers }) : response
  }
}

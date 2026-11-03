import 'server-only'

import { IMAGE_INPUT_TYPES, IMAGE_UPLOAD_LIMITS, type ImageInputType } from './contracts'
import { ImageUploadError } from './errors'

/** Independent of proxy coverage, cookies, forwarded hosts and NextURL rewrites. */
export function requireSameOriginWrite(request: Request): void {
  try {
    const requestUrl = new URL(request.url)
    const configured = process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SITE_URL
    const expected = configured
      ? new URL(configured)
      : new URL(`${requestUrl.protocol}//${request.headers.get('host') || requestUrl.host}`)
    const origin = request.headers.get('origin')
    const site = request.headers.get('sec-fetch-site')
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password ||
        expected.pathname !== '/' || expected.search || expected.hash ||
        !origin || origin !== expected.origin || (site !== null && site !== 'same-origin')) {
      throw new Error('Invalid origin')
    }
  } catch {
    throw new ImageUploadError(403, 'cross_origin_upload', 'Image uploads require a same-origin request.')
  }
}

/** Raw binary only: multipart parsing would buffer an unbounded envelope first. */
export function validateImageHeaders(request: Request): ImageInputType {
  const contentType = request.headers.get('content-type')?.trim().toLowerCase()
  if (!IMAGE_INPUT_TYPES.includes(contentType as ImageInputType) ||
      ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
    throw new ImageUploadError(415, 'unsupported_image', 'Choose a PNG, JPEG or static WebP image.')
  }
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d{1,16}$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      throw new ImageUploadError(400, 'invalid_length', 'The upload length is invalid.')
    }
    if (Number(declared) > IMAGE_UPLOAD_LIMITS.inputBytes) {
      throw new ImageUploadError(413, 'image_too_large', 'Images must be 5 MiB or smaller.')
    }
  }
  return contentType as ImageInputType
}

/** Count actual stream bytes, including chunked bodies and lying Content-Length. */
export async function readBoundedImageBody(request: Request): Promise<Buffer> {
  if (!request.body) throw new ImageUploadError(400, 'empty_image', 'Choose an image to upload.')
  if (request.signal.aborted) {
    void request.body.cancel().catch(() => undefined)
    throw new ImageUploadError(408, 'upload_interrupted', 'The upload was interrupted.')
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const deadline = Date.now() + IMAGE_UPLOAD_LIMITS.bodyTimeoutMs
  let rejectInterrupted: (reason: ImageUploadError) => void = () => undefined
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject })
  const abort = () => rejectInterrupted(new ImageUploadError(408, 'upload_interrupted', 'The upload was interrupted.'))
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) abort()
  const timer = setTimeout(
    () => rejectInterrupted(new ImageUploadError(408, 'upload_timeout', 'The image upload took too long.')),
    IMAGE_UPLOAD_LIMITS.bodyTimeoutMs,
  )
  try {
    for (;;) {
      if (request.signal.aborted) abort()
      if (Date.now() >= deadline) throw new ImageUploadError(408, 'upload_timeout', 'The image upload took too long.')
      const { value, done } = await Promise.race([reader.read(), interrupted])
      if (request.signal.aborted) throw new ImageUploadError(408, 'upload_interrupted', 'The upload was interrupted.')
      if (done) break
      if (!(value instanceof Uint8Array)) {
        throw new ImageUploadError(400, 'invalid_body', 'The image body is invalid.')
      }
      bytes += value.byteLength
      if (bytes > IMAGE_UPLOAD_LIMITS.inputBytes) {
        throw new ImageUploadError(413, 'image_too_large', 'Images must be 5 MiB or smaller.')
      }
      // Own each chunk; producers must not be able to mutate accepted bytes later.
      chunks.push(Uint8Array.from(value))
    }
    if (!bytes) throw new ImageUploadError(400, 'empty_image', 'Choose an image to upload.')
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    // Do not await a potentially hostile underlying stream's cancellation hook.
    void reader.cancel().catch(() => undefined)
    if (error instanceof ImageUploadError) throw error
    throw new ImageUploadError(400, 'invalid_body', 'The image body could not be read.')
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

/** Browser-safe contract. Limits are server-owned, never request parameters. */
export const IMAGE_UPLOAD_LIMITS = Object.freeze({
  inputBytes: 5 * 1024 * 1024,
  sourcePixels: 16 * 1024 * 1024,
  sourceDimension: 8192,
  sourceMetadataBytes: 256 * 1024,
  bodyTimeoutMs: 30_000,
  encodeTimeoutSeconds: 5,
  decodeConcurrency: 2,
  reservationTtlMs: 120_000,
  pendingPerActor: 2,
  pendingGlobal: 4,
  uploadsPerTenMinutes: 5,
  uploadsPerDay: 20,
  uploadsPerMinuteGlobal: 30,
  imagesPerOwner: 20,
  bytesPerOwner: 16 * 1024 * 1024,
  imagesGlobal: 512,
  bytesGlobal: 256 * 1024 * 1024,
})

export const IMAGE_RULES = Object.freeze({
  avatar: Object.freeze({ width: 512, height: 512, outputBytes: 512 * 1024 }),
  'project-cover': Object.freeze({ width: 1600, height: 900, outputBytes: 2 * 1024 * 1024 }),
})

export const IMAGE_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageInputType = (typeof IMAGE_INPUT_TYPES)[number]
export type ImageKind = keyof typeof IMAGE_RULES
export type ImageUploadTarget =
  | { kind: 'avatar' }
  | { kind: 'project-cover'; projectId: string }

export type UploadedImage = {
  id: string
  url: string
  kind: ImageKind
  width: number
  height: number
  bytes: number
  contentType: 'image/webp'
}

export const PRIVATE_IMAGE_BUCKET = 'bulla-private-images'

/** Immutable, opaque v4 IDs only. No paths, original names or query strings. */
export function validImageId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

export function imageUrl(id: string): string {
  if (!validImageId(id)) throw new Error('Invalid private image ID')
  return `/api/images/${id}`
}

export function imageObjectName(id: string): string {
  if (!validImageId(id)) throw new Error('Invalid private image ID')
  return `${id}.webp`
}

export function validPrivateImageUrl(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith('/api/images/') && validImageId(value.slice('/api/images/'.length))
}

/** Treat even a 2xx response as failure unless the committed contract is valid. */
export function parseUploadedImage(value: unknown): UploadedImage | null {
  if (!value || typeof value !== 'object') return null
  const image = value as Record<string, unknown>
  if (!validImageId(image.id) || image.url !== imageUrl(image.id) ||
      !['avatar', 'project-cover'].includes(String(image.kind)) ||
      image.contentType !== 'image/webp') return null
  const kind = image.kind as ImageKind
  const rules = IMAGE_RULES[kind]
  if (![image.width, image.height, image.bytes].every(Number.isSafeInteger) ||
      Number(image.width) < 1 || Number(image.width) > rules.width ||
      Number(image.height) < 1 || Number(image.height) > rules.height ||
      Number(image.bytes) < 1 || Number(image.bytes) > rules.outputBytes) return null
  return {
    id: image.id, url: image.url, kind,
    width: Number(image.width), height: Number(image.height), bytes: Number(image.bytes),
    contentType: 'image/webp',
  }
}

export function uploadEndpoint(target: ImageUploadTarget): string {
  return target.kind === 'avatar'
    ? '/api/uploads/avatar'
    : `/api/uploads/projects/${encodeURIComponent(target.projectId)}/cover`
}

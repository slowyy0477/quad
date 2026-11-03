import 'server-only'

export class ImageUploadError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'ImageUploadError'
  }
}

export function uploadsUnavailable(): ImageUploadError {
  return new ImageUploadError(
    503, 'uploads_unavailable',
    'Private image uploads are unavailable or could not be confirmed. Refresh before retrying; an operator may need to check storage.',
  )
}

export function imageNotFound(): ImageUploadError {
  return new ImageUploadError(404, 'image_not_found', 'That image is not available.')
}

export function uploadDenied(): ImageUploadError {
  return new ImageUploadError(403, 'upload_denied', 'You cannot change that image.')
}

export function uploadRateLimited(retryAfter = 600): ImageUploadError {
  return new ImageUploadError(
    429, 'upload_rate_limited', 'The image upload budget is exhausted. Try again later.', retryAfter,
  )
}

export function uploadQuotaExceeded(): ImageUploadError {
  return new ImageUploadError(
    409, 'image_quota_exceeded', 'The private image storage quota is full. An operator must review cleanup.',
  )
}

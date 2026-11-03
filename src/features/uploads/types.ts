import type { ImageInputType, ImageKind, ImageUploadTarget, UploadedImage } from './contracts'

export type NormalizedImage = {
  data: Buffer
  width: number
  height: number
  bytes: number
  sha256: string
  contentType: 'image/webp'
}

export type ImageReservation = {
  id: string
  kind: ImageKind
  ownerId: string
  actorId: string
  profileId: string | null
  projectId: string | null
  expiresAt: string
}

export type PrivateImageRecord = ImageReservation & {
  state: 'pending' | 'ready' | 'retired'
  bytes: number
  width: number | null
  height: number | null
  sha256: string | null
  createdAt: string
}

/** Only provider adapters construct this, after resolving the verified actor. */
export interface ImageBackend {
  reserve(target: ImageUploadTarget): Promise<ImageReservation>
  publish(reservation: ImageReservation, image: NormalizedImage): Promise<void>
  commit(reservation: ImageReservation, image: NormalizedImage): Promise<UploadedImage>
  rollback(reservation: ImageReservation): Promise<void>
  current(target: ImageUploadTarget): Promise<UploadedImage | null>
  read(id: string): Promise<{ image: UploadedImage; data: Buffer } | null>
}

export type ImageNormalizer = (data: Buffer, kind: ImageKind, inputType: ImageInputType) => Promise<NormalizedImage>

import { imageUploadState, uploadImage } from '@/features/uploads/http'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  return uploadImage(request, { kind: 'avatar' })
}

export async function GET(request: Request) {
  return imageUploadState(request, { kind: 'avatar' })
}

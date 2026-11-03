import { imageUploadState, uploadImage } from '@/features/uploads/http'

export const runtime = 'nodejs'

type Context = { params: Promise<{ projectId: string }> }

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params
  return uploadImage(request, { kind: 'project-cover', projectId })
}

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params
  return imageUploadState(request, { kind: 'project-cover', projectId })
}

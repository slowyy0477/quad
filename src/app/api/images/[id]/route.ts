import { servePrivateImage } from '@/features/uploads/http'

export const runtime = 'nodejs'

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  return servePrivateImage(request, (await context.params).id)
}

export async function HEAD(request: Request, context: Context) {
  return servePrivateImage(request, (await context.params).id, true)
}

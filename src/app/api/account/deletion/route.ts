import { deleteOwnAccount } from '@/features/account/provider'
import { deletionRequestSchema } from '@/features/account/schemas'
import { accountError, accountResult, readAccountRequest } from '@/features/account/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const incoming = await readAccountRequest(request)
    if ('response' in incoming) return incoming.response
    const parsed = deletionRequestSchema.safeParse(incoming.body)
    if (!parsed.success) return accountError('confirmation_required')
    const result = await deleteOwnAccount(parsed.data)
    return accountResult(result, result.ok && result.value.state === 'completed' ? 200 : 202)
  } catch { return accountError('unavailable') }
}

import { getAccountDeletionReceipt } from '@/features/account/provider'
import { receiptRequestSchema } from '@/features/account/schemas'
import { accountError, accountResult, readAccountRequest } from '@/features/account/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Anonymous, status-only receipt lookup; no account/content access is granted. */
export async function POST(request: Request) {
  try {
    const incoming = await readAccountRequest(request)
    if ('response' in incoming) return incoming.response
    const parsed = receiptRequestSchema.safeParse(incoming.body)
    if (!parsed.success) return accountError('invalid_request')
    return accountResult(await getAccountDeletionReceipt(parsed.data.receipt))
  } catch { return accountError('unavailable') }
}

import { exportOwnAccount } from '@/features/account/provider'
import { exportRequestSchema } from '@/features/account/schemas'
import { accountError, ACCOUNT_RESPONSE_HEADERS, readAccountRequest } from '@/features/account/http'
import type { ExportSection } from '@/features/account/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST only: no password/token in URL, no prefetch-triggered sensitive export. */
export async function POST(request: Request) {
  try {
    const incoming = await readAccountRequest(request)
    if ('response' in incoming) return incoming.response
    const parsed = exportRequestSchema.safeParse(incoming.body)
    if (!parsed.success) return accountError('invalid_request')
    const result = await exportOwnAccount({ ...parsed.data, section: parsed.data.section as ExportSection | undefined })
    if (!result.ok) return accountError(result.code, undefined, result.retryAfterSeconds)
    return Response.json(result.value, {
      headers: {
        ...ACCOUNT_RESPONSE_HEADERS,
        'Content-Disposition': `attachment; filename="bulla-account-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    })
  } catch { return accountError('unavailable') }
}

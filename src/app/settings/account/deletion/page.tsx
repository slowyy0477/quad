import type { Metadata } from 'next'
import { DeletionReceiptPanel } from '@/features/account/components/deletion-receipt'

export const metadata: Metadata = { title: 'Deletion receipt', robots: { index: false, follow: false } }

/** Status only. Main must exempt this exact route from the hosted settings
 * sign-in redirect; no private settings/data route should be exempted with it.
 */
export default function AccountDeletionReceiptPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="mb-6 text-3xl">Check a deletion receipt</h1>
      <DeletionReceiptPanel />
    </div>
  )
}

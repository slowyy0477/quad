import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'

export const metadata: Metadata = { title: 'Provider sign-in unavailable' }

export default function ProviderUnavailablePage() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-12">
      <h1 className="text-3xl">Google sign-in is unavailable</h1>
      <Alert tone="warning" className="mt-6">
        Google is not enabled or its configuration could not be checked. No provider sign-in was
        started. You can <Link href="/login">try email sign-in</Link> or <Link href="/setup">view setup information</Link>.
      </Alert>
    </div>
  )
}

import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
      <p className="font-display text-5xl text-ink-faint tabular">404</p>
      <h1 className="mt-4 text-2xl">There is nothing at this address</h1>
      <p className="mt-3 text-ink-muted">
        The page may have moved, or it may be a part of Quad that has not been built yet — the build
        status page lists which is which.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button asChild variant="primary">
          <Link href="/">Go to the homepage</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/status">Build status</Link>
        </Button>
      </div>
    </div>
  )
}

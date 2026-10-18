import { SkeletonList } from '@/components/ui/skeleton'

/** The shape of the list that is coming: a heading block, then rows. */
export default function NotificationsLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <div className="border-b border-rule pb-4">
        <div className="h-9 w-56 rounded-sm bg-paper-sunken" />
        <div className="mt-3 h-4 w-full max-w-md rounded-sm bg-paper-sunken" />
      </div>
      <div className="mt-7">
        <SkeletonList rows={6} />
      </div>
    </div>
  )
}

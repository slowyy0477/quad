import { SkeletonList } from '@/components/ui/skeleton'

export default function GoalsLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <div className="border-b border-rule pb-4">
        <div className="h-9 w-40 rounded-sm bg-paper-sunken" />
        <div className="mt-3 h-4 w-full max-w-lg rounded-sm bg-paper-sunken" />
      </div>
      <div className="mt-6 flex gap-4">
        <div className="h-4 w-24 rounded-sm bg-paper-sunken" />
        <div className="h-4 w-24 rounded-sm bg-paper-sunken" />
        <div className="h-4 w-24 rounded-sm bg-paper-sunken" />
      </div>
      <div className="mt-8">
        <SkeletonList rows={4} />
      </div>
    </div>
  )
}

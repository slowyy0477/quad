import { SkeletonList } from '@/components/ui/skeleton'

export default function StudyLogLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <div className="border-b border-rule pb-4">
        <div className="h-9 w-44 rounded-sm bg-paper-sunken" />
        <div className="mt-3 h-4 w-full max-w-md rounded-sm bg-paper-sunken" />
      </div>
      <div className="mt-6 border-b border-rule pb-6">
        <div className="h-4 w-28 rounded-sm bg-paper-sunken" />
        <div className="mt-2 h-10 w-24 rounded-sm bg-paper-sunken" />
        <div className="mt-4 flex h-8 items-end gap-1">
          {Array.from({ length: 14 }).map((_, index) => (
            <div
              key={index}
              className={index % 3 === 0 ? 'h-8 flex-1 rounded-sm bg-paper-sunken' : 'h-1.5 flex-1 rounded-sm bg-paper-sunken'}
            />
          ))}
        </div>
      </div>
      <div className="mt-7">
        <SkeletonList rows={3} />
      </div>
    </div>
  )
}

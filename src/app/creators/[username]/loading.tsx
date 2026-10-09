import SkeletonLoader from '@/components/SkeletonLoader';

/** The page's shape while 24 posts, stats and prices load; there was only the top progress bar. */
export default function CreatorLoading() {
  return (
    <div className="ui-page ui-page-ambient min-h-[calc(100dvh-64px)] px-4 py-8 sm:px-6 sm:py-12" aria-busy="true" aria-label="Loading creator">
      <div className="mx-auto max-w-5xl">
        <SkeletonLoader className="h-40 rounded-[28px]" />
        <div className="mt-6 flex items-center gap-4">
          <SkeletonLoader className="h-20 w-20 rounded-full" />
          <div className="flex-1 space-y-3">
            <SkeletonLoader className="h-6 w-48" />
            <SkeletonLoader className="h-4 w-32" />
          </div>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((placeholder) => (
            <SkeletonLoader key={placeholder} className="aspect-[4/5] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

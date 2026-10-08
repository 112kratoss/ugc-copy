/**
 * The feed's loading shape on the signed-in and signed-out home pages, which
 * are meant to stay identical. Each page used to carry its own copy.
 */
export const HOME_FEED_DETAIL_CONTEXT = { from: 'home', returnTo: '/' };

export function HomeFeedSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading feed">
      {[220, 320, 260].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
          style={{ minHeight: height }}
        >
          <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      ))}
    </div>
  );
}

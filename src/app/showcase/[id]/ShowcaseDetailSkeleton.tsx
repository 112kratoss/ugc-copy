/**
 * Placeholder shown while an intercepted post streams in. Feed links are
 * unprefetched, so without this the click would look like nothing happened.
 * It mirrors the real layout's three regions so the panel does not resize
 * under the viewer when content arrives.
 */
export default function ShowcaseDetailSkeleton() {
  return (
    <div className="canonical-post-shell canonical-post-shell-overlay relative z-10" aria-label="Loading post">
      <div className="canonical-post-layout">
        {[
          'canonical-post-identity min-h-[7rem]',
          'canonical-post-media min-h-[22rem]',
          'canonical-post-actions min-h-[16rem]',
        ].map((region) => (
          <div
            key={region}
            className={`relative overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03] ${region}`}
          >
            <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
          </div>
        ))}
      </div>
    </div>
  );
}

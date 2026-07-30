/**
 * The fallback while a post streams in.
 *
 * Without this, a post inherits `src/app/showcase/loading.tsx` — a
 * `min-h-screen` skeleton labelled "Loading Showcase", which is both the wrong
 * name for a post and a full-page takeover that hides the very shell it should
 * be leaving alone. This one mirrors the real post's three regions inside the
 * content column, so the sidebar and header visibly stay put and only the middle
 * changes.
 */
export default function ShowcaseDetailLoading() {
  return (
    <div
      className="canonical-post-shell studio-shell-wide relative z-10 pt-4 sm:pt-6"
      role="status"
      aria-label="Loading post"
    >
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

import { FEED_CHIPS, type FeedChipId } from '@/lib/post-feed-chips';

/**
 * The feed's loading shape on the signed-in and signed-out home pages, which
 * are meant to stay identical. Each page used to carry its own copy.
 */
export const HOME_FEED_DETAIL_CONTEXT = { from: 'home', returnTo: '/' };

/** The feed's column, drawn and held alike: its chip row, then its cards (FeedClient). */
export const HOME_FEED_COLUMN_CLASS = 'flex w-full flex-col gap-5';

/** A feed lane's chip, the feed's button and the skeleton's stand-in alike. */
export function feedChipClassName(active: boolean) {
  return `min-h-11 rounded-full border px-4 text-sm font-bold ${
    active
      ? 'border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
      : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)]'
  }`;
}

/**
 * The chip row stands where the feed draws it, so the first post lands where
 * the first grey card stood: without it the post landed a row lower, and the
 * swap read as a jump (owner's screen recording, 2026-11-14). `activeChipId`
 * is the lane the page opens on: For you on the static `/`, the address's
 * `?chip=` on the signed-in Home.
 */
export function HomeFeedSkeleton({ activeChipId = 'for-you' }: { activeChipId?: FeedChipId }) {
  return (
    <div className={HOME_FEED_COLUMN_CLASS} aria-label="Loading feed">
      <div className="flex flex-wrap items-center gap-2" aria-hidden data-testid="home-feed-skeleton-chips">
        {FEED_CHIPS.map((chip) => (
          <span key={chip.id} data-feed-chip={chip.id} className={`inline-flex items-center ${feedChipClassName(chip.id === activeChipId)}`}>
            {chip.label}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {[220, 320, 260].map((height, index) => (
          <div
            key={index}
            className="relative overflow-hidden rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
            style={{ minHeight: height }}
          >
            <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
          </div>
        ))}
      </div>
    </div>
  );
}

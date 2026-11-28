/**
 * Players whose clip the reader moved by hand with the reel's progress bar
 * (`components/reel-progress-bar.tsx`). A Home or Explore tile that a reel
 * closes into takes the player over where it is (`lib/video-player-loans.ts`),
 * and the place the reader dragged or tapped to is not watched: the tile
 * reports no progress for that player until the clip starts over
 * (`components/feed-video-preview.tsx`). The reel's own reports filter seeks
 * themselves (`createReelWatchVisit` in `lib/reel-progress-view-model.ts`).
 */
const movedByReader = new WeakSet<object>();

/** A loop's restart: a report this much earlier than the last one. */
const START_OVER_SECONDS = 0.05;

export function markVideoMovedByReader(player: object) {
  movedByReader.add(player);
}

export function wasVideoMovedByReader(player: object) {
  return movedByReader.has(player);
}

/**
 * For one tile reading one player's time reports: whether each report counts.
 * False while the reader's move stands; once the clip starts over, the mark is
 * cleared and every report counts again.
 */
export function createReaderMoveFilter(player: object) {
  let last: number | null = null;
  return (seconds: number): boolean => {
    const previous = last;
    last = seconds;
    if (!movedByReader.has(player)) return true;
    if (previous !== null && seconds < previous - START_OVER_SECONDS) {
      movedByReader.delete(player);
      return true;
    }
    return false;
  };
}

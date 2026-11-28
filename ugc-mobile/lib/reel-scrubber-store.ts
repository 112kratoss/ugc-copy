/**
 * Joins a reel slide's progress bar to the video playing on it. The bar is
 * drawn with the slide's chrome, over every media page of the post, while the
 * player belongs to one media page several components down
 * (`app/viewer.tsx`): the page whose video is playing attaches its player
 * here, and the bar draws and scrubs whatever is attached. Kept outside React
 * state so attaching, scrubbing and seeking re-render only the bar and the
 * page, never the slide.
 */

export type ReelScrubberSnapshot<Player> = {
  /** The player of the video playing on the slide, or null when none is. */
  player: Player | null;
  /** A finger is dragging the bar. */
  scrubbing: boolean;
  /**
   * The scrub is over and the clip is on its way back to playing: it loads at
   * the place the finger let go, and says it is not playing until it does.
   * That pause is the scrub's, not the reader's.
   */
  resuming: boolean;
};

export function createReelScrubberStore<Player>() {
  let snapshot: ReelScrubberSnapshot<Player> = { player: null, scrubbing: false, resuming: false };
  let seekGeneration = 0;
  let lastSeekAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const publish = (next: ReelScrubberSnapshot<Player>) => {
    if (next.player === snapshot.player && next.scrubbing === snapshot.scrubbing && next.resuming === snapshot.resuming) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * The page whose video is playing hands over its player; the returned
     * function takes it back. Taking back a player that has since been
     * replaced changes nothing, so the order pages swap in does not matter.
     */
    attach(player: Player) {
      if (snapshot.player !== player) publish({ player, scrubbing: false, resuming: false });
      return () => {
        if (snapshot.player === player) publish({ player: null, scrubbing: false, resuming: false });
      };
    },

    setScrubbing(scrubbing: boolean) {
      if (scrubbing && !snapshot.player) return;
      publish({ ...snapshot, scrubbing, resuming: scrubbing ? false : snapshot.resuming });
    },

    setResuming(resuming: boolean) {
      if (resuming && !snapshot.player) return;
      publish({ ...snapshot, resuming });
    },

    /** The bar moved the clip to a new place (a scrub let go of, a tap, a screen reader's step). */
    noteSeek(now: number) {
      seekGeneration += 1;
      lastSeekAt = now;
    },

    /** Counts the seeks so far: the page's watch progress starts a new stretch after each. */
    seekGeneration: () => seekGeneration,

    /**
     * Whether the clip is being scrubbed, is on its way back from a scrub, or
     * was moved within `windowMs`. A load a seek causes is the reader's doing,
     * not a stall.
     */
    seekedWithin(now: number, windowMs: number) {
      return snapshot.scrubbing || snapshot.resuming || now - lastSeekAt < windowMs;
    },
  };
}

export type ReelScrubberStore<Player> = ReturnType<typeof createReelScrubberStore<Player>>;

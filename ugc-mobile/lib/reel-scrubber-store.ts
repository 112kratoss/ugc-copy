/**
 * Joins a reel slide's progress bar to the video playing on it. The bar is
 * drawn with the slide's chrome, over every media page of the post, while the
 * player belongs to one media page several components down
 * (`app/viewer.tsx`): the page whose video is playing attaches its player
 * here, with a way to ask whether its clip means to play, and the bar draws
 * and scrubs whatever is attached. Kept outside React state so attaching,
 * scrubbing and seeking re-render only the bar and the page, never the slide.
 */

export type ReelScrubberSnapshot<Player> = {
  /** The player of the video playing on the slide, or null when none is. */
  player: Player | null;
  /** A finger is dragging the bar. */
  scrubbing: boolean;
  /**
   * The clip the bar moved is on its way back to playing: it loads at the new
   * place and says it is not playing until it does. That pause is the bar's,
   * not the reader's.
   */
  resuming: boolean;
};

const pausedIntent = () => false;

export function createReelScrubberStore<Player>() {
  let snapshot: ReelScrubberSnapshot<Player> = { player: null, scrubbing: false, resuming: false };
  let readIntent: () => boolean = pausedIntent;
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
     * The page whose video is playing hands over its player, and how to ask
     * whether its clip means to play (what the reader sees: playing, or the
     * Play mark); the returned function takes it back. Taking back a player
     * that has since been replaced changes nothing, so the order pages swap
     * in does not matter.
     */
    attach(player: Player, wantsPlayback: () => boolean = pausedIntent) {
      readIntent = wantsPlayback;
      if (snapshot.player !== player) publish({ player, scrubbing: false, resuming: false });
      return () => {
        if (snapshot.player !== player) return;
        readIntent = pausedIntent;
        publish({ player: null, scrubbing: false, resuming: false });
      };
    },

    /**
     * Whether the attached clip means to play. Not the player's own `playing`,
     * which is false while a clip that means to play is still loading.
     */
    wantsPlayback() {
      return snapshot.player !== null && readIntent();
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
     * Whether the clip is being scrubbed, is on its way back from a seek, or
     * was moved within `windowMs`. A load a seek causes is the reader's doing,
     * not a stall.
     */
    seekedWithin(now: number, windowMs: number) {
      return snapshot.scrubbing || snapshot.resuming || now - lastSeekAt < windowMs;
    },
  };
}

export type ReelScrubberStore<Player> = ReturnType<typeof createReelScrubberStore<Player>>;

/** The part of a player a resume needs: expo-video's `VideoPlayer` has it. */
export type ResumablePlayer = {
  addListener(eventName: 'playingChange', listener: (event: { isPlaying: boolean }) => void): { remove(): void };
  play(): void;
};

/**
 * Holds the slide's resume while a clip the bar moved, and that means to play,
 * loads at its new place: until it says it plays again, or `graceMs` passes,
 * its "not playing" is the seek's (`lib/reel-scrubber-store.ts`'s `resuming`),
 * so the page shows no Play mark and no loading sparkles for it. A drag paused
 * the clip, so it is asked to play (`play`); a tap or a screen reader's step
 * did not. Returns the function that ends the hold early (a new scrub, the
 * reader's own tap, the bar going); it ends once, and calls `onEnd` once.
 */
export function holdResume<Player extends ResumablePlayer>(
  store: ReelScrubberStore<Player>,
  player: Player,
  { play, graceMs, onEnd }: { play: boolean; graceMs: number; onEnd?: () => void },
): () => void {
  let ended = false;
  let subscription: { remove(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    subscription?.remove();
    if (timer !== null) clearTimeout(timer);
    if (store.getSnapshot().player === player) store.setResuming(false);
    onEnd?.();
  };
  if (store.getSnapshot().player !== player) {
    end();
    return end;
  }
  try {
    subscription = player.addListener('playingChange', (event) => {
      if (event.isPlaying) end();
    });
    store.setResuming(true);
    timer = setTimeout(end, graceMs);
    if (play) player.play();
  } catch {
    // Released under the bar (a page that settled, a re-signed source, Back).
    end();
  }
  return end;
}

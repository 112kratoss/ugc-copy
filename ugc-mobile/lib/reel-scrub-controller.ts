import { markVideoMovedByReader } from '@/lib/reader-video-moves';
import {
  reelAccessibilityStepSeconds,
  reelProgressFraction,
  reelProgressNeedsResync,
  reelSeekSeconds,
  type ReelProgressRun,
} from '@/lib/reel-progress-view-model';
import { holdResume, type ReelScrubberStore, type ResumablePlayer } from '@/lib/reel-scrubber-store';

/**
 * What the reel's progress bar does with the player it is given
 * (`components/reel-progress-bar.tsx`): following the clip, a scrub from first
 * touch to let-go, a tap's seek, a screen reader's step. Kept out of React (the
 * component holds one controller, made once) so its gesture callbacks touch no
 * refs, which React Compiler needs to compile the bar, and so all of it is
 * tested with a stand-in player.
 *
 * It never reads the player's `currentTime`: on Android that read blocks the
 * JS thread on the main thread (expo-video's VideoModule.kt). Where the clip
 * is comes from its time reports, and from the seeks the bar sends itself.
 */

/** The part of expo-video's `VideoPlayer` the bar uses: written, never read for its time. */
export type ScrubbablePlayer = ResumablePlayer & {
  currentTime: number;
  readonly playing: boolean;
  readonly status: string;
  readonly playbackRate: number;
  pause(): void;
  scrubbingModeOptions: { scrubbingModeEnabled?: boolean };
};

/** Draws the line: the component's shared value, on the UI thread. */
export type ReelProgressLine = {
  /** The line at a fraction, standing still. */
  setFraction(fraction: number): void;
  /** The line from a fraction to the end, at the clip's pace. */
  runToEnd(fraction: number, durationMs: number): void;
};

/** How long a clip the bar moved has to play again before its pause counts as a stop. */
export const REEL_RESUME_GRACE_MS = 2500;
/** After a seek, time reports from before it are ignored until one lands this near the new place... */
const SEEK_SETTLE_SECONDS = 0.5;
/** ...or this long has passed. */
const SEEK_SETTLE_MS = 1000;

/**
 * A write to a player that may have been released under the bar: a carousel
 * page that settled, a re-signed source, Back. expo-video throws then.
 */
function safely(write: () => void) {
  try {
    write();
  } catch {
    // Released: there is nothing left to set.
  }
}

export function createReelScrubController<Player extends ScrubbablePlayer>({
  store,
  line,
  setClock,
  now = Date.now,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: {
  store: ReelScrubberStore<Player>;
  line: ReelProgressLine;
  /** The whole seconds the scrub label and a screen reader say. */
  setClock: (wholeSeconds: number) => void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}) {
  let duration = 0;
  let position = 0;
  let run: ReelProgressRun | null = null;
  let pendingSeek: { seconds: number; until: number } | null = null;
  let scrub: { wasPlaying: boolean } | null = null;
  let scrubTarget = 0;
  let scrubFrame: number | null = null;
  let endHold: (() => void) | null = null;
  let tracksClock = false;

  const sync = (player: Player, reportedSeconds: number) => {
    if (store.getSnapshot().scrubbing) return;
    const at = now();
    if (pendingSeek) {
      if (at < pendingSeek.until && Math.abs(reportedSeconds - pendingSeek.seconds) > SEEK_SETTLE_SECONDS) return;
      pendingSeek = null;
    }
    if (tracksClock) setClock(Math.floor(reportedSeconds));
    const fraction = reelProgressFraction(reportedSeconds, duration);
    if (!player.playing || player.status !== 'readyToPlay') {
      run = null;
      line.setFraction(fraction);
      return;
    }
    if (!reelProgressNeedsResync(run, at, fraction, duration)) return;
    const rate = player.playbackRate > 0 ? player.playbackRate : 1;
    const remainingMs = Math.max(0, ((duration - reportedSeconds) * 1000) / rate);
    run = { from: fraction, startedAt: at, durationMs: remainingMs };
    line.runToEnd(fraction, remainingMs);
  };

  // Holds the page's "playing" through the load at the new place, for a clip
  // that meant to play. One hold at a time.
  const holdThroughSeek = (player: Player, play: boolean) => {
    endHold?.();
    let end: (() => void) | null = null;
    end = holdResume(store, player, {
      play,
      graceMs: REEL_RESUME_GRACE_MS,
      onEnd: () => {
        if (endHold === end) endHold = null;
      },
    });
    if (store.getSnapshot().resuming) endHold = end;
  };

  const seekTo = (player: Player, seconds: number) => {
    safely(() => {
      player.currentTime = seconds;
    });
    position = seconds;
    run = null;
    pendingSeek = { seconds, until: now() + SEEK_SETTLE_MS };
    store.noteSeek(now());
    markVideoMovedByReader(player);
    setClock(Math.floor(seconds));
  };

  // A tap or a screen reader's step: one seek, the clip carrying on as it was.
  const jumpTo = (seconds: number) => {
    const player = store.getSnapshot().player;
    if (!player || scrub) return;
    const playing = endHold !== null || store.wantsPlayback();
    seekTo(player, seconds);
    line.setFraction(reelProgressFraction(seconds, duration));
    if (playing) holdThroughSeek(player, false);
  };

  const applyScrub = () => {
    scrubFrame = null;
    const player = store.getSnapshot().player;
    if (!player || !scrub) return;
    const seconds = reelSeekSeconds(scrubTarget, duration);
    safely(() => {
      player.currentTime = seconds;
    });
    position = seconds;
    setClock(Math.floor(seconds));
  };

  const cancelScrubFrame = () => {
    if (scrubFrame === null) return;
    cancelFrame(scrubFrame);
    scrubFrame = null;
  };

  return {
    setDuration(seconds: number) {
      duration = seconds;
    },

    /** Whether a screen reader runs: it reads the clock each second, so it is kept then. */
    setTracksClock(tracks: boolean) {
      tracksClock = tracks;
    },

    /** A player was attached: the line starts from nothing until its first report. */
    follow() {
      run = null;
      position = 0;
      line.setFraction(0);
    },

    /** A time report from the attached player. */
    report(player: Player, seconds: number) {
      position = seconds;
      sync(player, seconds);
    },

    /** The attached player started, stopped or loaded: the line is set to it again. */
    resync(player: Player) {
      if (store.getSnapshot().scrubbing) return;
      run = null;
      sync(player, position);
    },

    /** A finger began a sideways drag at `fraction` of the line. */
    beginScrub(fraction: number) {
      const player = store.getSnapshot().player;
      if (!player) return;
      // A clip still coming back from the last move meant to play.
      const wasResuming = endHold !== null;
      endHold?.();
      scrub = { wasPlaying: wasResuming || store.wantsPlayback() };
      run = null;
      // The clip and the label go to the finger at once, not at its next move.
      const seconds = reelSeekSeconds(fraction, duration);
      safely(() => {
        player.pause();
        player.scrubbingModeOptions = { scrubbingModeEnabled: true };
        player.currentTime = seconds;
      });
      position = seconds;
      markVideoMovedByReader(player);
      setClock(Math.floor(seconds));
      store.setScrubbing(true);
    },

    /** The finger moved: at most one seek a frame, to its latest place. */
    scrubTo(fraction: number) {
      scrubTarget = fraction;
      if (scrubFrame !== null) return;
      scrubFrame = requestFrame(applyScrub);
    },

    /** The finger let go at `fraction`: one exact seek, and the clip plays on if it was playing. */
    endScrub(fraction: number) {
      cancelScrubFrame();
      const ended = scrub;
      scrub = null;
      const player = store.getSnapshot().player;
      if (!player || !ended) {
        store.setScrubbing(false);
        return;
      }
      safely(() => {
        player.scrubbingModeOptions = { scrubbingModeEnabled: false };
      });
      seekTo(player, reelSeekSeconds(fraction, duration));
      store.setScrubbing(false);
      // It loads at the new place before it plays, and says it is not playing
      // meanwhile: until it plays again, that is the scrub's, not the reader's.
      if (ended.wasPlaying) holdThroughSeek(player, true);
    },

    tapSeek(fraction: number) {
      jumpTo(reelSeekSeconds(fraction, duration));
    },

    /** A screen reader's swipe up (1) or down (-1): a tenth of the clip. Returns the line's new place, or null. */
    step(direction: 1 | -1): number | null {
      if (!(duration > 0)) return null;
      const next = position + direction * reelAccessibilityStepSeconds(duration);
      const seconds = reelSeekSeconds(reelProgressFraction(next, duration), duration);
      jumpTo(seconds);
      return reelProgressFraction(seconds, duration);
    },

    /**
     * The bar let go of `player` (the post scrolled on, the clip failed, the
     * bar went): its player is left as it was found.
     */
    release(player: Player | null) {
      cancelScrubFrame();
      endHold?.();
      if (!scrub) return;
      scrub = null;
      if (!player) return;
      safely(() => {
        player.scrubbingModeOptions = { scrubbingModeEnabled: false };
      });
    },
  };
}

export type ReelScrubController<Player extends ScrubbablePlayer> = ReturnType<typeof createReelScrubController<Player>>;

import { useSyncExternalStore } from 'react';

/**
 * Where the reel's playback stands: the page its scroll handlers last handed
 * playback to, and the page the reel had settled on when they did.
 */
export type ReelHandoffReading = {
  page: number;
  settledIndex: number;
};

/**
 * The page the reel's scroll handlers hand playback to (app/viewer.tsx), kept
 * where the reel's fixed top controls can follow it.
 *
 * Playback goes to a page as soon as that page has most of the screen, mid
 * swipe; the reel settles on it only once the list has come to rest and the
 * reel has drawn again: on Android the list says it is at rest 150–200 ms after
 * it visibly stops, and the reel's render takes more. The sound control
 * followed the settled post, so after a swipe from a clip to a picture the
 * clip's control stood ~200 ms on the S24 and at least 300 ms on the iPhone,
 * and a clip's came ~190 ms late (audit, 2026-11-27). Held here rather than in
 * the reel's state, and read by the controls alone, so a hand-off draws them
 * again and not the whole reel.
 */
export interface ReelHandoffPage {
  /** The page last handed playback, or null before any. */
  page: () => number | null;
  reading: () => ReelHandoffReading | null;
  /** A swipe hands playback to `page`; the reel is still settled where it was. */
  handTo: (page: number) => void;
  /** The reel has settled on `index`, however it got there. */
  settle: (index: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createReelHandoffPage(): ReelHandoffPage {
  let current: ReelHandoffReading | null = null;
  const listeners = new Set<() => void>();
  const write = (page: number, settledIndex: number) => {
    if (current && current.page === page && current.settledIndex === settledIndex) return;
    current = { page, settledIndex };
    listeners.forEach((listener) => listener());
  };
  return {
    page: () => current?.page ?? null,
    reading: () => current,
    handTo: (page) => write(page, current?.settledIndex ?? page),
    settle: (index) => write(index, index),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The page whose post the reel's fixed top controls speak for: the page a
 * swipe has handed playback to, while the reel is still settled where it was
 * when it did; otherwise the page the reel is settled on. So the sound control
 * comes and goes with the clip's own sound, as its page takes the screen over,
 * and follows a reel moved on with no swipe at all (a post taken out of it) in
 * the same render. One past the last post is the closing slide, which has none.
 */
export function reelChromePage(settledIndex: number, reading: ReelHandoffReading | null) {
  return reading && reading.settledIndex === settledIndex ? reading.page : settledIndex;
}

/** `reelChromePage`, drawn again only when its answer changes. */
export function useReelChromePage(handoff: ReelHandoffPage, settledIndex: number) {
  const chromePage = () => reelChromePage(settledIndex, handoff.reading());
  return useSyncExternalStore(handoff.subscribe, chromePage, chromePage);
}

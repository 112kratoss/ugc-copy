import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

import { takeKeyedMasonryShift } from '@/lib/keyed-masonry-layouts';

/** What the hook needs of a list. FlashList's handle has both. */
export type KeyedMasonryList = {
  getAbsoluteLastScrollOffset: () => number;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/** How long the list is still brought to a place its content did not reach at first. */
export const KEYED_MASONRY_PLACE_OWED_MS = 1500;

/** When, after the first scroll, the same scroll is made again unless the list has arrived. */
export const KEYED_MASONRY_PLACE_RETRY_MS = [60, 180, 400, 800];

/**
 * Brings the native list to where a masonry named with `keyedMasonryData` has
 * moved its own offset to keep the reader's place (posts above the screen gone,
 * or back). Returns what the list's `onContentSizeChange`, `onScroll` and
 * `onScrollBeginDrag` have to call.
 *
 * The list has already drawn its tiles around that offset in this commit, and
 * the scroll made here lands with them, before the frame is shown. One case
 * needs more: posts coming back near the end of the grid (an Undo) send the
 * list further down than its content, still the shorter one, reaches. Android
 * applies a scroll before the content of the same commit and stops it at the
 * old end, and a scroll made as the content reports its new size did not always
 * take either (Pixel 9a emulator, 2026-11-28). So the scroll stays owed and is
 * made again, at each size the content reports, at each scroll event that
 * leaves the list short of it, and a few times on a clock, until a scroll event
 * says the list is there or somewhere else altogether, the reader takes hold
 * of the list (nothing moves a list under a finger), other data arrives, or
 * the time above runs out.
 *
 * While the screen is covered on Android the scroll view may take none of
 * them, and `useScrollWithinContent` brings it to the list's offset as the
 * screen returns.
 */
export function useKeyedMasonryPlace(
  listRef: RefObject<KeyedMasonryList | null>,
  data: readonly unknown[],
) {
  const owed = useRef<{ offset: number; from: number; until: number } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const place = useMemo(() => {
    const stop = () => {
      owed.current = null;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    const bring = () => {
      const due = owed.current;
      if (!due) return;
      if (Date.now() > due.until) {
        stop();
        return;
      }
      listRef.current?.scrollToOffset({ offset: due.offset, animated: false });
    };
    return {
      /** `shift`: how far down the list is being sent to get to `offset`. */
      owe: (offset: number, shift: number) => {
        stop();
        owed.current = { offset, from: offset - shift, until: Date.now() + KEYED_MASONRY_PLACE_OWED_MS };
        timers.current = KEYED_MASONRY_PLACE_RETRY_MS.map((wait) => setTimeout(bring, wait));
      },
      stop,
      onContentSizeChange: bring,
      /** `offset`: where a scroll event says the native list is. */
      onScroll: (offset: number) => {
        const due = owed.current;
        if (!due) return;
        // There; or somewhere the cut-short scroll could not have left it, which
        // is a scroll of the app's own (to the top, on a tab's second press or
        // "New posts") or the reader's, and is not undone.
        if (Math.abs(offset - due.offset) <= 1 || offset < due.from - 2 || offset > due.offset + 1) stop();
        else bring();
      },
      onScrollBeginDrag: stop,
    };
  }, [listRef]);

  useLayoutEffect(() => {
    const shift = takeKeyedMasonryShift(data);
    // Other data, and nothing to keep: what the data before it was owed goes with it.
    if (!shift) {
      place.stop();
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const offset = list.getAbsoluteLastScrollOffset();
    if (shift > 0) place.owe(offset, shift);
    else place.stop();
    list.scrollToOffset({ offset, animated: false });
  }, [data, listRef, place]);

  // On the way out only: `place` is made again with a new `listRef`, and the
  // scroll just owed must outlive that.
  useEffect(() => () => {
    owed.current = null;
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  return place;
}

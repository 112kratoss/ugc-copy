import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

import { takeKeyedMasonryShift } from '@/lib/keyed-masonry-layouts';

/** What the hook needs of a list. FlashList's handle has both. */
export type KeyedMasonryList = {
  getAbsoluteLastScrollOffset: () => number;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/** How long a scroll further down is still owed to a content that has yet to grow. */
export const KEYED_MASONRY_PLACE_OWED_MS = 600;

/**
 * Brings the native list to where a masonry named with `keyedMasonryData` has
 * moved its own offset to keep the reader's place (posts above the screen gone,
 * or back). Returns what the list's `onContentSizeChange` has to call.
 *
 * The list has already drawn its tiles around that offset in this commit, and
 * the scroll made here lands with them, before the frame is shown. One case
 * needs a second go: posts coming back near the end of the grid (an Undo) send
 * the list further down than its content, still the shorter one, reaches. The
 * scroll view applies a scroll before the content of the same commit, and
 * stops it at the old end, so the same scroll is made again as the content
 * reports its new size.
 *
 * While the screen is covered on Android the scroll view may take neither, and
 * `useScrollWithinContent` brings it to the list's offset as the screen returns.
 */
export function useKeyedMasonryPlace(
  listRef: RefObject<KeyedMasonryList | null>,
  data: readonly unknown[],
) {
  const owed = useRef<{ offset: number; until: number } | null>(null);

  useLayoutEffect(() => {
    const shift = takeKeyedMasonryShift(data);
    if (!shift) return;
    const list = listRef.current;
    if (!list) return;
    const offset = list.getAbsoluteLastScrollOffset();
    owed.current = shift > 0 ? { offset, until: Date.now() + KEYED_MASONRY_PLACE_OWED_MS } : null;
    list.scrollToOffset({ offset, animated: false });
  }, [data, listRef]);

  return useCallback(() => {
    const due = owed.current;
    owed.current = null;
    if (!due || Date.now() > due.until) return;
    listRef.current?.scrollToOffset({ offset: due.offset, animated: false });
  }, [listRef]);
}

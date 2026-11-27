import { useLayoutEffect, type RefObject } from 'react';

import { takeKeyedMasonryShift } from '@/lib/keyed-masonry-layouts';

/** What the hook needs of a list. FlashList's handle has both. */
export type KeyedMasonryList = {
  getAbsoluteLastScrollOffset: () => number;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/**
 * Brings the native list to where a masonry named with `keyedMasonryData` has
 * moved its own offset to keep the reader's place (posts above the screen gone,
 * or back). The list has already drawn its tiles around that offset in this
 * commit; the scroll lands with them, before the frame is shown. While the
 * screen is covered on Android the scroll view may not take it, and
 * `useScrollWithinContent` brings it to the same offset as the screen returns.
 */
export function useKeyedMasonryPlace(
  listRef: RefObject<KeyedMasonryList | null>,
  data: readonly unknown[],
) {
  useLayoutEffect(() => {
    if (!takeKeyedMasonryShift(data)) return;
    const list = listRef.current;
    list?.scrollToOffset({ offset: list.getAbsoluteLastScrollOffset(), animated: false });
  }, [data, listRef]);
}

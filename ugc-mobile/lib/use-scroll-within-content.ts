import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';

/** What the guard needs of a list. FlashList's handle has all three. */
export type ScrollWithinContentList = {
  getAbsoluteLastScrollOffset: () => number;
  getWindowSize: () => { height: number };
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/**
 * Where a vertical list scrolled to `offset` has to go once its content is
 * `contentHeight` tall in a window `viewportHeight` tall: its new end, when the
 * offset has been left past it, or null when the offset is still within the
 * content. A pixel of slack keeps rounding from moving the list.
 */
export function scrollOffsetBackWithinContent(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): number | null {
  if (!Number.isFinite(offset) || !Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight)) return null;
  if (viewportHeight <= 0) return null;
  const end = Math.max(0, contentHeight - viewportHeight);
  return offset > end + 1 ? end : null;
}

/**
 * Keeps a list scrolled within its content when the content shrinks while the
 * list's screen is covered (Android). Returns the list's `onContentSizeChange`.
 *
 * React Native's Android scroll view moves its offset back to its new end when
 * its content shrinks only if the view is shown at that moment
 * (`ReactScrollView.onLayoutChange` checks `isShown()`), and nothing moves it
 * when the view is shown again. A covered screen still takes its data changes,
 * and the composer and the viewer collapse the profile libraries to their first
 * page (`truncateInfiniteDataToFirstPage`), so a Profile scrolled through several
 * pages kept an offset past the end of the one page left and came back drawing
 * nothing but its background: the owner's S24 on 2026-11-06, back on Profile
 * after a publish, with its 13 tiles all above the window.
 *
 * So while the screen is not focused, a size change is answered here the way
 * Android answers it on screen, and the check runs again as the screen is
 * focused. FlashList's own offset is read, not one kept from `onScroll`: FlashList
 * drops the scroll events of its own position corrections and moves its offset
 * itself, so a copy kept from the events falls behind after new items arrive
 * above the reader. iOS is left alone: the fault is in Android's scroll view.
 */
export function useScrollWithinContent(
  listRef: RefObject<ScrollWithinContentList | null>,
  isFocused: boolean,
) {
  const contentHeight = useRef<number | null>(null);

  const bringBack = useCallback(() => {
    const list = listRef.current;
    if (Platform.OS !== 'android' || !list || contentHeight.current === null) return;
    const offset = scrollOffsetBackWithinContent(
      list.getAbsoluteLastScrollOffset(),
      contentHeight.current,
      list.getWindowSize().height,
    );
    if (offset !== null) list.scrollToOffset({ offset, animated: false });
  }, [listRef]);

  useEffect(() => {
    if (isFocused) bringBack();
  }, [bringBack, isFocused]);

  return useCallback((_width: number, height: number) => {
    contentHeight.current = height;
    // On screen, the scroll view does this itself.
    if (!isFocused) bringBack();
  }, [bringBack, isFocused]);
}

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';

/** What the guard needs of a list. FlashList's handle has all three. */
export type ScrollWithinContentList = {
  getAbsoluteLastScrollOffset: () => number;
  getWindowSize: () => { height: number };
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/**
 * How long a change is left to settle before the list is moved: past the 100 ms
 * in which FlashList drops the scroll events of its own position corrections
 * (`ignoreScrollEvents`, `useRecyclerViewController`), so the event of the
 * scroll made here reaches it and its cells follow the list.
 */
export const SCROLL_WITHIN_CONTENT_SETTLE_MS = 150;

/**
 * How long after the screen comes back a size change is still checked: one can
 * land before the view is attached again, where Android does not clamp it.
 */
export const SCROLL_WITHIN_CONTENT_RETURN_MS = 1000;

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
 * `offset` kept within a content `contentHeight` tall in a window
 * `viewportHeight` tall, or null while the window has no size or a number is
 * unknown.
 */
export function scrollOffsetWithinContent(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): number | null {
  if (!Number.isFinite(offset) || !Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight)) return null;
  if (viewportHeight <= 0) return null;
  return Math.min(Math.max(0, offset), Math.max(0, contentHeight - viewportHeight));
}

/**
 * Keeps a list drawn where its cells are when its content changes while its
 * screen is covered (Android). Returns the list's `onContentSizeChange`.
 *
 * A screen under a pushed screen is detached from the window, and React
 * Native's Android scroll view then moves its offset for nothing that happens
 * to its content. It moves the offset back to a shrunk content's new end only
 * while shown (`ReactScrollView.onLayoutChange` checks `isShown()`).
 * `MaintainVisibleScrollPositionHelper`, which carries out FlashList's
 * keep-your-place corrections, stops when the view is detached. Nothing catches
 * up when the view is shown again. Meanwhile FlashList keeps moving its own
 * offset and draws its cells around it.
 *
 * Covered changes are not rare. The composer and the viewer collapse the
 * profile libraries to their first page (`truncateInfiniteDataToFirstPage`),
 * deletes and archives take items out, a block turns a creator's grid into one
 * page and takes their posts out of the feed lanes. So a list came back drawn
 * empty, or empty below its last row. The owner's S24 Profile on 2026-11-06
 * sat at an offset past all 13 of its tiles after a publish.
 *
 * So:
 * - A size change while the screen is not focused moves the list, once the
 *   change has settled, to FlashList's own offset kept within the content.
 *   That is where its cells are. The same runs again as the screen is focused.
 * - For a moment after the screen comes back, a size change that leaves
 *   FlashList past the end brings the list back to the end, since the view may
 *   not have been shown yet.
 * - On screen the scroll view does its own work; nothing here moves a list
 *   the reader is using.
 * - iOS is left alone: UIKit moves the offset back itself, covered or not.
 */
export function useScrollWithinContent(
  listRef: RefObject<ScrollWithinContentList | null>,
  isFocused: boolean,
) {
  const contentHeight = useRef<number | null>(null);
  const changedWhileCovered = useRef(false);
  const returnedAt = useRef<number | null>(null);
  const wasFocused = useRef(isFocused);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const move = useCallback((where: typeof scrollOffsetWithinContent) => {
    const list = listRef.current;
    if (Platform.OS !== 'android' || !list || contentHeight.current === null) return;
    const offset = where(list.getAbsoluteLastScrollOffset(), contentHeight.current, list.getWindowSize().height);
    if (offset !== null) list.scrollToOffset({ offset, animated: false });
  }, [listRef]);

  const later = useCallback((where: typeof scrollOffsetWithinContent) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      move(where);
    }, SCROLL_WITHIN_CONTENT_SETTLE_MS);
  }, [move]);

  useEffect(() => {
    const returned = isFocused && !wasFocused.current;
    wasFocused.current = isFocused;
    if (!returned) return;
    returnedAt.current = Date.now();
    if (!changedWhileCovered.current) return;
    changedWhileCovered.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    move(scrollOffsetWithinContent);
  }, [isFocused, move]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useCallback((_width: number, height: number) => {
    contentHeight.current = height;
    if (Platform.OS !== 'android') return;
    if (!isFocused) {
      changedWhileCovered.current = true;
      later(scrollOffsetWithinContent);
      return;
    }
    if (returnedAt.current !== null && Date.now() - returnedAt.current < SCROLL_WITHIN_CONTENT_RETURN_MS) {
      later(scrollOffsetBackWithinContent);
    }
  }, [isFocused, later]);
}

'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export const FEED_WINDOW_MAX_MOUNTED_CARDS = 24;
const FEED_WINDOW_INITIAL_CARD_COUNT = 12;
const FEED_WINDOW_ESTIMATED_CARD_HEIGHT = 640;
const FEED_WINDOW_OVERSCAN_PX = 1_280;
const FEED_WINDOW_HEIGHT_CACHE_MAX_ENTRIES = 240;

const feedCardHeightCache = new Map<string, number>();

export interface WindowedFeedRange {
  startIndex: number;
  endIndex: number;
  offsets: number[];
  totalHeight: number;
}

export function getWindowedFeedRange({
  heights,
  gap,
  viewportStart,
  viewportHeight,
  overscan = FEED_WINDOW_OVERSCAN_PX,
  maxMountedCards = FEED_WINDOW_MAX_MOUNTED_CARDS,
}: {
  heights: number[];
  gap: number;
  viewportStart: number;
  viewportHeight: number;
  overscan?: number;
  maxMountedCards?: number;
}): WindowedFeedRange {
  const offsets: number[] = [];
  let totalHeight = 0;
  for (const height of heights) {
    offsets.push(totalHeight);
    totalHeight += Math.max(1, height) + gap;
  }
  if (heights.length > 0) totalHeight -= gap;

  const windowStart = Math.max(0, viewportStart - overscan);
  const windowEnd = Math.max(windowStart, viewportStart + viewportHeight + overscan);
  let startIndex = 0;
  while (
    startIndex < heights.length
    && offsets[startIndex] + heights[startIndex] < windowStart
  ) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (
    endIndex < heights.length
    && offsets[endIndex] <= windowEnd
    && endIndex - startIndex < maxMountedCards
  ) {
    endIndex += 1;
  }

  if (endIndex === startIndex && startIndex < heights.length) {
    endIndex = startIndex + 1;
  }

  return { startIndex, endIndex, offsets, totalHeight };
}

export default function WindowedFeedList<T>({
  items,
  getKey,
  renderItem,
  pinnedKeys,
  gap = 12,
}: {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /**
   * Cards with live interaction state, such as an open comment composer. They
   * may sit outside the ordinary bounded viewport range but remain mounted so
   * virtualization cannot discard fetched data or an unsent draft.
   */
  pinnedKeys?: ReadonlySet<string>;
  gap?: number;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [, setMeasurementVersion] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [viewport, setViewport] = useState({
    ready: false,
    height: 0,
    listTop: 0,
    scrollY: 0,
  });

  const keys = useMemo(() => items.map(getKey), [getKey, items]);
  const heights = keys.map((key) => (
    feedCardHeightCache.get(key) ?? FEED_WINDOW_ESTIMATED_CARD_HEIGHT
  ));
  const range = viewport.ready
    ? getWindowedFeedRange({
        heights,
        gap,
        viewportStart: Math.max(0, viewport.scrollY - viewport.listTop),
        viewportHeight: viewport.height,
      })
    : getWindowedFeedRange({
        heights,
        gap,
        viewportStart: 0,
        viewportHeight: FEED_WINDOW_ESTIMATED_CARD_HEIGHT * FEED_WINDOW_INITIAL_CARD_COUNT,
        overscan: 0,
        maxMountedCards: FEED_WINDOW_INITIAL_CARD_COUNT,
      });

  const mountedIndexes = useMemo(() => {
    const indexes = new Set<number>();
    for (let index = range.startIndex; index < range.endIndex; index += 1) {
      indexes.add(index);
    }

    const keyIndexes = new Map(keys.map((key, index) => [key, index]));
    for (const key of pinnedKeys ?? []) {
      const index = keyIndexes.get(key);
      if (index !== undefined) indexes.add(index);
    }

    // Keep one card of runway on either side of keyboard focus. When the user
    // Tabs through the final mounted card, the next target already exists in
    // DOM order; focusing it advances the runway again. A focused card also
    // remains mounted if the page scrolls independently beneath it.
    if (focusedKey) {
      const focusedIndex = keyIndexes.get(focusedKey);
      if (focusedIndex !== undefined) {
        indexes.add(focusedIndex);
        if (focusedIndex > 0) indexes.add(focusedIndex - 1);
        if (focusedIndex + 1 < items.length) indexes.add(focusedIndex + 1);
      }
    }

    return [...indexes].sort((left, right) => left - right);
  }, [focusedKey, items.length, keys, pinnedKeys, range.endIndex, range.startIndex]);
  const mountedIndexesKey = mountedIndexes.join(':');

  useEffect(() => {
    const updateViewport = () => {
      frameRef.current = null;
      const list = listRef.current;
      if (!list) return;
      const rect = list.getBoundingClientRect();
      setViewport({
        ready: true,
        height: window.innerHeight,
        listTop: rect.top + window.scrollY,
        scrollY: window.scrollY,
      });
    };
    const scheduleUpdate = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(updateViewport);
    };

    updateViewport();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [items.length]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const list = listRef.current;
    if (!list) return;

    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.getAttribute('data-feed-window-key');
        if (!key) continue;
        const height = entry.target.getBoundingClientRect().height;
        if (height <= 0 || Math.abs((feedCardHeightCache.get(key) ?? 0) - height) < 1) continue;
        feedCardHeightCache.delete(key);
        feedCardHeightCache.set(key, height);
        changed = true;
      }

      while (feedCardHeightCache.size > FEED_WINDOW_HEIGHT_CACHE_MAX_ENTRIES) {
        const oldestKey = feedCardHeightCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        feedCardHeightCache.delete(oldestKey);
      }
      if (changed) setMeasurementVersion((current) => current + 1);
    });

    list.querySelectorAll<HTMLElement>('[data-feed-window-key]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items, mountedIndexesKey]);

  return (
    <div
      ref={listRef}
      data-feed-windowed-list="true"
      style={{ position: 'relative', height: range.totalHeight }}
      onFocusCapture={(event) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>('[data-feed-window-key]');
        const key = card?.dataset.feedWindowKey ?? null;
        if (key && key !== focusedKey) setFocusedKey(key);
      }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setFocusedKey(null);
      }}
    >
      {mountedIndexes.map((itemIndex) => {
        const item = items[itemIndex];
        const key = keys[itemIndex];
        return (
          <div
            key={key}
            data-feed-window-key={key}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: range.offsets[itemIndex],
            }}
          >
            {renderItem(item, itemIndex)}
          </div>
        );
      })}
    </div>
  );
}

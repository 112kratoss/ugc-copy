'use client';

import { useEffect, useEffectEvent, useState } from 'react';

/** The keys that scroll the page, pressed anywhere but in a field the reader types in. */
const SCROLLING_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);

function scrollsThePage(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || !SCROLLING_KEYS.has(event.key)) return false;
  // An Element, not only an HTMLElement: a control's icon is an <svg> (event-target-narrowing-guard).
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
  // Space presses the control it is on ("Load more recipes" among them) rather than scrolling.
  return !(event.key === ' ' && target?.closest('button, a[href], summary, [role="button"]'));
}

/**
 * Whether the reader has scrolled the listing named `listingKey` with a gesture of their own: a turn
 * of the wheel, a finger moving on the page, a key that scrolls it, or a press on the window's
 * scrollbar. The page's scroll position is never read for it. On Back, React draws the listing and
 * runs its effects inside the browser's popstate, and only then does the browser put the reader
 * back where they were: the window jumps a screen or more that nobody scrolled (review of #888). A
 * press elsewhere is no scroll either: a press of "Load more recipes" asks for one page.
 *
 * Another listing, picked in place or reached by Back and Forward, starts unscrolled.
 * `scrolledAtStart`: the reader had scrolled this listing already (in the first-paint shell, whose
 * scroll brought the interactive list in).
 */
export function useReaderScrolled(listingKey: string, scrolledAtStart = false): boolean {
  const [scrolledListing, setScrolledListing] = useState<string | null>(scrolledAtStart ? listingKey : null);
  const scrolled = scrolledListing === listingKey;
  const markScrolled = useEffectEvent(() => {
    setScrolledListing(listingKey);
  });

  useEffect(() => {
    if (scrolled) return;
    const onGesture = () => markScrolled();
    const onKeyDown = (event: KeyboardEvent) => {
      if (scrollsThePage(event)) markScrolled();
    };
    // The window's scrollbar stands outside the page's own width (or height); a press there starts a drag.
    // Not a finger's: a touch screen has no scrollbar to press, and a phone's clientHeight can stay at the
    // height with its toolbar shown, so a tap on "Load more" at the bottom edge would read as one.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const root = document.documentElement;
      if (root.clientWidth > 0 && (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight)) markScrolled();
    };
    window.addEventListener('wheel', onGesture, { passive: true });
    window.addEventListener('touchmove', onGesture, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    return () => {
      window.removeEventListener('wheel', onGesture);
      window.removeEventListener('touchmove', onGesture);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [scrolled]);

  return scrolled;
}

'use client';

import { useEffect, type RefObject } from 'react';

/** Where the rail sticks under the top bar: `top: 76px` on `.canonical-post-actions`. */
const RAIL_STUCK_TOP_PX = 76;

/**
 * Tells the post page's rail how far down the window it starts, as
 * `--canonical-post-rail-top` on the layout.
 *
 * The rail holds the conversation, whose composer sits on the rail's bottom
 * edge, so the rail must end inside the window. It starts level with the
 * masthead, at the layout's top, and sticks 76px from the top once the page
 * has scrolled that far: its room is the window less wherever its top is now,
 * which CSS alone cannot know. The layout never sticks, so its top is the
 * rail's top until the rail sticks.
 *
 * Measured, never computed from the scroll offset: it holds whichever element
 * scrolls. Written only when the pixel changes, so past the first hundred or
 * so pixels of scroll (the rail stuck) a scroll costs one read.
 */
export function usePostRailTop(layoutRef: RefObject<HTMLElement | null>, layoutKey: string) {
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;

    let frame = 0;
    let written = -1;
    const measure = () => {
      frame = 0;
      const top = Math.max(RAIL_STUCK_TOP_PX, Math.round(layout.getBoundingClientRect().top));
      if (top === written) return;
      written = top;
      layout.style.setProperty('--canonical-post-rail-top', `${top}px`);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    // Capture: the scroll of any ancestor, not only the window's.
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    // The masthead above the rail changes height after the first paint (the
    // remix credit arrives with the viewer's read) without any scroll.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(layout);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
    // `layoutKey` names the layout now drawn: another post, or the page back
    // from a state that drew none, is another element to measure.
  }, [layoutRef, layoutKey]);
}

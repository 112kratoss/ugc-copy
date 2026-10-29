'use client';

import { useEffect, type RefObject } from 'react';

/**
 * What the modals that are up hold inert: each element with how many hold it and its own state
 * from before the first did, and the body's scroll lock likewise. Modals go in any order (the
 * composer's resource editor can go while the question it asked is still up), so the page comes
 * back only as the last of them goes.
 */
const heldElements = new Map<HTMLElement, { holds: number; inert: boolean; ariaHidden: string | null }>();
let bodyHolds = 0;
let bodyOverflow = '';

/**
 * The page beneath a modal: everything in <body> but the modal and what stays live, which keeps
 * the elements on its way down from <body> (they are not made inert, only what is beside them).
 */
function pageBeneath(overlay: HTMLElement, keepLive: HTMLElement | null): HTMLElement[] {
  const way = new Set<Element>();
  for (let node = keepLive?.parentElement ?? null; node && node !== document.body; node = node.parentElement) way.add(node);
  const beneath: HTMLElement[] = [];
  const collect = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child === overlay || child === keepLive || !(child instanceof HTMLElement)) continue;
      if (way.has(child)) collect(child);
      else beneath.push(child);
    }
  };
  collect(document.body);
  return beneath;
}

/**
 * While a modal drawn as a child of <body> is up, the page beneath it takes no
 * press, no scroll and no reader's attention: every other child of <body> is
 * inert and hidden from assistive technology, and the body does not scroll.
 * All of it is put back as the last modal holding it goes.
 *
 * `keepLive` is drawn above the modal and stays live (the toasts over the shared
 * confirmation). `lockScroll: false` leaves the page's scroll to the overlays
 * that lock it (the shared confirmation, which is asked from inside them).
 *
 * Call it before `useModalQuestion` in the same component: effects are undone in
 * the order they were declared, and the focus that hook gives back on the way
 * out does nothing while the element it returns to is still inert.
 */
export function useInertPageBeneath(
  overlayRef: RefObject<HTMLElement | null>,
  { lockScroll = true, keepLive }: { lockScroll?: boolean; keepLive?: RefObject<HTMLElement | null> } = {},
) {
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (lockScroll) {
      if (bodyHolds === 0) bodyOverflow = document.body.style.overflow;
      bodyHolds += 1;
      document.body.style.overflow = 'hidden';
    }
    const beneath = pageBeneath(overlay, keepLive?.current ?? null);
    beneath.forEach((element) => {
      const held = heldElements.get(element);
      if (held) {
        held.holds += 1;
        return;
      }
      heldElements.set(element, { holds: 1, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    return () => {
      if (lockScroll) {
        bodyHolds -= 1;
        // Only the lock this took: an overlay that locked the scroll itself before it and has
        // gone since (the Showcase reel) has put the page's own value back already.
        if (bodyHolds === 0 && document.body.style.overflow === 'hidden') document.body.style.overflow = bodyOverflow;
      }
      beneath.forEach((element) => {
        const held = heldElements.get(element);
        if (!held) return;
        held.holds -= 1;
        if (held.holds > 0) return;
        heldElements.delete(element);
        element.inert = held.inert;
        if (held.ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', held.ariaHidden);
        }
      });
    };
  }, [overlayRef, lockScroll, keepLive]);
}

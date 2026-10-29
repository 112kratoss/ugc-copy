'use client';

import { useEffect, type RefObject } from 'react';

/**
 * What the modals that are up hold inert: each element with how many hold it and its own state
 * from before the first did, and the body's overflow likewise. Modals go in any order (the
 * composer's resource editor can go while the question it asked is still up), so the page comes
 * back only as the last of them goes.
 */
const heldElements = new Map<HTMLElement, { holds: number; inert: boolean; ariaHidden: string | null }>();
let bodyHolds = 0;
let bodyOverflow = '';

/**
 * While a modal drawn as a child of <body> is up, the page beneath it takes no
 * press, no scroll and no reader's attention: every other child of <body> is
 * inert and hidden from assistive technology, and the body does not scroll.
 * All of it is put back as the last modal holding it goes.
 *
 * Call it before `useModalQuestion` in the same component: effects are undone in
 * the order they were declared, and the focus that hook gives back on the way
 * out does nothing while the element it returns to is still inert.
 */
export function useInertPageBeneath(overlayRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (bodyHolds === 0) bodyOverflow = document.body.style.overflow;
    bodyHolds += 1;
    document.body.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    siblings.forEach((element) => {
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
      bodyHolds -= 1;
      if (bodyHolds === 0) document.body.style.overflow = bodyOverflow;
      siblings.forEach((element) => {
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
  }, [overlayRef]);
}

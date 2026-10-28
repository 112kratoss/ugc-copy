'use client';

import { useEffect, type RefObject } from 'react';

/**
 * While a modal drawn as a child of <body> is up, the page beneath it takes no
 * press, no scroll and no reader's attention: every other child of <body> is
 * inert and hidden from assistive technology, and the body does not scroll.
 * All of it is put back as the modal goes.
 *
 * Call it before `useModalQuestion` in the same component: effects are undone in
 * the order they were declared, and the focus that hook gives back on the way
 * out does nothing while the element it returns to is still inert.
 */
export function useInertPageBeneath(overlayRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', ariaHidden);
        }
      });
    };
  }, [overlayRef]);
}

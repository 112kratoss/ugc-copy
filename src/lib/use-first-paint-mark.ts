import { useLayoutEffect } from 'react';

import { releaseAddressFirstPaintMark } from '@/lib/address-first-paint';

/**
 * Takes the address's first-paint mark (`src/lib/address-first-paint.ts`) off once the page
 * draws the choice it stands for, in the layout phase, so the stylesheet hands the choice to the
 * page's own drawing within one frame. `drawn` is the choice the page draws now, null for its
 * default. A mark the page does not draw yet (the render that hydrates draws the server's
 * default) stays until it does.
 */
export function useFirstPaintMark(attribute: string, drawn: string | null): void {
  useLayoutEffect(() => {
    const marked = document.documentElement.getAttribute(attribute);
    if (marked !== null && marked === drawn) releaseAddressFirstPaintMark(attribute);
  }, [attribute, drawn]);
}

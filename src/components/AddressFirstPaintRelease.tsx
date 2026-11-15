'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { ADDRESS_FIRST_PAINT_MARKS, releaseAddressFirstPaintMark } from '@/lib/address-first-paint';

/**
 * The shell's half of the address's first-paint marks (`src/lib/address-first-paint.ts`): a mark
 * stands for the page it was drawn on, so another page the reader goes to first (a creator not
 * found, a link out of Templates before it drew its filter) never inherits it.
 */
export default function AddressFirstPaintRelease() {
  const pathname = usePathname();
  const openedOnRef = useRef(pathname);

  useEffect(() => {
    if (pathname === openedOnRef.current) return;
    for (const attribute of ADDRESS_FIRST_PAINT_MARKS) releaseAddressFirstPaintMark(attribute);
  }, [pathname]);

  return null;
}

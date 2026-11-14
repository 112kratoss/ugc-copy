'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { REEL_OPENING_ATTRIBUTE, releaseReelOpening } from '@/lib/reel-opening-restore';

/**
 * Longest the page stays covered for a reel that never attaches (its chunk failed to load):
 * then the page under it shows, as it would have without the cover.
 */
export const REEL_OPENING_COVER_MAX_MS = 10_000;

/**
 * The reel's stage, drawn over the page from the first paint while a reel the address opens is
 * on its way (`src/lib/reel-opening-restore.ts`; shown by globals.css only while the root element
 * carries the mark). The reel takes the mark away when its dialog attaches; this gives the page
 * back when the reader leaves for another page first (a signed-out profile goes to sign-in) or
 * the reel never comes.
 */
export default function ReelOpeningCover() {
  const pathname = usePathname();
  const openedOnRef = useRef(pathname);

  useEffect(() => {
    if (!document.documentElement.hasAttribute(REEL_OPENING_ATTRIBUTE)) return;
    const timer = window.setTimeout(releaseReelOpening, REEL_OPENING_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (pathname !== openedOnRef.current) releaseReelOpening();
  }, [pathname]);

  return (
    <div className="reel-opening-cover" role="status" aria-live="polite">
      <span className="reel-opening-cover-pill">
        <span className="reel-opening-cover-spinner" aria-hidden />
        Opening post
      </span>
    </div>
  );
}

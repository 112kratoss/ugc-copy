'use client';

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

import type { EditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCardFallback from './CreatorProfileCardFallback';

interface DeferredCreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  loadError: string | null;
  collapseOptionalDetails?: boolean;
  hideIntro?: boolean;
  /**
   * What the page draws under the editor, drawn with the editor and never before it. The
   * placeholder is much shorter than the editor, and its height cannot be the editor's: that
   * depends on the account (a cover or none, the line under the handle) and on the editor's own
   * layout at each width. Drawn under the placeholder, Connected apps on /profile/edit stood at
   * y 830 of a 900px window, then the editor pushed it off the screen (live, 2026-11-17).
   */
  children?: ReactNode;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// React.lazy in a Suspense boundary of this file's own, not next/dynamic: dynamic draws its loading
// state in a boundary of its own, and what comes under the editor has to wait in the editor's.
const CreatorProfileCard = lazy(() => import('@/app/creations/CreatorProfileCard'));

function useDeferredUntilIdle() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(() => setIsReady(true), {
        timeout: 1200,
      });

      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(() => setIsReady(true), 650);
    return () => idleWindow.clearTimeout(timeoutId);
  }, []);

  return isReady;
}

export default function DeferredCreatorProfileCard({ children, ...props }: DeferredCreatorProfileCardProps) {
  const isReady = useDeferredUntilIdle();
  const placeholder = <CreatorProfileCardFallback initialProfile={props.initialProfile} loadError={props.loadError} />;

  if (!isReady) {
    return placeholder;
  }

  // The placeholder stays up until the editor can draw (the page was blank between the idle wait and
  // the code arriving), and whatever comes under the editor waits with it.
  return (
    <Suspense fallback={placeholder}>
      <CreatorProfileCard {...props} />
      {children}
    </Suspense>
  );
}

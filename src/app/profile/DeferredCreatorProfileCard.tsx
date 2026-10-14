'use client';

import dynamic from 'next/dynamic';
import { createContext, useContext, useEffect, useState } from 'react';

import type { EditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCardFallback from './CreatorProfileCardFallback';

interface DeferredCreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  loadError: string | null;
  onboardingMode?: boolean;
  nextPath?: string;
  returnAfterSave?: boolean;
  collapseOptionalDetails?: boolean;
  hideIntro?: boolean;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// A `dynamic` loading component is handed no props of its own, so the
// skeleton drawn while the editor's code downloads reads them from here.
const DeferredCardPropsContext = createContext<DeferredCreatorProfileCardProps | null>(null);

function EditorDownloadFallback() {
  const props = useContext(DeferredCardPropsContext);
  return props ? <CreatorProfileCardFallback {...props} /> : null;
}

const CreatorProfileCard = dynamic(() => import('@/app/creations/CreatorProfileCard'), {
  ssr: false,
  // The skeleton stays up until the editor can draw: the page was blank
  // between the idle wait and the code arriving.
  loading: EditorDownloadFallback,
});

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

export default function DeferredCreatorProfileCard(props: DeferredCreatorProfileCardProps) {
  const isDeferredReady = useDeferredUntilIdle();
  const isReady = props.onboardingMode || isDeferredReady;

  return (
    <DeferredCardPropsContext.Provider value={props}>
      {isReady ? <CreatorProfileCard {...props} /> : <CreatorProfileCardFallback {...props} />}
    </DeferredCardPropsContext.Provider>
  );
}

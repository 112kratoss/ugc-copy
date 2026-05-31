'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import type { EditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCardFallback from './CreatorProfileCardFallback';

interface DeferredCreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onboardingMode?: boolean;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const CreatorProfileCard = dynamic(() => import('@/app/creations/CreatorProfileCard'), {
  ssr: false,
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
  const isReady = useDeferredUntilIdle();

  if (!isReady) {
    return <CreatorProfileCardFallback {...props} />;
  }

  return <CreatorProfileCard {...props} />;
}

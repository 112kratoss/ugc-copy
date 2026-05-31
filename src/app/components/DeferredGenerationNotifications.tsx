'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const GenerationNotifications = dynamic(() => import('./GenerationNotifications'), {
  ssr: false,
  loading: () => null,
});

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function useDeferredUntilIdle() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(() => setIsReady(true), {
        timeout: 2500,
      });

      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(() => setIsReady(true), 1200);
    return () => idleWindow.clearTimeout(timeoutId);
  }, []);

  return isReady;
}

export default function DeferredGenerationNotifications() {
  const isReady = useDeferredUntilIdle();

  return isReady ? <GenerationNotifications /> : null;
}

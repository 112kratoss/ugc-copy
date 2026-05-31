'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import AppShellAccountFallback from './AppShellAccountFallback';

const AppShellAccount = dynamic(() => import('./AppShellAccount'), {
  ssr: false,
  loading: () => <AppShellAccountFallback />,
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
        timeout: 1500,
      });

      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(() => setIsReady(true), 800);
    return () => idleWindow.clearTimeout(timeoutId);
  }, []);

  return isReady;
}

export default function DeferredAppShellAccount() {
  const isReady = useDeferredUntilIdle();

  return isReady ? <AppShellAccount /> : <AppShellAccountFallback />;
}

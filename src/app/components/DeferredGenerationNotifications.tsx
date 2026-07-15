'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import {
  readAppShellAuthentication,
  subscribeToAppShellAuthentication,
} from './app-shell-auth-state';

const GenerationNotifications = dynamic(() => import('./GenerationNotifications'), {
  ssr: false,
  loading: () => null,
});

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function useDeferredUntilIdle(enabled: boolean) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
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
  }, [enabled]);

  return isReady;
}

export default function DeferredGenerationNotifications() {
  const [authenticated, setAuthenticated] = useState(
    () => readAppShellAuthentication() === true,
  );
  const isReady = useDeferredUntilIdle(authenticated);

  useEffect(() => subscribeToAppShellAuthentication(setAuthenticated), []);

  return authenticated && isReady ? <GenerationNotifications /> : null;
}

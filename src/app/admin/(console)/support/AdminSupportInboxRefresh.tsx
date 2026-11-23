'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** How often the console's support list is read again while its tab is visible. */
export const ADMIN_SUPPORT_INBOX_REFRESH_MS = 15_000;

/**
 * Keeps the console's support list current, as a chat app's list is: the page
 * is read again every 15 seconds while its tab is visible, and at once when
 * the tab comes back. Nothing is asked while it is hidden.
 */
export function AdminSupportInboxRefresh() {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => router.refresh(), ADMIN_SUPPORT_INBOX_REFRESH_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [router]);

  return null;
}

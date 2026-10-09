'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The unread alerts count the app shows on its Alerts tab, for the web shell's
 * bell and bottom tab. One read is shared by every badge on the page and kept
 * for a minute, the slowest a badge can lag without feeling broken; the alerts
 * page publishes what it reads and marks so the badge never waits on that.
 */
const UNREAD_TTL_MS = 60_000;

let unreadCount = 0;
let readAt = 0;
let inflight: Promise<number> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function publishUnreadAlertsCount(count: number) {
  unreadCount = Math.max(0, count);
  readAt = Date.now();
  notify();
}

async function readUnreadAlertsCount(): Promise<number> {
  // Loaded on first read, not at import: the shell renders in places with no
  // Supabase environment at all (tests), and the client is only needed here.
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return 0;
  const response = await fetch('/api/mobile/notifications?limit=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return unreadCount;
  const body = await response.json() as { unreadCount?: unknown };
  return typeof body.unreadCount === 'number' ? body.unreadCount : 0;
}

function refreshUnreadAlertsCount(force = false) {
  if (!force && Date.now() - readAt < UNREAD_TTL_MS) return;
  if (!inflight) {
    inflight = readUnreadAlertsCount()
      .catch(() => unreadCount)
      .then((count) => {
        publishUnreadAlertsCount(count);
        return count;
      })
      .finally(() => {
        inflight = null;
      });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUnreadAlertsCount(): number {
  const pathname = usePathname();
  const previousPathnameRef = useRef(pathname);
  const count = useSyncExternalStore(subscribe, () => unreadCount, () => 0);

  useEffect(() => {
    // Leaving the alerts page, which marks alerts read, must show that at once.
    const leftAlerts = previousPathnameRef.current === '/notifications' && pathname !== '/notifications';
    previousPathnameRef.current = pathname;
    refreshUnreadAlertsCount(leftAlerts);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshUnreadAlertsCount();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [pathname]);

  return count;
}

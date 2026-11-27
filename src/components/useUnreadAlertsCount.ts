'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

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
// Bumped by a reset: a read that was out for the account before it answers nobody.
let generation = 0;
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
  // A browser with no session cookie has no alerts to count, and asking would
  // load the Supabase client (66 KB transferred, 245 KB of script) on every
  // signed-out page the shell draws: 33 of 34 public pages did, for a badge
  // that always read 0 (speed baseline, 2026-11-19). A sign-in sets the cookie,
  // and the next read (a minute on, a page change or a return to the tab)
  // counts as before.
  if (!hasSupabaseAuthCookie()) return 0;
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

/**
 * Forgets the count: a sign-out, or a session of another account. The count was kept a minute with
 * no reset, so the previous account's unread count stayed on the bell for up to a minute after
 * either. The badge shows nothing at once, and while a badge is on the page the count of the
 * account now signed in (none, after a sign-out) is read again at once.
 */
export function resetUnreadAlertsCount() {
  generation += 1;
  inflight = null;
  unreadCount = 0;
  readAt = 0;
  notify();
  if (listeners.size > 0) refreshUnreadAlertsCount(true);
}

function refreshUnreadAlertsCount(force = false) {
  if (!force && Date.now() - readAt < UNREAD_TTL_MS) return;
  if (!inflight) {
    const readGeneration = generation;
    const read = readUnreadAlertsCount()
      .catch(() => unreadCount)
      .then((count) => {
        if (readGeneration === generation) publishUnreadAlertsCount(count);
        return count;
      })
      .finally(() => {
        if (inflight === read) inflight = null;
      });
    inflight = read;
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

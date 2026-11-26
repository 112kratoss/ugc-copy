'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

import {
  SUPPORT_UPDATES_SEEN_STORAGE_KEY,
  hasUnseenSupportUpdates,
  readSupportUpdatesPage,
  supportUpdatesSeenValue,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

/**
 * The unread dot of Help & Support's Updates (plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md), on the shell's
 * "Help & feedback" and on the page's Updates tab: an update was published
 * after this device's last look (`hasUnseenSupportUpdates`).
 *
 * - When the newest update was published is read once a browser session, with
 *   the one-row read `GET /api/support/updates?limit=1`, and kept in the tab's
 *   sessionStorage. A browser with no session cookie asks the read every
 *   visitor gets (`scope=public`), which the CDN keeps; one with a cookie asks
 *   without a token, read for no one, since the time is everyone's.
 * - The last look is kept in localStorage (`SUPPORT_UPDATES_SEEN_STORAGE_KEY`),
 *   written when Updates shows its list, so a reader with no account has one
 *   too. Another tab's look reaches this one through the storage event.
 *
 * The read waits for the browser to be idle and never holds a page, and the
 * dot is drawn only in the browser: the server's HTML and the render that
 * hydrates it have none. Storage that cannot be read (a private window,
 * blocked site data) is treated as empty.
 */

/** Where a tab keeps the newest update's time once read, as `{ "latestAt": string | null }`. */
export const SUPPORT_UPDATES_LATEST_SESSION_KEY = 'magicbooklet.support-updates.latest-at';

/** The read the dot asks, without and with a session cookie. */
export const SUPPORT_UPDATES_DOT_READ_PATH = '/api/support/updates?limit=1';
export const SUPPORT_UPDATES_DOT_PUBLIC_READ_PATH = '/api/support/updates?limit=1&scope=public';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** What this document knows of the newest update: undefined until known. */
let latest: { latestAt: string | null } | undefined;
/** This device's last look: undefined until read from storage. */
let seenAt: string | null | undefined;
/** Whether this document has asked for the newest update (or been told it). */
let requested = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function readStoredSeenAt(): string | null {
  try {
    return window.localStorage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readSessionLatest(): { latestAt: string | null } | undefined {
  try {
    const raw = window.sessionStorage.getItem(SUPPORT_UPDATES_LATEST_SESSION_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('latestAt' in parsed)) return undefined;
    const value = (parsed as { latestAt: unknown }).latestAt;
    return typeof value === 'string' || value === null ? { latestAt: value } : undefined;
  } catch {
    return undefined;
  }
}

function currentSeenAt(): string | null {
  if (seenAt === undefined) seenAt = readStoredSeenAt();
  return seenAt;
}

function currentLatest(): { latestAt: string | null } | undefined {
  if (latest === undefined) latest = readSessionLatest();
  return latest;
}

function readUnread(): boolean {
  if (typeof window === 'undefined') return false;
  const known = currentLatest();
  return known ? hasUnseenSupportUpdates(known.latestAt, currentSeenAt()) : false;
}

function readNoUnread(): boolean {
  return false;
}

function onStorage(event: StorageEvent) {
  if (event.key !== SUPPORT_UPDATES_SEEN_STORAGE_KEY && event.key !== null) return;
  // Another tab looked at Updates (or the storage was cleared).
  seenAt = event.key === null ? null : event.newValue;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/**
 * When the newest update was published, as a read of Updates found it (the
 * page's first page, or the dot's own read): kept for the tab.
 */
export function noteSupportUpdatesLatest(latestAt: string | null): void {
  requested = true;
  latest = { latestAt };
  try {
    window.sessionStorage.setItem(SUPPORT_UPDATES_LATEST_SESSION_KEY, JSON.stringify({ latestAt }));
  } catch {
    // Kept for this document alone.
  }
  notify();
}

/**
 * Updates was looked at with its newest update published at `latestAt`: kept
 * as this device's last look, never earlier than one kept already.
 */
export function markSupportUpdatesSeen(latestAt: string | null): void {
  const before = currentSeenAt();
  const next = supportUpdatesSeenValue(latestAt, before);
  if (next === before || next === null) return;
  seenAt = next;
  try {
    window.localStorage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, next);
  } catch {
    // Kept for this document alone.
  }
  notify();
}

/**
 * Asks once a browser session when the newest update was published, unless
 * this tab knows already. Failures leave the dot off; the next full load of a
 * page asks again.
 */
export function requestSupportUpdatesLatest(fetcher: typeof fetch = fetch): void {
  if (typeof window === 'undefined' || requested) return;
  requested = true;
  if (currentLatest()) return;
  const path = hasSupabaseAuthCookie() ? SUPPORT_UPDATES_DOT_READ_PATH : SUPPORT_UPDATES_DOT_PUBLIC_READ_PATH;
  void Promise.resolve()
    .then(() => fetcher(path))
    .then(async (response) => (response.ok ? readSupportUpdatesPage(await response.json()) : null))
    .then((page) => {
      if (page) noteSupportUpdatesLatest(page.latestAt);
    })
    .catch(() => undefined);
}

function whenIdle(callback: () => void): () => void {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 4000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 1500);
  return () => window.clearTimeout(handle);
}

/**
 * Whether Updates holds something this device has not seen. With `enabled`,
 * asks when the newest update was published (once a browser session, when the
 * browser is idle); without it, draws nothing and asks nothing.
 */
export function useSupportUpdatesUnread(enabled = true): boolean {
  const unread = useSyncExternalStore(subscribe, readUnread, readNoUnread);

  useEffect(() => {
    if (!enabled) return undefined;
    return whenIdle(() => requestSupportUpdatesLatest());
  }, [enabled]);

  return enabled && unread;
}

/** For tests: forgets what this document knew and asked. */
export function resetSupportUpdatesUnreadForTests(): void {
  latest = undefined;
  seenAt = undefined;
  requested = false;
  notify();
}

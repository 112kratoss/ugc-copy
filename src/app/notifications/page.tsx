'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
import { publishNavigationStartTo } from '@/components/navigation-progress-state';
import { publishUnreadAlertsCount } from '@/components/useUnreadAlertsCount';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import { supabase } from '@/lib/supabase';
import { resolveWebNotificationPath } from '@/lib/web-notification-links';
import { AlertsErrorCard } from './AlertsErrorCard';
import { MARK_ALL_READ_AT_REST, MARK_ALL_READ_SHAPE } from './mark-all-read-look';
import { SignedInAlertsBoundary } from './SignedInAlertsBoundary';
import type { WebNotification } from './web-notification';

// The Alerts tab is in the shell of every page, so signed-out visitors open
// this page too: this file and its sign-in card are drawn with globals.css
// alone. The signed-in half links the supplement itself and loads only once
// the session check finds a reader (globals.css skips its file). While this
// folder's layout linked the supplement, a signed-out click on the tab
// fetched the signed-in sheet's text and kept it for the rest of the visit.
// Each use of the half sits in a SignedInAlertsBoundary: a load that fails (a
// deploy rotated the chunk names while the tab was open; offline) draws the
// page's error card, not Next's generic one. Both uses share one load, so they
// arrive or fail together: with an import() each, the controls' load could fail
// on a flaky connection and the list's succeed a moment later (a failed chunk
// is asked for again by the next import()), leaving the list without Refresh
// and Mark all read, and no card to say so, until a reload.
let signedInHalf: Promise<typeof import('./SignedInAlerts')> | undefined;
const SignedInAlerts = dynamic(() => (signedInHalf ??= import('./SignedInAlerts')), {
  ssr: false,
  loading: () => <AlertsListPlaceholder />,
});
const SignedInAlertsActions = dynamic(
  () => (signedInHalf ??= import('./SignedInAlerts')).then((module) => module.SignedInAlertsActions),
  { ssr: false, loading: () => <SignedInAlertsActionsPlaceholder /> },
);

// The placeholder's rows: about a first screen of alerts at 1440x900, where six fill the window under
// the header; a list of more continues under them, one of fewer ends sooner. Their title bars are as
// varied as titles are.
const PLACEHOLDER_TITLE_WIDTHS = ['w-2/5', 'w-1/2', 'w-1/3', 'w-3/5', 'w-2/5', 'w-1/2'];

/** A line of a row's own type, so it is that line's height whatever the font; its bar is drawn in it. */
function PlaceholderLine({ type, bar }: { type: string; bar: string }) {
  return (
    <span className={`relative block ${type}`}>
      &nbsp;
      <span className={`absolute left-0 top-1/2 h-[0.7em] -translate-y-1/2 rounded-full bg-white/[0.07] ${bar}`} />
    </span>
  );
}

/**
 * The list's place while the session check, the list's first read and the
 * signed-in half are under way: rows in the shape of the list's own
 * (`SignedInAlerts.tsx`), a line of title, a line of body and the row of chips,
 * each in the list's own type and spacing, so the rows arrive where these stood
 * and nothing under the header moves. A spinner in an empty box stood here,
 * and the list then appeared all at once (live, 2026-11-17). Drawing only: the
 * status line says it to a screen reader, and the shimmer, which is motion,
 * stands still under reduced motion.
 */
function AlertsListPlaceholder({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p role="status" className="sr-only">Loading alerts</p>
      <div aria-hidden className="space-y-3">
        {PLACEHOLDER_TITLE_WIDTHS.map((titleWidth, index) => (
          <div
            key={index}
            data-alerts-placeholder-row
            className="relative flex w-full items-start gap-4 overflow-hidden rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-4"
          >
            <span className="h-10 w-10 shrink-0 rounded-xl bg-white/[0.06]" />
            <span className="block min-w-0 flex-1">
              <PlaceholderLine type="text-sm leading-tight sm:text-base" bar={titleWidth} />
              <PlaceholderLine type="mt-1 text-xs leading-relaxed sm:text-sm" bar="w-4/5" />
              <span className="mt-2.5 flex items-center gap-3 text-[11px] font-medium text-transparent">
                <span className="rounded-full bg-white/5 px-2.5 py-0.5">Creator</span>
                <span className="rounded-full bg-white/[0.04]">Just now</span>
              </span>
            </span>
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.05] to-transparent motion-safe:animate-[skeleton-shimmer_1.5s_linear_infinite] motion-reduce:hidden" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Refresh and Mark all read, holding their place while the module that draws
 * them loads, and while the session check runs for a browser that holds a
 * session. Without them the header row drew empty until then and the two
 * controls popped in; below 640px, where the row stacks, that moved the list's
 * place down by 64px. Mark all read is drawn as the button draws it with no
 * count read (`mark-all-read-look.ts`), so it arrives unchanged; its words are
 * the button's, so the outline is exactly as wide whatever the font.
 */
function SignedInAlertsActionsPlaceholder({ className = '' }: { className?: string }) {
  return (
    <div className={`flex gap-2 select-none ${className}`} aria-hidden data-testid="alerts-actions-placeholder">
      <span className="h-12 w-12 rounded-full border border-[var(--ui-border-default)]" />
      <span className={`${MARK_ALL_READ_SHAPE} ${MARK_ALL_READ_AT_REST}`}>
        <CheckCheck className="h-4 w-4" />
        Mark all read
      </span>
    </div>
  );
}

/** What a reader with no session is shown in the list's place. */
function SignInRequiredCard({ className = '' }: { className?: string }) {
  return (
    <div className={`rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-8 text-center ${className}`}>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-zinc-400">
        <Bell className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-white">Sign in required</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Sign in to review generation results, recipe purchases, follows, saves, remixes, and creator activity.
      </p>
      {/* Back here after signing in, not the default landing page. */}
      <Link
        href="/login?returnUrl=/notifications"
        className="ui-focus-ring mt-6 inline-flex min-h-12 items-center justify-center rounded-full bg-[var(--ui-primary)] px-6 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
      >
        Sign in
      </Link>
    </div>
  );
}

/** Alerts per read, the newest page and every older one. */
const ALERTS_PAGE_SIZE = 50;

interface AlertsInbox {
  items: WebNotification[];
  /** The last page read was full, so the server may hold older alerts. */
  hasOlder: boolean;
}

/**
 * The newest page replaces the head of the list. Alerts already read below it
 * stay when the page reaches them, that is when its last row is one the list
 * holds unchanged: nothing can sit between the two. Otherwise the page starts
 * the list again. auth-js reports a sign-in on every return to the tab, and
 * each one refetches; a plain replace threw away every older page.
 */
function withNewestPage(current: AlertsInbox, newest: WebNotification[]): AlertsInbox {
  if (newest.length < ALERTS_PAGE_SIZE) return { items: newest, hasOlder: false };
  const last = newest[newest.length - 1];
  const joinIndex = current.items.findIndex((n) => n.id === last.id && n.updatedAt === last.updatedAt);
  if (joinIndex === -1) return { items: newest, hasOlder: true };
  const newestIds = new Set(newest.map((n) => n.id));
  return {
    items: [...newest, ...current.items.slice(joinIndex + 1).filter((n) => !newestIds.has(n.id))],
    hasOlder: current.hasOlder,
  };
}

/** A refusal the server explained in words the reader can act on. */
class AlertsRequestError extends Error {
  detail: string;

  constructor(detail: string, message: string) {
    super(message);
    this.detail = detail;
  }
}

async function readRefusalDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : null;
  } catch {
    return null;
  }
}

export default function NotificationsPage() {
  const router = useRouter();
  const [inbox, setInbox] = useState<AlertsInbox>({ items: [], hasOlder: false });
  const notifications = inbox.items;
  // null until a list read answers. The shell's badge keeps its own count
  // until then: publishing the initial 0 blanked every badge on each visit,
  // and left it at 0 when the read failed.
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const unreadCountRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  // null until the session check answers: a signed-in visitor used to see
  // "Sign in required" for the first few hundred milliseconds of every visit.
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMarkingAll, setIsMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  // What the page draws before the session check answers, which takes a moment
  // and, on a full load, the page's script first. The browser's session cookie
  // says which reader the check will find, as the top bar's account slot reads
  // it (`DeferredAppShellAccount`). The server's HTML and the render that
  // hydrates it cannot read a cookie, so they draw both shapes and the root
  // element's mark, set from the cookie before the page draws
  // (`app-shell-account-restore.ts`), shows one; after that the cookie picks.
  // A cookie with no live session behind it draws the signed-in shape until the
  // check refuses it, then the sign-in card, the shell's accepted cost too.
  const hasReadSessionCookie = useHasHydratedSupabaseAuthCookieHint();
  const holdsSessionCookie = useSupabaseAuthCookieHint();
  const beforeSessionCheck: 'both' | 'signed-in' | 'signed-out' = !hasReadSessionCookie
    ? 'both'
    : holdsSessionCookie
      ? 'signed-in'
      : 'signed-out';

  // The shell's bell and Alerts tab show this count; what this page reads and
  // marks is the freshest value there is, so each change is published as made.
  const showUnreadCount = useCallback((count: number) => {
    const next = Math.max(0, count);
    unreadCountRef.current = next;
    setUnreadCount(next);
    publishUnreadAlertsCount(next);
  }, []);

  const setRowsRead = useCallback((isRead: boolean, id?: string) => {
    setInbox((current) => ({
      ...current,
      items: current.items.map((n) => (id === undefined || n.id === id ? { ...n, isRead } : n)),
    }));
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      setError(null);
      if (!session) {
        setIsAuthenticated(false);
        setLoading(false);
        return;
      }
      setIsAuthenticated(true);

      const response = await fetch(`/api/mobile/notifications?limit=${ALERTS_PAGE_SIZE}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Alerts request failed with ${response.status}`);
      }
      const data = await response.json();
      if (data.success) {
        const newest: WebNotification[] = data.notifications || [];
        setInbox((current) => withNewestPage(current, newest));
        showUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
      setError('Could not load alerts. Check the connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [showUnreadCount]);

  useEffect(() => {
    // The listener fires once on subscription with the current session
    // (INITIAL_SESSION), so this is the first load too; a separate first fetch
    // sent the list request twice on every visit.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        setIsAuthenticated(true);
        void fetchNotifications();
      } else {
        setIsAuthenticated(false);
        setInbox({ items: [], hasOlder: false });
        showUnreadCount(0);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchNotifications, showUnreadCount]);

  useEffect(() => {
    const updateCurrentTime = () => setCurrentTimeMs(Date.now());
    const initialFrame = window.requestAnimationFrame(updateCurrentTime);
    const interval = window.setInterval(updateCurrentTime, 60_000);

    return () => {
      window.cancelAnimationFrame(initialFrame);
      window.clearInterval(interval);
    };
  }, []);

  const handleMarkAllRead = async () => {
    if (!unreadCount || isMarkingAll) return;
    setIsMarkingAll(true);
    setMarkAllError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new AlertsRequestError('Sign in again, then try again.', 'No session to mark alerts read');
      }

      const response = await fetch('/api/mobile/notifications/read-all', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!response.ok) {
        // A 429 says to wait; any other refusal says what failed.
        const detail = await readRefusalDetail(response);
        throw new AlertsRequestError(
          detail ?? 'Try again in a moment.',
          `Mark all read failed with ${response.status}`,
        );
      }
      setRowsRead(true);
      showUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all read:', error);
      // Nothing was marked here: the rows and the count stay as the server has them.
      setMarkAllError(`Alerts were not marked read. ${
        error instanceof AlertsRequestError ? error.detail : 'Check the connection and try again.'
      }`);
    } finally {
      setIsMarkingAll(false);
    }
  };

  const handleLoadOlder = async () => {
    const oldest = notifications[notifications.length - 1];
    if (!oldest || isLoadingOlder) return;
    setIsLoadingOlder(true);
    setOlderError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('No session to read older alerts');

      // The inbox pages on its own order, each alert's last event (`updatedAt`).
      const query = new URLSearchParams({ limit: String(ALERTS_PAGE_SIZE), before: oldest.updatedAt, beforeId: oldest.id });
      const response = await fetch(`/api/mobile/notifications?${query}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Older alerts request failed with ${response.status}`);
      }
      const data = await response.json();
      if (!data.success) throw new Error('Older alerts request was not answered');
      const older: WebNotification[] = data.notifications || [];
      setInbox((current) => {
        // A refresh that started the list again meanwhile has its own end, and
        // this page belongs after the row it was read from.
        if (current.items[current.items.length - 1]?.id !== oldest.id) return current;
        const loadedIds = new Set(current.items.map((n) => n.id));
        return {
          items: [...current.items, ...older.filter((n) => !loadedIds.has(n.id))],
          hasOlder: older.length >= ALERTS_PAGE_SIZE,
        };
      });
      if (typeof data.unreadCount === 'number') showUnreadCount(data.unreadCount);
    } catch (error) {
      console.error('Failed to load older alerts:', error);
      setOlderError('Could not load older alerts. Check the connection and try again.');
    } finally {
      setIsLoadingOlder(false);
    }
  };

  const handlePressNotification = (notification: WebNotification) => {
    // Navigate at once and mark read in the background, as the app does; the
    // tap used to wait for a session check and the write before moving.
    const webPath = resolveWebNotificationPath(notification.deepLink);
    if (webPath) {
      // Announced as a link click is: the progress bar shows, and a post opened
      // here steps back to Alerts by its "Back" even when Alerts was the first page.
      publishNavigationStartTo(webPath);
      startTransition(() => {
        router.push(webPath);
      });
    }
    if (notification.isRead) return;

    setRowsRead(true, notification.id);
    showUnreadCount((unreadCountRef.current ?? 0) - 1);
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const response = await fetch('/api/mobile/notifications/read', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: [notification.id] }),
        });
        if (!response.ok) throw new Error(`Mark-read failed with ${response.status}`);
      } catch (error) {
        console.error('Failed to mark notification read:', error);
        setRowsRead(false, notification.id);
        showUnreadCount((unreadCountRef.current ?? 0) + 1);
      }
    })();
  };

  return (
    <div className="ui-page ui-page-ambient">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="ui-enter mb-6 flex flex-col gap-4 border-b border-[var(--ui-border-subtle)] pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">Alerts</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {isAuthenticated === null || (isAuthenticated && unreadCount === null)
              ? '\u00a0'
              : isAuthenticated
                ? `${unreadCount} unread ${unreadCount === 1 ? 'alert' : 'alerts'}`
                : 'Sign in to view alerts'}
          </p>
        </div>

        {/* Rendered as soon as a reader is known, so the signed-in half starts loading beside the list read.
            If the load fails, the list's boundary below says so; the row needs no second card. Before the
            check, their outlines, for a browser that holds a session. */}
        {isAuthenticated ? (
          <SignedInAlertsBoundary fallback={null}>
            <SignedInAlertsActions
              unreadCount={unreadCount}
              isMarkingAll={isMarkingAll}
              onRefresh={() => void fetchNotifications()}
              onMarkAllRead={() => void handleMarkAllRead()}
            />
          </SignedInAlertsBoundary>
        ) : isAuthenticated === null && beforeSessionCheck !== 'signed-out' ? (
          <SignedInAlertsActionsPlaceholder
            className={beforeSessionCheck === 'both' ? 'app-shell-when-signed-in' : ''}
          />
        ) : null}
      </div>

      {isAuthenticated === false ? (
        <SignInRequiredCard />
      ) : isAuthenticated === null && beforeSessionCheck === 'both' ? (
        <>
          <SignInRequiredCard className="app-shell-when-signed-out" />
          <AlertsListPlaceholder className="app-shell-when-signed-in" />
        </>
      ) : isAuthenticated === null && beforeSessionCheck === 'signed-out' ? (
        <SignInRequiredCard />
      ) : isAuthenticated === null || loading ? (
        <AlertsListPlaceholder />
      ) : (
        <SignedInAlertsBoundary
          fallback={(
            // A reload fetches the chunk names of the deployment that is live now.
            <AlertsErrorCard
              detail="Part of this page did not load. Retry reloads it."
              onRetry={() => window.location.reload()}
            />
          )}
        >
          <SignedInAlerts
            notifications={notifications}
            hasOlder={inbox.hasOlder}
            error={error}
            markAllError={markAllError}
            isLoadingOlder={isLoadingOlder}
            olderError={olderError}
            currentTimeMs={currentTimeMs}
            onRetry={() => void fetchNotifications()}
            onLoadOlder={() => void handleLoadOlder()}
            onPressNotification={handlePressNotification}
          />
        </SignedInAlertsBoundary>
      )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  Clock,
  CreditCard,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { publishUnreadAlertsCount } from '@/components/useUnreadAlertsCount';
import { supabase } from '@/lib/supabase';
import { resolveWebNotificationPath } from '@/lib/web-notification-links';

interface WebNotification {
  id: string;
  type: string;
  category: 'generation' | 'commerce' | 'social' | 'system';
  title: string;
  body: string;
  deepLink: string | null;
  isRead: boolean;
  /** How many events this alert groups ("Someone saved your post" × 7). */
  eventCount?: number;
  createdAt: string;
  updatedAt: string;
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

const CATEGORY_META = {
  generation: { color: 'text-[#ff9b7f] border-[#ff7a59]/25 bg-[#ff7a59]/10', Icon: Sparkles, label: 'Generation' },
  // 'Unlocks', as the app labels it: the category also carries credit purchases.
  commerce: { color: 'text-amber-400 border-amber-500/20 bg-amber-500/10', Icon: CreditCard, label: 'Unlocks' },
  social: { color: 'text-rose-400 border-rose-500/20 bg-rose-500/10', Icon: Heart, label: 'Creator' },
  system: { color: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/10', Icon: Bell, label: 'System' },
};

function formatNotificationTime(value: string, currentTimeMs: number | null) {
  if (currentTimeMs === null) return 'Just now';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Just now';
  const diffMs = currentTimeMs - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'Just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
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

        {isAuthenticated && (
          <div className="flex gap-2">
            <button
              onClick={fetchNotifications}
              aria-label="Refresh alerts"
              className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
              title="Refresh alerts"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => void handleMarkAllRead()}
              disabled={!unreadCount || isMarkingAll}
              className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isMarkingAll ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCheck className="h-4 w-4" />}
              <span>Mark all read</span>
            </button>
          </div>
        )}
      </div>

      {markAllError ? (
        <p role="alert" className="mb-4 rounded-2xl border border-rose-300/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {markAllError}
        </p>
      ) : null}

      {isAuthenticated === false ? (
        <div className="rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-8 text-center">
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
      ) : loading ? (
        <div className="flex min-h-[240px] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--ui-primary)]" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-3xl border border-rose-300/25 bg-rose-400/10 p-6">
          <h2 className="text-lg font-bold text-rose-200">Could not load alerts</h2>
          <p className="mt-2 text-sm text-[var(--ui-text-secondary)]">{error}</p>
          <button onClick={() => void fetchNotifications()} className="ui-focus-ring mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]">
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </button>
        </div>
      ) : notifications.length > 0 ? (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const meta = CATEGORY_META[notification.category] || CATEGORY_META.system;
            const Icon = meta.Icon;

            return (
              <button
                type="button"
                key={notification.id}
                onClick={() => handlePressNotification(notification)}
                className={`ui-focus-ring flex w-full cursor-pointer items-start gap-4 rounded-2xl border p-4 text-left transition ${
                  notification.isRead
                    ? 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] hover:bg-[var(--ui-surface-raised)]'
                    : 'border-[rgba(255,122,89,0.28)] bg-[var(--ui-primary-soft)] hover:border-[rgba(255,122,89,0.4)]'
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${meta.color}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold text-white text-sm sm:text-base leading-tight">
                      {notification.title}
                    </h3>
                    {!notification.isRead && (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--ui-primary)]" />
                    )}
                  </div>
                  <p className="mt-1 text-xs sm:text-sm leading-relaxed text-zinc-400">
                    {notification.body}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-zinc-300">
                      {meta.label}
                    </span>
                    {(notification.eventCount ?? 1) > 1 ? (
                      // Grouped alerts ("Someone saved your post" × 7) read as one event without this; the app shows the same chip.
                      <span className="inline-flex items-center rounded-full border border-[var(--ui-border-default)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ui-text-secondary)]">
                        {`${notification.eventCount} updates`}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 font-medium">
                      <Clock className="h-3 w-3" />
                      {formatNotificationTime(notification.updatedAt, currentTimeMs)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
          {/* The unread count covers every alert, so a busy inbox needs the ones past the first page. */}
          {inbox.hasOlder ? (
            <div className="flex flex-col items-center gap-3 pt-3">
              <button
                type="button"
                onClick={() => void handleLoadOlder()}
                disabled={isLoadingOlder}
                className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoadingOlder ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {isLoadingOlder ? 'Loading older alerts…' : 'Load older alerts'}
              </button>
              {olderError ? (
                <p role="alert" className="text-sm text-rose-200">{olderError}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">You are all caught up</h3>
          <p className="mt-2 text-sm text-zinc-400">
            New alerts appear here with unread status, categories, and direct links to the relevant features.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}

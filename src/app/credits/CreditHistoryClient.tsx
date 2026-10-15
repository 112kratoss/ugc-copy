'use client';

import clsx from 'clsx';
import {
  ArrowRight,
  Gift,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import {
  Button,
  Kicker,
  StatusCallout,
  Surface,
  Text,
  getAccentClasses,
  type UiAccent,
} from '@/components/DesignSystem';
import SkeletonLoader from '@/components/SkeletonLoader';
import { supabase } from '@/lib/supabase';

import {
  CREDIT_BALANCE_LOADING_LABEL,
  CREDIT_HISTORY_SIGN_IN_HREF,
  appendCreditHistoryPage,
  creditHistoryUrl,
  creditUnit,
  formatCreditBalance,
  formatCreditChange,
  formatCreditHistoryTime,
  parseCreditHistoryPage,
  type CreditHistoryEntry,
  type CreditHistoryKind,
  type CreditHistoryPage,
} from './credit-history';

const KIND_STYLE: Record<CreditHistoryKind, { icon: LucideIcon; accent: UiAccent }> = {
  purchase: { icon: ShoppingBag, accent: 'commerce' },
  grant: { icon: Gift, accent: 'workflow' },
  refund: { icon: RotateCcw, accent: 'image' },
  reversal: { icon: Undo2, accent: 'danger' },
  spend: { icon: Sparkles, accent: 'neutral' },
  adjustment: { icon: SlidersHorizontal, accent: 'motion' },
};

// The app's credit history screen says the same (ugc-mobile/app/credit-history.tsx).
const LOAD_FAILED_BODY = 'Your credits are safe. Check your connection, then try again.';
const REFRESH_FAILED_BODY = 'This is what loaded before. Check your connection, then try again.';
const OLDER_FAILED_MESSAGE = 'Older activity could not be loaded. Check your connection, then try again.';
const CURSOR_REFUSED_MESSAGE = 'Your credit history changed since it was opened. Reload it from the newest.';

type PageRead =
  | { ok: true; page: CreditHistoryPage }
  /**
   * `session`: no session here, or the server no longer takes it.
   * `cursor`: the server refused the cursor of a page further down, so the
   * list has to be read again from the newest.
   */
  | { ok: false; reason: 'session' | 'cursor' | 'failed'; message: string | null };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function serverMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error.trim() : null;
}

/**
 * auth-js could not reach Supabase Auth to refresh an expired token: that says
 * nothing about the session, so it reads as a connection problem, never as a
 * sign-out. A refused refresh token is a session that ended.
 */
function isAuthUnreachable(error: unknown) {
  return Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AuthRetryableFetchError';
}

/**
 * One page, newest first. The token is read for each page, not once: auth-js
 * refreshes an expired one here, and the list can sit open for an hour.
 */
async function readCreditHistoryPage(cursor: string | null): Promise<PageRead> {
  let accessToken: string | null = null;
  try {
    const { data, error } = await supabase.auth.getSession();
    accessToken = data.session?.access_token ?? null;
    if (!accessToken && isAuthUnreachable(error)) return { ok: false, reason: 'failed', message: null };
  } catch {
    return { ok: false, reason: 'failed', message: null };
  }
  if (!accessToken) return { ok: false, reason: 'session', message: null };

  let response: Response;
  try {
    response = await fetch(creditHistoryUrl(cursor), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'failed', message: null };
  }

  const payload = await readJson(response);
  if (response.status === 401) return { ok: false, reason: 'session', message: null };
  if (response.status === 400 && cursor) return { ok: false, reason: 'cursor', message: serverMessage(payload) };
  if (!response.ok) return { ok: false, reason: 'failed', message: serverMessage(payload) };

  try {
    return { ok: true, page: parseCreditHistoryPage(payload) };
  } catch {
    return { ok: false, reason: 'failed', message: null };
  }
}

type HistoryView =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'signed-out' }
  /** `pagesRead` counts the pages joined into `entries`, the first one included. */
  | { kind: 'list'; entries: CreditHistoryEntry[]; nextCursor: string | null; pagesRead: number };

type OlderRead =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; message: string; restart: boolean };

type Refresh = { status: 'idle' } | { status: 'loading' } | { status: 'failed'; message: string };

function viewFromFirstPage(result: PageRead): HistoryView {
  if (result.ok) {
    return { kind: 'list', entries: result.page.entries, nextCursor: result.page.nextCursor, pagesRead: 1 };
  }
  if (result.reason === 'session') return { kind: 'signed-out' };
  return { kind: 'failed', message: result.message ?? LOAD_FAILED_BODY };
}

function CreditHistorySkeleton() {
  return (
    <div role="status" aria-label="Loading your credit history">
      <Surface variant="card" padding="none" className="overflow-hidden">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex min-h-20 items-center gap-4 border-t border-[var(--ui-border-subtle)] px-4 py-4 first:border-t-0 sm:px-5">
            <SkeletonLoader className="h-11 w-11 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonLoader className="h-4 w-2/5" />
              <SkeletonLoader className="h-3 w-1/4" />
            </div>
            <SkeletonLoader className="h-4 w-16 shrink-0" />
          </div>
        ))}
      </Surface>
    </div>
  );
}

function CreditHistoryRow({ entry }: { entry: CreditHistoryEntry }) {
  const style = KIND_STYLE[entry.kind];
  const Icon = style.icon;
  const time = formatCreditHistoryTime(entry.occurredAt);
  const amountTone = entry.amount > 0
    ? getAccentClasses('workflow').accentText
    : entry.amount < 0
      ? 'text-[var(--ui-text-primary)]'
      : 'text-[var(--ui-text-muted)]';

  return (
    <li className="flex min-h-20 items-center gap-4 border-t border-[var(--ui-border-subtle)] px-4 py-4 first:border-t-0 sm:px-5">
      <span
        className={clsx(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border',
          getAccentClasses(style.accent).iconWrap,
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-bold text-[var(--ui-text-primary)]">{entry.title}</p>
        {entry.detail ? <Text variant="bodySm" className="break-words">{entry.detail}</Text> : null}
        {time ? (
          <Text variant="caption" className="mt-1">
            <time dateTime={entry.occurredAt}>{time}</time>
          </Text>
        ) : null}
      </div>
      {/* The unit under the number keeps this column narrow on a phone, so the title keeps the width. */}
      <p className="flex shrink-0 flex-col items-end text-right tabular-nums">
        <span className={clsx('text-sm font-extrabold', amountTone)}>{formatCreditChange(entry.amount)}</span>{' '}
        <span className="text-xs font-semibold text-[var(--ui-text-faint)]">{creditUnit(entry.amount)}</span>
      </p>
    </li>
  );
}

export default function CreditHistoryClient() {
  const { credits } = useAuth();
  const [view, setView] = useState<HistoryView>({ kind: 'loading' });
  const [older, setOlder] = useState<OlderRead>({ status: 'idle' });
  const [refresh, setRefresh] = useState<Refresh>({ status: 'idle' });
  const [announcement, setAnnouncement] = useState('');
  // Each read of the newest page started from here begins a new list; whatever
  // an earlier read or a page further down answers after that belongs to a
  // list that is gone.
  const listEpochRef = useRef(0);
  // The older-page read the Load more button is waiting on: a newer one or a
  // fresh list supersedes it, and the quiet refresh stands down while it is out.
  const olderRequestRef = useRef(0);
  const olderInFlightRef = useRef(false);

  useEffect(() => {
    const epoch = ++listEpochRef.current;
    void readCreditHistoryPage(null).then((result) => {
      if (epoch !== listEpochRef.current) return;
      setView(viewFromFirstPage(result));
    });
    return () => {
      listEpochRef.current += 1;
    };
  }, []);

  const reloadFromNewest = () => {
    const epoch = ++listEpochRef.current;
    olderRequestRef.current += 1;
    olderInFlightRef.current = false;
    // Nothing else changes the list while this read is out: Load more waits
    // for it and the quiet refresh stands down, so this is still true when
    // the answer comes.
    const listOnScreen = view.kind === 'list';
    setOlder({ status: 'idle' });
    setRefresh({ status: 'loading' });
    if (!listOnScreen) setView({ kind: 'loading' });
    void readCreditHistoryPage(null).then((result) => {
      if (epoch !== listEpochRef.current) return;
      // A list on screen stays when a refresh cannot be read; it says so above it.
      if (!result.ok && result.reason === 'failed' && listOnScreen) {
        setRefresh({ status: 'failed', message: result.message ?? REFRESH_FAILED_BODY });
        return;
      }
      setRefresh({ status: 'idle' });
      setView(viewFromFirstPage(result));
    });
  };

  const loadOlder = () => {
    if (view.kind !== 'list' || !view.nextCursor || older.status === 'loading' || refresh.status === 'loading') return;
    const listed = view;
    const cursor = view.nextCursor;
    const epoch = listEpochRef.current;
    const request = ++olderRequestRef.current;
    olderInFlightRef.current = true;
    setOlder({ status: 'loading' });
    void readCreditHistoryPage(cursor).then((result) => {
      if (request !== olderRequestRef.current) return;
      olderInFlightRef.current = false;
      if (epoch !== listEpochRef.current) {
        // The list was read again from the newest meanwhile; this page belonged to the old one.
        setOlder({ status: 'idle' });
        return;
      }
      if (!result.ok) {
        if (result.reason === 'session') {
          setOlder({ status: 'idle' });
          setView({ kind: 'signed-out' });
          return;
        }
        setOlder(result.reason === 'cursor'
          ? { status: 'failed', restart: true, message: CURSOR_REFUSED_MESSAGE }
          : { status: 'failed', restart: false, message: OLDER_FAILED_MESSAGE });
        return;
      }
      const entries = appendCreditHistoryPage(listed.entries, result.page.entries);
      const added = entries.length - listed.entries.length;
      setView((current) => (
        current === listed
          ? { kind: 'list', entries, nextCursor: result.page.nextCursor, pagesRead: listed.pagesRead + 1 }
          : current
      ));
      setOlder({ status: 'idle' });
      setAnnouncement(added === 0
        ? 'No older activity.'
        : `Loaded ${added} older ${added === 1 ? 'entry' : 'entries'}.`);
    });
  };

  // A balance that moved (a purchase settled in the app, a creation refunded,
  // the tab coming back after a while: the shell's `credits_updated`) moves the
  // newest page with it. Only while the newest page is all that is listed, so
  // nobody reading older activity has it taken from under them; the Refresh
  // button reads it again in that case.
  const quietRefreshAllowed = view.kind === 'list'
    && view.pagesRead === 1
    && older.status !== 'loading'
    && refresh.status !== 'loading';

  useEffect(() => {
    if (!quietRefreshAllowed) return;
    const handleCreditsUpdated = () => {
      // An older page being read keeps the list as it is; one asked for while
      // this read is out wins over its answer, and so does a Refresh.
      if (olderInFlightRef.current) return;
      const epoch = listEpochRef.current;
      const olderRequest = olderRequestRef.current;
      void readCreditHistoryPage(null).then((result) => {
        if (!result.ok || epoch !== listEpochRef.current || olderRequest !== olderRequestRef.current) return;
        setView((current) => (
          current.kind === 'list' && current.pagesRead === 1 ? viewFromFirstPage(result) : current
        ));
      });
    };
    window.addEventListener('credits_updated', handleCreditsUpdated);
    return () => window.removeEventListener('credits_updated', handleCreditsUpdated);
  }, [quietRefreshAllowed]);

  const refreshing = refresh.status === 'loading';
  const listShown = view.kind === 'list';

  return (
    <div className="ui-page ui-page-ambient min-h-screen pb-20">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="ui-enter mb-8">
          <Kicker icon={History}>Credits</Kicker>
          <Text as="h1" variant="pageTitle" className="mt-3">Credit history</Text>
          <Text variant="bodySm" className="mt-3 max-w-xl sm:text-base">
            Every credit added to your balance and every credit your creations used, newest first.
          </Text>
        </header>

        <Surface variant="panel" padding="lg" className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Text variant="caption">Available balance</Text>
            <Text as="p" variant="metric" className="mt-1">
              {typeof credits === 'number' ? `${formatCreditBalance(credits)} ${creditUnit(credits)}` : CREDIT_BALANCE_LOADING_LABEL}
            </Text>
          </div>
          <Button href="/pricing" prefetch={false} variant="primary" icon={ArrowRight} className="shrink-0">
            Get credits
          </Button>
        </Surface>

        <section aria-label="Credit activity">
          <div className="mb-4 flex items-center justify-between gap-4">
            <Text as="h2" variant="cardTitle">Activity</Text>
            {listShown ? (
              <button
                type="button"
                onClick={reloadFromNewest}
                disabled={refreshing}
                aria-label="Refresh credit history"
                title="Refresh credit history"
                className="ui-icon-button ui-focus-ring disabled:cursor-wait disabled:opacity-60"
              >
                <RefreshCw className={clsx('h-4 w-4', refreshing && 'animate-spin')} aria-hidden />
              </button>
            ) : null}
          </div>

          {refresh.status === 'failed' && listShown ? (
            <StatusCallout
              tone="danger"
              icon={RefreshCw}
              title="Could not refresh your credit history"
              body={refresh.message}
              className="mb-4"
            />
          ) : null}

          {view.kind === 'loading' ? (
            <CreditHistorySkeleton />
          ) : view.kind === 'signed-out' ? (
            <div>
              <StatusCallout
                tone="warning"
                icon={History}
                title="Sign in again to see your credit history"
                body="Your session on this browser has ended."
              />
              <Button href={CREDIT_HISTORY_SIGN_IN_HREF} prefetch={false} variant="primary" className="mt-5">
                Sign in
              </Button>
            </div>
          ) : view.kind === 'failed' ? (
            <div>
              <StatusCallout
                tone="danger"
                icon={RefreshCw}
                title="Could not load your credit history"
                body={view.message}
              />
              <button
                type="button"
                onClick={reloadFromNewest}
                disabled={refreshing}
                className="ui-button ui-button-primary ui-focus-ring mt-5 disabled:cursor-wait disabled:opacity-60"
              >
                <RefreshCw className={clsx('h-4 w-4', refreshing && 'animate-spin')} aria-hidden />
                Try again
              </button>
            </div>
          ) : view.entries.length === 0 ? (
            <Surface variant="soft" padding="lg" className="text-center">
              <span className={clsx('mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border', getAccentClasses('neutral').iconWrap)}>
                <History className="h-5 w-5" aria-hidden />
              </span>
              <Text as="h3" variant="cardTitle" className="mt-4">No credit activity yet</Text>
              <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">
                Credits you buy or are given, and what your creations spend, will be listed here.
              </Text>
              <Button href="/create" prefetch={false} variant="secondary" icon={Sparkles} iconPosition="start" className="mt-5">
                Start creating
              </Button>
            </Surface>
          ) : (
            <>
              <Surface variant="card" padding="none" className="overflow-hidden">
                <ul aria-label="Credit activity, newest first">
                  {view.entries.map((entry) => (
                    <CreditHistoryRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              </Surface>

              {view.nextCursor ? (
                <div className="mt-5 flex flex-col items-center gap-3">
                  {older.status === 'failed' && older.restart ? (
                    <button
                      type="button"
                      onClick={reloadFromNewest}
                      disabled={refreshing}
                      className="ui-button ui-button-secondary ui-focus-ring disabled:cursor-wait disabled:opacity-60"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      Reload from the newest
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={loadOlder}
                      disabled={older.status === 'loading' || refreshing}
                      aria-busy={older.status === 'loading' || undefined}
                      className="ui-button ui-button-secondary ui-focus-ring disabled:cursor-wait disabled:opacity-60"
                    >
                      {older.status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                      {older.status === 'loading' ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                  {older.status === 'failed' ? (
                    <p role="alert" className="text-center text-sm text-[var(--ui-text-secondary)]">{older.message}</p>
                  ) : null}
                </div>
              ) : (
                // As the app's list ends: nothing older is left to load.
                <Text variant="caption" className="mt-5 text-center">Your credit history starts here.</Text>
              )}
            </>
          )}

          <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
        </section>
      </div>
    </div>
  );
}

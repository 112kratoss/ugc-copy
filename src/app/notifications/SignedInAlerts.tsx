'use client';

// The signed-in half of Alerts brings the signed-in sheet itself. The page
// loads this module only once its session check finds a reader, so a
// signed-out visit, whose sign-in card globals.css draws, never fetches the
// supplement, by a click on the shell's Alerts tab or by a full load.
import '@/app/non-public-utilities.css';

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

import { AlertsErrorCard } from './AlertsErrorCard';
import type { WebNotification } from './web-notification';

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

interface SignedInAlertsActionsProps {
  unreadCount: number | null;
  isMarkingAll: boolean;
  onRefresh: () => void;
  onMarkAllRead: () => void;
}

/** Refresh and Mark all read, beside the page's heading. */
export function SignedInAlertsActions({ unreadCount, isMarkingAll, onRefresh, onMarkAllRead }: SignedInAlertsActionsProps) {
  return (
    <div className="flex gap-2">
      <button
        onClick={onRefresh}
        aria-label="Refresh alerts"
        className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
        title="Refresh alerts"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
      <button
        onClick={onMarkAllRead}
        disabled={!unreadCount || isMarkingAll}
        className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isMarkingAll ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCheck className="h-4 w-4" />}
        <span>Mark all read</span>
      </button>
    </div>
  );
}

interface SignedInAlertsProps {
  notifications: WebNotification[];
  hasOlder: boolean;
  error: string | null;
  markAllError: string | null;
  isLoadingOlder: boolean;
  olderError: string | null;
  currentTimeMs: number | null;
  onRetry: () => void;
  onLoadOlder: () => void;
  onPressNotification: (notification: WebNotification) => void;
}

/** The list once its first read has answered: the alerts, the error, or the empty state. */
export default function SignedInAlerts({
  notifications,
  hasOlder,
  error,
  markAllError,
  isLoadingOlder,
  olderError,
  currentTimeMs,
  onRetry,
  onLoadOlder,
  onPressNotification,
}: SignedInAlertsProps) {
  return (
    <>
      {markAllError ? (
        <p role="alert" className="mb-4 rounded-2xl border border-rose-300/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {markAllError}
        </p>
      ) : null}

      {error ? (
        <AlertsErrorCard detail={error} onRetry={onRetry} />
      ) : notifications.length > 0 ? (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const meta = CATEGORY_META[notification.category] || CATEGORY_META.system;
            const Icon = meta.Icon;

            return (
              <button
                type="button"
                key={notification.id}
                onClick={() => onPressNotification(notification)}
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
          {hasOlder ? (
            <div className="flex flex-col items-center gap-3 pt-3">
              <button
                type="button"
                onClick={onLoadOlder}
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
    </>
  );
}

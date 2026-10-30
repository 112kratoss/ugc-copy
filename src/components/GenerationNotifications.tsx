'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Clock3, X } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';

import {
  getGenerationKind,
  getGenerationNotificationCopy,
  type GenerationKind,
} from '@/lib/generation-feedback';
import {
  announceGenerationStatusSynced,
  readGenerationsOnPage,
  subscribeToGenerationOnPage,
  subscribeToGenerationStarted,
  type GenerationOnPageState,
} from '@/lib/generation-status-client';
import { HOME_WORKSPACE_ACTIVE_STATUSES } from '@/lib/home-dashboard';
import { supabase } from '@/lib/supabase';

const STATUS_CACHE_STORAGE_KEY = 'magicbooklet:generation-status-cache:v1';
const LEGACY_STATUS_CACHE_STORAGE_KEYS = [
  'emptybooklet:generation-status-cache:v1',
  'ugc:generation-status-cache:v1',
];
const GENERATION_STATUS_POLL_URL = '/api/generations?detail=status&limit=80';
const TOAST_LIFETIME_MS = 8000;
const POLL_INTERVAL_MS = 30000;

interface GenerationRecord {
  id: string;
  status: string;
  created_at?: string | null;
  completed_at?: string | null;
  category?: string | null;
  model?: string | null;
}

interface NotificationItem {
  id: string;
  generationId: string;
  status: 'succeeded' | 'failed';
  kind: GenerationKind;
  title: string;
  description: string;
}

/** In flight as the Home card and Studio count it, `pending` included. */
function isActiveGenerationStatus(status: string | undefined): boolean {
  return status !== undefined && (HOME_WORKSPACE_ACTIVE_STATUSES as readonly string[]).includes(status);
}

function readStatusCache(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw =
      window.sessionStorage.getItem(STATUS_CACHE_STORAGE_KEY) ??
      LEGACY_STATUS_CACHE_STORAGE_KEYS
        .map((key) => window.sessionStorage.getItem(key))
        .find((value) => Boolean(value));
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStatusCache(statuses: Record<string, string>) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(STATUS_CACHE_STORAGE_KEY, JSON.stringify(statuses));
  } catch {
    // Ignore storage failures in private mode or restrictive browsers.
  }
}

function clearStatusCache() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.removeItem(STATUS_CACHE_STORAGE_KEY);
    LEGACY_STATUS_CACHE_STORAGE_KEYS.forEach((key) => {
      window.sessionStorage.removeItem(key);
    });
  } catch {
    // Ignore storage failures.
  }
}

function getCompletionDurationMs(generation: GenerationRecord): number | null {
  const startedAtMs = generation.created_at ? Date.parse(generation.created_at) : Number.NaN;
  const completedAtMs = generation.completed_at ? Date.parse(generation.completed_at) : Number.NaN;

  if (Number.isNaN(startedAtMs) || Number.isNaN(completedAtMs)) {
    return null;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

export default function GenerationNotifications() {
  const [session, setSession] = useState<Session | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const knownStatusesRef = useRef<Record<string, string>>({});
  const timeoutMapRef = useRef<Record<string, number>>({});

  useEffect(() => {
    let isActive = true;

    const syncSessionState = async (nextSession?: Session | null) => {
      const resolvedSession =
        nextSession !== undefined
          ? nextSession
          : (await supabase.auth.getSession()).data.session;

      if (!isActive) {
        return;
      }

      setSession(resolvedSession ?? null);
    };

    void syncSessionState();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void syncSessionState(nextSession);
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const resetNotificationsState = () => {
      knownStatusesRef.current = {};
      clearStatusCache();
      setNotifications([]);

      Object.values(timeoutMapRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      timeoutMapRef.current = {};
    };

    if (!session?.access_token) {
      resetNotificationsState();
      return;
    }

    knownStatusesRef.current = readStatusCache();
    let isActive = true;
    let syncInFlight = false;
    let hasCompletedInitialSync = false;
    let pollingRequested = false;
    let pollingRequestVersion = 0;
    let shouldFetchFullList = true;
    let activeGenerationIds = new Set<string>();
    let pollTimeoutId: number | null = null;

    const clearScheduledPoll = () => {
      if (pollTimeoutId !== null) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }
    };

    const dismissNotification = (notificationId: string) => {
      setNotifications((current) => current.filter((item) => item.id !== notificationId));
      const timeoutId = timeoutMapRef.current[notificationId];
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        delete timeoutMapRef.current[notificationId];
      }
    };

    // What this tab's pages say of the runs they show (`generation-status-client.ts`): a run a
    // creator follows has its toast held until the page says how it ended (then it goes, and so
    // does one already up) or lets go of it (then it comes); a run the page showed ending is never
    // said, whichever of the two polls read the finish first. A toast rising from the bottom for
    // such a run covered the creator's Publish just as the page offered it. The register is read
    // here for a page that spoke before this mount, then kept by its events.
    const onPage = new Map<string, GenerationOnPageState>(readGenerationsOnPage());
    const held = new Map<string, { generation: GenerationRecord; status: 'succeeded' | 'failed' }>();
    // A sync's answer, read before a page's word and handled after, would put the run back to
    // active and have the next sync say it: the page's word stays over any list.
    const withRunsSettledOnPage = (statuses: Record<string, string>) => {
      onPage.forEach((state, id) => {
        if (state !== 'following') statuses[id] = state;
      });
      return statuses;
    };

    const enqueueNotification = (
      generation: GenerationRecord,
      status: 'succeeded' | 'failed'
    ) => {
      const onThisPage = onPage.get(generation.id);
      if (onThisPage === 'succeeded' || onThisPage === 'failed') {
        return;
      }
      if (onThisPage === 'following') {
        held.set(generation.id, { generation, status });
        return;
      }

      const existingId = `${generation.id}:${status}`;
      if (timeoutMapRef.current[existingId]) {
        return;
      }

      const kind = getGenerationKind(generation);
      const copy = getGenerationNotificationCopy(kind, status, getCompletionDurationMs(generation));
      const nextNotification: NotificationItem = {
        id: existingId,
        generationId: generation.id,
        status,
        kind,
        title: copy.title,
        description: copy.description,
      };

      setNotifications((current) => [nextNotification, ...current].slice(0, 3));
      timeoutMapRef.current[existingId] = window.setTimeout(() => {
        dismissNotification(existingId);
      }, TOAST_LIFETIME_MS);
    };

    const unsubscribeOnPage = subscribeToGenerationOnPage(({ id, state }) => {
      if (state === 'left') {
        onPage.delete(id);
        const waiting = held.get(id);
        held.delete(id);
        if (waiting) enqueueNotification(waiting.generation, waiting.status);
        return;
      }
      onPage.set(id, state);
      if (state === 'following') return;
      held.delete(id);
      knownStatusesRef.current = { ...knownStatusesRef.current, [id]: state };
      writeStatusCache(knownStatusesRef.current);
      dismissNotification(`${id}:succeeded`);
      dismissNotification(`${id}:failed`);
    });

    const syncGenerations = async () => {
      if (document.visibilityState === 'hidden') {
        pollingRequested = true;
        return;
      }
      if (syncInFlight) return;

      clearScheduledPoll();
      syncInFlight = true;
      const requestVersionAtStart = pollingRequestVersion;
      const fetchingFullList = shouldFetchFullList || activeGenerationIds.size === 0;
      const pollUrl = fetchingFullList
        ? GENERATION_STATUS_POLL_URL
        : `${GENERATION_STATUS_POLL_URL}&ids=${encodeURIComponent(Array.from(activeGenerationIds).join(','))}`;

      try {
        const response = await fetch(pollUrl, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Generation notification sync failed (${response.status}).`);
        }

        const data = await response.json();
        const generations = Array.isArray(data.generations)
          ? (data.generations as GenerationRecord[])
          : [];

        if (!isActive) {
          return;
        }

        const previousStatuses = knownStatusesRef.current;
        const nextStatuses = generations.slice(0, 80).reduce<Record<string, string>>((acc, generation) => {
          acc[generation.id] = generation.status;
          return acc;
        }, {});

        if (Object.keys(previousStatuses).length > 0) {
          let anyRunFailed = false;
          generations.forEach((generation) => {
            // From `pending` too: a held start that the reaper fails at 45
            // minutes, returning its credits, used to end without a word.
            if (
              isActiveGenerationStatus(previousStatuses[generation.id]) &&
              (generation.status === 'succeeded' || generation.status === 'failed')
            ) {
              enqueueNotification(generation, generation.status);
              if (generation.status === 'failed') {
                anyRunFailed = true;
              }
            }
          });
          if (anyRunFailed) {
            // Settling a failure returns its credits. The account shell and the
            // creators' balance gate re-read the balance on this event, which
            // only a creator that watched the run sent, so a refund that landed
            // off-screen left "Insufficient credits" in place until a reload.
            window.dispatchEvent(new Event('credits_updated'));
          }
        }

        knownStatusesRef.current = withRunsSettledOnPage(nextStatuses);
        writeStatusCache(knownStatusesRef.current);
        // Let passive listeners (home workspace card) consume this poll
        // instead of running their own — this component stays the only
        // status poller in the app.
        announceGenerationStatusSynced(generations);
        hasCompletedInitialSync = true;
        activeGenerationIds = new Set(
          generations
            // `pending` too: the workspace card counts it as in progress, and a
            // run still queued when a poll lands used to stay "in progress"
            // until a reload.
            .filter((generation) => isActiveGenerationStatus(generation.status))
            .map((generation) => generation.id),
        );
        shouldFetchFullList = pollingRequestVersion !== requestVersionAtStart;
        pollingRequested = pollingRequestVersion !== requestVersionAtStart
          || activeGenerationIds.size > 0;

        if (pollingRequested && isActive) {
          pollTimeoutId = window.setTimeout(() => {
            void syncGenerations();
          }, POLL_INTERVAL_MS);
        }
      } catch (error) {
        console.error('Failed to sync generation notifications:', error);
        if (isActive && (!hasCompletedInitialSync || pollingRequested)) {
          pollTimeoutId = window.setTimeout(() => {
            void syncGenerations();
          }, POLL_INTERVAL_MS * 2);
        }
      } finally {
        syncInFlight = false;
      }
    };

    const requestPolling = () => {
      pollingRequestVersion += 1;
      pollingRequested = true;
      shouldFetchFullList = true;
      clearScheduledPoll();
      void syncGenerations();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && pollingRequested) {
        clearScheduledPoll();
        void syncGenerations();
      }
    };

    void syncGenerations();
    const unsubscribeGenerationStarted = subscribeToGenerationStarted(requestPolling);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isActive = false;
      clearScheduledPoll();
      unsubscribeGenerationStarted();
      unsubscribeOnPage();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      Object.values(timeoutMapRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
    };
  }, [session?.access_token]);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div data-testid="generation-notifications" className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-end gap-3 sm:inset-x-auto sm:right-6 sm:w-full sm:max-w-sm">
      <AnimatePresence initial={false}>
        {notifications.map((notification) => {
          const isSuccess = notification.status === 'succeeded';

          return (
            <motion.div
              key={notification.id}
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto w-full overflow-hidden rounded-[24px] border border-white/10 bg-zinc-950/92 p-4 shadow-[0_22px_80px_-28px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
                    isSuccess
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                      : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
                  }`}
                >
                  {isSuccess ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : (
                    <AlertCircle className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">{notification.title}</div>
                      <p className="mt-1 text-sm leading-6 text-zinc-400">{notification.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const timeoutId = timeoutMapRef.current[notification.id];
                        if (timeoutId) {
                          window.clearTimeout(timeoutId);
                          delete timeoutMapRef.current[notification.id];
                        }
                        setNotifications((current) =>
                          current.filter((item) => item.id !== notification.id)
                        );
                      }}
                      className="rounded-full border border-white/10 bg-white/[0.03] p-1.5 text-zinc-400 transition hover:bg-white/[0.06] hover:text-white"
                      aria-label="Dismiss notification"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                      <Clock3 className="h-3.5 w-3.5" />
                      {notification.kind}
                    </div>
                    {/* Studio opens and points at this run, as the alert's own link does. */}
                    <Link
                      href={`/creations?generation=${encodeURIComponent(notification.generationId)}`}
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-100 transition hover:bg-white/[0.08]"
                    >
                      View Studio
                    </Link>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

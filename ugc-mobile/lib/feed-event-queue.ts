import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MagicbookletApiClient } from './api-client';
import { getFeedInstallationId } from './feed-installation-id';
import type { ShowcaseFeedEventRequest, ShowcaseFeedEventType } from './types';

export const FEED_EVENT_QUEUE_STORAGE_KEY = 'magicbooklet.feedEvents.queue.v1';
export const FEED_EVENT_QUEUE_FLUSH_SIZE = 10;
export const FEED_EVENT_QUEUE_FLUSH_DELAY_MS = 2_000;
export const FEED_EVENT_QUEUE_CHUNK_SIZE = 25;
export const FEED_EVENT_QUEUE_MAX_ENTRIES = 200;
export const FEED_EVENT_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const FEED_EVENT_QUEUE_TRANSITION_DRAIN_MS = 2 * 60 * 1_000;
const FEED_EVENT_QUEUE_TRANSITION_PENDING_MS = 15 * 60 * 1_000;

const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 2 * 60 * 1_000;
const QUEUE_VERSION = 1;

export const BATCHED_SHOWCASE_FEED_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
]);

export function isBatchedShowcaseFeedEventType(eventType: ShowcaseFeedEventType) {
  return BATCHED_SHOWCASE_FEED_EVENT_TYPES.has(eventType);
}

export type FeedEventQueueStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

type FeedEventQueueTimer = ReturnType<typeof setTimeout> | number;

type QueuedFeedEvent = {
  identityKey: string;
  event: ShowcaseFeedEventRequest & { occurredAt: string };
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
};

type PersistedFeedEventQueue = {
  version: 1;
  entries: QueuedFeedEvent[];
  retiringIdentities?: Array<{
    identityKey: string;
    discardAt: number;
    committed?: boolean;
  }>;
};

type TransitionCredential = {
  accessToken: string;
  discardAt: number;
  tokenExpiresAt: number;
  transitionId: number;
};

type RetiringIdentity = {
  discardAt: number;
  transitionId: number | null;
  committed: boolean;
};

export type FeedEventIdentityTransition = {
  /** Resolves after the immediate best-effort attempt, without gating auth UI. */
  drain: Promise<void>;
  /** Keep retiring this bucket after the auth provider confirms the switch. */
  commit: () => void;
  /** Return the bucket to normal ownership when the auth attempt fails. */
  cancel: () => void;
};

export type FeedEventQueueDependencies = {
  storage: FeedEventQueueStorage;
  sendBatch: (
    events: ShowcaseFeedEventRequest[],
    options: { accessToken: string | null },
  ) => Promise<unknown>;
  getAccessToken: () => Promise<string | null>;
  getCurrentIdentityKey: () => Promise<string | null>;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => FeedEventQueueTimer;
  clearTimer?: (timer: FeedEventQueueTimer) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isQueuedFeedEvent(value: unknown): value is QueuedFeedEvent {
  if (!isRecord(value) || !isRecord(value.event)) return false;
  return typeof value.identityKey === 'string'
    && value.identityKey.length > 0
    && typeof value.enqueuedAt === 'number'
    && Number.isFinite(value.enqueuedAt)
    && typeof value.attempts === 'number'
    && Number.isInteger(value.attempts)
    && value.attempts >= 0
    && typeof value.nextAttemptAt === 'number'
    && Number.isFinite(value.nextAttemptAt)
    && typeof value.event.clientEventId === 'string'
    && typeof value.event.postId === 'string'
    && typeof value.event.eventType === 'string'
    && isBatchedShowcaseFeedEventType(value.event.eventType as ShowcaseFeedEventType)
    && typeof value.event.sourceSurface === 'string'
    && typeof value.event.occurredAt === 'string';
}

function getErrorStatus(error: unknown) {
  if (!isRecord(error)) return null;
  return typeof error.status === 'number' && Number.isInteger(error.status)
    ? error.status
    : null;
}

function shouldRetry(error: unknown) {
  const status = getErrorStatus(error);
  // The API client uses status 0 for fetch failures and request timeouts. Those
  // are the most important failures for this persisted queue to survive.
  return status === null || status === 0 || status === 408 || status === 429 || status >= 500;
}

export function createFeedEventQueue(dependencies: FeedEventQueueDependencies) {
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  let entries: QueuedFeedEvent[] = [];
  let restorePromise: Promise<void> | null = null;
  let flushPromise: Promise<void> | null = null;
  let timer: FeedEventQueueTimer | null = null;
  let transitionSequence = 0;
  const transitionCredentials = new Map<string, TransitionCredential>();
  const retiringIdentities = new Map<string, RetiringIdentity>();

  function trimAndDropStale(current: QueuedFeedEvent[], currentTime = now()) {
    return current
      .filter((entry) => currentTime - entry.enqueuedAt <= FEED_EVENT_QUEUE_MAX_AGE_MS)
      .slice(-FEED_EVENT_QUEUE_MAX_ENTRIES);
  }

  async function persist() {
    const body: PersistedFeedEventQueue = {
      version: QUEUE_VERSION,
      entries,
      // The outgoing bearer token intentionally never reaches storage. This
      // marker only makes the failure policy crash-safe: once its bounded
      // drain window closes, telemetry for an identity this installation can
      // no longer authenticate is removed instead of remaining stranded.
      retiringIdentities: [...retiringIdentities].map(([identityKey, value]) => ({
        identityKey,
        discardAt: value.discardAt,
        committed: value.committed,
      })),
    };
    await dependencies.storage
      .setItem(FEED_EVENT_QUEUE_STORAGE_KEY, JSON.stringify(body))
      .catch(() => undefined);
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function hasUsableTransitionCredential(identityKey: string, currentTime = now()) {
    const credential = transitionCredentials.get(identityKey);
    return Boolean(credential && credential.discardAt > currentTime);
  }

  function isSendableForIdentity(
    entry: QueuedFeedEvent,
    identityKey: string | null,
    currentTime = now(),
  ) {
    return entry.identityKey.startsWith('installation:')
      || entry.identityKey === identityKey
      || hasUsableTransitionCredential(entry.identityKey, currentTime);
  }

  function scheduleTimer(identityKey: string | null) {
    cancelTimer();
    const currentTime = now();
    const sendableEntries = entries.filter((entry) => (
      isSendableForIdentity(entry, identityKey, currentTime)
    ));
    const retirementDeadlines = [...retiringIdentities.values()]
      .map(({ discardAt }) => discardAt);
    if (sendableEntries.length === 0 && retirementDeadlines.length === 0) return;
    const nextReadyAt = sendableEntries.length > 0
      ? Math.min(...sendableEntries.map((entry) => entry.nextAttemptAt))
      : Number.POSITIVE_INFINITY;
    const nextRetirementAt = retirementDeadlines.length > 0
      ? Math.min(...retirementDeadlines)
      : Number.POSITIVE_INFINITY;
    // New events wait for the normal two-second batching window. Retried events
    // wait until their actual backoff expires instead of firing early and
    // leaving the queue without another timer.
    const delayMs = Math.max(
      FEED_EVENT_QUEUE_FLUSH_DELAY_MS,
      Math.min(nextReadyAt, nextRetirementAt) - currentTime,
    );
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  function restore() {
    if (!restorePromise) {
      restorePromise = (async () => {
        try {
          const raw = await dependencies.storage.getItem(FEED_EVENT_QUEUE_STORAGE_KEY);
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          entries = isRecord(parsed)
            && parsed.version === QUEUE_VERSION
            && Array.isArray(parsed.entries)
            ? trimAndDropStale(parsed.entries.filter(isQueuedFeedEvent))
            : [];
          if (isRecord(parsed)
            && parsed.version === QUEUE_VERSION
            && Array.isArray(parsed.retiringIdentities)) {
            for (const value of parsed.retiringIdentities) {
              if (!isRecord(value)
                || typeof value.identityKey !== 'string'
                || !value.identityKey.startsWith('user:')
                || typeof value.discardAt !== 'number'
                || !Number.isFinite(value.discardAt)) continue;
              const runtimeValue = retiringIdentities.get(value.identityKey);
              if (!runtimeValue) {
                retiringIdentities.set(value.identityKey, {
                  discardAt: value.discardAt,
                  transitionId: null,
                  committed: value.committed === true,
                });
              } else if (runtimeValue.transitionId === null) {
                retiringIdentities.set(value.identityKey, {
                  ...runtimeValue,
                  discardAt: Math.max(runtimeValue.discardAt, value.discardAt),
                  committed: runtimeValue.committed || value.committed === true,
                });
              }
            }
          }
        } catch {
          entries = [];
        }
        await persist();
        const identityKey = await dependencies.getCurrentIdentityKey().catch(() => null);
        scheduleTimer(identityKey);
      })();
    }
    return restorePromise;
  }

  async function enqueue(event: ShowcaseFeedEventRequest) {
    await restore();
    if (!isBatchedShowcaseFeedEventType(event.eventType)) return false;
    const identityKey = await dependencies.getCurrentIdentityKey().catch(() => null);
    if (!identityKey) return false;
    const enqueuedAt = now();
    entries = trimAndDropStale([...entries, {
      identityKey,
      event: { ...event, occurredAt: new Date(enqueuedAt).toISOString() },
      enqueuedAt,
      attempts: 0,
      nextAttemptAt: enqueuedAt,
    }], enqueuedAt);
    await persist();
    if (entries.filter((entry) => entry.identityKey === identityKey).length >= FEED_EVENT_QUEUE_FLUSH_SIZE) {
      void flush();
    } else {
      scheduleTimer(identityKey);
    }
    return true;
  }

  function retryDelay(attempts: number) {
    const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (3 ** Math.max(0, attempts - 1)));
    return Math.round(exponential * (0.5 + random()));
  }

  function retryChunk(chunkIds: Set<string>, retryAt = now()) {
    entries = trimAndDropStale(entries.map((entry) => {
      if (!chunkIds.has(entry.event.clientEventId)) return entry;
      const attempts = entry.attempts + 1;
      return {
        ...entry,
        attempts,
        nextAttemptAt: retryAt + retryDelay(attempts),
      };
    }), retryAt);
  }

  function settleIdentityRetirements(currentIdentityKey: string | null, currentTime: number) {
    for (const [identityKey, retirement] of retiringIdentities) {
      if (retirement.discardAt > currentTime) continue;
      retiringIdentities.delete(identityKey);
      transitionCredentials.delete(identityKey);
      // A failed/cancelled auth attempt may leave the same identity current at
      // the deadline. Its events are still attributable and remain eligible
      // for the ordinary queue; only inaccessible outgoing buckets are retired.
      if (identityKey !== currentIdentityKey) {
        entries = entries.filter((entry) => entry.identityKey !== identityKey);
      }
    }
  }

  function finishRetirementWhenDrained(identityKey: string) {
    const retirement = retiringIdentities.get(identityKey);
    // Keep the outgoing credential alive until auth confirms the identity
    // changed. A late dwell/open event can arrive while OAuth or sign-out is
    // still running even if the first background drain already emptied it.
    if (!retirement?.committed) return;
    if (entries.some((entry) => entry.identityKey === identityKey)) return;
    retiringIdentities.delete(identityKey);
    transitionCredentials.delete(identityKey);
  }

  async function runFlush() {
    await restore();
    cancelTimer();
    const currentTime = now();
    entries = trimAndDropStale(entries, currentTime);
    const currentIdentityKey = await dependencies.getCurrentIdentityKey().catch(() => null);
    settleIdentityRetirements(currentIdentityKey, currentTime);
    if (!currentIdentityKey && !entries.some((entry) => entry.identityKey.startsWith('installation:'))) {
      await persist();
      return;
    }

    const ready = entries.filter((entry) => (
      isSendableForIdentity(entry, currentIdentityKey, currentTime)
        && entry.nextAttemptAt <= currentTime
    ));
    if (ready.length === 0) {
      await persist();
      scheduleTimer(currentIdentityKey);
      return;
    }

    const readyByIdentity = new Map<string, QueuedFeedEvent[]>();
    for (const entry of ready) {
      const bucket = readyByIdentity.get(entry.identityKey);
      if (bucket) bucket.push(entry);
      else readyByIdentity.set(entry.identityKey, [entry]);
    }

    for (const [identityKey, identityEntries] of readyByIdentity) {
      for (let index = 0; index < identityEntries.length; index += FEED_EVENT_QUEUE_CHUNK_SIZE) {
        const chunk = identityEntries.slice(index, index + FEED_EVENT_QUEUE_CHUNK_SIZE);
        const chunkIds = new Set(chunk.map((entry) => entry.event.clientEventId));
        let accessToken: string | null = null;

        if (identityKey.startsWith('user:')) {
          const transitionCredential = transitionCredentials.get(identityKey);
          if (transitionCredential && transitionCredential.discardAt > now()) {
            accessToken = transitionCredential.accessToken;
          } else {
            const identityBeforeToken = await dependencies.getCurrentIdentityKey().catch(() => null);
            if (identityBeforeToken !== identityKey) break;
            try {
              accessToken = await dependencies.getAccessToken();
            } catch {
              retryChunk(chunkIds);
              await persist();
              break;
            }
            const identityAfterToken = await dependencies.getCurrentIdentityKey().catch(() => null);
            if (identityAfterToken !== identityKey) break;
            if (!accessToken) {
              retryChunk(chunkIds);
              await persist();
              break;
            }
          }
        }

        try {
          await dependencies.sendBatch(
            chunk.map((entry) => entry.event),
            { accessToken },
          );
          // Acknowledgement is the commit point. Until this resolves, the
          // chunk remains in AsyncStorage so suspension or termination can
          // only cause an idempotent replay, never silent loss.
          entries = entries.filter((entry) => !chunkIds.has(entry.event.clientEventId));
          finishRetirementWhenDrained(identityKey);
          await persist();
        } catch (error) {
          if (shouldRetry(error)) {
            retryChunk(chunkIds);
            await persist();
            break;
          }
          // Other 4xx responses are terminal for the whole chunk. Remove only
          // after the server has definitively rejected it.
          entries = entries.filter((entry) => !chunkIds.has(entry.event.clientEventId));
          finishRetirementWhenDrained(identityKey);
          await persist();
        }
      }
    }

    await persist();
    scheduleTimer(await dependencies.getCurrentIdentityKey().catch(() => null));
  }

  function flush() {
    if (!flushPromise) {
      flushPromise = runFlush().finally(() => {
        flushPromise = null;
      });
    }
    return flushPromise;
  }

  function beginIdentityTransition({
    identityKey,
    accessToken,
    accessTokenExpiresAt,
  }: {
    identityKey: string;
    accessToken: string;
    accessTokenExpiresAt?: number | null;
  }): FeedEventIdentityTransition {
    const transitionId = ++transitionSequence;
    const currentTime = now();
    const tokenExpiresAt = typeof accessTokenExpiresAt === 'number'
      && Number.isFinite(accessTokenExpiresAt)
      ? Math.max(currentTime + 5_000, accessTokenExpiresAt)
      : currentTime + FEED_EVENT_QUEUE_TRANSITION_PENDING_MS;
    // OAuth can legitimately keep the old identity current while the system
    // prompt is open. Keep its token only in memory for a bounded pending
    // window, then shorten that window once auth confirms the identity switch.
    const discardAt = Math.min(
      currentTime + FEED_EVENT_QUEUE_TRANSITION_PENDING_MS,
      tokenExpiresAt,
    );
    const credential: TransitionCredential = {
      accessToken,
      discardAt,
      tokenExpiresAt,
      transitionId,
    };
    transitionCredentials.set(identityKey, credential);
    retiringIdentities.set(identityKey, { discardAt, transitionId, committed: false });

    const drain = (async () => {
      await restore();
      if (transitionCredentials.get(identityKey)?.transitionId !== transitionId) return;
      // Auth transitions override an existing retry delay once. This is the
      // last opportunity to use the outgoing token; subsequent failures still
      // follow normal persisted exponential backoff within the drain window.
      const forceAt = now();
      entries = entries.map((entry) => entry.identityKey === identityKey
        ? { ...entry, nextAttemptAt: forceAt }
        : entry);
      await persist();
      await flush();
      // If another flush had already snapshotted its ready set, it may finish
      // without seeing the just-forced bucket. Run once more only when no send
      // attempt moved these entries back into retry delay.
      if (transitionCredentials.get(identityKey)?.transitionId === transitionId
        && entries.some((entry) => (
          entry.identityKey === identityKey && entry.nextAttemptAt <= now()
        ))) {
        await flush();
      }
    })().catch(() => undefined);

    const updateIfCurrent = (action: 'commit' | 'cancel') => {
      const currentCredential = transitionCredentials.get(identityKey);
      if (currentCredential?.transitionId !== transitionId) return;
      if (action === 'cancel') {
        transitionCredentials.delete(identityKey);
        const retirement = retiringIdentities.get(identityKey);
        if (retirement?.transitionId === transitionId) retiringIdentities.delete(identityKey);
      } else {
        const retirement = retiringIdentities.get(identityKey);
        if (retirement?.transitionId === transitionId) {
          const committedDiscardAt = Math.min(
            now() + FEED_EVENT_QUEUE_TRANSITION_DRAIN_MS,
            currentCredential.tokenExpiresAt,
          );
          transitionCredentials.set(identityKey, {
            ...currentCredential,
            discardAt: committedDiscardAt,
          });
          retiringIdentities.set(identityKey, {
            ...retirement,
            committed: true,
            discardAt: committedDiscardAt,
          });
          finishRetirementWhenDrained(identityKey);
        }
      }
      // `commit` intentionally keeps the in-memory credential and the
      // non-secret persisted deadline. Neither path waits on storage or I/O.
      void restore().then(persist).catch(() => undefined);
      if (action === 'commit') void flush();
    };

    return {
      drain,
      commit: () => updateIfCurrent('commit'),
      cancel: () => updateIfCurrent('cancel'),
    };
  }

  return {
    enqueue,
    flush,
    restore,
    beginIdentityTransition,
    getEntriesForTests: () => entries.map((entry) => ({ ...entry, event: { ...entry.event } })),
  };
}

type FeedEventQueueRuntime = {
  api: MagicbookletApiClient;
  getAccessToken: () => Promise<string | null>;
  getIdentityUserId: () => string | null;
};

let runtime: FeedEventQueueRuntime | null = null;

const feedEventQueue = createFeedEventQueue({
  storage: AsyncStorage,
  sendBatch: (events, options) => {
    if (!runtime) return Promise.reject(new Error('Feed event queue is not configured.'));
    return runtime.api.recordShowcaseFeedEvents(events, options);
  },
  getAccessToken: () => runtime?.getAccessToken() ?? Promise.resolve(null),
  getCurrentIdentityKey: async () => {
    const userId = runtime?.getIdentityUserId();
    if (userId) return `user:${userId}`;
    const installationId = await getFeedInstallationId();
    return installationId ? `installation:${installationId}` : null;
  },
});

export function configureFeedEventQueue(nextRuntime: FeedEventQueueRuntime) {
  runtime = nextRuntime;
}

export function enqueueShowcaseFeedEvent(event: ShowcaseFeedEventRequest) {
  return feedEventQueue.enqueue(event);
}

export function flushShowcaseFeedEvents() {
  return feedEventQueue.flush();
}

export function beginShowcaseFeedEventIdentityTransition(options: {
  identityKey: string;
  accessToken: string;
  accessTokenExpiresAt?: number | null;
}) {
  return feedEventQueue.beginIdentityTransition(options);
}

export function restoreShowcaseFeedEvents() {
  return feedEventQueue.restore();
}

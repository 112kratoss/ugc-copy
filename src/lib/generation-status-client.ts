import { useEffect } from 'react';

import type { GenerationTiming } from '@/lib/generation-timing';

const GENERATION_STATUSES = new Set([
  'processing',
  'waiting',
  'succeeded',
  'failed',
]);

export type GenerationStatusResponse = {
  status: 'processing' | 'waiting' | 'succeeded' | 'failed';
  output?: string | null;
  outputs?: string[] | null;
  error?: string | null;
  timing?: GenerationTiming | null;
  retryAfterMs?: number | null;
};

type FetchGenerationStatusOptions = {
  url: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

type FetchGenerationStatusWithRetryOptions = {
  url: string;
  /** Read again before every attempt: a run can outlive the token it started with. */
  getAccessToken: () => Promise<string | null | undefined> | string | null | undefined;
  signal?: AbortSignal;
  maxAttempts?: number;
  /** The wait before the second, third, … attempt; the last value repeats. */
  delaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
};

/** A status read the server answered with an error status. */
export class GenerationStatusRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GenerationStatusRequestError';
  }
}

type PollWaitOptions = {
  signal?: AbortSignal;
  random?: () => number;
  documentRef?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
};

export const DEFAULT_GENERATION_STATUS_RETRY_AFTER_MS = 15_000;
const MIN_GENERATION_STATUS_RETRY_AFTER_MS = 1_000;
const MAX_GENERATION_STATUS_RETRY_AFTER_MS = 30_000;
const MAX_GENERATION_STATUS_JITTER_MS = 1_000;
const GENERATION_STARTED_EVENT = 'magicbooklet:generation-started';
const GENERATION_STARTED_CHANNEL = 'magicbooklet-generation-status';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : null;
}

export async function fetchGenerationStatus<
  T extends GenerationStatusResponse = GenerationStatusResponse,
>({
  url,
  accessToken,
  signal,
  fetchImpl = fetch,
}: FetchGenerationStatusOptions): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    ...(signal ? { signal } : {}),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw new Error('Invalid generation status response.');
    }
  }

  if (!response.ok) {
    throw new GenerationStatusRequestError(
      getErrorMessage(payload) ?? `Generation status request failed (${response.status}).`,
      response.status,
    );
  }

  if (
    !isRecord(payload)
    || typeof payload.status !== 'string'
    || !GENERATION_STATUSES.has(payload.status)
  ) {
    throw new Error('Invalid generation status response.');
  }

  return payload as T;
}

/**
 * Worth another try: no answer (a network failure), a server fault, or a token
 * that expired during the run. Anything else, such as an unknown run, would
 * answer the same again.
 */
function isRetryableGenerationStatusFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  return error instanceof GenerationStatusRequestError
    && (error.status === 401 || error.status >= 500);
}

/**
 * One status read that rides out a blip. The first failed read used to end
 * the run view while the run went on with the credits it had taken, and a
 * second press then paid for a second run. The token is read again for every
 * attempt; after the last one the last error is thrown.
 */
export async function fetchGenerationStatusWithRetry<
  T extends GenerationStatusResponse = GenerationStatusResponse,
>({
  url,
  getAccessToken,
  signal,
  maxAttempts = 4,
  delaysMs = [2000, 5000, 10000],
  fetchImpl,
}: FetchGenerationStatusWithRetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await waitForAbortableDelay(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0, signal);
    }
    throwIfAborted(signal);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        // A refresh that has not landed yet reads as signed out for a moment.
        throw new GenerationStatusRequestError('Please log in to check generation status.', 401);
      }
      return await fetchGenerationStatus<T>({
        url,
        accessToken,
        signal,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (error) {
      if (signal?.aborted || isGenerationStatusAbortError(error) || !isRetryableGenerationStatusFailure(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

export function getGenerationStatusRetryDelayMs(
  retryAfterMs: unknown,
  random: () => number = Math.random,
) {
  const requestedDelay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : DEFAULT_GENERATION_STATUS_RETRY_AFTER_MS;
  const clampedDelay = Math.min(
    MAX_GENERATION_STATUS_RETRY_AFTER_MS,
    Math.max(MIN_GENERATION_STATUS_RETRY_AFTER_MS, Math.round(requestedDelay)),
  );
  const jitterWindow = Math.min(MAX_GENERATION_STATUS_JITTER_MS, Math.round(clampedDelay * 0.1));
  const jitter = Math.max(0, Math.min(1, random())) * jitterWindow;

  return clampedDelay + Math.round(jitter);
}

export async function waitForNextGenerationStatusPoll(
  retryAfterMs: unknown,
  {
    signal,
    random = Math.random,
    documentRef = typeof document === 'undefined' ? null : document,
  }: PollWaitOptions = {},
) {
  await waitForAbortableDelay(getGenerationStatusRetryDelayMs(retryAfterMs, random), signal);
  await waitForVisibleDocument(documentRef, signal);
}

export function isGenerationStatusAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export function announceGenerationStarted() {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new Event(GENERATION_STARTED_EVENT));
  if (typeof BroadcastChannel === 'undefined') return;

  const channel = new BroadcastChannel(GENERATION_STARTED_CHANNEL);
  channel.postMessage({ type: 'generation-started' });
  channel.close();
}

export function subscribeToGenerationStarted(callback: () => void) {
  if (typeof window === 'undefined') return () => undefined;

  window.addEventListener(GENERATION_STARTED_EVENT, callback);
  const channel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(GENERATION_STARTED_CHANNEL);
  const handleChannelMessage = (event: MessageEvent<unknown>) => {
    if (isRecord(event.data) && event.data.type === 'generation-started') {
      callback();
    }
  };
  channel?.addEventListener('message', handleChannelMessage);

  return () => {
    window.removeEventListener(GENERATION_STARTED_EVENT, callback);
    channel?.removeEventListener('message', handleChannelMessage);
    channel?.close();
  };
}

const GENERATION_STATUS_SYNC_EVENT = 'magicbooklet:generation-status-sync';

export type GenerationStatusSyncRecord = {
  id: string;
  status: string;
  created_at?: string | null;
  completed_at?: string | null;
  category?: string | null;
  model?: string | null;
};

function isGenerationStatusSyncRecord(value: unknown): value is GenerationStatusSyncRecord {
  return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string';
}

/**
 * Same-tab broadcast of the freshest owner generation statuses, fired by the
 * app-wide poller (`GenerationNotifications`) after every successful sync so
 * passive surfaces (the home workspace card) can update without polling
 * `/api/generations` themselves. Cross-tab delivery is unnecessary: the
 * poller runs in every tab.
 */
export function announceGenerationStatusSynced(records: GenerationStatusSyncRecord[]) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent(GENERATION_STATUS_SYNC_EVENT, { detail: records }));
}

export function subscribeToGenerationStatusSynced(
  callback: (records: GenerationStatusSyncRecord[]) => void,
) {
  if (typeof window === 'undefined') return () => undefined;

  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!Array.isArray(detail)) return;

    const records = detail.filter(isGenerationStatusSyncRecord);
    if (records.length > 0) {
      callback(records);
    }
  };

  window.addEventListener(GENERATION_STATUS_SYNC_EVENT, handleEvent);
  return () => {
    window.removeEventListener(GENERATION_STATUS_SYNC_EVENT, handleEvent);
  };
}

const GENERATION_SETTLED_ON_PAGE_EVENT = 'magicbooklet:generation-settled-on-page';

export type GenerationSettledOnPage = { id: string; status: 'succeeded' | 'failed' };

/**
 * Same-tab word from a page that showed a run end (a creator's canvas: Done, or It didn't
 * finish). The app-wide poller (`GenerationNotifications`) then has nothing to announce for that
 * run: its toast would only say again what the page says, over the creator's Publish. A run the
 * page lost sight of (left, or still processing in the background) is never said here, so its
 * toast still comes. Cross-tab delivery is unnecessary: each tab shows its own pages.
 */
export function announceGenerationSettledOnPage(settled: GenerationSettledOnPage) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent(GENERATION_SETTLED_ON_PAGE_EVENT, { detail: settled }));
}

export function subscribeToGenerationSettledOnPage(callback: (settled: GenerationSettledOnPage) => void) {
  if (typeof window === 'undefined') return () => undefined;

  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isRecord(detail) && typeof detail.id === 'string' && (detail.status === 'succeeded' || detail.status === 'failed')) {
      callback({ id: detail.id, status: detail.status });
    }
  };

  window.addEventListener(GENERATION_SETTLED_ON_PAGE_EVENT, handleEvent);
  return () => {
    window.removeEventListener(GENERATION_SETTLED_ON_PAGE_EVENT, handleEvent);
  };
}

/** A creator's half of the above: says how the run it shows ended, once its canvas shows it. */
export function useAnnounceRunSettledOnPage(generationId: string | null, status: GenerationSettledOnPage['status'] | null) {
  useEffect(() => {
    if (generationId && status) announceGenerationSettledOnPage({ id: generationId, status });
  }, [generationId, status]);
}

function createAbortError() {
  const error = new Error('Generation status check cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function waitForAbortableDelay(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function waitForVisibleDocument(
  documentRef: PollWaitOptions['documentRef'],
  signal?: AbortSignal,
) {
  if (!documentRef || documentRef.visibilityState !== 'hidden') {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);

    const cleanup = () => {
      documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
      signal?.removeEventListener('abort', handleAbort);
    };
    const handleVisibilityChange = () => {
      if (documentRef.visibilityState === 'hidden') return;
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    documentRef.addEventListener('visibilitychange', handleVisibilityChange);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

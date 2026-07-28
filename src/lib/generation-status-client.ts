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
    throw new Error(
      getErrorMessage(payload) ?? `Generation status request failed (${response.status}).`
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

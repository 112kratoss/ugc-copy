import type { GenerationStatusResponse } from './types';

export type GenerationKind = 'image' | 'video' | 'motion';

export function isGenerationFinished(status: string) {
  return status === 'succeeded' || status === 'failed';
}

export function getGenerationOutput(status: GenerationStatusResponse) {
  return status.outputs?.[0] ?? status.output ?? null;
}

export async function pollGenerationStatus(
  getStatus: () => Promise<GenerationStatusResponse>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onTick?: (status: GenerationStatusResponse) => void;
    signal?: AbortSignal;
    random?: () => number;
    waitUntilReady?: (signal?: AbortSignal) => Promise<void>;
  } = {}
) {
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 12;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(options.signal);
    await options.waitUntilReady?.(options.signal);
    const status = await getStatus();
    throwIfAborted(options.signal);
    options.onTick?.(status);
    if (isGenerationFinished(status.status)) {
      return status;
    }
    await waitForNextPoll(
      getPollDelayMs(status.retryAfterMs, intervalMs, options.random ?? Math.random),
      options.signal,
    );
  }

  throw new Error('Generation is still processing. Check Studio in a few minutes.');
}

export function getPollDelayMs(
  retryAfterMs: unknown,
  fallbackMs = 15_000,
  random: () => number = Math.random,
) {
  const requested = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : fallbackMs;
  const base = Math.min(30_000, Math.max(1_000, Math.round(requested)));
  const jitterWindow = Math.min(1_000, Math.round(base * 0.1));
  return base + Math.round(Math.max(0, Math.min(1, random())) * jitterWindow);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error('Generation status check cancelled.');
  error.name = 'AbortError';
  throw error;
}

function waitForNextPoll(intervalMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, intervalMs);
    const handleAbort = () => {
      clearTimeout(timer);
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

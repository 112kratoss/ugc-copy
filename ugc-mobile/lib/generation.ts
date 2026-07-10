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
  } = {}
) {
  const intervalMs = options.intervalMs ?? 4000;
  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 12;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(options.signal);
    const status = await getStatus();
    throwIfAborted(options.signal);
    options.onTick?.(status);
    if (isGenerationFinished(status.status)) {
      return status;
    }
    await waitForNextPoll(intervalMs, options.signal);
  }

  throw new Error('Generation is still processing. Check Studio in a few minutes.');
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

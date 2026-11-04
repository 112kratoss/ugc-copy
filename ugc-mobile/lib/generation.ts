import type { GenerationStatusResponse } from './types';

export type GenerationKind = 'image' | 'video' | 'motion';

export function isGenerationFinished(status: string) {
  // `completed` is the legacy spelling still allowed by the database; the web
  // maps it to succeeded, and the app used to count it as in flight for ever.
  return status === 'succeeded' || status === 'failed' || status === 'completed';
}

/**
 * Stated positively rather than as `!isGenerationFinished`, because "not
 * finished" also covers a run the user cancelled, and a cancelled run is not
 * something the app should still be reporting as in flight.
 */
export function isGenerationInFlight(status: string | null | undefined) {
  if (!status) return false;
  const value = status.toLowerCase();
  return !isGenerationFinished(value) && value !== 'cancelled' && value !== 'canceled';
}

/** The primary output: the one Post to feed publishes. */
export function getGenerationOutput(status: GenerationStatusResponse) {
  return status.outputs?.[0] ?? status.output ?? null;
}

/**
 * Every output a finished run returned, the primary first, so a run that made several
 * (Grok Imagine's options) shows them all; `[output]` when the status carries no list.
 */
export function getGenerationOutputs(status: GenerationStatusResponse): string[] {
  const outputs = (status.outputs ?? []).filter((output): output is string => typeof output === 'string' && output.length > 0);
  if (outputs.length > 0) return outputs;
  return status.output ? [status.output] : [];
}

/**
 * The waits between two status reads of a run a creator watches: 8 s after the
 * first read, half as long again after each one, and 30 s at most. Runs take
 * one to four minutes (`src/lib/generation-timing.ts`), and each read of one
 * still running costs the server two lookups, three lock writes and up to one
 * provider call. A fixed 15 s read a two-minute run 9 times and a four-minute
 * one 17; this reads them 7 and 11 times. A finished run is met sooner than the
 * wait says when its push arrives (`wake`), and a wait the server asks for is
 * never cut short.
 */
export const GENERATION_POLL_FIRST_DELAY_MS = 8_000;
export const GENERATION_POLL_MAX_DELAY_MS = 30_000;
const GENERATION_POLL_GROWTH = 1.5;

/** The wait after the status read numbered `readIndex` (0 for the first). */
export function getGenerationPollBackoffMs(readIndex: number) {
  return Math.min(
    GENERATION_POLL_MAX_DELAY_MS,
    Math.round(GENERATION_POLL_FIRST_DELAY_MS * GENERATION_POLL_GROWTH ** Math.max(0, readIndex)),
  );
}

export async function pollGenerationStatus(
  getStatus: () => Promise<GenerationStatusResponse>,
  options: {
    /** A fixed wait between reads instead of the backoff, which a server hint then replaces. */
    intervalMs?: number;
    timeoutMs?: number;
    onTick?: (status: GenerationStatusResponse) => void;
    signal?: AbortSignal;
    random?: () => number;
    waitUntilReady?: (signal?: AbortSignal) => Promise<void>;
    /**
     * Something that can end a wait early: a run's completion push. The read
     * it brings forward says whether this run is the one that ended.
     */
    wake?: (onWake: () => void) => () => void;
    isGuest?: boolean;
  } = {}
) {
  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 12;
  const startedAt = Date.now();
  let readIndex = 0;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(options.signal);
    await options.waitUntilReady?.(options.signal);
    const status = await getStatus();
    throwIfAborted(options.signal);
    options.onTick?.(status);
    if (isGenerationFinished(status.status)) {
      return status;
    }
    const random = options.random ?? Math.random;
    const delayMs = options.intervalMs !== undefined
      ? getPollDelayMs(status.retryAfterMs, options.intervalMs, random)
      : getPollDelayMs(
        Math.max(
          typeof status.retryAfterMs === 'number' && Number.isFinite(status.retryAfterMs) ? status.retryAfterMs : 0,
          getGenerationPollBackoffMs(readIndex),
        ),
        GENERATION_POLL_MAX_DELAY_MS,
        random,
      );
    readIndex += 1;
    await waitForNextPoll(delayMs, options.signal, options.wake);
  }

  throw new Error(generationStillProcessingMessage(options.isGuest === true));
}

/**
 * What the creator says when it stops watching a run that is still going. Only a
 * registered account gets the push and an Alerts list; a guest gets no push and
 * finds Alerts behind a sign-in, so "Check Alerts" sent them to a wall. The
 * creator reopened on this device picks the run back up, which is where a guest
 * can see how it ended.
 */
export function generationStillProcessingMessage(isGuest: boolean) {
  return isGuest
    ? 'Generation is still processing. Sign in to get an alert when it’s done. Until then, come back to this screen.'
    : 'Generation is still processing. Check Alerts in a few minutes.';
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

function waitForNextPoll(
  intervalMs: number,
  signal?: AbortSignal,
  wake?: (onWake: () => void) => () => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
      return;
    }

    let stopWaking: () => void = () => undefined;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      stopWaking();
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    const handleAbort = () => {
      clearTimeout(timer);
      stopWaking();
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (wake) stopWaking = wake(finish);
  });
}

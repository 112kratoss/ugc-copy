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
 * first read, half as long again after each one, to a cap. Runs take one to
 * four minutes (`src/lib/generation-timing.ts`), and each read of one still
 * running costs the server two lookups, three lock writes and up to one
 * provider call.
 *
 * The cap is 30 s (`GENERATION_POLL_MAX_DELAY_MS`) only where the run's
 * completion push can wake the poll (`wake`): a registered account whose phone
 * has a push registration and notifications on. A fixed 15 s read a two-minute
 * run 9 times and a four-minute one 17; this reads them 7 and 11 times, and the
 * push reads the finished run within moments. Anywhere else, a guest's run or
 * notifications off, nothing wakes the poll, so it keeps the old pace at most:
 * 15 s (`GENERATION_POLL_UNWOKEN_MAX_DELAY_MS`).
 *
 * A wait the server asks for (`retryAfterMs`, its throttle on provider checks)
 * is a floor: no wake reads before it ends.
 */
export const GENERATION_POLL_FIRST_DELAY_MS = 8_000;
export const GENERATION_POLL_MAX_DELAY_MS = 30_000;
export const GENERATION_POLL_UNWOKEN_MAX_DELAY_MS = 15_000;
const GENERATION_POLL_GROWTH = 1.5;

/** The wait after the status read numbered `readIndex` (0 for the first), up to `maxDelayMs`. */
export function getGenerationPollBackoffMs(readIndex: number, maxDelayMs = GENERATION_POLL_MAX_DELAY_MS) {
  return Math.min(
    maxDelayMs,
    Math.round(GENERATION_POLL_FIRST_DELAY_MS * GENERATION_POLL_GROWTH ** Math.max(0, readIndex)),
  );
}

/**
 * The longest wait for a run this phone watches: 30 s where its completion
 * push can wake the poll, which takes a registered account (`isGuest` false), a
 * push registration on this phone (`devicePush`, the check `lib/auth.tsx` runs)
 * and notifications on for runs (`preferences`, Alerts' read; the account's
 * default, on, until it is read). 15 s anywhere else.
 */
export function generationPollMaxDelayMs({
  isGuest,
  devicePush,
  preferences,
}: {
  isGuest: boolean;
  devicePush: { status: string } | null | undefined;
  preferences: { pushEnabled?: boolean; generationEnabled?: boolean } | null | undefined;
}) {
  const pushReachesThisPhone = !isGuest
    && devicePush?.status === 'registered'
    && preferences?.pushEnabled !== false
    && preferences?.generationEnabled !== false;
  return pushReachesThisPhone ? GENERATION_POLL_MAX_DELAY_MS : GENERATION_POLL_UNWOKEN_MAX_DELAY_MS;
}

export async function pollGenerationStatus(
  getStatus: () => Promise<GenerationStatusResponse>,
  options: {
    /** A fixed wait between reads instead of the backoff, which a server hint then replaces. */
    intervalMs?: number;
    /**
     * The longest backoff wait: `GENERATION_POLL_MAX_DELAY_MS` where a completion
     * push can wake the poll, and `GENERATION_POLL_UNWOKEN_MAX_DELAY_MS` (the
     * default) anywhere else.
     */
    maxDelayMs?: number;
    timeoutMs?: number;
    onTick?: (status: GenerationStatusResponse) => void;
    signal?: AbortSignal;
    random?: () => number;
    waitUntilReady?: (signal?: AbortSignal) => Promise<void>;
    /**
     * What can end a wait early: a run's completion push, the app coming back
     * to the front. Listened to for the whole poll, so one that comes while a
     * read is on its way brings the next read forward too. The read it brings
     * says whether this run is the one that ended. Never before a wait the
     * server asked for.
     */
    wake?: (onWake: () => void) => () => void;
    isGuest?: boolean;
  } = {}
) {
  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 12;
  const maxDelayMs = options.maxDelayMs ?? GENERATION_POLL_UNWOKEN_MAX_DELAY_MS;
  const startedAt = Date.now();
  let readIndex = 0;
  const wakes: PollWakes = { woken: false, onWake: null };
  const stopWaking = options.wake?.(() => {
    wakes.woken = true;
    wakes.onWake?.();
  }) ?? (() => undefined);

  try {
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal);
      await options.waitUntilReady?.(options.signal);
      // A wake from here on, during the read included, is for the next wait.
      wakes.woken = false;
      const status = await getStatus();
      throwIfAborted(options.signal);
      options.onTick?.(status);
      if (isGenerationFinished(status.status)) {
        return status;
      }
      const random = options.random ?? Math.random;
      const serverWaitMs = typeof status.retryAfterMs === 'number' && Number.isFinite(status.retryAfterMs)
        ? Math.min(GENERATION_POLL_MAX_DELAY_MS, Math.max(0, status.retryAfterMs))
        : 0;
      const delayMs = options.intervalMs !== undefined
        ? getPollDelayMs(status.retryAfterMs, options.intervalMs, random)
        : getPollDelayMs(
          Math.max(serverWaitMs, getGenerationPollBackoffMs(readIndex, maxDelayMs)),
          maxDelayMs,
          random,
        );
      readIndex += 1;
      await waitForNextPoll(delayMs, serverWaitMs, options.signal, options.wake ? wakes : null);
    }
  } finally {
    stopWaking();
  }

  throw new Error(generationStillProcessingMessage(options.isGuest === true));
}

/** A poll's wakes: whether one came since its last read began, and the wait listening for one. */
type PollWakes = { woken: boolean; onWake: (() => void) | null };

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
  floorMs: number,
  signal?: AbortSignal,
  wakes?: PollWakes | null,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
      return;
    }

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopListening = () => {
      if (wakes) wakes.onWake = null;
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = () => {
      if (timer) clearTimeout(timer);
      stopListening();
      resolve();
    };
    const handleAbort = () => {
      if (timer) clearTimeout(timer);
      stopListening();
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    // Woken: the read comes once the server's own wait is over, at once if it is.
    const wake = () => {
      const floorLeftMs = floorMs - (Date.now() - startedAt);
      if (floorLeftMs <= 0) {
        finish();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, floorLeftMs);
    };
    timer = setTimeout(finish, intervalMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (wakes) {
      wakes.onWake = wake;
      if (wakes.woken) wake();
    }
  });
}

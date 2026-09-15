import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A generation start whose outcome the phone does not know yet.
 *
 * The creator used to mint a fresh idempotency key for every Generate press
 * and forget it once the request settled. When the server accepted a start but
 * the response never arrived, the next press sent the same request under a new
 * key, and the server, seeing a key it had never met, started and charged a
 * second run (model/post/remix audit, finding A3).
 *
 * The attempt is now saved, under the identity making it, before the request
 * leaves the phone, and only a definitive answer clears it. Until then,
 * checking it replays the exact request under the exact key: the server answers
 * with the run it already started, or starts it once if it never saw it.
 * Starting a new run is a separate, explicit choice.
 */

export const GENERATION_ATTEMPT_STORAGE_PREFIX = 'magicbooklet.generation.pendingAttempt.v1';
/** Past this an unconfirmed attempt is dropped: it is no longer worth a second look. */
export const PENDING_GENERATION_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const GENERATION_ATTEMPT_UNCONFIRMED_MESSAGE =
  'We couldn’t confirm your generation started. Check again: that can’t start a second run.';
export const GENERATION_ATTEMPT_CHOICE_MESSAGE =
  'Your last generation may already be running. Check it first, or start a new run.';

export type GenerationAttemptTool = 'image' | 'video' | 'motion';
export type GenerationAttemptRoute = 'unified' | GenerationAttemptTool;

export type PendingGenerationAttempt = {
  version: 1;
  identityUserId: string;
  tool: GenerationAttemptTool;
  route: GenerationAttemptRoute;
  idempotencyKey: string;
  /** Exactly what was sent, so a check replays the request the server hashed. */
  requestJson: string;
  createdAt: string;
};

type AttemptStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

const TOOLS = new Set<GenerationAttemptTool>(['image', 'video', 'motion']);
const ROUTES = new Set<GenerationAttemptRoute>(['unified', 'image', 'video', 'motion']);

export function pendingGenerationAttemptStorageKey(identityUserId: string) {
  return `${GENERATION_ATTEMPT_STORAGE_PREFIX}:${encodeURIComponent(identityUserId)}`;
}

function parseAttempt(raw: string): PendingGenerationAttempt | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingGenerationAttempt>;
    if (
      value.version !== 1
      || typeof value.identityUserId !== 'string'
      || !TOOLS.has(value.tool as GenerationAttemptTool)
      || !ROUTES.has(value.route as GenerationAttemptRoute)
      || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey
      || typeof value.requestJson !== 'string'
      || typeof value.createdAt !== 'string'
    ) {
      return null;
    }
    return value as PendingGenerationAttempt;
  } catch {
    return null;
  }
}

export async function loadPendingGenerationAttempt(
  identityUserId: string,
  { storage = AsyncStorage, now = Date.now() }: { storage?: AttemptStorage; now?: number } = {},
): Promise<PendingGenerationAttempt | null> {
  const key = pendingGenerationAttemptStorageKey(identityUserId);
  const raw = await storage.getItem(key);
  if (!raw) return null;
  const attempt = parseAttempt(raw);
  const createdAt = attempt ? Date.parse(attempt.createdAt) : Number.NaN;
  if (
    !attempt
    || attempt.identityUserId !== identityUserId
    || !Number.isFinite(createdAt)
    || now - createdAt > PENDING_GENERATION_ATTEMPT_MAX_AGE_MS
  ) {
    await storage.removeItem(key).catch(() => undefined);
    return null;
  }
  return attempt;
}

export async function savePendingGenerationAttempt(
  attempt: PendingGenerationAttempt,
  { storage = AsyncStorage }: { storage?: AttemptStorage } = {},
) {
  await storage.setItem(pendingGenerationAttemptStorageKey(attempt.identityUserId), JSON.stringify(attempt));
}

export async function clearPendingGenerationAttempt(
  identityUserId: string,
  { storage = AsyncStorage }: { storage?: AttemptStorage } = {},
) {
  await storage.removeItem(pendingGenerationAttemptStorageKey(identityUserId));
}

/**
 * Whether a start that threw may still have reached the server and started a
 * run. A refusal the server made before reserving credits is definitive. A lost
 * connection (status 0), a server fault, or a start already in flight under this
 * key is not.
 */
export function isAmbiguousGenerationStartFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code, details } = error as { status?: unknown; code?: unknown; details?: { code?: unknown } | null };
  if (typeof status !== 'number') return false;
  if (status === 0 || status >= 500) return true;
  const failureCode = code ?? details?.code;
  return status === 409 && (failureCode === 'GENERATION_START_IN_PROGRESS' || failureCode === 'submission_pending');
}

/** The key a press must reuse: the unconfirmed attempt's own, when this is that exact request. */
export function reusableAttemptKey(
  pending: PendingGenerationAttempt | null,
  identityUserId: string,
  route: GenerationAttemptRoute,
  requestJson: string,
): string | null {
  return pending
    && pending.identityUserId === identityUserId
    && pending.route === route
    && pending.requestJson === requestJson
    ? pending.idempotencyKey
    : null;
}

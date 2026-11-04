import 'server-only';

import { randomUUID } from 'node:crypto';

import { unstable_cache } from 'next/cache';

import {
  PREPARED_FEED_SESSION_TTL_MS,
  type PreparedRankedFeedSession,
} from '@/lib/showcase-feed-personalization';

/**
 * Where a first page ranked ahead (`prepareRankedShowcaseFeedSession`) waits
 * for the request that shows it, keyed by a random token the app holds.
 *
 * Nothing here is feed state: a ranking that is never shown leaves no row
 * anywhere and simply expires. It is held in this instance's memory, which
 * serves a request that lands on the same instance, and in Next's data cache,
 * which Vercel shares between the function's instances in the region, for one
 * that does not. A token found in neither (an evicted entry, another region, a
 * new deployment) costs nothing but the speed-up: the request ranks a fresh
 * first page, as it would have without one.
 */

export const SHOWCASE_FEED_READ_AHEAD_TTL_MS = PREPARED_FEED_SESSION_TTL_MS;

const READ_AHEAD_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/**
 * Rankings held in this instance at once; a busy instance drops the oldest.
 * Each is a whole hydrated ranking (about 100-300 KB), and a dropped one is
 * still in the data cache.
 */
export const SHOWCASE_FEED_READ_AHEAD_LOCAL_LIMIT = 50;

type LocalEntry = { prepared: PreparedRankedFeedSession; expiresAt: number };

const localEntries = new Map<string, LocalEntry>();
/** Tokens this instance has handed out, so a repeat finds nothing here either. */
const takenTokens = new Map<string, number>();
/**
 * The value the data-cache read below stores on its miss. The cached function
 * is a slot rather than a computation: the request that prepares a ranking
 * puts it here and reads the slot, which misses and so stores it; any later
 * read of the same token answers from the cache, or, missing, stores null.
 * Nothing in it can rank or read the database, so the background refresh Next
 * runs for an entry past its revalidate time only writes null over it.
 */
const pendingSlotValues = new Map<string, PreparedRankedFeedSession>();

const readAheadSlot = unstable_cache(
  async (token: string): Promise<PreparedRankedFeedSession | null> => {
    const value = pendingSlotValues.get(token) ?? null;
    pendingSlotValues.delete(token);
    return value;
  },
  ['showcase-feed-read-ahead-v1'],
  { revalidate: Math.ceil(SHOWCASE_FEED_READ_AHEAD_TTL_MS / 1000) },
);

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

export function isShowcaseFeedReadAheadToken(value: unknown): value is string {
  return typeof value === 'string' && READ_AHEAD_TOKEN_PATTERN.test(value);
}

function pruneLocalEntries(now: number) {
  for (const [token, entry] of localEntries) {
    if (entry.expiresAt <= now) localEntries.delete(token);
  }
  for (const [token, expiresAt] of takenTokens) {
    if (expiresAt <= now) takenTokens.delete(token);
  }
  for (const entries of [localEntries, takenTokens]) {
    while (entries.size > SHOWCASE_FEED_READ_AHEAD_LOCAL_LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
}

/** Holds a prepared ranking and answers the token that claims it. */
export async function storePreparedShowcaseFeedSession(
  prepared: PreparedRankedFeedSession,
  { now = Date.now }: { now?: () => number } = {},
): Promise<{ token: string; expiresInMs: number }> {
  const token = randomUUID();
  const expiresAt = prepared.preparedAt + SHOWCASE_FEED_READ_AHEAD_TTL_MS;
  localEntries.set(token, { prepared, expiresAt });
  pruneLocalEntries(now());
  pendingSlotValues.set(token, prepared);
  try {
    await readAheadSlot(token);
  } catch (error) {
    // Outside a request (a script, a test) there is no data cache: this
    // instance's copy still serves.
    if (!isMissingIncrementalCacheError(error)) throw error;
  } finally {
    pendingSlotValues.delete(token);
  }
  return { token, expiresInMs: Math.max(0, expiresAt - now()) };
}

/**
 * The prepared ranking a token names, once: this instance never hands it out
 * twice, and a ranking past its time, or ranked for another viewer, is never
 * handed out at all. Null leaves the request to rank its own first page.
 */
export async function takePreparedShowcaseFeedSession(
  token: string,
  {
    anonymousKeyHash,
    viewerUserId,
    now = Date.now,
  }: { anonymousKeyHash: string | null; viewerUserId: string | null; now?: () => number },
): Promise<PreparedRankedFeedSession | null> {
  if (!isShowcaseFeedReadAheadToken(token) || takenTokens.has(token)) return null;
  pruneLocalEntries(now());
  takenTokens.set(token, now() + SHOWCASE_FEED_READ_AHEAD_TTL_MS);

  let prepared: PreparedRankedFeedSession | null = null;
  const local = localEntries.get(token);
  if (local) {
    localEntries.delete(token);
    prepared = local.prepared;
  } else {
    try {
      prepared = await readAheadSlot(token);
    } catch (error) {
      if (!isMissingIncrementalCacheError(error)) throw error;
      prepared = null;
    }
  }

  if (!prepared || prepared.format !== 1) return null;
  const age = now() - prepared.preparedAt;
  if (!Number.isFinite(age) || age < 0 || age > SHOWCASE_FEED_READ_AHEAD_TTL_MS) return null;
  if (prepared.viewerUserId !== viewerUserId) return null;
  if (prepared.anonymousKeyHash !== (viewerUserId ? null : anonymousKeyHash)) return null;
  return prepared;
}

/** Test-only: forget this instance's held rankings. */
export function resetShowcaseFeedReadAheadStoreForTests() {
  localEntries.clear();
  takenTokens.clear();
  pendingSlotValues.clear();
}

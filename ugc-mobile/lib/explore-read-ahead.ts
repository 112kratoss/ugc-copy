import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
import {
  createShowcaseFeedQueryKey,
  getShowcaseFeedPageParams,
  type ShowcaseFeedFilters,
  type ShowcaseFeedPageParam,
} from './showcase-feed-query';
import type { ShowcaseFeedReadAheadResponse, ShowcaseFeedResponse } from './types';

// Explore's first page, ranked ahead once Home has settled.
//
// A first visit to Explore drew a skeleton for ~2 s (device sweep, 2026-11-03):
// its lane is a fresh ranked session every time, and the request pays the
// whole ranking. It cannot simply be fetched early: the ordinary read opens a
// session and marks its page served, so posts read ahead and never seen would
// be pushed down for this person and counted as shown.
//
// So the app asks the server to rank the page and hold it (`readAhead=1`),
// which writes nothing, and keeps only the token it gets back. The read Explore
// makes when it draws the lane hands the token over (`readAheadToken`): the
// server then persists that ranking and marks page one served, at the moment
// it is shown, and answers in the time a reused session takes. A token that is
// late, spent or unknown just ranks afresh, as Explore always did.
//
// Only a server that has said it holds read-aheads is asked
// (`readAheadSupported` on its For you pages, which Home's lane reads first):
// one without the mode would answer `readAhead=1` with an ordinary page, served
// to nobody.
//
// At most one read-ahead per identity per launch, whatever comes of it: a
// ranking, nothing to hold, a failure, or a token that runs out unused. Each
// one is a whole ranking on the server, and Home settling again (a refetch, a
// return to the tab) must not buy another. An identity that arrives later in
// the launch (a sign-in, a sign-out to a guest) may have its own.
//
// Guests included, on purpose: a new person is still a guest when they first
// open Explore, which makes them the ones who meet its skeleton first, and the
// once-per-launch limit keeps what they cost the same as anyone's.

/** Explore's own lane as it first opens: All, For you, media. */
export const EXPLORE_READ_AHEAD_FILTERS: ShowcaseFeedFilters = { category: 'media' };
/** After Home's page lands, and once the app is idle, so it never competes with Home's own first frames. */
export const EXPLORE_READ_AHEAD_DELAY_MS = 1_500;
/** Under the server's two minutes, for the time the claim takes to arrive. */
export const EXPLORE_READ_AHEAD_MAX_AGE_MS = 100_000;
/** How long Explore waits on a read-ahead still under way before reading the page itself. */
export const EXPLORE_READ_AHEAD_WAIT_MS = 4_000;

type HeldToken = { token: string; expiresAt: number };

type Entry =
  | { identity: string; state: 'pending'; request: Promise<HeldToken | null> }
  | ({ identity: string; state: 'ready' } & HeldToken);

type ExploreLaneData = InfiniteData<ShowcaseFeedResponse, ShowcaseFeedPageParam>;

let serverHoldsReadAheads = false;
let entry: Entry | null = null;
/** The identities this launch has read ahead for: one each, never a second. */
const readAheadIdentities = new Set<string>();

function laneOf(filters: ShowcaseFeedFilters | undefined) {
  return JSON.stringify(createShowcaseFeedQueryKey(filters, null).at(-1));
}

const EXPLORE_LANE = laneOf(EXPLORE_READ_AHEAD_FILTERS);

export function isExploreReadAheadLane(filters: ShowcaseFeedFilters | undefined) {
  return laneOf(filters) === EXPLORE_LANE;
}

/**
 * Reads, off every For you page, whether this server holds read-aheads. A page
 * without the flag (an older server, or a reader it would not hold one for)
 * turns them off again.
 */
export function noteShowcaseFeedReadAheadSupport(
  filters: ShowcaseFeedFilters | undefined,
  response: Pick<ShowcaseFeedResponse, 'readAheadSupported'> | null | undefined,
) {
  if ((filters?.sort ?? 'for-you') !== 'for-you') return;
  serverHoldsReadAheads = response?.readAheadSupported === true;
}

function isServedPage(response: unknown): response is ShowcaseFeedResponse {
  return typeof response === 'object' && response !== null
    && Array.isArray((response as ShowcaseFeedResponse).items)
    && !('readAhead' in response);
}

/**
 * Asks for Explore's first page to be ranked ahead, for this identity, when
 * the server holds read-aheads and Explore's lane has nothing yet. Returns
 * whether it asked.
 */
export function startExploreReadAhead({
  api,
  identityUserId,
  queryClient,
  now = Date.now,
}: {
  api: Pick<MagicbookletApiClient, 'prepareShowcaseFeedReadAhead'>;
  identityUserId: string | null | undefined;
  queryClient: QueryClient;
  now?: () => number;
}): boolean {
  const identity = identityUserId?.trim();
  // The server holds one for any identity with a bearer token, a guest's
  // included (see the note at the top), and for no device without one.
  if (!serverHoldsReadAheads || !identity) return false;
  if (readAheadIdentities.has(identity)) return false;
  const startedAt = now();
  const laneKey = createShowcaseFeedQueryKey(EXPLORE_READ_AHEAD_FILTERS, identity);
  const lane = queryClient.getQueryState(laneKey);
  // Explore has its page, or is reading it now.
  if (lane?.data !== undefined || lane?.fetchStatus === 'fetching') return false;

  const request: Promise<HeldToken | null> = api.prepareShowcaseFeedReadAhead(
    getShowcaseFeedPageParams({ ...EXPLORE_READ_AHEAD_FILTERS, offset: 0 }),
  ).then((response: ShowcaseFeedReadAheadResponse | ShowcaseFeedResponse) => {
    const held = 'readAhead' in response ? response.readAhead : null;
    if (held && typeof held.token === 'string' && held.token && Number.isFinite(held.expiresInMs)) {
      const ready: HeldToken = {
        token: held.token,
        expiresAt: startedAt + Math.min(held.expiresInMs, EXPLORE_READ_AHEAD_MAX_AGE_MS),
      };
      if (entry?.state === 'pending' && entry.request === request) entry = { identity, state: 'ready', ...ready };
      return ready;
    }
    if (isServedPage(response)) {
      // A server without the mode answered with an ordinary page, which it
      // has already marked served. Explore draws that page, then, so what was
      // marked is what is shown. Only if the lane is still empty: never over
      // a page of its own.
      if (queryClient.getQueryState(laneKey)?.data === undefined) {
        queryClient.setQueryData<ExploreLaneData>(laneKey, { pages: [response], pageParams: [{ offset: 0 }] });
      }
      serverHoldsReadAheads = false;
    }
    if (entry?.state === 'pending' && entry.request === request) entry = null;
    return null;
  }, () => {
    if (entry?.state === 'pending' && entry.request === request) entry = null;
    return null;
  });
  readAheadIdentities.add(identity);
  entry = { identity, state: 'pending', request };
  return true;
}

/**
 * The token for the read that is about to draw Explore's first page: once,
 * for the identity it was read ahead for, while it is good. A read-ahead still
 * under way is waited for, up to EXPLORE_READ_AHEAD_WAIT_MS, rather than
 * ranking the page a second time. Null for any other lane or page.
 */
export async function takeExploreReadAheadToken({
  filters,
  identityUserId,
  now = Date.now,
}: {
  filters: ShowcaseFeedFilters | undefined;
  identityUserId: string | null | undefined;
  now?: () => number;
}): Promise<string | null> {
  const identity = identityUserId?.trim();
  if (!identity || !isExploreReadAheadLane(filters)) return null;
  const held = entry;
  if (!held || held.identity !== identity) return null;
  // Spent now, whatever comes of it: a retry of this read ranks afresh.
  entry = null;

  let token: HeldToken | null;
  if (held.state === 'ready') {
    token = held;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    token = await Promise.race([
      held.request,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EXPLORE_READ_AHEAD_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  return token && token.expiresAt > now() ? token.token : null;
}

/**
 * Starts a read-ahead after Home's page has landed and the app has gone idle.
 * Returns the cancel for an effect's cleanup.
 */
export function scheduleExploreReadAhead(start: () => void, delayMs = EXPLORE_READ_AHEAD_DELAY_MS) {
  let cancelled = false;
  let idleHandle: number | null = null;
  const timer = setTimeout(() => {
    if (cancelled) return;
    const whenIdle = globalThis.requestIdleCallback;
    if (typeof whenIdle !== 'function') {
      start();
      return;
    }
    try {
      idleHandle = whenIdle(() => {
        if (!cancelled) start();
      });
    } catch {
      // The legacy runtime scheduler has no idle tasks.
      start();
    }
  }, delayMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (idleHandle !== null && typeof globalThis.cancelIdleCallback === 'function') {
      globalThis.cancelIdleCallback(idleHandle);
    }
  };
}

/** Forgets a held read-ahead, as a sign-out does to everything ranked for the person leaving. */
export function clearExploreReadAhead() {
  entry = null;
}

/** Test-only: back to a launch that has heard nothing from the server. */
export function resetExploreReadAheadForTests() {
  serverHoldsReadAheads = false;
  entry = null;
  readAheadIdentities.clear();
}

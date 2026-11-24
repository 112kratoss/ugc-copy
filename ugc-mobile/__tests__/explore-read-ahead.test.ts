import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  EXPLORE_READ_AHEAD_FILTERS,
  EXPLORE_READ_AHEAD_MAX_AGE_MS,
  EXPLORE_READ_AHEAD_WAIT_MS,
  noteExploreOpening,
  noteShowcaseFeedReadAheadSupport,
  resetExploreReadAheadForTests,
  scheduleExploreReadAhead,
  startExploreReadAhead,
  takeExploreReadAheadToken,
} from '@/lib/explore-read-ahead';
import { showcaseFeedLaneQueryOptions } from '@/lib/showcase-feed-lane';
import { createShowcaseFeedQueryKey } from '@/lib/showcase-feed-query';
import type { ShowcaseFeedReadAheadResponse, ShowcaseFeedResponse } from '@/lib/types';

const endpoint = mobileApiContract.endpoints.prepareShowcaseFeedReadAhead;
const TOKEN = endpoint.response.readAhead.token;
const NOW = 1_000_000;

function heldAnswer(overrides: Partial<NonNullable<ShowcaseFeedReadAheadResponse['readAhead']>> = {}): ShowcaseFeedReadAheadResponse {
  return { readAhead: { ...endpoint.response.readAhead, ...overrides } };
}

function servedPage(): ShowcaseFeedResponse {
  return { items: [], feedSessionId: 'session-1', pageInfo: { hasMore: false, nextOffset: null, offset: 0 } };
}

function api(answer: () => Promise<ShowcaseFeedReadAheadResponse | ShowcaseFeedResponse> = async () => heldAnswer()) {
  return { prepareShowcaseFeedReadAhead: vi.fn(answer) };
}

function supported() {
  noteShowcaseFeedReadAheadSupport({ sort: 'for-you' }, { readAheadSupported: true });
}

describe("Explore's read-ahead", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    resetExploreReadAheadForTests();
    queryClient = new QueryClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks nothing of a server that has not said it holds read-aheads', () => {
    const client = api();

    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(false);
    noteShowcaseFeedReadAheadSupport({ sort: 'for-you' }, {});
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(false);

    supported();
    // A later For you page without the flag (an older server back in place) turns it off again.
    noteShowcaseFeedReadAheadSupport({ sort: 'for-you' }, { readAheadSupported: false });
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(false);
    expect(client.prepareShowcaseFeedReadAhead).not.toHaveBeenCalled();
  });

  it("reads the flag off For you pages only: Recent's pages carry none", () => {
    supported();
    noteShowcaseFeedReadAheadSupport({ sort: 'recent' }, {});

    expect(startExploreReadAhead({ api: api(), identityUserId: 'user-1', queryClient })).toBe(true);
  });

  it("asks for Explore's own first page, as the contract pins it, for an identity and an empty lane only", async () => {
    supported();
    const client = api();

    expect(startExploreReadAhead({ api: client, identityUserId: null, queryClient })).toBe(false);
    queryClient.setQueryData(createShowcaseFeedQueryKey(EXPLORE_READ_AHEAD_FILTERS, 'user-1'), {
      pages: [servedPage()],
      pageParams: [{ offset: 0 }],
    });
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(false);
    expect(client.prepareShowcaseFeedReadAhead).not.toHaveBeenCalled();

    expect(startExploreReadAhead({ api: client, identityUserId: 'user-2', queryClient })).toBe(true);
    // One at a time per identity.
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-2', queryClient })).toBe(false);
    expect(client.prepareShowcaseFeedReadAhead).toHaveBeenCalledTimes(1);
    const [params] = client.prepareShowcaseFeedReadAhead.mock.calls[0] as unknown as [Record<string, unknown>];
    const { readAhead: _mode, ...pageQuery } = endpoint.query;
    expect(params).toMatchObject({ ...pageQuery, offset: 0 });
  });

  it("hands Explore's first read the token once, for the identity and lane it was read for", async () => {
    supported();
    startExploreReadAhead({ api: api(), identityUserId: 'user-1', queryClient, now: () => NOW });
    await Promise.resolve();
    await Promise.resolve();

    const claim = (filters: object, identityUserId = 'user-1') => takeExploreReadAheadToken({
      filters,
      identityUserId,
      now: () => NOW + 1_000,
    });
    await expect(claim({ category: 'media', unlock: 'paid' })).resolves.toBeNull();
    await expect(claim({ category: 'media' }, 'user-2')).resolves.toBeNull();
    await expect(claim({ category: 'media' })).resolves.toBe(TOKEN);
    await expect(claim({ category: 'media' })).resolves.toBeNull();
  });

  it('lets a token go unused once it is older than the server keeps it', async () => {
    supported();
    startExploreReadAhead({ api: api(), identityUserId: 'user-1', queryClient, now: () => NOW });
    await Promise.resolve();
    await Promise.resolve();

    await expect(takeExploreReadAheadToken({
      filters: EXPLORE_READ_AHEAD_FILTERS,
      identityUserId: 'user-1',
      now: () => NOW + EXPLORE_READ_AHEAD_MAX_AGE_MS,
    })).resolves.toBeNull();
  });

  it('waits for a read-ahead still under way rather than ranking the page twice', async () => {
    supported();
    let answer: (value: ShowcaseFeedReadAheadResponse) => void = () => {};
    startExploreReadAhead({
      api: api(() => new Promise((resolve) => { answer = resolve; })),
      identityUserId: 'user-1',
      queryClient,
      now: () => NOW,
    });

    const waiting = takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1', now: () => NOW });
    answer(heldAnswer());
    await expect(waiting).resolves.toBe(TOKEN);
  });

  // A stalled read-ahead (a network switch, a hung instance) settles only at
  // the API client's 30 s; Explore must not draw its skeleton for that long.
  it("gives up on a read-ahead 12 s after the read-ahead started, however late Explore opened", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    supported();
    startExploreReadAhead({ api: api(() => new Promise(() => {})), identityUserId: 'user-1', queryClient });
    // Explore opens 11 s into the read-ahead: it is waited for 1 s only.
    await vi.advanceTimersByTimeAsync(11_000);
    const whileWaiting = vi.fn();
    const stuck = takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1', whileWaiting });
    let settled = false;
    void stuck.then(() => { settled = true; });
    expect(whileWaiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stuck).resolves.toBeNull();
    expect(EXPLORE_READ_AHEAD_WAIT_MS).toBe(12_000);

    // One already past its 12 s is not waited for at all.
    resetExploreReadAheadForTests();
    supported();
    startExploreReadAhead({ api: api(() => new Promise(() => {})), identityUserId: 'user-1', queryClient });
    await vi.advanceTimersByTimeAsync(12_000);
    const late = vi.fn();
    await expect(takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1', whileWaiting: late }))
      .resolves.toBeNull();
    expect(late).not.toHaveBeenCalled();
  });

  // On the emulator (2026-11-24), Explore opened 1 s into a 6 s read-ahead
  // gave up at 4 s and ranked the page a second time.
  it.each([4_500, 6_000])("hands Explore's first read a read-ahead that answers after %i ms, so the page is ranked once", async (answerMs) => {
    vi.useFakeTimers();
    supported();
    startExploreReadAhead({
      api: api(() => new Promise((resolve) => { setTimeout(() => resolve(heldAnswer()), answerMs); })),
      identityUserId: 'user-1',
      queryClient,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const feed = { getShowcaseFeed: vi.fn(async () => ({ ...servedPage(), readAheadSupported: true })) };

    const reading = showcaseFeedLaneQueryOptions(feed as never, EXPLORE_READ_AHEAD_FILTERS, 'user-1')
      .queryFn({ pageParam: { offset: 0 } });
    await vi.advanceTimersByTimeAsync(answerMs - 1_000);
    await reading;

    expect(feed.getShowcaseFeed).toHaveBeenCalledTimes(1);
    expect(feed.getShowcaseFeed).toHaveBeenCalledWith(expect.objectContaining({ readAheadToken: TOKEN }));
  });

  it("keeps a read-ahead to its identity when the identity changes while Explore waits on it", async () => {
    vi.useFakeTimers();
    supported();
    startExploreReadAhead({
      api: api(() => new Promise((resolve) => { setTimeout(() => resolve(heldAnswer()), 3_000); })),
      identityUserId: 'user-1',
      queryClient,
    });
    const feed = { getShowcaseFeed: vi.fn(async () => ({ ...servedPage(), readAheadSupported: true })) };
    const firstLane = showcaseFeedLaneQueryOptions(feed as never, EXPLORE_READ_AHEAD_FILTERS, 'user-1');
    const secondLane = showcaseFeedLaneQueryOptions(feed as never, EXPLORE_READ_AHEAD_FILTERS, 'user-2');

    // user-1's Explore read waits on the read-ahead; then a sign-in brings
    // user-2, whose lane reads at once and neither waits nor takes the token.
    const firstRead = firstLane.queryFn({ pageParam: { offset: 0 } });
    await vi.advanceTimersByTimeAsync(500);
    await secondLane.queryFn({ pageParam: { offset: 0 } });
    expect(feed.getShowcaseFeed).toHaveBeenCalledTimes(1);
    expect(feed.getShowcaseFeed.mock.calls[0]).not.toEqual([expect.objectContaining({ readAheadToken: expect.anything() })]);

    await vi.advanceTimersByTimeAsync(2_500);
    await firstRead;
    expect(feed.getShowcaseFeed).toHaveBeenCalledTimes(2);
    expect(feed.getShowcaseFeed).toHaveBeenLastCalledWith(expect.objectContaining({ readAheadToken: TOKEN }));
  });

  it.each([
    ['a ranking it held and Explore never claimed', async () => heldAnswer()],
    ['nothing to hold', async () => ({ readAhead: null })],
    ['a failure', async () => { throw new Error('offline'); }],
  ] as const)('reads ahead once per identity per launch, whatever came of it: %s', async (_case, answer) => {
    supported();
    let now = NOW;
    const client = api(answer as () => Promise<ShowcaseFeedReadAheadResponse>);

    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient, now: () => now })).toBe(true);
    await takeExploreReadAheadToken({ filters: { category: 'video' }, identityUserId: 'user-1' });
    await Promise.resolve();
    await Promise.resolve();
    // Home settling again, long after any token would have run out.
    now += 10 * EXPLORE_READ_AHEAD_MAX_AGE_MS;
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient, now: () => now })).toBe(false);
    expect(client.prepareShowcaseFeedReadAhead).toHaveBeenCalledTimes(1);

    // An identity that arrives later in the launch (a sign-in) has its own.
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-2', queryClient, now: () => now })).toBe(true);
  });

  // A guard: `startExploreReadAhead` sees Explore's lane only once its query
  // reads, after the screen's first commit. On the emulator nothing ran in
  // between, but nothing promises that it never will.
  it('starts none once Explore is opening for that identity, though its lane has not begun to read', () => {
    supported();
    const client = api();

    noteExploreOpening('user-1');
    // Explore's lane is still empty and idle: its query subscribes after the
    // screen's first commit, which is when an idle callback could run.
    expect(queryClient.getQueryState(createShowcaseFeedQueryKey(EXPLORE_READ_AHEAD_FILTERS, 'user-1'))).toBeUndefined();
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(false);
    expect(client.prepareShowcaseFeedReadAhead).not.toHaveBeenCalled();

    // Another identity of the same launch (a sign-in before Explore saw it) still may.
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-2', queryClient })).toBe(true);
  });

  it('lets Explore opening join a read-ahead already under way, so the page is ranked once', async () => {
    vi.useFakeTimers();
    supported();
    const client = api(() => new Promise((resolve) => { setTimeout(() => resolve(heldAnswer()), 2_000); }));
    expect(startExploreReadAhead({ api: client, identityUserId: 'user-1', queryClient })).toBe(true);
    noteExploreOpening('user-1');
    const feed = { getShowcaseFeed: vi.fn(async () => ({ ...servedPage(), readAheadSupported: true })) };

    const reading = showcaseFeedLaneQueryOptions(feed as never, EXPLORE_READ_AHEAD_FILTERS, 'user-1')
      .queryFn({ pageParam: { offset: 0 } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(feed.getShowcaseFeed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reading;

    expect(client.prepareShowcaseFeedReadAhead).toHaveBeenCalledTimes(1);
    expect(feed.getShowcaseFeed).toHaveBeenCalledTimes(1);
    expect(feed.getShowcaseFeed).toHaveBeenCalledWith(expect.objectContaining({ readAheadToken: TOKEN }));
  });

  it('reads ahead for a guest identity too: new people meet the skeleton first', () => {
    supported();
    const client = api();

    expect(startExploreReadAhead({ api: client, identityUserId: 'guest-anonymous-uid', queryClient })).toBe(true);
    expect(client.prepareShowcaseFeedReadAhead).toHaveBeenCalledTimes(1);
  });

  it('draws a page an older server answered with as an ordinary read, so what it marked served is what Explore shows', async () => {
    supported();
    const page = servedPage();
    startExploreReadAhead({ api: api(async () => page), identityUserId: 'user-1', queryClient });

    await expect(takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1' })).resolves.toBeNull();
    expect(queryClient.getQueryData(createShowcaseFeedQueryKey(EXPLORE_READ_AHEAD_FILTERS, 'user-1')))
      .toEqual({ pages: [page], pageParams: [{ offset: 0 }] });
    // And that server is not asked again.
    expect(startExploreReadAhead({ api: api(), identityUserId: 'user-2', queryClient })).toBe(false);
  });

  it("claims the token on Explore's first page read and on no later page", async () => {
    supported();
    startExploreReadAhead({ api: api(), identityUserId: 'user-1', queryClient });
    await Promise.resolve();
    await Promise.resolve();
    const feed = { getShowcaseFeed: vi.fn(async () => ({ ...servedPage(), readAheadSupported: true })) };
    const lane = showcaseFeedLaneQueryOptions(feed as never, EXPLORE_READ_AHEAD_FILTERS, 'user-1');

    await lane.queryFn({ pageParam: { offset: 0 } });
    await lane.queryFn({ pageParam: { cursor: 'cursor-2' } });
    await lane.queryFn({ pageParam: { offset: 0 } });

    const calls = feed.getShowcaseFeed.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0][0]).toMatchObject({ ...endpoint.claim.query, offset: 0 });
    expect(calls[1][0]).not.toHaveProperty('readAheadToken');
    expect(calls[2][0]).not.toHaveProperty('readAheadToken');
  });

  it("never claims it for one of Home's lanes", async () => {
    supported();
    startExploreReadAhead({ api: api(), identityUserId: 'user-1', queryClient });
    await Promise.resolve();
    await Promise.resolve();
    const feed = { getShowcaseFeed: vi.fn(async () => servedPage()) };

    await showcaseFeedLaneQueryOptions(feed as never, { sort: 'for-you' }, 'user-1').queryFn({ pageParam: { offset: 0 } });

    expect(feed.getShowcaseFeed.mock.calls[0]).not.toEqual([expect.objectContaining({ readAheadToken: expect.anything() })]);
    // Home's For you page had no flag: support is off again.
    expect(startExploreReadAhead({ api: api(), identityUserId: 'user-3', queryClient })).toBe(false);
  });

  it('starts after the delay, once idle, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const start = vi.fn();

    scheduleExploreReadAhead(start, 1_000);
    vi.advanceTimersByTime(999);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);

    const cancel = scheduleExploreReadAhead(start, 1_000);
    cancel();
    vi.advanceTimersByTime(2_000);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

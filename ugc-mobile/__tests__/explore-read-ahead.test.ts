import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  EXPLORE_READ_AHEAD_FILTERS,
  EXPLORE_READ_AHEAD_MAX_AGE_MS,
  EXPLORE_READ_AHEAD_RETRY_MS,
  EXPLORE_READ_AHEAD_WAIT_MS,
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

  it('waits for a read-ahead still under way rather than ranking the page twice, but not for long', async () => {
    vi.useFakeTimers();
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

    resetExploreReadAheadForTests();
    supported();
    startExploreReadAhead({
      api: api(() => new Promise(() => {})),
      identityUserId: 'user-1',
      queryClient,
      now: () => NOW,
    });
    const stuck = takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1', now: () => NOW });
    await vi.advanceTimersByTimeAsync(EXPLORE_READ_AHEAD_WAIT_MS);
    await expect(stuck).resolves.toBeNull();
  });

  it('holds nothing when there was nothing to hold, and backs off after a failure', async () => {
    supported();
    let now = NOW;
    const empty = api(async () => ({ readAhead: null }));
    startExploreReadAhead({ api: empty, identityUserId: 'user-1', queryClient, now: () => now });
    await expect(takeExploreReadAheadToken({ filters: EXPLORE_READ_AHEAD_FILTERS, identityUserId: 'user-1' })).resolves.toBeNull();

    const failing = api(async () => { throw new Error('offline'); });
    startExploreReadAhead({ api: failing, identityUserId: 'user-1', queryClient, now: () => now });
    await Promise.resolve();
    await Promise.resolve();
    expect(startExploreReadAhead({ api: failing, identityUserId: 'user-1', queryClient, now: () => now })).toBe(false);
    now += EXPLORE_READ_AHEAD_RETRY_MS;
    expect(startExploreReadAhead({ api: failing, identityUserId: 'user-1', queryClient, now: () => now })).toBe(true);
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

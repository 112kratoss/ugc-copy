import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  configurePostViewReporter,
  createPostViewReporter,
  flushPostViews,
  flushPostViewsOfLeavingIdentity,
  isSettledPostViewFailure,
  POST_VIEW_FLUSH_DELAY_MS,
  POST_VIEW_MAX_WAIT_MS,
  POST_VIEWS_MAX_BATCH,
  reportPostView,
  resetPostViewReporterForTests,
  utcDay,
  type PostViewRequestBody,
  type PostViewSendOptions,
} from '../lib/post-view-reporter';

/**
 * The app's views (post view counts, step 3): batched like the web's reporter,
 * once a reader, post and UTC day, let go on a failed send so the next look
 * reports again, and sent only under the identity that saw the post.
 */

const reader = 'reader-1';

function setup({ identity = reader as string | null, send }: {
  identity?: string | null;
  send?: (body: PostViewRequestBody, options: PostViewSendOptions) => Promise<unknown>;
} = {}) {
  const sent: PostViewRequestBody[] = [];
  const state = { identity };
  const sender = vi.fn(send ?? (async (body: PostViewRequestBody, _options: PostViewSendOptions) => {
    sent.push(body);
    return null;
  }));
  const reporter = createPostViewReporter({ send: sender, currentIdentity: () => state.identity });
  return { reporter, sent, sender, state };
}

const settle = async () => {
  // A batch's send and its answer each take a turn of the microtask queue.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetPostViewReporterForTests();
});

describe('post view reporter', () => {
  it('sends a view 5 s after the last one queued, in the request the route takes', async () => {
    const { reporter, sent } = setup();
    expect(reporter.report({ postId: 'post-1', surface: 'post-page', identity: reader })).toBe(true);
    vi.advanceTimersByTime(POST_VIEW_FLUSH_DELAY_MS - 1);
    await settle();
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    await settle();
    expect(sent).toEqual([{ views: [{ postId: 'post-1', surface: 'post-page' }] }]);
  });

  it('keeps the batch the contract pins: 25 a request, and the surfaces the route takes', async () => {
    expect(POST_VIEWS_MAX_BATCH).toBe(mobileApiContract.endpoints.recordPostViews.maxViews);
    for (const surface of ['feed', 'post-page', 'reel'] as const) {
      expect(mobileApiContract.endpoints.recordPostViews.surfaces).toContain(surface);
    }

    const { reporter, sent } = setup();
    for (let index = 0; index < POST_VIEWS_MAX_BATCH; index += 1) {
      reporter.report({ postId: `post-${index}`, surface: 'reel', identity: reader });
    }
    // The 25th sends at once, without waiting for the quiet.
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].views).toHaveLength(POST_VIEWS_MAX_BATCH);
    expect(reporter.pendingCount()).toBe(0);
  });

  it('never holds the first view of a batch more than 30 s, however busy the reader', () => {
    const { reporter } = setup();
    reporter.report({ postId: 'post-0', surface: 'reel', identity: reader });
    // A view every 4 s: each starts the 5 s quiet again.
    for (let at = 4_000; at < POST_VIEW_MAX_WAIT_MS; at += 4_000) {
      vi.advanceTimersByTime(4_000);
      reporter.report({ postId: `post-${at}`, surface: 'reel', identity: reader });
    }
    // At 28 s the quiet would run to 33 s; the batch goes at 30.
    vi.advanceTimersByTime(POST_VIEW_MAX_WAIT_MS - 28_000 - 1);
    expect(reporter.pendingCount()).toBe(8);
    vi.advanceTimersByTime(1);
    expect(reporter.pendingCount()).toBe(0);
  });

  it('reports a reader’s view of a post once a UTC day, and again on the next day', async () => {
    const { reporter, sent } = setup();
    expect(reporter.report({ postId: 'post-1', surface: 'post-page', identity: reader })).toBe(true);
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(false);
    // Another reader's view of the same post is theirs.
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: 'reader-2' })).toBe(true);
    await reporter.flush();

    vi.setSystemTime(new Date('2026-11-25T23:59:59.000Z'));
    expect(reporter.report({ postId: 'post-1', surface: 'post-page', identity: reader })).toBe(false);
    vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
    expect(utcDay(Date.now())).toBe('2026-11-26');
    expect(reporter.report({ postId: 'post-1', surface: 'post-page', identity: reader })).toBe(true);
    await reporter.flush();
    expect(sent.flatMap((body) => body.views)).toEqual([
      { postId: 'post-1', surface: 'post-page' },
      { postId: 'post-1', surface: 'post-page' },
    ]);
  });

  it('sends what it holds when told to, as the app leaves the foreground', async () => {
    const { reporter, sent } = setup();
    reporter.report({ postId: 'post-1', surface: 'reel', identity: reader });
    reporter.report({ postId: 'post-2', surface: 'post-page', identity: reader });
    await reporter.flush();
    expect(sent).toEqual([{ views: [{ postId: 'post-1', surface: 'reel' }, { postId: 'post-2', surface: 'post-page' }] }]);
    // Nothing left for the timer to send.
    vi.advanceTimersByTime(POST_VIEW_MAX_WAIT_MS);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['the network', new TypeError('Network request failed')],
    ['a 5xx', Object.assign(new Error('Server error'), { status: 503 })],
    ['a 401', Object.assign(new Error('Unauthorized'), { status: 401 })],
    ['a 408', Object.assign(new Error('Timeout'), { status: 408 })],
    ['a 429', Object.assign(new Error('Too many'), { status: 429 })],
  ])('lets a view go when %s fails its send, so the next look reports it again', async (_name, failure) => {
    let fail = true;
    const { reporter, sender } = setup({
      send: async () => {
        if (fail) throw failure;
        return null;
      },
    });
    reporter.report({ postId: 'post-1', surface: 'reel', identity: reader });
    await expect(reporter.flush()).resolves.toBeUndefined();

    fail = false;
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(true);
    await reporter.flush();
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('keeps a view reported when the route refuses it for good', async () => {
    expect(isSettledPostViewFailure(Object.assign(new Error('Malformed'), { status: 400 }))).toBe(true);
    expect(isSettledPostViewFailure(Object.assign(new Error('Too large'), { status: 413 }))).toBe(true);
    expect(isSettledPostViewFailure(new TypeError('Network request failed'))).toBe(false);

    const { reporter, sender } = setup({ send: async () => { throw Object.assign(new Error('Malformed'), { status: 400 }); } });
    reporter.report({ postId: 'post-1', surface: 'reel', identity: reader });
    await reporter.flush();
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(false);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('sends a view only under the identity that saw the post, and lets the rest go', async () => {
    const { reporter, sent, state } = setup();
    reporter.report({ postId: 'post-1', surface: 'reel', identity: reader });
    // A sign-in before the batch leaves: the client would send the new token.
    state.identity = 'account-2';
    reporter.report({ postId: 'post-2', surface: 'reel', identity: 'account-2' });
    await reporter.flush();
    expect(sent).toEqual([{ views: [{ postId: 'post-2', surface: 'reel' }] }]);

    // The guest's view was let go: seen again by the guest, it is reported again.
    state.identity = reader;
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(true);
  });

  it('queues nothing without a post', () => {
    const { reporter } = setup();
    expect(reporter.report({ postId: '', surface: 'reel', identity: reader })).toBe(false);
    expect(reporter.pendingCount()).toBe(0);
  });

  it('sends each batch with the identity that saw its views, for the sender to send under that session only', async () => {
    const { reporter, sender } = setup();
    reporter.report({ postId: 'post-1', surface: 'feed', identity: reader });
    await reporter.flush();
    expect(sender).toHaveBeenCalledWith({ views: [{ postId: 'post-1', surface: 'feed' }] }, { identity: reader });
  });

  it('holds a view seen while the session is unknown, and reports it under the session that comes (review of #929, 7)', async () => {
    // A cold start still reading its session, or a device whose guest sign-in
    // failed (offline, or the network's limit on new guests): no identity yet.
    const { reporter, sent, sender, state } = setup({ identity: null });
    expect(reporter.report({ postId: 'post-1', surface: 'post-page', identity: null })).toBe(true);
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: null })).toBe(false);
    expect(reporter.report({ postId: 'post-2', surface: 'reel', identity: '' })).toBe(true);
    expect(reporter.pendingCount()).toBe(0);
    await reporter.flush();
    vi.advanceTimersByTime(POST_VIEW_MAX_WAIT_MS);
    await settle();
    expect(sender).not.toHaveBeenCalled();

    // The guest session lands (or the stored one is read): the held views are that reader's.
    state.identity = reader;
    reporter.adoptHeldViews();
    expect(reporter.pendingCount()).toBe(2);
    await reporter.flush();
    expect(sent).toEqual([{ views: [{ postId: 'post-1', surface: 'post-page' }, { postId: 'post-2', surface: 'reel' }] }]);
    // Reported for the day under that reader now.
    expect(reporter.report({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(false);
  });

  it('sends the views of an identity a sign-in or sign-out is leaving at once, with that session’s own token (review of #929, 12)', async () => {
    const { reporter, sender } = setup();
    reporter.report({ postId: 'post-1', surface: 'reel', identity: reader });
    reporter.report({ postId: 'post-2', surface: 'reel', identity: 'reader-2' });
    await reporter.flushIdentity({ identity: reader, accessToken: 'outgoing-token' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      { views: [{ postId: 'post-1', surface: 'reel' }] },
      { identity: reader, accessToken: 'outgoing-token' },
    );
    // Another identity's views wait for their own batch.
    expect(reporter.pendingCount()).toBe(1);
  });

  it('reports through the app’s reporter once the auth provider has configured it', async () => {
    expect(reportPostView({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(false);
    await expect(flushPostViews()).resolves.toBeUndefined();

    const send = vi.fn(async (_body: PostViewRequestBody, _options: PostViewSendOptions) => null);
    const auth = { identity: null as string | null };
    configurePostViewReporter({ send, currentIdentity: () => auth.identity });
    // Seen before the session was read: held until it is.
    expect(reportPostView({ postId: 'post-0', surface: 'reel', identity: null })).toBe(true);
    auth.identity = reader;
    // The auth provider configures the reporter again as its session changes.
    configurePostViewReporter({ send, currentIdentity: () => auth.identity });
    expect(reportPostView({ postId: 'post-1', surface: 'reel', identity: reader })).toBe(true);
    await flushPostViews();
    expect(send).toHaveBeenCalledWith(
      { views: [{ postId: 'post-0', surface: 'reel' }, { postId: 'post-1', surface: 'reel' }] },
      { identity: reader },
    );

    reportPostView({ postId: 'post-2', surface: 'feed', identity: reader });
    await flushPostViewsOfLeavingIdentity({ identity: reader, accessToken: 'outgoing-token' });
    expect(send).toHaveBeenLastCalledWith(
      { views: [{ postId: 'post-2', surface: 'feed' }] },
      { identity: reader, accessToken: 'outgoing-token' },
    );
  });
});

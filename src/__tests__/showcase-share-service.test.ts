import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  parseShowcaseSharePayloadForRoute,
  shareShowcasePostForRoute,
  type ShowcaseShareServiceDependencies,
} from '@/lib/showcase-share-service';

function createServiceClientMock() {
  return {
    client: { service: true } as unknown as SupabaseClient,
  };
}

/**
 * Derived from the real dependency rather than restated as
 * `Record<string, unknown>`, which does not satisfy the service's declared
 * return type and would drift as the row shape changes.
 */
type SharePostReference = Awaited<
  ReturnType<ShowcaseShareServiceDependencies['findPublicPostReferenceByIdOrGenerationId']>
>;

function createDependencies(
  post: SharePostReference = {
    id: 'post-1',
    generation_id: 'gen-1',
    user_id: 'creator-1',
    visibility: 'public',
    category: 'image',
    prompt: 'a prompt',
    source_kind: 'magicbooklet',
  },
) {
  return {
    findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => post),
    isUserRelationshipBlocked: vi.fn(async () => false),
    // `null`, not `undefined`: the real notifier returns null when it declines
    // to send, and never returns undefined.
    notifyPostSocialActivity: vi.fn(async () => null),
    recordPostShareEvent: vi.fn(async () => undefined),
  } satisfies Partial<ShowcaseShareServiceDependencies>;
}

describe('parseShowcaseSharePayloadForRoute', () => {
  it('prefers post ids over generation ids and validates share metadata', () => {
    const result = parseShowcaseSharePayloadForRoute({
      generationId: 'gen-1',
      postId: 'post-1',
      sourceSurface: 'showcase',
      channel: 'copy-link',
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        referenceId: 'post-1',
        sourceSurface: 'showcase',
        channel: 'copy-link',
      },
    });
  });

  it.each([
    [{ sourceSurface: 'showcase', channel: 'copy-link' }, 'Missing post ID'],
    [{ postId: 'post-1', sourceSurface: 'invalid', channel: 'copy-link' }, 'Invalid share source surface'],
    [{ postId: 'post-1', sourceSurface: 'showcase', channel: 'invalid' }, 'Invalid share channel'],
  ])('returns route-ready validation errors for malformed payloads', (body, expectedError) => {
    const result = parseShowcaseSharePayloadForRoute(body);

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: expectedError },
    });
  });
});

describe('shareShowcasePostForRoute', () => {
  it('records authenticated share clicks for public posts and notifies creators', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(dependencies.findPublicPostReferenceByIdOrGenerationId).toHaveBeenCalledWith(
      'post-1',
      serviceClient.client,
    );
    expect(dependencies.recordPostShareEvent).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'showcase',
      channel: 'copy-link',
      actorUserId: 'user-1',
    }, serviceClient.client);
    expect(dependencies.notifyPostSocialActivity).toHaveBeenCalledWith(serviceClient.client, {
      type: 'post_shared',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it('records anonymous share clicks without notifying creators', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await shareShowcasePostForRoute({
      actorUserId: null,
      channel: 'native-share',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'detail-page',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(dependencies.recordPostShareEvent).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'detail-page',
      channel: 'native-share',
      actorUserId: null,
    }, serviceClient.client);
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects blocked creator interactions before recording or notifying shares', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockResolvedValue(true);

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    });
    expect(dependencies.recordPostShareEvent).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects private or missing post references before recording share events', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies(null);

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-2',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    });
    expect(dependencies.recordPostShareEvent).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });
});

describe('post share notifications', () => {
  // The real notifier runs here against held notification history: one grouped
  // notification, to the creator whose post was shared. Its key ends in the
  // quarter-hour it was sent in.
  const shareAggregationKey = expect.stringMatching(/^post-social:post_shared:creator-1:post-1:\d+$/);
  const shareNotification = expect.objectContaining({
    user_id: 'creator-1',
    actor_user_id: 'user-1',
    type: 'post_shared',
    category: 'social',
    title: 'Someone shared your post',
    object_id: 'post-1',
    aggregation_key: shareAggregationKey,
  });
  const sharedAnswer = { ok: true, body: { success: true } };
  const shareClick = {
    postId: 'post-1',
    eventType: 'share_click',
    sourceSurface: 'showcase',
    channel: 'copy-link',
    actorUserId: 'user-1',
  };

  // Everything but the notifier is stood in for, so the real one runs.
  function createRealNotifierDependencies(post?: SharePostReference) {
    const {
      findPublicPostReferenceByIdOrGenerationId,
      isUserRelationshipBlocked,
      recordPostShareEvent,
    } = createDependencies(post);

    return { findPublicPostReferenceByIdOrGenerationId, isUserRelationshipBlocked, recordPostShareEvent };
  }

  function createHistoryClient(history: ReturnType<typeof createMobileNotificationHistory>) {
    return withMobileNotificationHistory(createServiceClientMock().client, history);
  }

  it('answers a share before the creator is told when the caller can run work after the response', async () => {
    // The notification ends in a push request to Expo for the creator's
    // devices. In production, before an account's devices went out in one
    // request (#259), a share waited 17 s on a creator with 51. Whoever
    // shared is the one waiting on that request.
    const history = createMobileNotificationHistory();
    history.hold();
    const serviceClient = createHistoryClient(history);
    const dependencies = createRealNotifierDependencies();
    const deferred: Array<() => Promise<unknown>> = [];

    const share = shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient,
      sourceSurface: 'showcase',
      dependencies,
      runAfterResponse: (task) => { deferred.push(task); },
    });

    // A notification that has not finished no longer holds the answer back,
    // and the share behind that answer is recorded as it always was.
    expect(await hasAnswered(share)).toBe(true);
    await expect(share).resolves.toEqual(sharedAnswer);
    expect(dependencies.recordPostShareEvent.mock.calls).toEqual([[shareClick, serviceClient]]);
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    history.release();
    await deferred[0]();
    expect(history.sent).toEqual([shareNotification]);
  });

  it('tells the creator before answering a share when the caller has nowhere to run it afterwards', async () => {
    const history = createMobileNotificationHistory();
    history.hold();
    const serviceClient = createHistoryClient(history);
    const dependencies = createRealNotifierDependencies();

    const share = shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(await hasAnswered(share)).toBe(false);
    expect(history.started).toEqual([shareAggregationKey]);

    history.release();
    await expect(share).resolves.toEqual(sharedAnswer);
    expect(dependencies.recordPostShareEvent.mock.calls).toEqual([[shareClick, serviceClient]]);
    expect(history.sent).toEqual([shareNotification]);
  });

  it.each([
    {
      kind: 'a share by someone who is signed out',
      actorUserId: null,
      blocked: false,
      post: undefined,
    },
    {
      kind: 'a share across a block',
      actorUserId: 'user-1',
      blocked: true,
      post: undefined,
    },
    {
      kind: 'a share of a post that is not public',
      actorUserId: 'user-1',
      blocked: false,
      post: null,
    },
  ])('defers nothing for $kind', async ({ actorUserId, blocked, post }) => {
    const history = createMobileNotificationHistory();
    const dependencies = createRealNotifierDependencies(post);
    dependencies.isUserRelationshipBlocked.mockResolvedValue(blocked);
    const runAfterResponse = vi.fn();

    await shareShowcasePostForRoute({
      actorUserId,
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient: createHistoryClient(history),
      sourceSurface: 'showcase',
      dependencies,
      runAfterResponse,
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('tells the creator in front of the answer rather than fail a recorded share when the task cannot be queued', async () => {
    const history = createMobileNotificationHistory();
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      // The share is already recorded. A scheduler that will not take the task
      // must not turn that into a failed share.
      await expect(shareShowcasePostForRoute({
        actorUserId: 'user-1',
        channel: 'copy-link',
        referenceId: 'post-1',
        serviceClient: createHistoryClient(history),
        sourceSurface: 'showcase',
        dependencies: createRealNotifierDependencies(),
        runAfterResponse: () => {
          throw new Error('`after` was called outside a request scope.');
        },
      })).resolves.toEqual(sharedAnswer);
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual([shareNotification]);
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });
});

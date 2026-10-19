import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  withUniqueDedupeKeys,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  saveShowcasePostForRoute,
  type ShowcaseSaveServiceDependencies,
} from '@/lib/showcase-save-service';

function createServiceClientMock(
  saveState: { is_saved: boolean; save_count: number; changed: boolean } = {
    is_saved: true,
    save_count: 5,
    changed: true,
  },
) {
  const eventInsertMock = vi.fn(async () => ({ data: null, error: null }));
  const rpcMock = vi.fn(async (fn: string) => {
    if (fn === 'set_post_save_state') {
      return {
        data: [saveState],
        error: null,
      };
    }

    throw new Error(`Unexpected RPC: ${fn}`);
  });
  const fromMock = vi.fn((table: string) => {
    if (table !== 'post_save_events') {
      throw new Error(`Unexpected table: ${table}`);
    }

    return { insert: eventInsertMock };
  });

  return {
    client: {
      from: fromMock,
      rpc: rpcMock,
    } as unknown as SupabaseClient,
    eventInsertMock,
    fromMock,
    rpcMock,
  };
}

describe('saveShowcasePostForRoute', () => {
  it('idempotently saves a post, records analytics, and notifies when save state changes', async () => {
    const serviceClient = createServiceClientMock();
    const notifyPostSocialActivity = vi.fn(async () => null);
    const dependencies = {
      findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
        id: 'post-1',
        generation_id: 'gen-1',
        user_id: 'creator-1',
        visibility: 'public' as const,
        category: 'image' as const,
        prompt: null,
        source_kind: 'magicbooklet' as const,
      })),
      isMissingPostsSchemaError: vi.fn(() => false),
      isUserRelationshipBlocked: vi.fn(async () => false),
      notifyPostSocialActivity,
    } satisfies Partial<ShowcaseSaveServiceDependencies>;

    const result = await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        isSaved: true,
        saveCount: 5,
        changed: true,
        message: 'Saved to bookmarks',
      },
    });
    expect(serviceClient.rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_should_save: true,
    });
    expect(serviceClient.eventInsertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      post_id: 'post-1',
      requested_state: true,
      result_state: true,
      changed: true,
      source_surface: 'showcase',
    });
    expect(notifyPostSocialActivity).toHaveBeenCalledWith(serviceClient.client, {
      type: 'post_saved',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it.each([
    ['a block', vi.fn(async () => true)],
    ['an unavailable block lookup', vi.fn(async () => { throw new Error('block lookup failed'); })],
  ])('fails closed before saving or notifying when there is %s', async (_label, isUserRelationshipBlocked) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serviceClient = createServiceClientMock();
    const notifyPostSocialActivity = vi.fn(async () => null);

    const result = await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies: {
        findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
          id: 'post-1',
          generation_id: 'gen-1',
          user_id: 'creator-1',
          visibility: 'public' as const,
          category: 'image' as const,
          prompt: null,
          source_kind: 'magicbooklet' as const,
        })),
        isMissingPostsSchemaError: vi.fn(() => false),
        isUserRelationshipBlocked,
        notifyPostSocialActivity,
      },
    });

    expect(result).toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(serviceClient.eventInsertMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('post save notifications', () => {
  // The real notifier runs here against held notification history: one grouped
  // notification, to the creator whose post was saved. Its key ends in the
  // quarter-hour it was sent in.
  const saveAggregationKey = expect.stringMatching(/^post-social:post_saved:creator-1:post-1:\d+$/);
  const saveNotification = expect.objectContaining({
    user_id: 'creator-1',
    actor_user_id: 'user-1',
    type: 'post_saved',
    category: 'social',
    title: 'Someone saved your post',
    object_id: 'post-1',
    aggregation_key: saveAggregationKey,
  });
  const savedAnswer = {
    ok: true,
    body: {
      success: true,
      isSaved: true,
      saveCount: 5,
      changed: true,
      message: 'Saved to bookmarks',
    },
  };
  const savedEvent = {
    user_id: 'user-1',
    post_id: 'post-1',
    requested_state: true,
    result_state: true,
    changed: true,
    source_surface: 'showcase',
  };

  // Everything but the notifier is stood in for, so the real one runs.
  function createDependencies(isUserRelationshipBlocked = vi.fn(async () => false)) {
    return {
      findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
        id: 'post-1',
        generation_id: 'gen-1',
        user_id: 'creator-1',
        visibility: 'public' as const,
        category: 'image' as const,
        prompt: null,
        source_kind: 'magicbooklet' as const,
      })),
      isMissingPostsSchemaError: vi.fn(() => false),
      isUserRelationshipBlocked,
    } satisfies Partial<ShowcaseSaveServiceDependencies>;
  }

  it('answers a save before the creator is told when the caller can run work after the response', async () => {
    // The notification ends in a push request to Expo for the creator's
    // devices. In production on 2026-10-01, before an account's devices went
    // out in one request, one with 32 held an unlock's answer for 14 s. Here
    // the person waiting on that request is whoever saved.
    const serviceClient = createServiceClientMock();
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const save = saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: withMobileNotificationHistory(serviceClient.client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(),
      runAfterResponse: (task) => { deferred.push(task); },
    });

    // A notification that has not finished no longer holds the answer back,
    // and the save behind that answer is recorded as it always was.
    expect(await hasAnswered(save)).toBe(true);
    await expect(save).resolves.toEqual(savedAnswer);
    expect(serviceClient.rpcMock).toHaveBeenCalledTimes(1);
    expect(serviceClient.eventInsertMock.mock.calls).toEqual([[savedEvent]]);
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    history.release();
    await deferred[0]();
    expect(history.sent).toEqual([saveNotification]);
  });

  it('tells the creator before answering a save when the caller has nowhere to run it afterwards', async () => {
    const serviceClient = createServiceClientMock();
    const history = createMobileNotificationHistory();
    history.hold();

    const save = saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: withMobileNotificationHistory(serviceClient.client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(),
    });

    expect(await hasAnswered(save)).toBe(false);
    expect(history.started).toEqual([saveAggregationKey]);

    history.release();
    await expect(save).resolves.toEqual(savedAnswer);
    expect(serviceClient.eventInsertMock.mock.calls).toEqual([[savedEvent]]);
    expect(history.sent).toEqual([saveNotification]);
  });

  it.each([
    {
      kind: 'an unsave',
      requestedSaveState: false,
      saveState: { is_saved: false, save_count: 4, changed: true },
      isUserRelationshipBlocked: vi.fn(async () => false),
    },
    {
      kind: 'a save that was already in place',
      requestedSaveState: true,
      saveState: { is_saved: true, save_count: 5, changed: false },
      isUserRelationshipBlocked: vi.fn(async () => false),
    },
    {
      kind: 'a save across a block',
      requestedSaveState: true,
      saveState: { is_saved: true, save_count: 5, changed: true },
      isUserRelationshipBlocked: vi.fn(async () => true),
    },
  ])('defers nothing for $kind', async ({ requestedSaveState, saveState, isUserRelationshipBlocked }) => {
    const serviceClient = createServiceClientMock(saveState);
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState,
      serviceClient: withMobileNotificationHistory(serviceClient.client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(isUserRelationshipBlocked),
      runAfterResponse,
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('tells the creator in front of the answer rather than fail a recorded save when the task cannot be queued', async () => {
    const serviceClient = createServiceClientMock();
    const history = createMobileNotificationHistory();
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      // The save is already recorded. A scheduler that will not take the task
      // must not turn that into a failed save.
      await expect(saveShowcasePostForRoute({
        actorUserId: 'user-1',
        referenceId: 'post-1',
        requestedSaveState: true,
        serviceClient: withMobileNotificationHistory(serviceClient.client, history),
        sourceSurface: 'showcase',
        dependencies: createDependencies(),
        runAfterResponse: () => {
          throw new Error('`after` was called outside a request scope.');
        },
      })).resolves.toEqual(savedAnswer);
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual([saveNotification]);
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });
});

describe('named save notifications', () => {
  // Saves were private until the apps began telling people that creators can
  // see who saved. A save names its saver only when the app it came from says
  // so, and the saver has a handle to name.
  const namedSaveNotification = expect.objectContaining({
    user_id: 'creator-1',
    actor_user_id: 'user-1',
    type: 'post_saved',
    category: 'social',
    title: '@maya saved your post',
    body: 'It is in their saved media now.',
    deep_link: '/showcase/post-1',
    object_type: 'post',
    object_id: 'post-1',
    dedupe_key: 'post-save:user-1:post-1',
    aggregation_key: null,
  });
  const unnamedSaveNotification = expect.objectContaining({
    actor_user_id: 'user-1',
    title: 'Someone saved your post',
    aggregation_key: expect.stringMatching(/^post-social:post_saved:creator-1:post-1:\d+$/),
  });

  function createDependencies() {
    return {
      findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
        id: 'post-1',
        generation_id: 'gen-1',
        user_id: 'creator-1',
        visibility: 'public' as const,
        category: 'image' as const,
        prompt: null,
        source_kind: 'magicbooklet' as const,
      })),
      isMissingPostsSchemaError: vi.fn(() => false),
      isUserRelationshipBlocked: vi.fn(async () => false),
    } satisfies Partial<ShowcaseSaveServiceDependencies>;
  }

  /** The service client, with a `profiles` row the saver's handle is read from. */
  function withSaverProfile(answer: { data: unknown; error: unknown } | Error) {
    const serviceClient = createServiceClientMock();
    const lookups: unknown[][] = [];
    const client = {
      from: (table: string) => {
        if (table !== 'profiles') return serviceClient.client.from(table);
        return {
          select: (columns: string) => ({
            eq: (column: string, value: unknown) => {
              lookups.push([columns, column, value]);
              return {
                maybeSingle: async () => {
                  if (answer instanceof Error) throw answer;
                  return answer;
                },
              };
            },
          }),
        };
      },
      rpc: (name: string, args?: Record<string, unknown>) => serviceClient.client.rpc(name, args),
    } as unknown as SupabaseClient;
    return { client, lookups };
  }

  function save(
    client: SupabaseClient,
    history: MobileNotificationHistory,
    options: { creatorSeesSaver?: boolean; actorUserId?: string } = {},
  ) {
    return saveShowcasePostForRoute({
      actorUserId: options.actorUserId ?? 'user-1',
      creatorSeesSaver: options.creatorSeesSaver,
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: withMobileNotificationHistory(client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(),
    });
  }

  it('names the saver to the creator once per post when their app told them', async () => {
    const { client, lookups } = withSaverProfile({ data: { username: 'maya' }, error: null });
    const history = withUniqueDedupeKeys(createMobileNotificationHistory());

    // Saved, taken back and saved again: the second save tells the creator
    // nothing new, as a second follow does not.
    await save(client, history, { creatorSeesSaver: true });
    await save(client, history, { creatorSeesSaver: true });

    expect(history.sent).toEqual([namedSaveNotification]);
    expect(lookups[0]).toEqual(['username', 'id', 'user-1']);
  });

  it.each([{ creatorSeesSaver: false }, { creatorSeesSaver: undefined }])(
    'keeps a save from an app that never said so as "Someone", without reading the saver ($creatorSeesSaver)',
    async ({ creatorSeesSaver }) => {
      const { client, lookups } = withSaverProfile({ data: { username: 'maya' }, error: null });
      const history = createMobileNotificationHistory();

      await save(client, history, { creatorSeesSaver });

      expect(history.sent).toEqual([unnamedSaveNotification]);
      expect(lookups).toEqual([]);
    },
  );

  it.each([
    { kind: 'no handle', answer: { data: { username: null }, error: null }, logs: false },
    { kind: 'a blank handle', answer: { data: { username: '  ' }, error: null }, logs: false },
    { kind: 'no profile row', answer: { data: null, error: null }, logs: false },
    { kind: 'a read that errors', answer: { data: null, error: { message: 'timeout' } }, logs: true },
    { kind: 'a read that throws', answer: new Error('socket hang up'), logs: true },
  ])('falls back to "Someone" for a saver with $kind', async ({ answer, logs }) => {
    const { client } = withSaverProfile(answer);
    const history = createMobileNotificationHistory();
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(save(client, history, { creatorSeesSaver: true })).resolves.toMatchObject({ ok: true });
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual([unnamedSaveNotification]);
    expect(logged.map((record) => record.msg)).toEqual(logs ? ['failed_to_load_saver_username'] : []);
  });

  it('never reads the handle of a creator saving their own post', async () => {
    const { client, lookups } = withSaverProfile({ data: { username: 'maya' }, error: null });
    const history = createMobileNotificationHistory();

    await save(client, history, { creatorSeesSaver: true, actorUserId: 'creator-1' });

    expect(lookups).toEqual([]);
    expect(history.sent).toEqual([]);
  });
});

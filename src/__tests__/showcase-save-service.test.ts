import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createExpoPushService,
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
    // "Someone" keeps no one.
    actor_user_id: null,
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
      kind: 'an unsave that changed nothing',
      requestedSaveState: false,
      saveState: { is_saved: false, save_count: 4, changed: false },
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
    {
      // "Someone saved your post" seconds before the first alert that names
      // them would give the person away.
      kind: 'a save made while its saver is being told',
      requestedSaveState: true,
      saveState: { is_saved: true, save_count: 5, changed: true },
      isUserRelationshipBlocked: vi.fn(async () => false),
      saverNotYetTold: true,
    },
  ])('defers nothing for $kind', async ({ requestedSaveState, saveState, isUserRelationshipBlocked, saverNotYetTold }) => {
    const serviceClient = createServiceClientMock(saveState);
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState,
      saverNotYetTold,
      serviceClient: withMobileNotificationHistory(serviceClient.client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(isUserRelationshipBlocked),
      runAfterResponse,
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('lets an unsave through a block, with nothing left to do behind its answer', async () => {
    // Blocked either way, the post is out of the saver's reach; the save must
    // not outlast the block, and an alert naming them goes with the save.
    const serviceClient = createServiceClientMock({ is_saved: false, save_count: 4, changed: true });
    const history = createMobileNotificationHistory();
    const isUserRelationshipBlocked = vi.fn(async () => true);
    const runAfterResponse = vi.fn();

    await expect(saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: false,
      serviceClient: withMobileNotificationHistory(serviceClient.client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(isUserRelationshipBlocked),
      runAfterResponse,
    })).resolves.toMatchObject({ ok: true, body: { isSaved: false } });

    expect(serviceClient.rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_should_save: false,
    });
    expect(isUserRelationshipBlocked).not.toHaveBeenCalled();
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
  // it told them before they tapped, only once that telling is on record, and
  // only by a handle they chose.
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
    actor_user_id: null,
    title: 'Someone saved your post',
    aggregation_key: expect.stringMatching(/^post-social:post_saved:creator-1:post-1:\d+$/),
  });
  const handleRead = ['username, saver_notice_seen_at', 'id', 'user-1'];
  const toldOn = '2026-10-19T09:00:00.000Z';
  const told = (username: unknown) => ({ data: { username, saver_notice_seen_at: toldOn }, error: null });

  /** History in which the creator's phone takes pushes, with Expo stood in for. */
  function withCreatorPhone() {
    vi.stubGlobal('fetch', createExpoPushService().fetch);
    return createMobileNotificationHistory({ pushTo: { 'creator-1': ['ExponentPushToken[creator-phone]'] } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  type ProfileAnswer = { data: unknown; error: unknown } | Error;
  type SaveState = { is_saved: boolean; save_count: number; changed: boolean };
  const saved: SaveState = { is_saved: true, save_count: 5, changed: true };
  const unsaved: SaveState = { is_saved: false, save_count: 4, changed: true };

  /**
   * The service client, with the `profiles` rows savers' handles are read from
   * and the save states its saves answer, in order (the last one repeats).
   */
  function withSaverProfile(
    answer: ProfileAnswer | ((userId: string) => ProfileAnswer),
    states: SaveState[] = [saved],
  ) {
    const serviceClient = createServiceClientMock();
    const lookups: unknown[][] = [];
    const pending = [...states];
    const client = {
      from: (table: string) => {
        if (table !== 'profiles') return serviceClient.client.from(table);
        return {
          select: (columns: string) => ({
            eq: (column: string, value: unknown) => {
              lookups.push([columns, column, value]);
              return {
                maybeSingle: async () => {
                  const row = typeof answer === 'function' ? answer(String(value)) : answer;
                  if (row instanceof Error) throw row;
                  return row;
                },
              };
            },
          }),
        };
      },
      rpc: async (name: string, args?: Record<string, unknown>) => {
        if (name === 'set_post_save_state') {
          const state = pending.length > 1 ? pending.shift() : pending[0];
          return { data: [state], error: null };
        }
        return serviceClient.client.rpc(name, args);
      },
    } as unknown as SupabaseClient;
    return { client, lookups };
  }

  function save(
    client: SupabaseClient,
    history: MobileNotificationHistory,
    options: {
      creatorSeesSaver?: boolean;
      saverNotYetTold?: boolean;
      actorUserId?: string;
      requestedSaveState?: boolean;
      runAfterResponse?: (task: () => Promise<unknown>) => void;
    } = {},
  ) {
    return saveShowcasePostForRoute({
      actorUserId: options.actorUserId ?? 'user-1',
      creatorSeesSaver: options.creatorSeesSaver,
      saverNotYetTold: options.saverNotYetTold,
      referenceId: 'post-1',
      requestedSaveState: options.requestedSaveState ?? true,
      serviceClient: withMobileNotificationHistory(client, history),
      sourceSurface: 'showcase',
      dependencies: createDependencies(),
      runAfterResponse: options.runAfterResponse,
    });
  }

  it('names the saver to the creator when their app told them before the tap and the telling is on record', async () => {
    const { client, lookups } = withSaverProfile(told('maya'));
    const history = withUniqueDedupeKeys(createMobileNotificationHistory());

    await save(client, history, { creatorSeesSaver: true });

    expect(history.sent).toEqual([namedSaveNotification]);
    expect(lookups).toEqual([handleRead]);
    expect(history.preferenceReads).toEqual(['creator-1']);
  });

  it('takes the named alert away with the save, and writes it anew at the next save', async () => {
    const { client } = withSaverProfile(told('maya'), [saved, unsaved, saved]);
    const history = withUniqueDedupeKeys(withCreatorPhone());
    const runAfterResponse = vi.fn();

    await save(client, history, { creatorSeesSaver: true });
    // The unsave carries no flag, and leaves nothing to do behind its answer:
    // deleting the save deletes the alert, whichever app wrote it.
    await save(client, history, { requestedSaveState: false, runAfterResponse });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect([...history.removedRows]).toEqual([0]);
    expect(history.standing()).toEqual([]);

    await save(client, history, { creatorSeesSaver: true });

    expect(history.sent).toEqual([namedSaveNotification, namedSaveNotification]);
    expect(history.standing()).toEqual([namedSaveNotification]);
    // The alert written anew waits in Alerts: the creator's phone has heard
    // about this post's saves once this quarter-hour already.
    expect(history.pushClaims).toEqual([
      { key: 'creator-1:post-1', allowed: true },
      { key: 'creator-1:post-1', allowed: false },
    ]);
    expect(history.pushed.map((push) => push.title)).toEqual(['@maya saved your post']);
  });

  it("pushes one post's saves once a quarter-hour, however many people they name", async () => {
    const { client } = withSaverProfile((userId) => told(userId === 'user-1' ? 'maya' : 'lee'));
    const history = withUniqueDedupeKeys(withCreatorPhone());

    await save(client, history, { creatorSeesSaver: true });
    await save(client, history, { creatorSeesSaver: true, actorUserId: 'user-2' });

    expect(history.sent.map((row) => [row.title, row.dedupe_key])).toEqual([
      ['@maya saved your post', 'post-save:user-1:post-1'],
      ['@lee saved your post', 'post-save:user-2:post-1'],
    ]);
    expect(history.pushClaims).toEqual([
      { key: 'creator-1:post-1', allowed: true },
      { key: 'creator-1:post-1', allowed: false },
    ]);
    expect(history.pushed.map((push) => push.title)).toEqual(['@maya saved your post']);
  });

  it("answers before the saver's handle is read, and names them behind the answer", async () => {
    const { client, lookups } = withSaverProfile(told('maya'));
    const history = createMobileNotificationHistory();
    const deferred: Array<() => Promise<unknown>> = [];

    const answer = save(client, history, {
      creatorSeesSaver: true,
      runAfterResponse: (task) => { deferred.push(task); },
    });

    expect(await hasAnswered(answer)).toBe(true);
    expect(lookups).toEqual([]);
    expect(history.sent).toEqual([]);

    await deferred[0]();
    expect(lookups).toEqual([handleRead]);
    expect(history.sent).toEqual([namedSaveNotification]);
  });

  it('writes no named alert once an unsave answered first has taken the save away', async () => {
    // The save's alert is written behind its answer; the unsave that followed
    // was answered, and its save gone, before that ran.
    const { client } = withSaverProfile(told('maya'), [saved, unsaved]);
    const history = withCreatorPhone();
    const deferred: Array<() => Promise<unknown>> = [];
    const runAfterResponse = (task: () => Promise<unknown>) => { deferred.push(task); };

    await save(client, history, { creatorSeesSaver: true, runAfterResponse });
    await save(client, history, { requestedSaveState: false, runAfterResponse });
    // Only the save left work behind its answer.
    expect(deferred).toHaveLength(1);
    await deferred[0]();

    expect(history.sent).toEqual([]);
    expect(history.pushClaims).toEqual([]);
    expect(history.pushed).toEqual([]);
  });

  it("leaves nothing behind the answer to an unsave, of another's post or the creator's own", async () => {
    const { client } = withSaverProfile(told('maya'), [unsaved]);
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await expect(save(client, history, { requestedSaveState: false, runAfterResponse }))
      .resolves.toMatchObject({ ok: true, body: { isSaved: false, changed: true } });
    await save(client, history, { requestedSaveState: false, runAfterResponse, actorUserId: 'creator-1' });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it.each([{ creatorSeesSaver: false }, { creatorSeesSaver: undefined }])(
    'keeps a save from an app that never said so as "Someone", without reading the saver ($creatorSeesSaver)',
    async ({ creatorSeesSaver }) => {
      const { client, lookups } = withSaverProfile(told('maya'));
      const history = createMobileNotificationHistory();

      await save(client, history, { creatorSeesSaver });

      expect(history.sent).toEqual([unnamedSaveNotification]);
      expect(lookups).toEqual([]);
    },
  );

  it('tells the creator nothing of a save made while its saver is being told, whatever else it says', async () => {
    const { client, lookups } = withSaverProfile(told('maya'));
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await save(client, history, { saverNotYetTold: true, creatorSeesSaver: true, runAfterResponse });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
    expect(history.sent).toEqual([]);
  });

  it.each([
    // Every account starts with a generated handle it never chose.
    { kind: 'only the generated placeholder handle', answer: told('creator-1a2b3c4d'), logs: false },
    // The app says it told them, but no telling is on record for the account.
    { kind: 'no telling on record', answer: { data: { username: 'maya', saver_notice_seen_at: null }, error: null }, logs: false },
    { kind: 'no handle', answer: told(null), logs: false },
    { kind: 'a blank handle', answer: told('  '), logs: false },
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
    expect(logged.map((record) => record.msg)).toEqual(logs ? ['failed_to_load_alert_profile'] : []);
  });

  it('never reads the handle of a creator saving their own post', async () => {
    const { client, lookups } = withSaverProfile(told('maya'));
    const history = createMobileNotificationHistory();

    await save(client, history, { creatorSeesSaver: true, actorUserId: 'creator-1' });

    expect(lookups).toEqual([]);
    expect(history.sent).toEqual([]);
  });
});

describe('an unsave of a post that has left public view', () => {
  // Made unlisted, private or archived since it was saved: the public lookup
  // no longer finds it. The save is the saver's own row, and taking it off
  // (which takes any alert naming them with it) must not wait for the post.
  const POST_ID = '7d3f2a10-5b8c-4e61-9a2f-0c1d2e3f4a5b';

  function createClient(ownSave: 'held' | 'none' | 'unreadable') {
    const saveLookups: unknown[][] = [];
    const rpcMock = vi.fn(async (name: string) => {
      if (name === 'set_post_save_state') return { data: [{ is_saved: false, save_count: 3, changed: true }], error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const fromMock = vi.fn((table: string) => {
      if (table === 'post_save_events') return { insert: async () => ({ data: null, error: null }) };
      if (table !== 'post_saves') throw new Error(`Unexpected table: ${table}`);

      const calls: unknown[] = [];
      saveLookups.push(calls);
      const query = {
        select(columns: string) {
          calls.push(['select', columns]);
          return query;
        },
        eq(column: string, value: unknown) {
          calls.push(['eq', column, value]);
          return query;
        },
        async maybeSingle() {
          if (ownSave === 'unreadable') return { data: null, error: { message: 'statement timeout' } };
          return { data: ownSave === 'held' ? { post_id: POST_ID } : null, error: null };
        },
      };
      return query;
    });
    return { client: { from: fromMock, rpc: rpcMock } as unknown as SupabaseClient, rpcMock, fromMock, saveLookups };
  }

  function takeOff(
    client: SupabaseClient,
    { referenceId = POST_ID, requestedSaveState = false }: { referenceId?: string; requestedSaveState?: boolean | null } = {},
  ) {
    const notifyPostSocialActivity = vi.fn(async () => null);
    const findPublicPostReferenceByIdOrGenerationId = vi.fn(async () => null);
    const result = saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId,
      requestedSaveState,
      serviceClient: client,
      sourceSurface: 'saved-media',
      dependencies: {
        findPublicPostReferenceByIdOrGenerationId,
        isMissingPostsSchemaError: vi.fn(() => false),
        isUserRelationshipBlocked: vi.fn(async () => false),
        notifyPostSocialActivity,
      },
    });
    return { result, notifyPostSocialActivity, findPublicPostReferenceByIdOrGenerationId };
  }

  it("takes the save off, found through the saver's own save of it", async () => {
    const { client, rpcMock, saveLookups } = createClient('held');
    const { result, notifyPostSocialActivity, findPublicPostReferenceByIdOrGenerationId } = takeOff(client);

    await expect(result).resolves.toEqual({
      ok: true,
      body: { success: true, isSaved: false, saveCount: 3, changed: true, message: 'Removed from bookmarks' },
    });
    expect(findPublicPostReferenceByIdOrGenerationId).toHaveBeenCalledWith(POST_ID);
    // Only this account's save of that post can be found this way.
    expect(saveLookups).toEqual([[
      ['select', 'post_id'],
      ['eq', 'user_id', 'user-1'],
      ['eq', 'post_id', POST_ID],
    ]]);
    expect(rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: POST_ID,
      p_user_id: 'user-1',
      p_should_save: false,
    });
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('answers not found when the account holds no save of it', async () => {
    const { client, rpcMock, saveLookups } = createClient('none');

    await expect(takeOff(client).result).resolves.toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    expect(saveLookups).toHaveLength(1);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('asks nothing of the saves for an id that is not a post id', async () => {
    const { client, rpcMock, fromMock } = createClient('held');

    for (const referenceId of ['post-1', 'gen-1', `${POST_ID}'`, ` ${POST_ID}`]) {
      await expect(takeOff(client, { referenceId }).result)
        .resolves.toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    }
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('looks for no save of its own for a save, or a toggle, of a post out of public view', async () => {
    const { client, rpcMock, fromMock } = createClient('held');

    for (const requestedSaveState of [true, null]) {
      await expect(takeOff(client, { requestedSaveState }).result)
        .resolves.toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    }
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('answers not found, and logs, when its save cannot be read', async () => {
    const { client, rpcMock } = createClient('unreadable');
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(takeOff(client).result).resolves.toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    } finally {
      restoreLogSink();
    }

    expect(logged.map((record) => record.msg)).toEqual(['failed_to_find_own_saved_post']);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

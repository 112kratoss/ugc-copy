import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  getVideoGenerationStatusForRoute,
  type VideoGenerationStatusDependencies,
} from '@/lib/video-generation-status-service';

function createStatusClientMock(
  overrides: Record<string, unknown> = {},
  linkedGuestIds: string[] = [],
) {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value?: unknown; values?: unknown[] }> = [];
  const generation = {
    id: 'gen-video-1',
    prediction_id: 'task-video-1',
    user_id: 'user-1',
    status: 'succeeded',
    output_url: 'generated_videos/user-1/generated_task-video-1.mp4',
    created_at: '2026-04-15T10:00:00.000Z',
    completed_at: '2026-04-15T10:01:00.000Z',
    model: 'kling-3.0-video',
    category: 'video',
    creation_mode: null,
    workflow_settings: null,
    duration: 5,
    ...overrides,
  };
  const createSignedUrl = vi.fn(async (path: string) => ({
    data: { signedUrl: `signed:${path}` },
    error: null,
  }));
  const storageFrom = vi.fn(() => ({ createSignedUrl }));

  const client = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq: vi.fn(async () => ({
                data: linkedGuestIds.map((id) => ({ id })),
                error: null,
              })),
            };
          },
        };
      }
      if (table !== 'generations') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        select(columns = '') {
          selects.push(columns);
          const filters: Record<string, unknown> = {};
          const query = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              eqs.push({ column, value });
              return query;
            },
            in(column: string, values: unknown[]) {
              filters[column] = values;
              eqs.push({ column, values });
              return query;
            },
            single() {
              if (
                filters.prediction_id === generation.prediction_id
                && (Array.isArray(filters.user_id)
                  ? filters.user_id.includes(generation.user_id)
                  : filters.user_id === generation.user_id)
              ) {
                return Promise.resolve({ data: generation, error: null });
              }

              return Promise.resolve({ data: null, error: null });
            },
          };

          return query;
        },
      };
    },
    storage: { from: storageFrom },
  };

  return {
    client: client as unknown as SupabaseClient,
    selects,
    eqs,
    createSignedUrl,
    storageFrom,
  };
}

describe('getVideoGenerationStatusForRoute', () => {

  it.each(['empty', 'malformed', 'veo-empty'])('keeps an incomplete %s provider success retryable', async (shape) => {
    const admin = createStatusClientMock({
      status: 'processing', output_url: null, completed_at: null,
      ...(shape === 'veo-empty' ? { model: 'veo3', workflow_settings: { model: 'veo-3.1' } } : {}),
    });
    const enqueue = vi.fn().mockResolvedValue('import-job');
    const notify = vi.fn();
    const result = await getVideoGenerationStatusForRoute({
      request: new Request('http://localhost/api/status'), predictionId: 'task-video-1', userId: 'user-1',
      supabase: admin.client,
      createAdminSupabase: () => admin.client, kieApiKey: 'test-key',
      dependencies: {
        withBackendJobLock: async (_client, _options, task) => ({ acquired: true, value: await task() }),
        tryAcquireGenerationProviderStatusThrottle: async () => true,
        fetchWithProviderTimeout: vi.fn().mockResolvedValue(new Response(JSON.stringify({
          code: 200,
          data: shape === 'veo-empty'
            ? { successFlag: 1, response: { resultUrls: [] } }
            : { state: 'success', resultJson: shape === 'malformed' ? '{broken' : '{"resultUrls":[]}' },
        }), { status: 200 })),
        enqueueGenerationOutputImportJob: enqueue,
        notifyGenerationStatus: notify,
      },
    });
    expect(result).toMatchObject({ ok: true, body: mobileApiContract.endpoints.getVideoGeneration.responseVariants.outputPending });
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('returns cached succeeded output from storage without polling the provider', async () => {
    const userClient = createStatusClientMock();
    const adminClient = createStatusClientMock();
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async () => 'signed:video-url'),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<VideoGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient.client);

    const result = await getVideoGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-video?id=task-video-1'),
      predictionId: 'task-video-1',
      userId: 'user-1',
      supabase: userClient.client,
      createAdminSupabase,
      kieApiKey: 'test-key',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        status: 'succeeded',
        output: 'signed:video-url',
        timing: expect.objectContaining({
          appStatus: 'succeeded',
          completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
        }),
      },
    });
    // The lookup must run service-role: `authenticated` cannot SELECT output_url,
    // model, completed_at or workflow_settings, so reading it as the user denies
    // the row and the caller reports a phantom "Generation not found".
    expect(adminClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration, error_message',
    ]);
    expect(adminClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-video-1' },
      { column: 'user_id', values: ['user-1'] },
    ]);
    expect(userClient.selects).toEqual([]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledWith(
      adminClient.client,
      'generated_videos/user-1/generated_task-video-1.mp4',
      'user-1',
    );
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });

  it('authorizes a linked guest row but refuses an encoded foreign-owner path', async () => {
    const userClient = createStatusClientMock();
    const adminClient = createStatusClientMock({
      user_id: 'guest-1',
      output_url: 'generated_videos/guest-1%252f..%252fvictim/private.mp4',
    }, ['guest-1']);

    const result = await getVideoGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-video?id=task-video-1'),
      predictionId: 'task-video-1',
      userId: 'user-1',
      supabase: userClient.client,
      createAdminSupabase: () => adminClient.client,
      kieApiKey: 'test-key',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        status: 'succeeded',
        output: null,
        timing: expect.objectContaining({ appStatus: 'succeeded' }),
      },
    });
    expect(adminClient.eqs).toContainEqual({
      column: 'user_id',
      values: ['user-1', 'guest-1'],
    });
    expect(adminClient.storageFrom).not.toHaveBeenCalled();
  });

  it('rejects a motion generation before reading output or polling the provider', async () => {
    const userClient = createStatusClientMock({ creation_mode: 'motion' });
    const adminClient = createStatusClientMock({ creation_mode: 'motion' });
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<VideoGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient.client);

    const result = await getVideoGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-video?id=task-video-1'),
      predictionId: 'task-video-1',
      userId: 'user-1',
      supabase: userClient.client,
      createAdminSupabase,
      kieApiKey: 'test-key',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Generation not found' },
    });
    // Only the ownership/kind lookup runs; the rejection still happens before any
    // media resolution or provider poll, which is what this test guards.
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).not.toHaveBeenCalled();
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });
});

describe('video generation failure notifications', () => {
  // A poll that finds the provider failed the task settles the failure, then
  // tells the creator's own devices. The real notifier runs here against held
  // notification history.
  type RunAfterResponse = Parameters<typeof getVideoGenerationStatusForRoute>[0]['runAfterResponse'];

  const failedDedupeKey = 'generation:gen-video-1:failed';
  const failedNotification = expect.objectContaining({
    user_id: 'user-1',
    type: 'generation_failed',
    category: 'generation',
    title: 'Your video failed',
    object_id: 'gen-video-1',
    dedupe_key: failedDedupeKey,
  });
  const failedAnswer = {
    ok: true,
    body: {
      status: 'failed',
      output: null,
      error: 'provider failure',
      timing: expect.objectContaining({
        appStatus: 'failed',
        completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
      }),
    },
  };
  // The two provider APIs a video task can be on report a failure differently,
  // and each has its own branch in the status check.
  const failures = [
    {
      provider: 'Kling',
      generation: {},
      task: {
        state: 'fail',
        completeTime: '2026-04-15T10:01:00.000Z',
        failMsg: 'provider failure',
      },
    },
    {
      provider: 'Veo',
      generation: { model: 'veo3', workflow_settings: { model: 'veo-3.1' } },
      task: {
        successFlag: 2,
        completeTime: '2026-04-15T10:01:00.000Z',
        errorMessage: 'provider failure',
      },
    },
  ];

  function createPoll({
    generation = {},
    task = failures[0].task,
    settled = 'failed',
  }: {
    generation?: Record<string, unknown>;
    task?: Record<string, unknown>;
    settled?: 'failed' | 'succeeded';
  } = {}) {
    const admin = createStatusClientMock({
      status: 'processing',
      output_url: null,
      completed_at: null,
      ...generation,
    });
    const history = createMobileNotificationHistory();
    const adminSupabase = withMobileNotificationHistory(admin.client, history);
    const settleGenerationFailed = vi.fn<VideoGenerationStatusDependencies['settleGenerationFailed']>(
      async () => settled,
    );
    const enqueueGenerationOutputImportJob = vi.fn<
      VideoGenerationStatusDependencies['enqueueGenerationOutputImportJob']
    >(async () => 'import-job');

    return {
      history,
      adminSupabase,
      settleGenerationFailed,
      enqueueGenerationOutputImportJob,
      poll: (runAfterResponse?: RunAfterResponse) => getVideoGenerationStatusForRoute({
        request: new Request('http://localhost/api/generate-video?id=task-video-1'),
        predictionId: 'task-video-1',
        userId: 'user-1',
        supabase: admin.client,
        createAdminSupabase: () => adminSupabase,
        kieApiKey: 'test-key',
        runAfterResponse,
        dependencies: {
          withBackendJobLock: async (_client, _options, run) => ({ acquired: true, value: await run() }),
          tryAcquireGenerationProviderStatusThrottle: async () => true,
          fetchWithProviderTimeout: async () => Response.json({ code: 200, data: task }),
          enqueueGenerationOutputImportJob,
          settleGenerationFailed,
        },
      }),
    };
  }

  it.each(failures)(
    'answers a poll that finds a $provider failure before the creator is told when the caller can run work after the response',
    async ({ generation, task }) => {
      // The notification ends in a push request to Expo for the creator's
      // devices: five seconds a try, up to three tries. A poll that waited on
      // it kept the app showing a video as still rendering after its failure
      // was settled and its credits returned.
      const { history, adminSupabase, settleGenerationFailed, poll } = createPoll({ generation, task });
      history.hold();
      const deferred: Array<() => Promise<unknown>> = [];

      const request = poll((queued) => { deferred.push(queued); });

      // A notification that has not finished no longer holds the answer back,
      // and the failure behind that answer is settled as it always was.
      expect(await hasAnswered(request)).toBe(true);
      await expect(request).resolves.toEqual(failedAnswer);
      expect(settleGenerationFailed).toHaveBeenCalledTimes(1);
      expect(settleGenerationFailed).toHaveBeenCalledWith(
        adminSupabase,
        'task-video-1',
        '2026-04-15T10:01:00.000Z',
        'provider failure',
      );
      expect(history.started).toEqual([]);
      expect(deferred).toHaveLength(1);

      history.release();
      await deferred[0]();
      expect(history.sent).toEqual([failedNotification]);
    },
  );

  it.each(failures)(
    'tells the creator before answering a poll that finds a $provider failure when the caller has nowhere to run it afterwards',
    async ({ generation, task }) => {
      const { history, settleGenerationFailed, poll } = createPoll({ generation, task });
      history.hold();

      const request = poll();

      expect(await hasAnswered(request)).toBe(false);
      expect(history.started).toEqual([failedDedupeKey]);

      history.release();
      await expect(request).resolves.toEqual(failedAnswer);
      expect(settleGenerationFailed).toHaveBeenCalledTimes(1);
      expect(history.sent).toEqual([failedNotification]);
    },
  );

  it.each(failures)(
    'gives a poll that finds a $provider failure the same answer whether or not its notification waits for the response',
    async ({ generation, task }) => {
      const awaited = await createPoll({ generation, task }).poll();
      const deferred = await createPoll({ generation, task }).poll(() => {});

      expect(awaited).toEqual(failedAnswer);
      expect(deferred).toStrictEqual(awaited);
    },
  );

  it('tells the creator in front of the answer rather than fail a settled poll when the task cannot be queued', async () => {
    const { history, poll } = createPoll();
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      // The failure is already settled. A scheduler that will not take the
      // task must not turn that into a failed poll.
      await expect(poll(() => {
        throw new Error('`after` was called outside a request scope.');
      })).resolves.toEqual(failedAnswer);
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual([failedNotification]);
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });

  // The app polls for as long as a video renders, so a poll with nothing to
  // tell anyone must hand the scheduler nothing.
  it.each([
    {
      found: 'the video still rendering',
      task: { state: 'generating' },
      settled: 'failed' as const,
      answer: { status: 'processing', output: null, error: null },
    },
    {
      found: 'the video finished and waiting on its import',
      task: {
        state: 'success',
        completeTime: '2026-04-15T10:01:00.000Z',
        resultJson: JSON.stringify({ resultUrls: ['https://provider.example.com/output.mp4'] }),
      },
      settled: 'failed' as const,
      answer: { status: 'processing', output: null, error: null },
    },
    {
      // Its success was settled first, so there is no failure to report.
      found: 'a failure the settlement turned down',
      task: failures[0].task,
      settled: 'succeeded' as const,
      answer: { status: 'succeeded', output: null, error: 'provider failure' },
    },
  ])('defers nothing for a poll that finds $found', async ({ task, settled, answer }) => {
    const { history, poll } = createPoll({ task, settled });
    const runAfterResponse = vi.fn();

    await expect(poll(runAfterResponse)).resolves.toMatchObject({ ok: true, body: answer });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('queues nothing when the failure could not be settled', async () => {
    // Telling the creator comes second. A failure that was not recorded, with
    // its credits not returned, must not be announced.
    const { history, settleGenerationFailed, poll } = createPoll();
    settleGenerationFailed.mockRejectedValueOnce(new Error('settlement unavailable'));
    const runAfterResponse = vi.fn();

    await expect(poll(runAfterResponse)).rejects.toThrow('settlement unavailable');

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('defers nothing for a poll that finds the failure already settled', async () => {
    // The webhook usually settles a failure seconds before the app next polls.
    const { history, settleGenerationFailed, poll } = createPoll({
      generation: {
        status: 'failed',
        completed_at: '2026-04-15T10:01:00.000Z',
        error_message: 'provider failure',
      },
    });
    const runAfterResponse = vi.fn();

    await expect(poll(runAfterResponse)).resolves.toEqual(failedAnswer);

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(settleGenerationFailed).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });
});

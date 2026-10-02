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
  getImageGenerationStatusForRoute,
  type ImageGenerationStatusDependencies,
} from '@/lib/image-generation-status-service';

function createStatusClientMock(
  overrides: Record<string, unknown> = {},
  linkedGuestIds: string[] = [],
) {
  const selects: string[] = [];
  // `value` for eq(), `values` for the linked-owner in() filter.
  const eqs: Array<{ column: string; value?: unknown; values?: unknown[] }> = [];
  const generation = {
    id: 'gen-image-1',
    prediction_id: 'task-image-1',
    user_id: 'user-1',
    status: 'succeeded',
    output_url: 'generated_images/user-1/generated_task-image-1.png',
    created_at: '2026-04-15T10:00:00.000Z',
    completed_at: '2026-04-15T10:01:00.000Z',
    model: 'grok-imagine-image',
    category: 'image',
    workflow_settings: {
      outputs: [
        { storagePath: 'generated_images/user-1/output-1.png' },
        { storagePath: 'generated_images/user-1/output-2.png' },
      ],
    },
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
                // The owner filter is now `in` over the linked-account set, so
                // it arrives as an array. Accept either shape so the mock keeps
                // describing ownership rather than a specific query operator.
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

describe('getImageGenerationStatusForRoute', () => {

  it.each(['empty', 'malformed'])('keeps an incomplete %s provider success retryable', async (shape) => {
    const admin = createStatusClientMock({
      status: 'processing', output_url: null, completed_at: null,
      ...(shape === 'veo-empty' ? { model: 'veo3', workflow_settings: { model: 'veo-3.1' } } : {}),
    });
    const settle = vi.fn().mockResolvedValue('succeeded');
    const notify = vi.fn();
    const result = await getImageGenerationStatusForRoute({
      request: new Request('http://localhost/api/status'), predictionId: 'task-image-1', userId: 'user-1',

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

        notifyGenerationStatus: notify,
      },
    });
    expect(result).toMatchObject({ ok: true, body: mobileApiContract.endpoints.getImageGeneration.responseVariants.outputPending });
    expect(settle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('returns cached succeeded output and persisted output list without polling the provider', async () => {
    const adminClient = createStatusClientMock();
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async (_client, value: string) => `signed:${value}`),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<ImageGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient.client);

    const result = await getImageGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
      predictionId: 'task-image-1',
      userId: 'user-1',
      createAdminSupabase,
      kieApiKey: 'test-key',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        status: 'succeeded',
        output: 'signed:generated_images/user-1/generated_task-image-1.png',
        outputs: [
          'signed:generated_images/user-1/output-1.png',
          'signed:generated_images/user-1/output-2.png',
        ],
        timing: expect.objectContaining({
          appStatus: 'succeeded',
          completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
        }),
      },
    });
    // The lookup must run service-role: `authenticated` cannot SELECT output_url,
    // model, completed_at or workflow_settings, so reading it as the user denies
    // the row and the caller reports a phantom "Generation not found". The
    // service no longer accepts a user client at all, so this is now enforced by
    // the signature rather than by convention.
    expect(adminClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings, error_message',
    ]);
    expect(adminClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-image-1' },
      // Owner scoping is `in` over the linked-account set: a generation started
      // before the person registered keeps its guest UUID, so an `eq` here would
      // 404 their own in-flight work the moment they signed up.
      { column: 'user_id', values: ['user-1'] },
    ]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledTimes(3);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenNthCalledWith(
      1,
      adminClient.client,
      'generated_images/user-1/output-1.png',
      'user-1',
    );
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenNthCalledWith(
      3,
      adminClient.client,
      'generated_images/user-1/generated_task-image-1.png',
      'user-1',
    );
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });

  it('authorizes a linked guest row but refuses its encoded foreign-owner paths', async () => {
    const adminClient = createStatusClientMock({
      user_id: 'guest-1',
      output_url: 'generated_images/guest-1%252f..%252fvictim/private.png',
      workflow_settings: {
        outputs: [{ storagePath: 'generated_images/victim/private-2.png' }],
      },
    }, ['guest-1']);

    const result = await getImageGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
      predictionId: 'task-image-1',
      userId: 'user-1',
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
});

describe('image generation failure notifications', () => {
  // A poll that finds the provider failed the task settles the failure, then
  // tells the creator's own devices. The real notifier runs here against held
  // notification history.
  type RunAfterResponse = Parameters<typeof getImageGenerationStatusForRoute>[0]['runAfterResponse'];

  const failedDedupeKey = 'generation:gen-image-1:failed';
  const failedNotification = expect.objectContaining({
    user_id: 'user-1',
    type: 'generation_failed',
    category: 'generation',
    title: 'Your image failed',
    object_id: 'gen-image-1',
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
  const failedTask = {
    state: 'fail',
    completeTime: '2026-04-15T10:01:00.000Z',
    failMsg: 'provider failure',
  };

  function createPoll({
    generation = {},
    task = failedTask,
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
      model: 'nano-banana-2',
      workflow_settings: null,
      ...generation,
    });
    const history = createMobileNotificationHistory();
    const adminSupabase = withMobileNotificationHistory(admin.client, history);
    const settleGenerationFailed = vi.fn<ImageGenerationStatusDependencies['settleGenerationFailed']>(
      async () => settled,
    );
    const enqueueGenerationOutputImportJob = vi.fn<
      ImageGenerationStatusDependencies['enqueueGenerationOutputImportJob']
    >(async () => 'import-job');

    return {
      history,
      adminSupabase,
      settleGenerationFailed,
      enqueueGenerationOutputImportJob,
      poll: (runAfterResponse?: RunAfterResponse) => getImageGenerationStatusForRoute({
        request: new Request('http://localhost/api/generate-image?id=task-image-1'),
        predictionId: 'task-image-1',
        userId: 'user-1',
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

  it('answers a failed poll before the creator is told when the caller can run work after the response', async () => {
    // The notification ends in a push request to Expo for the creator's
    // devices: five seconds a try, up to three tries. A poll that waited on it
    // kept the app showing an image as still rendering after its failure was
    // settled and its credits returned.
    const { history, adminSupabase, settleGenerationFailed, poll } = createPoll();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const request = poll((task) => { deferred.push(task); });

    // A notification that has not finished no longer holds the answer back,
    // and the failure behind that answer is settled as it always was.
    expect(await hasAnswered(request)).toBe(true);
    await expect(request).resolves.toEqual(failedAnswer);
    expect(settleGenerationFailed).toHaveBeenCalledTimes(1);
    expect(settleGenerationFailed).toHaveBeenCalledWith(
      adminSupabase,
      'task-image-1',
      '2026-04-15T10:01:00.000Z',
      'provider failure',
    );
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    history.release();
    await deferred[0]();
    expect(history.sent).toEqual([failedNotification]);
  });

  it('tells the creator before answering a failed poll when the caller has nowhere to run it afterwards', async () => {
    const { history, settleGenerationFailed, poll } = createPoll();
    history.hold();

    const request = poll();

    expect(await hasAnswered(request)).toBe(false);
    expect(history.started).toEqual([failedDedupeKey]);

    history.release();
    await expect(request).resolves.toEqual(failedAnswer);
    expect(settleGenerationFailed).toHaveBeenCalledTimes(1);
    expect(history.sent).toEqual([failedNotification]);
  });

  it('gives a failed poll the same answer whether or not its notification waits for the response', async () => {
    const awaited = await createPoll().poll();
    const deferred = await createPoll().poll(() => {});

    expect(awaited).toEqual(failedAnswer);
    expect(deferred).toStrictEqual(awaited);
  });

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

  // The app polls for as long as an image renders, so a poll with nothing to
  // tell anyone must hand the scheduler nothing.
  it.each([
    {
      found: 'the image still rendering',
      task: { state: 'generating' },
      settled: 'failed' as const,
      settlements: 0,
      answer: { status: 'processing', output: null, error: null },
    },
    {
      found: 'the image finished and waiting on its import',
      task: {
        state: 'success',
        completeTime: '2026-04-15T10:01:00.000Z',
        resultJson: JSON.stringify({ resultUrls: ['https://provider.example.com/output.png'] }),
      },
      settled: 'failed' as const,
      settlements: 0,
      answer: { status: 'processing', output: null, error: null },
    },
    {
      // Its success was settled first, so there is no failure to report.
      found: 'a failure the settlement turned down',
      task: failedTask,
      settled: 'succeeded' as const,
      settlements: 1,
      answer: { status: 'succeeded', output: null, error: 'provider failure' },
    },
  ])('defers nothing for a poll that finds $found', async ({ task, settled, settlements, answer }) => {
    const { history, settleGenerationFailed, poll } = createPoll({ task, settled });
    const runAfterResponse = vi.fn();

    await expect(poll(runAfterResponse)).resolves.toMatchObject({ ok: true, body: answer });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(settleGenerationFailed).toHaveBeenCalledTimes(settlements);
    expect(history.started).toEqual([]);
  });

  it('tells the creator nothing about a failure the settlement turned down when the caller has nowhere to run it afterwards', async () => {
    // The provider reports a failure for an image whose success was settled
    // first. The settlement keeps the success and the poll answers with it, so
    // "Your image failed" would contradict the answer it was sent beside.
    const { history, adminSupabase, settleGenerationFailed, poll } = createPoll({ settled: 'succeeded' });

    await expect(poll()).resolves.toMatchObject({
      ok: true,
      body: { status: 'succeeded', output: null, error: 'provider failure' },
    });

    // The settlement was still asked, exactly as for any provider failure.
    expect(settleGenerationFailed).toHaveBeenCalledTimes(1);
    expect(settleGenerationFailed).toHaveBeenCalledWith(
      adminSupabase,
      'task-image-1',
      '2026-04-15T10:01:00.000Z',
      'provider failure',
    );
    expect(history.started).toEqual([]);
    expect(history.sent).toEqual([]);
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

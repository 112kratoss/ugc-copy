import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchGenerationStatus } from '@/lib/generation-status-client';
import { createStoredRows } from './fixtures/stored-rows';

/**
 * A queued run, followed the way every client follows it: by polling a status
 * route with the id its start answered. The handle's own logic is covered in
 * generation-run-handle.test.ts; this is the three routes around it, with the
 * real lookup, from the queued answer through to the status service being
 * given the provider's task id once the run has one.
 */

const mocks = vi.hoisted(() => ({
  status: {
    image: vi.fn(),
    video: vi.fn(),
    motion: vi.fn(),
  },
  readQueued: vi.fn(),
  countAhead: vi.fn(),
  drive: vi.fn(async (..._args: unknown[]) => ({ sent: 0, queued: 1, gone: 0, expired: 0, failed: 0 })),
}));

vi.mock('@/lib/image-generation-status-service', () => ({
  getImageGenerationStatusForRoute: (...args: unknown[]) => mocks.status.image(...args),
}));
vi.mock('@/lib/video-generation-status-service', () => ({
  getVideoGenerationStatusForRoute: (...args: unknown[]) => mocks.status.video(...args),
}));
vi.mock('@/lib/motion-generation-status-service', () => ({
  getMotionGenerationStatusForRoute: (...args: unknown[]) => mocks.status.motion(...args),
}));
vi.mock('@/lib/generation-submission-queue-store', () => ({
  readQueuedProviderSubmission: (...args: unknown[]) => mocks.readQueued(...args),
  countQueuedProviderSubmissionsAhead: (...args: unknown[]) => mocks.countAhead(...args),
}));
vi.mock('@/lib/generation-submission-queue', () => ({
  driveQueuedSubmissions: (...args: unknown[]) => mocks.drive(...args),
}));
vi.mock('@/lib/account-identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/account-identity')>(),
  resolveLinkedAccountIds: async (_client: unknown, userId: string) => [userId],
}));

const HANDLE = '6a0c7f2e-4d1b-4f6a-9c3e-2b8d5e7f9a10';
const TASK_ID = '582fa1827ca37b5d621536962040a8cd';

const ROUTES = [
  { kind: 'image', path: '/api/generate-image', load: async () => (await import('@/lib/image-generation-route-service')).getImageGenerationForRoute },
  { kind: 'video', path: '/api/generate-video', load: async () => (await import('@/lib/video-generation-route-service')).getVideoGenerationForRoute },
  { kind: 'motion', path: '/api/generate', load: async () => (await import('@/lib/motion-generation-route-service')).getMotionGenerationForRoute },
] as const;

function generation(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    id: HANDLE,
    user_id: 'user-1',
    prediction_id: null,
    status: 'pending',
    category: kind,
    model: 'a-model',
    created_at: '2026-11-15T10:00:00.000+00:00',
    completed_at: null,
    error_message: null,
    ...overrides,
  };
}

type RouteResult = { ok: boolean; status?: number; body: Record<string, unknown> };

async function poll(route: typeof ROUTES[number], rows: Array<Record<string, unknown>>, options: {
  id?: string;
  userId?: string;
  later?: Array<() => Promise<unknown>>;
} = {}): Promise<RouteResult> {
  const { client } = createStoredRows({ generations: rows });
  const user = { id: options.userId ?? 'user-1' };
  const get = await route.load();
  return await get({
    request: new Request(`http://localhost${route.path}?id=${options.id ?? HANDLE}`),
    createUserSupabase: () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }),
    createAdminSupabase: () => client as SupabaseClient,
    kieApiKey: 'kie-key',
    ...(options.later ? { runAfterResponse: (task: () => Promise<unknown>) => { options.later!.push(task); } } : {}),
  } as never) as RouteResult;
}

beforeEach(() => {
  for (const mock of Object.values(mocks.status)) {
    mock.mockReset();
    mock.mockResolvedValue({ ok: true, body: { status: 'processing', output: null } });
  }
  mocks.readQueued.mockReset();
  mocks.countAhead.mockReset();
  mocks.drive.mockClear();
  mocks.readQueued.mockResolvedValue({ generationId: HANDLE, userId: 'user-1', model: 'a-model', queuedAtMs: 1 });
  mocks.countAhead.mockResolvedValue(2);
});

describe.each(ROUTES)('following a queued $kind run by its handle', (route) => {
  it('answers waiting with its place while it is queued, and serves the queue behind the answer', async () => {
    const later: Array<() => Promise<unknown>> = [];

    const result = await poll(route, [generation(route.kind)], { later });

    expect(result).toMatchObject({
      ok: true,
      body: { status: 'waiting', queued: true, queuePosition: 3, output: null, retryAfterMs: 3_000 },
    });
    expect(result.body.timing).toMatchObject({ appStatus: 'waiting', phaseLabel: 'Queued · 2 ahead of you' });
    // No estimate: the run has not started, and a client must not count one down.
    expect((result.body.timing as { estimatedTotalMs?: unknown }).estimatedTotalMs ?? null).toBeNull();
    // The provider is not asked about a task that does not exist yet.
    expect(mocks.status[route.kind]).not.toHaveBeenCalled();

    expect(mocks.drive).not.toHaveBeenCalled();
    expect(later).toHaveLength(1);
    await later[0]();
    expect(mocks.drive).toHaveBeenCalledTimes(1);
  });

  it('gives an answer the web\'s status reader takes', async () => {
    const result = await poll(route, [generation(route.kind)]);

    const read = await fetchGenerationStatus({
      url: `http://localhost${route.path}?id=${HANDLE}`,
      accessToken: 'token',
      fetchImpl: (async () => new Response(JSON.stringify(result.body), { status: 200 })) as typeof fetch,
    });

    expect(read).toMatchObject({ status: 'waiting', queued: true, queuePosition: 3 });
  });

  it('hands the provider\'s task id to the status service once the run has been sent', async () => {
    // The client goes on asking with the handle: it never has to switch ids.
    const result = await poll(route, [generation(route.kind, { prediction_id: TASK_ID, status: 'processing' })]);

    expect(result).toMatchObject({ ok: true, body: { status: 'processing' } });
    expect(mocks.status[route.kind]).toHaveBeenCalledTimes(1);
    expect(mocks.status[route.kind].mock.calls[0][0]).toMatchObject({ predictionId: TASK_ID, userId: 'user-1' });
    expect(mocks.readQueued).not.toHaveBeenCalled();
  });

  it('answers failed, with the reason, for a run that ended before it was sent', async () => {
    const result = await poll(route, [generation(route.kind, {
      status: 'failed',
      completed_at: '2026-11-15T10:10:00.000+00:00',
      error_message: 'This generation could not be started in time. Your credits were returned.',
    })]);

    expect(result).toMatchObject({
      ok: true,
      body: { status: 'failed', error: 'This generation could not be started in time. Your credits were returned.' },
    });
    expect(mocks.status[route.kind]).not.toHaveBeenCalled();
  });

  it('says nothing of another creator\'s run: the id goes to the task lookup, which owns "not found"', async () => {
    mocks.status[route.kind].mockResolvedValue({ ok: false, body: { error: 'Generation not found' }, status: 404 });

    const result = await poll(route, [generation(route.kind)], { userId: 'someone-else' });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.status[route.kind].mock.calls[0][0]).toMatchObject({ predictionId: HANDLE, userId: 'someone-else' });
    expect(mocks.readQueued).not.toHaveBeenCalled();
    expect(mocks.drive).not.toHaveBeenCalled();
  });

  it('still follows a provider task whose id is shaped like a generation\'s', async () => {
    // No provider we use answers such ids today. One that did must not be
    // read as a missing handle: with no generation of that id, it is a task.
    const result = await poll(route, [generation(route.kind, { id: 'another-generation', prediction_id: HANDLE })]);

    expect(result).toMatchObject({ ok: true, body: { status: 'processing' } });
    expect(mocks.status[route.kind].mock.calls[0][0]).toMatchObject({ predictionId: HANDLE });
  });

  it('leaves a provider task id alone, without a lookup', async () => {
    const result = await poll(route, [], { id: TASK_ID });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.status[route.kind].mock.calls[0][0]).toMatchObject({ predictionId: TASK_ID });
  });
});

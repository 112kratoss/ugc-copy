import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isQueuedRunHandle, isRunHandle } from '@/lib/generation-run-handle';
import { createStoredRows } from './fixtures/stored-rows';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

const mocks = vi.hoisted(() => ({
  readQueued: vi.fn(),
  countAhead: vi.fn(),
  drive: vi.fn(async (..._args: unknown[]) => ({ sent: 0, queued: 1, gone: 0, expired: 0, failed: 0 })),
  linkedIds: vi.fn(async (_client: unknown, userId: string) => [userId]),
}));

vi.mock('@/lib/generation-submission-queue-store', () => ({
  readQueuedProviderSubmission: (...args: unknown[]) => mocks.readQueued(...args),
  countQueuedProviderSubmissionsAhead: (...args: unknown[]) => mocks.countAhead(...args),
}));

vi.mock('@/lib/generation-submission-queue', () => ({
  driveQueuedSubmissions: (...args: unknown[]) => mocks.drive(...args),
}));

vi.mock('@/lib/account-identity', () => ({
  resolveLinkedAccountIds: (client: unknown, userId: string) => mocks.linkedIds(client, userId),
}));

import {
  QUEUED_RUN_STATUS_RETRY_AFTER_MS,
  queuedRunPhaseLabel,
  resolveRunHandleStatus,
} from '@/lib/generation-run-handle-status';

const HANDLE = '6a0c7f2e-4d1b-4f6a-9c3e-2b8d5e7f9a10';

function generation(overrides: Record<string, unknown> = {}) {
  return {
    id: HANDLE,
    user_id: 'user-1',
    prediction_id: null,
    status: 'pending',
    category: 'image',
    model: 'nano-banana-2',
    created_at: '2026-11-15T10:00:00.000+00:00',
    completed_at: null,
    error_message: null,
    ...overrides,
  };
}

function resolve(rows: Array<Record<string, unknown>>, options: { id?: string; userId?: string; later?: Array<() => Promise<unknown>> } = {}) {
  const { client } = createStoredRows({ generations: rows });
  return resolveRunHandleStatus({
    id: options.id ?? HANDLE,
    userId: options.userId ?? 'user-1',
    createAdminSupabase: () => client as SupabaseClient,
    ...(options.later ? { runAfterResponse: (task) => { options.later!.push(task); } } : {}),
  });
}

beforeEach(() => {
  mocks.readQueued.mockReset();
  mocks.countAhead.mockReset();
  mocks.drive.mockClear();
  mocks.linkedIds.mockClear();
  mocks.readQueued.mockResolvedValue({ generationId: HANDLE, userId: 'user-1', model: 'nano-banana-2', queuedAtMs: 1 });
  mocks.countAhead.mockResolvedValue(0);
});

describe('a run handle', () => {
  it('is a generation id, which no provider task id is', () => {
    expect(isRunHandle(HANDLE)).toBe(true);
    expect(isRunHandle(` ${HANDLE.toUpperCase()} `)).toBe(true);
    // The provider's ids: 32 hex characters with no dashes, or its legacy form.
    expect(isRunHandle('582fa1827ca37b5d621536962040a8cd')).toBe(false);
    expect(isRunHandle('veo_task_abcdef123456')).toBe(false);
    expect(isRunHandle('')).toBe(false);
    expect(isRunHandle(null)).toBe(false);
  });

  it('is what a queued start answers in place of the task it does not have yet', () => {
    expect(isQueuedRunHandle({ predictionId: HANDLE, generationId: HANDLE })).toBe(true);
    expect(isQueuedRunHandle({ predictionId: '582fa1827ca37b5d621536962040a8cd', generationId: HANDLE })).toBe(false);
    expect(isQueuedRunHandle({ predictionId: HANDLE, generationId: null })).toBe(false);
    // An id that is its own generation's but is not a uuid is nobody's handle.
    expect(isQueuedRunHandle({ predictionId: 'gen-1', generationId: 'gen-1' })).toBe(false);
  });
});

describe('a status check made with a run handle', () => {
  it('passes a provider task id through untouched, without a read', async () => {
    const { client, reads } = createStoredRows({ generations: [] });

    await expect(resolveRunHandleStatus({
      id: '582fa1827ca37b5d621536962040a8cd',
      userId: 'user-1',
      createAdminSupabase: () => client as SupabaseClient,
    })).resolves.toEqual({ kind: 'task', predictionId: '582fa1827ca37b5d621536962040a8cd' });
    expect(reads).toEqual([]);
  });

  it('answers a queued run as waiting, with its place and words the clients can show', async () => {
    mocks.countAhead.mockResolvedValue(3);
    const later: Array<() => Promise<unknown>> = [];

    const status = await resolve([generation()], { later });

    expect(status).toMatchObject({
      kind: 'answered',
      body: {
        // `waiting` is a status every client already follows, queue or no queue.
        status: 'waiting',
        output: null,
        error: null,
        retryAfterMs: QUEUED_RUN_STATUS_RETRY_AFTER_MS,
        queued: true,
        queuePosition: 4,
        timing: { appStatus: 'waiting', phaseLabel: 'Queued · 3 ahead of you' },
      },
    });
  });

  it('answers a queued run as the contract the app is held to says', async () => {
    const fixture = mobileApiContract.endpoints.startGeneration.queued;
    mocks.countAhead.mockResolvedValue(fixture.status.queuePosition - 1);

    const status = await resolve([generation({ id: fixture.response.generationId })], { id: fixture.response.predictionId });

    expect(status).toMatchObject({ kind: 'answered', body: fixture.status });
    // Nothing the fixture does not name, apart from the timing's own clock.
    expect(Object.keys((status as { body: Record<string, unknown> }).body).sort())
      .toEqual(Object.keys(fixture.status).sort());
  });

  it('serves the queue behind its answer', async () => {
    // Whoever is watching a queued run moves the queue along: one pass over
    // its head per check, which sends the watcher's own run when it is its
    // turn and the runs ahead of it when it is theirs.
    const later: Array<() => Promise<unknown>> = [];

    await resolve([generation()], { later });

    expect(mocks.drive).not.toHaveBeenCalled();
    expect(later).toHaveLength(1);
    await later[0]();
    expect(mocks.drive).toHaveBeenCalledTimes(1);
    // The head of the queue, not this run: a run is never sent out of turn.
    expect(mocks.drive.mock.calls[0]).toEqual([]);
  });

  it('says a run with nobody ahead is starting soon', () => {
    expect(queuedRunPhaseLabel(0)).toBe('Queued · starting soon');
    expect(queuedRunPhaseLabel(1)).toBe('Queued · 1 ahead of you');
  });

  it('hands over to the provider task once the run has one', async () => {
    const status = await resolve([generation({ prediction_id: '582fa1827ca37b5d621536962040a8cd', status: 'processing' })]);

    // From here the status services follow the run as they follow any other,
    // and the client goes on asking with the handle it has.
    expect(status).toEqual({ kind: 'attached', predictionId: '582fa1827ca37b5d621536962040a8cd' });
    expect(mocks.readQueued).not.toHaveBeenCalled();
  });

  it('answers a run that ended before it was sent as failed, with why', async () => {
    const status = await resolve([generation({
      status: 'failed',
      completed_at: '2026-11-15T10:10:00.000+00:00',
      error_message: 'This generation could not be started in time. Your credits were returned.',
    })]);

    expect(status).toMatchObject({
      kind: 'answered',
      body: {
        status: 'failed',
        error: 'This generation could not be started in time. Your credits were returned.',
      },
    });
  });

  it('answers a run that left the queue and is being sent as processing, to be asked about again', async () => {
    mocks.readQueued.mockResolvedValue(null);
    const later: Array<() => Promise<unknown>> = [];

    const status = await resolve([generation()], { later });

    expect(status).toMatchObject({
      kind: 'answered',
      body: { status: 'processing', retryAfterMs: QUEUED_RUN_STATUS_RETRY_AFTER_MS },
    });
    expect(status).not.toMatchObject({ body: { queued: true } });
    // Something else holds its request: there is nothing here to drive.
    expect(later).toEqual([]);
  });

  it('is nobody else\'s to ask about', async () => {
    // Not this creator's generation, or no generation at all: the id is then
    // looked up as a provider task id, as every id was before handles, and
    // that lookup's own ownership check answers "not found". Nothing of the
    // run is read or said here, and a provider whose task ids are shaped like
    // ours is still followed.
    await expect(resolve([generation({ user_id: 'someone-else' })]))
      .resolves.toEqual({ kind: 'task', predictionId: HANDLE });
    await expect(resolve([])).resolves.toEqual({ kind: 'task', predictionId: HANDLE });
    expect(mocks.readQueued).not.toHaveBeenCalled();
  });

  it('does not answer "not found" for a run it could not look up', async () => {
    // A poll stops on a 404, and the run is there: the route answers 500 and the poll comes back.
    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ in: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }) }) }) }),
      }),
    };

    await expect(resolveRunHandleStatus({
      id: HANDLE,
      userId: 'user-1',
      createAdminSupabase: () => failing as unknown as SupabaseClient,
    })).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('is found for every identity linked to the caller', async () => {
    mocks.linkedIds.mockResolvedValueOnce(['account-1', 'guest-1']);

    await expect(resolve([generation({ user_id: 'guest-1' })], { userId: 'account-1' }))
      .resolves.toMatchObject({ kind: 'answered', body: { queued: true } });
  });
});

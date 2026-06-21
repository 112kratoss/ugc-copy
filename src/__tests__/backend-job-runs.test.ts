import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { finishBackendJobRun, startBackendJobRun } from '@/lib/backend-job-runs';

function createStartClient(result: { data: { id: string } | null; error: Error | null }) {
  const single = vi.fn(async () => result);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    insert,
    select,
    single,
  };
}

function createFinishClient(result: { error: Error | null }) {
  const eq = vi.fn(async () => result);
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    update,
    eq,
  };
}

describe('backend job run recording', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a durable job run row and returns its handle', async () => {
    const db = createStartClient({ data: { id: 'run-1' }, error: null });

    const run = await startBackendJobRun(db.client, {
      name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      requestId: 'request-1',
      lockOwner: 'request-1:1000',
      startedAtMs: 1000,
    });

    expect(run).toEqual({
      id: 'run-1',
      name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      requestId: 'request-1',
      lockOwner: 'request-1:1000',
      startedAtMs: 1000,
    });
    expect(db.from).toHaveBeenCalledWith('backend_job_runs');
    expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      request_id: 'request-1',
      lock_owner: 'request-1:1000',
      status: 'started',
      started_at: new Date(1000).toISOString(),
    }));
    expect(db.select).toHaveBeenCalledWith('id');
  });

  it('finishes a run with status, duration, and summary data', async () => {
    const db = createFinishClient({ error: null });

    await finishBackendJobRun(db.client, {
      id: 'run-1',
      name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      requestId: 'request-1',
      lockOwner: 'request-1:1000',
      startedAtMs: 1000,
    }, {
      status: 'succeeded',
      finishedAtMs: 1550,
      summary: { completed: 2 },
    });

    expect(db.from).toHaveBeenCalledWith('backend_job_runs');
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'succeeded',
      finished_at: new Date(1550).toISOString(),
      duration_ms: 550,
      updated_at: new Date(1550).toISOString(),
      summary: { completed: 2 },
    }));
    expect(db.eq).toHaveBeenCalledWith('id', 'run-1');
  });

  it('records skipped and failed outcomes without negative durations', async () => {
    const skippedDb = createFinishClient({ error: null });
    await finishBackendJobRun(skippedDb.client, {
      id: 'run-2',
      name: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      requestId: 'request-2',
      lockOwner: 'request-2:2000',
      startedAtMs: 2000,
    }, {
      status: 'skipped',
      finishedAtMs: 1990,
      skipReason: 'already_running',
    });

    expect(skippedDb.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      duration_ms: 0,
      skip_reason: 'already_running',
    }));

    const failedDb = createFinishClient({ error: null });
    await finishBackendJobRun(failedDb.client, {
      id: 'run-3',
      name: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      requestId: 'request-3',
      lockOwner: 'request-3:3000',
      startedAtMs: 3000,
    }, {
      status: 'failed',
      finishedAtMs: 3300,
      errorMessage: 'provider failed',
    });

    expect(failedDb.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      duration_ms: 300,
      error_message: 'provider failed',
    }));
  });

  it('logs and returns null when the start insert fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = createStartClient({ data: null, error: new Error('database unavailable') });

    const run = await startBackendJobRun(db.client, {
      name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      requestId: 'request-1',
      lockOwner: 'request-1:1000',
      startedAtMs: 1000,
    });

    expect(run).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_job_run_start_failed'));
  });

  it('logs finish failures but does not throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = createFinishClient({ error: new Error('update failed') });

    await expect(finishBackendJobRun(db.client, {
      id: 'run-1',
      name: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      requestId: 'request-1',
      lockOwner: 'request-1:1000',
      startedAtMs: 1000,
    }, {
      status: 'failed',
      finishedAtMs: 1100,
      errorMessage: 'task failed',
    })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_job_run_finish_failed'));
  });
});

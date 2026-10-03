import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import type { TemplateRunDto, TemplateRunStatus } from '@/lib/media-template-types';
import { processTemplateRunJobs } from '@/lib/template-run-jobs-processor';

import { createTemplateRunJobQueue, type TemplateRunJobQueue } from './fixtures/template-run-job-queue';

// The run worker is stood in for by what each test passes as `syncRun`, and
// ending a run by `abandonRun`. The processor, its sweep and the queue
// wrappers they call run their real code.
vi.mock('@/lib/template-run-service', () => ({ syncTemplateRun: vi.fn(), abandonTemplateRun: vi.fn() }));

const RUN_ID = 'run-1';
const USER_ID = 'user-1';
const MINUTE = 60_000;
const TIMEOUT_MESSAGE = 'canceling statement due to statement timeout';

describe('a template run whose job runs out of attempts', () => {
  let queue: TemplateRunJobQueue;
  let logs: BackendLogRecord[];
  let restoreLogSink: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-02T10:00:00.000Z') });
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    queue = createTemplateRunJobQueue();
    queue.addRun({ id: RUN_ID, userId: USER_ID, status: 'collecting_inputs' });
    // The start route: the status change writes the run's ticket.
    queue.setRunStatus(RUN_ID, 'queued');
  });
  afterEach(() => {
    restoreLogSink();
    vi.useRealTimers();
  });

  /** A pass that cannot read the run, as a statement timeout leaves it. */
  const failingPass = async (): Promise<TemplateRunDto> => {
    throw new Error(TIMEOUT_MESSAGE);
  };
  /** A pass that works and finds the run still waiting, so the ticket is deferred. */
  const goodPass = (status: TemplateRunStatus = 'queued', runId = RUN_ID) => async () => {
    // What every pass that works does: it writes the run's progress.
    queue.setRunStatus(runId, status);
    return { status } as TemplateRunDto;
  };
  /**
   * Ends a run the way the service does: only if nothing has written the run
   * since the give-up time began.
   */
  const abandonRun = vi.fn(async (params: { runId: string; idleBefore: string }) => {
    const run = queue.run(params.runId);
    if (!['queued', 'processing'].includes(run.status) || run.updated_at >= params.idleBefore) return false;
    queue.setRunStatus(params.runId, 'failed');
    return true;
  });
  /** One call of the worker, as the cron job, a provider callback and the run's routes make it. */
  const tick = (syncRun: () => Promise<TemplateRunDto>) => (
    processTemplateRunJobs({ client: queue.client, lockedBy: 'worker', syncRun, abandonRun })
  );
  const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * MINUTE);
  const logged = (event: string) => logs.filter((record) => record.msg === event);

  /**
   * Five failed passes, each as soon as the last one's retry delay is over
   * (1, 2, 4 and 8 minutes), so the ticket is spent 15 minutes after the first.
   */
  async function failFivePasses(pass: () => Promise<TemplateRunDto> = failingPass) {
    const outcomes = [];
    for (const delay of [1, 2, 4, 8, 0]) {
      const outcome = await tick(pass);
      outcomes.push([outcome.claimed, outcome.retried, outcome.exhausted]);
      later(delay);
    }
    return outcomes;
  }

  beforeEach(() => {
    abandonRun.mockClear();
  });

  it('the fifth failed pass spends the ticket and leaves the run as it was', async () => {
    expect(await failFivePasses()).toEqual([
      [1, 1, 0],
      [1, 1, 0],
      [1, 1, 0],
      [1, 1, 0],
      [1, 0, 1],
    ]);

    expect(queue.job(RUN_ID)).toMatchObject({ status: 'failed', attempt_count: 5, last_error: TIMEOUT_MESSAGE });
    expect(queue.run(RUN_ID).status).toBe('queued');
    expect(queue.strandedRuns()).toEqual([RUN_ID]);
  });

  it('a run whose ticket was spent gets it back, once the ticket has been dead for two minutes', async () => {
    await failFivePasses();

    // A pass may be letting its ticket go this very moment.
    later(1);
    expect(await tick(goodPass())).toMatchObject({ adopted: 0, claimed: 0 });

    // Whatever made the passes fail is over, 18 minutes after the run last worked.
    later(2);
    expect(await tick(goodPass())).toMatchObject({ adopted: 1, abandoned: 0, claimed: 1, deferred: 1 });

    expect(queue.job(RUN_ID)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: null });
    expect(queue.strandedRuns()).toEqual([]);
    expect(abandonRun).not.toHaveBeenCalled();
    expect(logged('template_run_adopted')).toEqual([
      expect.objectContaining({ level: 'warn', runId: RUN_ID, lastError: TIMEOUT_MESSAGE }),
    ]);
  });

  it('a run that has gone the give-up time without a pass that worked is ended', async () => {
    await failFivePasses();
    later(3);

    // 18 minutes in: the ticket is written again, and its passes fail as before.
    expect((await tick(failingPass)).adopted).toBe(1);
    for (const delay of [1, 2, 4, 8]) {
      later(delay);
      await tick(failingPass);
    }
    expect(queue.job(RUN_ID)).toMatchObject({ status: 'failed', attempt_count: 5 });
    expect(abandonRun).not.toHaveBeenCalled();

    // 36 minutes in, and the run has not worked once since it started.
    later(3);
    const startedAt = Date.parse('2026-10-02T10:00:00.000Z');
    expect(Date.now() - startedAt).toBe(36 * MINUTE);
    expect(await tick(failingPass)).toMatchObject({ adopted: 0, abandoned: 1, claimed: 0 });

    expect(abandonRun).toHaveBeenCalledTimes(1);
    expect(abandonRun).toHaveBeenCalledWith({
      client: queue.client,
      runId: RUN_ID,
      userId: USER_ID,
      // Thirty minutes before this sweep: the run is ended only if nothing wrote it since.
      idleBefore: new Date(startedAt + 6 * MINUTE).toISOString(),
      lastError: TIMEOUT_MESSAGE,
    });
    expect(queue.run(RUN_ID).status).toBe('failed');

    // It is over: a day of the cron job does nothing more to it.
    for (let run = 1; run <= 144; run += 1) {
      later(10);
      expect(await tick(failingPass)).toMatchObject({ adopted: 0, abandoned: 0, claimed: 0 });
    }
    expect(abandonRun).toHaveBeenCalledTimes(1);
    expect(queue.strandedRuns()).toEqual([]);
  });

  it('failed passes are counted over the whole run, and the run carries on all the same', async () => {
    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await tick(failingPass)).toMatchObject({ claimed: 1, retried: 1 });
      later(20);
      expect(await tick(goodPass())).toMatchObject({ claimed: 1, deferred: 1 });
      later(20);
    }
    // A pass that works does not clear the count.
    expect(queue.job(RUN_ID)).toMatchObject({ status: 'pending', attempt_count: 4 });

    // The fifth failure, hours after the first and with a working pass since each one.
    expect(await tick(failingPass)).toMatchObject({ claimed: 1, exhausted: 1 });
    expect(queue.job(RUN_ID)).toMatchObject({ status: 'failed', attempt_count: 5 });

    // The run worked 23 minutes ago, so it is picked up again and not given up on.
    later(3);
    expect(await tick(goodPass())).toMatchObject({ adopted: 1, abandoned: 0, claimed: 1, deferred: 1 });
    expect(abandonRun).not.toHaveBeenCalled();
    expect(queue.strandedRuns()).toEqual([]);
  });

  it('a generation of the run that finishes later writes the ticket again', async () => {
    queue.setRunStatus(RUN_ID, 'processing');
    await failFivePasses();
    expect(queue.job(RUN_ID)).toMatchObject({ status: 'failed', attempt_count: 5 });

    queue.generationTurnedTerminal(RUN_ID);

    expect(queue.job(RUN_ID)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: null });
    expect(await tick(goodPass('processing'))).toMatchObject({ adopted: 0, claimed: 1, deferred: 1 });
  });

  it('a ticket closed by a pass that had read the run before the person acted is written again', async () => {
    // The pass finds a result waiting for review and is about to close its
    // ticket. The person approves in that moment: the run goes back to
    // processing while the pass still holds the ticket, so no new one is written.
    const outcome = await tick(async () => {
      queue.setRunStatus(RUN_ID, 'awaiting_approval');
      const seen = { status: 'awaiting_approval' } as TemplateRunDto;
      queue.setRunStatus(RUN_ID, 'processing');
      return seen;
    });
    expect(outcome).toMatchObject({ claimed: 1, completed: 1 });
    expect(queue.job(RUN_ID)).toMatchObject({ status: 'succeeded' });
    expect(queue.strandedRuns()).toEqual([RUN_ID]);

    later(3);
    expect(await tick(goodPass('processing'))).toMatchObject({ adopted: 1, claimed: 1, deferred: 1 });
    expect(queue.strandedRuns()).toEqual([]);
  });

  it('a run with a live ticket is left alone however long it waits', async () => {
    // Two hours of a run waiting on a slow generation: every pass works and defers.
    for (let run = 1; run <= 12; run += 1) {
      expect(await tick(goodPass('processing'))).toMatchObject({ adopted: 0, abandoned: 0, claimed: 1, deferred: 1 });
      later(10);
    }

    // A worker that dies holding the ticket: the lease runs out and the claim
    // takes the ticket over. That is not the sweep's to do.
    const { data: held } = await queue.client.rpc('claim_template_run_jobs', {
      p_limit: 1, p_locked_by: 'a worker that died', p_lock_ttl_seconds: 300,
    });
    expect(held).toHaveLength(1);
    later(3);
    expect(await tick(goodPass('processing'))).toMatchObject({ adopted: 0, abandoned: 0, claimed: 0 });
    later(3);
    expect(await tick(goodPass('processing'))).toMatchObject({ adopted: 0, abandoned: 0, claimed: 1, deferred: 1 });
    expect(abandonRun).not.toHaveBeenCalled();
  });

  it.each(['awaiting_approval', 'needs_attention'] as const)(
    'a run that waits for the person as %s is left alone',
    async (status) => {
      expect(await tick(goodPass(status))).toMatchObject({ claimed: 1, completed: 1 });

      later(24 * 60);
      expect(await tick(failingPass)).toMatchObject({ adopted: 0, abandoned: 0, claimed: 0 });
      expect(queue.run(RUN_ID).status).toBe(status);
      expect(abandonRun).not.toHaveBeenCalled();
    },
  );

  it('a run somebody wrote in the meantime is not ended', async () => {
    await failFivePasses();
    later(40);
    // The person cancels between the sweep's read and its write.
    abandonRun.mockImplementationOnce(async () => false);

    expect(await tick(failingPass)).toMatchObject({ adopted: 0, abandoned: 0 });
    expect(queue.run(RUN_ID).status).toBe('queued');
  });

  it('a run that cannot be taken up does not stop the sweep for the others', async () => {
    queue.addRun({ id: 'run-2', userId: 'user-2', status: 'collecting_inputs' });
    queue.setRunStatus('run-2', 'queued');
    await failFivePasses();
    later(40);
    abandonRun.mockImplementationOnce(async () => {
      throw new Error('the run could not be written');
    });

    const outcome = await tick(failingPass);

    expect(abandonRun).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ abandoned: 1 });
    expect(logged('template_run_adopt_failed')).toEqual([
      expect.objectContaining({ level: 'error', errorMessage: 'the run could not be written' }),
    ]);
    expect([queue.run(RUN_ID).status, queue.run('run-2').status].sort()).toEqual(['failed', 'queued']);
  });

  it('a sweep that cannot read the runs does not cost the due tickets their turn', async () => {
    queue.conditions.runsUnreadable = true;

    expect(await tick(goodPass())).toMatchObject({ adopted: 0, abandoned: 0, claimed: 1, deferred: 1 });
    expect(logged('template_run_sweep_failed')).toEqual([
      expect.objectContaining({ level: 'error', errorMessage: TIMEOUT_MESSAGE }),
    ]);
  });

  it('the ticket and the log say why a pass failed, also for an error that is not an Error', async () => {
    // What PostgREST hands back for a cancelled read, thrown on by the worker as it is.
    const databaseError = { code: '57014', details: null, hint: null, message: TIMEOUT_MESSAGE };

    expect(await tick(async () => {
      throw databaseError;
    })).toMatchObject({ claimed: 1, retried: 1 });

    expect(queue.job(RUN_ID)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: TIMEOUT_MESSAGE });
    expect(logged('template_run_pass_failed')).toEqual([
      expect.objectContaining({
        level: 'error',
        runId: RUN_ID,
        outcome: 'retry_scheduled',
        errorMessage: TIMEOUT_MESSAGE,
      }),
    ]);
  });
});

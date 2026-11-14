import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

const QUEUED_AT = Date.parse('2026-11-15T10:00:00.000Z');

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  claim: vi.fn(),
  list: vi.fn(),
  attach: vi.fn(),
  settle: vi.fn(),
  notifyFailed: vi.fn(),
  notifyStartFailure: vi.fn(),
}));

vi.mock('@/lib/generation-submission-queue-store', () => ({
  readQueuedProviderSubmission: (...args: unknown[]) => mocks.read(...args),
  claimQueuedProviderSubmission: (...args: unknown[]) => mocks.claim(...args),
  listOldestQueuedProviderSubmissions: (...args: unknown[]) => mocks.list(...args),
}));

vi.mock('@/lib/generation-services', () => ({
  markGenerationProviderStarted: (...args: unknown[]) => mocks.attach(...args),
  postKieTask: vi.fn(),
  settleGenerationStartFailureQuietly: (...args: unknown[]) => mocks.settle(...args),
}));

vi.mock('@/lib/run-step-start-failure-notification', () => ({
  notifyRunStepGenerationFailed: (...args: unknown[]) => mocks.notifyFailed(...args),
  notifyRunStepStartFailure: (...args: unknown[]) => mocks.notifyStartFailure(...args),
}));

import {
  cancelQueuedSubmission,
  driveQueuedSubmissions,
  QUEUED_SUBMISSION_CANCELLED_MESSAGE,
  QUEUED_SUBMISSION_EXPIRED_MESSAGE,
  QUEUED_SUBMISSION_PASS_BUDGET_MS,
  QUEUED_SUBMISSION_PASS_LIMIT,
  QUEUED_SUBMISSION_PASS_SPACING_MS,
  resetQueuedSubmissionPasses,
} from '@/lib/generation-submission-queue';

/** Queued runs `a`, `b`, `c`…, oldest first. */
function run(letter: string, overrides: Record<string, unknown> = {}) {
  const position = letter.charCodeAt(0) - 'a'.charCodeAt(0);
  return {
    generationId: `${letter}2000000-0000-4000-8000-000000000001`,
    userId: `user-${letter}`,
    model: 'nano-banana-2',
    queuedAtMs: QUEUED_AT + position * 1_000,
    ...overrides,
  };
}

function taskOf(generationId: string) {
  return {
    endpoint: 'https://api.kie.ai/api/v1/jobs/createTask',
    body: { model: 'nano-banana-2', input: { prompt: `request of ${generationId}` } },
    callbackUrl: `https://example.invalid/callback?generationId=${generationId}`,
    modelId: 'nano-banana-2',
  };
}

const ADMITTED = { allowed: true, reason: 'admitted' };
const noPlace = (reason = 'rate_limited') => ({ allowed: false, reason });

/** The service client: the queue's refunds go through its `settle_generation_start_failed`. */
function serviceClient(settleStatus: string | Error = 'failed') {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => (
    settleStatus instanceof Error
      ? { data: null, error: settleStatus }
      : { data: { status: settleStatus }, error: null }
  ));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

/**
 * A queue holding `queued`, served with a gate that answers `admit` by
 * generation id, on a clock only the pauses between passes move.
 */
function queue(queued: ReturnType<typeof run>[], options: {
  admit?: (generationId: string) => unknown;
  post?: (task: ReturnType<typeof taskOf>) => Promise<string>;
  nowMs?: number;
  /** Generations settled, attached or marked unknown while their row waited. */
  unsendable?: string[];
} = {}) {
  // A queue of its own is a server instance of its own: no pass of an earlier one to join or follow.
  resetQueuedSubmissionPasses();
  let clock = options.nowMs ?? QUEUED_AT + 5_000;
  const waiting = [...queued];
  const pauses: number[] = [];
  const asked: string[] = [];
  const sent: string[] = [];
  mocks.list.mockImplementation(async (_client: unknown, limit: number) => waiting.slice(0, limit));
  mocks.read.mockImplementation(async (_client: unknown, generationId: string) => (
    waiting.find((candidate) => candidate.generationId === generationId) ?? null
  ));
  mocks.claim.mockImplementation(async (_client: unknown, generationId: string) => {
    const index = waiting.findIndex((candidate) => candidate.generationId === generationId);
    if (index < 0) return null;
    const [claimed] = waiting.splice(index, 1);
    return {
      generationId,
      userId: claimed.userId,
      task: taskOf(generationId),
      queuedAtMs: claimed.queuedAtMs,
      sendable: !options.unsendable?.includes(generationId),
    };
  });
  const admit = vi.fn(async ({ generationId }: { generationId: string }) => {
    asked.push(generationId);
    const answer = options.admit ? options.admit(generationId) : ADMITTED;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const post = vi.fn(options.post ?? (async (task: ReturnType<typeof taskOf>) => {
    sent.push(String(task.body.input.prompt));
    return `task-${sent.length}`;
  }));
  return {
    waiting,
    pauses,
    asked,
    sent,
    admit,
    post,
    advance: (ms: number) => { clock += ms; },
    dependencies: {
      admit: admit as never,
      post: post as never,
      now: () => clock,
      sleep: async (ms: number) => { pauses.push(ms); clock += ms; },
      // No spread between passes, so the pauses read as the policy's own.
      random: () => 0,
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.attach.mockResolvedValue(undefined);
  mocks.settle.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('a pass over the head of the queue', () => {
  it('asks for the runs that have waited longest, oldest first, and sends each that has its turn', async () => {
    const [a, b, c] = [run('a'), run('b'), run('c')];
    const served = queue([a, b, c]);
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(mocks.list).toHaveBeenCalledWith(client, QUEUED_SUBMISSION_PASS_LIMIT);
    expect(served.asked).toEqual([a.generationId, b.generationId, c.generationId]);
    expect(served.sent).toEqual([a, b, c].map((queued) => `request of ${queued.generationId}`));
    expect(summary).toEqual({ sent: 3, queued: 0, gone: 0, expired: 0, failed: 0 });
    expect(served.waiting).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    // One pass, no waiting: a status check, the provider's callback and the cron.
    expect(served.pauses).toEqual([]);
  });

  it('asks by the queue\'s own order: the gate reads each run\'s turn from its row', async () => {
    const a = run('a');
    const served = queue([a]);

    await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    // And never failing open: a queued run the gate cannot be asked about waits for the next pass.
    expect(served.admit).toHaveBeenCalledWith({
      generationId: a.generationId, model: 'nano-banana-2', mayQueue: true, failOpen: false,
    });
  });

  it('claims a run\'s request before sending it, and attaches the task it gets back', async () => {
    const a = run('a');
    const order: string[] = [];
    const served = queue([a], { post: async () => { order.push('post'); return 'task-queued-1'; } });
    const claim = mocks.claim.getMockImplementation()!;
    mocks.claim.mockImplementation(async (...args: unknown[]) => { order.push('claim'); return claim(...args); });
    mocks.attach.mockImplementation(async () => { order.push('attach'); });
    const { client } = serviceClient();

    await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    // The claim comes first: only the caller holding the request may send it.
    expect(order).toEqual(['claim', 'post', 'attach']);
    expect(served.post).toHaveBeenCalledWith(taskOf(a.generationId));
    expect(mocks.attach).toHaveBeenCalledWith(client, a.generationId, 'task-queued-1');
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('stops at the first run the account has no place for: every run behind it was queued later', async () => {
    const [a, b, c] = [run('a'), run('b'), run('c')];
    for (const reason of ['rate_limited', 'max_in_flight']) {
      const served = queue([a, b, c], { admit: () => noPlace(reason) });

      const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

      // Asking for b and c would only be load: the gate refuses them the same place.
      expect(served.asked).toEqual([a.generationId]);
      expect(summary).toEqual({ sent: 0, queued: 1, gone: 0, expired: 0, failed: 0 });
      expect(mocks.claim).not.toHaveBeenCalled();
    }
  });

  it('passes over a run its own model has no place for: the next may be another model\'s', async () => {
    const [a, b] = [run('a', { model: 'busy-model' }), run('b', { model: 'quiet-model' })];
    const served = queue([a, b], {
      admit: (generationId) => (generationId === a.generationId ? noPlace('model_rate_limited') : ADMITTED),
    });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(served.asked).toEqual([a.generationId, b.generationId]);
    expect(summary).toEqual({ sent: 1, queued: 1, gone: 0, expired: 0, failed: 0 });
    expect(served.waiting).toEqual([a]);
  });

  it('asks once for a model whose share is full, and reaches another model\'s run behind its backlog', async () => {
    // Six of one model queued ahead of one of another. Asking for each of the
    // six would be six refusals for the same reason; reading only the first
    // five would never reach the seventh, which has a place.
    const backlog = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => run(letter, { model: 'busy-model' }));
    const other = run('g', { model: 'quiet-model' });
    const served = queue([...backlog, other], {
      admit: (generationId) => (generationId === other.generationId ? ADMITTED : noPlace('model_rate_limited')),
    });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(served.asked).toEqual([backlog[0].generationId, other.generationId]);
    expect(served.sent).toEqual([`request of ${other.generationId}`]);
    expect(summary).toEqual({ sent: 1, queued: 6, gone: 0, expired: 0, failed: 0 });
  });

  it('never sends a run whose generation was settled while its row waited', async () => {
    // The start that queued it failed after the row was written, or the reaper
    // ended it: its credits are back with the creator. The claim says so, and
    // the request is dropped with the row.
    const [a, b] = [run('a'), run('b')];
    const served = queue([a, b], { unsendable: [a.generationId] });
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(served.sent).toEqual([`request of ${b.generationId}`]);
    expect(summary).toEqual({ sent: 1, queued: 0, gone: 1, expired: 0, failed: 0 });
    expect(served.waiting).toEqual([]);
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not send a run the gate could not be asked about, and goes on to the next', async () => {
    const [a, b] = [run('a'), run('b')];
    const served = queue([a, b], {
      admit: (generationId) => (generationId === a.generationId ? noPlace('unavailable') : ADMITTED),
    });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(served.sent).toEqual([`request of ${b.generationId}`]);
    expect(summary).toEqual({ sent: 1, queued: 1, gone: 0, expired: 0, failed: 0 });
    expect(served.waiting).toEqual([a]);
  });

  it('ends the pass when the gate cannot be asked at all', async () => {
    const queued = ['a', 'b', 'c', 'd'].map((letter) => run(letter));
    const served = queue(queued, { admit: () => noPlace('unavailable') });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(served.asked).toEqual([queued[0].generationId, queued[1].generationId]);
    expect(summary).toMatchObject({ sent: 0, queued: 2 });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('keeps the credits of a run the provider accepted when the task could not be attached', async () => {
    // The provider is running it. A refund here would be for a task that goes
    // on to finish: the callback attaches it when it reports, as for a start
    // that died at this point.
    const a = run('a');
    const served = queue([a]);
    mocks.attach.mockRejectedValue(new GenerationServiceError('Failed to attach provider task to generation.', 500));
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(served.sent).toEqual([`request of ${a.generationId}`]);
    expect(summary).toEqual({ sent: 1, queued: 0, gone: 0, expired: 0, failed: 0 });
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.notifyStartFailure).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('begins no send once its time is spent', async () => {
    const [a, b] = [run('a'), run('b')];
    const served = queue([a, b], {
      post: async () => { served.advance(QUEUED_SUBMISSION_PASS_BUDGET_MS); return 'task-a'; },
    });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    // The send that had begun is finished; the next run waits for the next pass.
    expect(served.asked).toEqual([a.generationId]);
    expect(summary).toMatchObject({ sent: 1 });
    expect(served.waiting).toEqual([b]);
  });
});

describe('passes within one server instance', () => {
  it('skips a pass wanted straight after one found the account full', async () => {
    const a = run('a');
    const served = queue([a], { admit: () => noPlace() });
    const { client } = serviceClient();

    await driveQueuedSubmissions({ client, dependencies: served.dependencies });
    await driveQueuedSubmissions({ client, dependencies: served.dependencies });
    expect(served.asked).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    served.advance(QUEUED_SUBMISSION_PASS_SPACING_MS);
    await driveQueuedSubmissions({ client, dependencies: served.dependencies });
    expect(served.asked).toHaveLength(2);
  });

  it('does not skip after a pass that sent what it asked for: the next may send more', async () => {
    const served = queue([run('a')]);
    const { client } = serviceClient();

    await driveQueuedSubmissions({ client, dependencies: served.dependencies });
    served.waiting.push(run('b'));
    await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(served.sent).toHaveLength(2);
  });

  it('joins a pass that is running instead of asking the gate beside it', async () => {
    const a = run('a');
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const served = queue([a], { post: async () => { await held; return 'task-a'; } });
    const { client } = serviceClient();

    const first = driveQueuedSubmissions({ client, dependencies: served.dependencies });
    await vi.waitFor(() => expect(served.post).toHaveBeenCalledTimes(1));
    const second = driveQueuedSubmissions({ client, dependencies: served.dependencies });
    release!();
    await Promise.all([first, second]);

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(served.asked).toEqual([a.generationId]);
  });

  it('sends nothing for a run something else claimed first', async () => {
    // Several passes run at once. The claim hands a request to one of them;
    // the rest find nothing to claim, and the run is sent once.
    const a = run('a');
    const served = queue([a]);
    mocks.claim.mockResolvedValue(null);

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(summary).toMatchObject({ sent: 0, gone: 1 });
    expect(served.post).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('settles a send the provider refused as a start\'s own failure, tells the creator, and goes on', async () => {
    // Nobody is waiting on a response here, so a refund is said by notification.
    const [a, b] = [run('a'), run('b')];
    const refusal = new Error('Provider rejected the request');
    const served = queue([a, b], {
      post: async (task) => {
        if (String(task.body.input.prompt).includes(a.generationId)) throw refusal;
        return 'task-b';
      },
    });
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(summary).toEqual({ sent: 1, queued: 0, gone: 0, expired: 0, failed: 1 });
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({
      creditSupabase: client, error: refusal, generationId: a.generationId, userId: 'user-a',
    }));
    expect(mocks.notifyStartFailure).toHaveBeenCalledWith({ client, error: refusal, userId: 'user-a' });
    // The settle helper decides between a hold and a refund from the error, as
    // for any start. This file never refunds a run it has tried to send.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('leaves a run queued while the breaker is open, and asks for none behind it', async () => {
    const [a, b] = [run('a'), run('b')];
    const served = queue([a, b], { admit: () => new GenerationServiceError('not accepting requests', 429, 'provider_busy') });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(served.asked).toEqual([a.generationId]);
    expect(summary).toMatchObject({ queued: 1, sent: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('looks at as many of the oldest runs as its caller says', async () => {
    queue([run('a')], { admit: () => noPlace() });
    const { client } = serviceClient();

    await driveQueuedSubmissions({ client, limit: 25, dependencies: { admit: (async () => noPlace()) as never } });

    expect(mocks.list).toHaveBeenCalledWith(client, 25);
  });

  it('never throws when the queue cannot be read', async () => {
    mocks.list.mockRejectedValue(new Error('connection reset'));

    await expect(driveQueuedSubmissions({ client: serviceClient().client }))
      .resolves.toEqual({ sent: 0, queued: 0, gone: 0, expired: 0, failed: 0 });
  });
});

describe('the request that queued a run, once it has answered', () => {
  const { queueDriveBudgetMs, queuePollMs } = PROVIDER_ADMISSION_POLICY;

  it('goes on passing over the head of the queue until its own run has left it', async () => {
    const [a, b] = [run('a'), run('b')];
    let places = 0;
    const served = queue([a, b], { admit: () => (places-- > 0 ? ADMITTED : noPlace()) });
    // A place opens during each of the first two pauses.
    const sleep = served.dependencies.sleep;
    served.dependencies.sleep = async (ms: number) => { places = 1; await sleep(ms); };

    const summary = await driveQueuedSubmissions({
      client: serviceClient().client,
      untilGenerationId: b.generationId,
      deadlineMs: QUEUED_AT + 5_000 + queueDriveBudgetMs,
      dependencies: served.dependencies,
    });

    // It serves the head, not its own run: a was queued first and is sent first.
    expect(served.sent).toEqual([`request of ${a.generationId}`, `request of ${b.generationId}`]);
    expect(summary).toMatchObject({ sent: 2 });
    expect(served.pauses).toEqual([queuePollMs, queuePollMs]);
  });

  it('stops when its time is spent, leaving the run queued for whatever serves the queue next', async () => {
    const a = run('a');
    const served = queue([a], { admit: () => noPlace('max_in_flight') });

    const summary = await driveQueuedSubmissions({
      client: serviceClient().client,
      untilGenerationId: a.generationId,
      deadlineMs: QUEUED_AT + 5_000 + 5_000,
      dependencies: served.dependencies,
    });

    // 2 s + 2 s + the 1 s that was left.
    expect(served.pauses).toEqual([2_000, 2_000, 1_000]);
    expect(served.waiting).toEqual([a]);
    // Three asks: at the deadline itself none is begun.
    expect(served.asked).toHaveLength(3);
    expect(summary).toMatchObject({ sent: 0, queued: 3 });
  });

  it('spreads its passes, so the requests of one burst do not all come back at once', async () => {
    const a = run('a');
    const served = queue([a], { admit: () => noPlace() });
    served.dependencies.random = () => 1;

    await driveQueuedSubmissions({
      client: serviceClient().client,
      untilGenerationId: a.generationId,
      deadlineMs: QUEUED_AT + 5_000 + 4_000,
      dependencies: served.dependencies,
    });

    expect(served.pauses).toEqual([queuePollMs * 1.5, 1_000]);
  });

  it('stops at once when something else sent its run', async () => {
    const [a, b] = [run('a'), run('b')];
    const served = queue([a], { admit: () => noPlace() });

    await driveQueuedSubmissions({
      client: serviceClient().client,
      untilGenerationId: b.generationId,
      deadlineMs: QUEUED_AT + 5_000 + queueDriveBudgetMs,
      dependencies: served.dependencies,
    });

    expect(served.pauses).toEqual([]);
    expect(served.asked).toEqual([a.generationId]);
  });

  it('makes one pass and no more when it is given no run to wait for', async () => {
    const served = queue([run('a')], { admit: () => noPlace() });

    await driveQueuedSubmissions({
      client: serviceClient().client, deadlineMs: QUEUED_AT + 65_000, dependencies: served.dependencies,
    });

    expect(served.asked).toHaveLength(1);
    expect(served.pauses).toEqual([]);
  });
});

describe('a queued start that waited too long', () => {
  const a = run('a');
  const EXPIRED_AT = QUEUED_AT + PROVIDER_ADMISSION_POLICY.queueMaxAgeMs;

  it('is taken out of the queue, refunded and its creator told, without asking the gate', async () => {
    const served = queue([a], { nowMs: EXPIRED_AT });
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(summary).toEqual({ sent: 0, queued: 0, gone: 0, expired: 1, failed: 0 });
    expect(served.asked).toEqual([]);
    expect(served.post).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledWith(client, a.generationId);
    expect(rpc).toHaveBeenCalledWith('settle_generation_start_failed', {
      p_generation_id: a.generationId,
      p_error_message: QUEUED_SUBMISSION_EXPIRED_MESSAGE,
    });
    expect(mocks.notifyFailed).toHaveBeenCalledWith({ client, generationId: a.generationId, userId: 'user-a' });
  });

  it('does not hold up the runs queued behind it', async () => {
    const b = run('b', { queuedAtMs: EXPIRED_AT - 60_000 });
    const served = queue([a, b], { nowMs: EXPIRED_AT });

    const summary = await driveQueuedSubmissions({ client: serviceClient().client, dependencies: served.dependencies });

    expect(summary).toEqual({ sent: 1, queued: 0, gone: 0, expired: 1, failed: 0 });
    expect(served.asked).toEqual([b.generationId]);
  });

  it('is left alone when something else claimed it: that caller ends it', async () => {
    const served = queue([a], { nowMs: EXPIRED_AT });
    mocks.claim.mockResolvedValue(null);
    const { client, rpc } = serviceClient();

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(summary).toMatchObject({ gone: 1, expired: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.notifyFailed).not.toHaveBeenCalled();
  });

  it('is not announced as refunded when its hold was no longer the queue\'s to return', async () => {
    // Attached by a late callback, or settled by the reaper, between the read
    // and the claim: the settlement says so, and nothing is told.
    const served = queue([a], { nowMs: EXPIRED_AT });
    const { client } = serviceClient('provider_task_attached');

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(summary).toMatchObject({ expired: 1 });
    expect(mocks.notifyFailed).not.toHaveBeenCalled();
  });

  it('is not announced again when something else had already returned its credits', async () => {
    // The reaper, or the start's own failure, told the creator when it did.
    const served = queue([a], { nowMs: EXPIRED_AT });
    const { client } = serviceClient('already_failed');

    const summary = await driveQueuedSubmissions({ client, dependencies: served.dependencies });

    expect(summary).toMatchObject({ expired: 1 });
    expect(mocks.notifyFailed).not.toHaveBeenCalled();
  });
});

describe('deleting a queued start', () => {
  const a = run('a');

  it('takes it out of the queue and returns its credits', async () => {
    queue([a]);
    const { client, rpc } = serviceClient();

    await expect(cancelQueuedSubmission(client, a.generationId)).resolves.toBe('cancelled');
    expect(mocks.claim).toHaveBeenCalledWith(client, a.generationId);
    expect(rpc).toHaveBeenCalledWith('settle_generation_start_failed', {
      p_generation_id: a.generationId,
      p_error_message: QUEUED_SUBMISSION_CANCELLED_MESSAGE,
    });
    // The creator did it themselves: there is nobody to tell.
    expect(mocks.notifyFailed).not.toHaveBeenCalled();
  });

  it('refunds nothing for a creation that is not queued', async () => {
    queue([]);
    const { client, rpc } = serviceClient();

    await expect(cancelQueuedSubmission(client, a.generationId)).resolves.toBe('not_queued');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('says so when the credits could not be returned, so the creation is kept for the reaper to settle', async () => {
    // Out of the queue already. Deleting the row now would lose the hold with it.
    queue([a]);
    const { client, rpc } = serviceClient(new Error('connection reset'));

    await expect(cancelQueuedSubmission(client, a.generationId)).resolves.toBe('refund_failed');
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('counts a hold something else settled as done: there is nothing left to lose', async () => {
    for (const status of ['already_failed', 'provider_task_attached']) {
      queue([a]);
      await expect(cancelQueuedSubmission(serviceClient(status).client, a.generationId)).resolves.toBe('cancelled');
    }
  });

  it('lets a failed claim reach its caller, which must not delete the creation', async () => {
    mocks.claim.mockRejectedValue(new Error('connection reset'));

    await expect(cancelQueuedSubmission(serviceClient().client, a.generationId)).rejects.toThrow('connection reset');
  });
});

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { getPublicGenerationStartFailure } from '@/lib/generation-public-failure';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  admitProviderSubmission,
  PROVIDER_ADMISSION_POLICY,
  providerAdmissionTurnSinceMs,
  providerSubmissionMayQueue,
  withProviderAdmissionTurn,
  withProviderSubmissionQueue,
} from '@/lib/provider-admission';
import { STALLED_GENERATION_START_FAILURE_AFTER_MINUTES } from '@/lib/stalled-generation-reaper';

const GENERATION_ID = 'e2000000-0000-4000-8000-000000000001';

const ADMITTED = {
  allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 3, waitersAhead: 0,
};

function refused(reason: string, retryAfterSeconds: number) {
  return { allowed: false, reason, state: 'closed', retryAfterSeconds, inFlight: 50, waitersAhead: 2 };
}

/** What the reservation raised, as PostgREST hands it back: an object with a message, not an `Error`. */
class Raised {
  constructor(readonly message: string) {}
}

/**
 * A database that answers each ask in turn (an `Error` is an ask that got no
 * answer, a `Raised` one the function refused to run), and a clock that only
 * the pauses between asks move.
 */
function line(answers: unknown[]) {
  let clock = 0;
  const pauses: number[] = [];
  const rpc = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Raised) return { data: null, error: { message: answer.message, code: 'P0001' } };
    return answer instanceof Error ? { data: null, error: answer } : { data: answer, error: null };
  });
  return {
    rpc,
    pauses,
    seams: {
      client: { rpc },
      now: () => clock,
      sleep: async (ms: number) => { pauses.push(ms); clock += ms; },
    },
  };
}

/**
 * The same, through a client that takes a time limit the way supabase-js does:
 * every ask after the first `fastAsks` takes `askMs` on the clock, or runs
 * into the limit it was given and comes back as the abort supabase-js reports.
 */
function slowLine(askMs: number, answers: unknown[], fastAsks = 1) {
  let clock = 0;
  let asked = 0;
  const pauses: number[] = [];
  const limits: number[] = [];
  let limit = Number.POSITIVE_INFINITY;
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    limit = ms;
    limits.push(ms);
    return new AbortController().signal;
  });
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => ({
    fn,
    args,
    abortSignal: async (): Promise<{ data: unknown; error: unknown }> => {
      asked += 1;
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      const takes = asked <= fastAsks ? 0 : askMs;
      if (takes > limit) {
        clock += limit;
        return { data: null, error: { message: 'TimeoutError: The operation was aborted due to timeout' } };
      }
      clock += takes;
      return { data: answer, error: null };
    },
  }));
  return {
    rpc,
    pauses,
    limits,
    clock: () => clock,
    seams: {
      client: { rpc } as never,
      now: () => clock,
      sleep: async (ms: number) => { pauses.push(ms); clock += ms; },
    },
  };
}

function argsOfAsk(rpc: { mock: { calls: unknown[][] } }, ask: number) {
  return (rpc.mock.calls[ask] as [string, Record<string, unknown>])[1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a start that may not be queued', () => {
  it('is refused outright', async () => {
    // A template or workflow step has a durable retry of its own. It is
    // refused at once, as every over-limit start once was, and comes back later.
    const { rpc, pauses, seams } = line([refused('rate_limited', 2)]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, ...seams }))
      .rejects.toMatchObject({ status: 429 });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(argsOfAsk(rpc, 0)).toMatchObject({ p_generation_id: GENERATION_ID, p_turn_since: null });
    // The queue is the line. Nothing takes a ticket to wait in its request.
    expect(argsOfAsk(rpc, 0)).not.toHaveProperty('p_wait');
    expect(pauses).toEqual([]);
  });

  it('is refused whatever the refusal, when its caller cannot queue it', async () => {
    for (const reason of ['rate_limited', 'model_rate_limited', 'max_in_flight', 'circuit_open']) {
      const { seams } = line([refused(reason, 2)]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: false, ...seams }))
        .rejects.toBeInstanceOf(GenerationServiceError);
    }
  });
});

describe('a creator\'s start over the limits', () => {
  it('comes back as a verdict to queue the run on, not as an error', async () => {
    const { rpc, pauses, seams } = line([refused('max_in_flight', 15)]);

    const verdict = await admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams });

    expect(verdict).toMatchObject({ allowed: false, reason: 'max_in_flight', waitersAhead: 2 });
    // One ask: the request does not wait for the place. The queue does.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });

  it('is told so for each of the three refusals a place clears', async () => {
    for (const reason of ['rate_limited', 'model_rate_limited', 'max_in_flight']) {
      const { seams } = line([refused(reason, 1)]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams }))
        .resolves.toMatchObject({ allowed: false, reason });
    }
  });

  it('goes straight through when there is a place', async () => {
    const { seams } = line([ADMITTED]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams }))
      .resolves.toMatchObject({ allowed: true, reason: 'admitted' });
  });

  it('is still refused for the breaker: no queue clears a provider outage', async () => {
    for (const reason of ['circuit_open', 'circuit_probe_in_flight']) {
      const { seams } = line([refused(reason, 30)]);
      const error = await admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams })
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(GenerationServiceError);
      expect(getPublicGenerationStartFailure(error).code).toBe('provider_busy');
      // The one error type the settle helper would hold the credits for.
      expect(isExternalServiceTimeoutError(error)).toBe(false);
    }
  });

  it('cannot be queued without a generation: the row is what waits', async () => {
    const { rpc, seams } = line([refused('rate_limited', 2)]);

    await expect(admitProviderSubmission({ mayQueue: true, ...seams })).rejects.toMatchObject({ status: 429 });

    expect(rpc).toHaveBeenCalledWith('admit_provider_submission', expect.any(Object));
    expect(argsOfAsk(rpc, 0)).not.toHaveProperty('p_generation_id');
    expect(argsOfAsk(rpc, 0)).not.toHaveProperty('p_turn_since');
  });

  it('still fails open when the gate cannot be reached at all', async () => {
    for (const down of [new Error('relation does not exist'), new Raised('permission denied for function')]) {
      const { seams } = line([down]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams }))
        .resolves.toMatchObject({ allowed: true, state: 'unknown' });
    }
  });

  it('does not fail open for what sends queued runs: a gate it could not ask is no turn', async () => {
    // A start fails open because the alternative is refusing it. A queued run
    // waits anyway, and "could not ask" may be the database saying the
    // generation is no longer one to send.
    for (const down of [new Error('relation does not exist'), new Raised('Generation is already terminal')]) {
      const { seams } = line([down]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, failOpen: false, ...seams }))
        .resolves.toMatchObject({ allowed: false, reason: 'unavailable' });
    }
  });

  it('gives one ask a time limit where the client can be told to', async () => {
    const { limits, seams } = slowLine(1_000, [ADMITTED], 0);

    await admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams });

    expect(limits).toEqual([PROVIDER_ADMISSION_POLICY.askTimeoutMs]);
  });

  it('is queued, not let through, when the gate takes too long to answer', async () => {
    // A reservation that runs into its time limit is waiting behind others:
    // that is load, not an outage. Failing open on it would lift every limit
    // at the moment the gate is busiest. The run is queued and asked for again.
    const { seams } = slowLine(15_000, [ADMITTED], 0);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, mayQueue: true, ...seams }))
      .resolves.toMatchObject({ allowed: false, reason: 'rate_limited' });
  });

  it('is refused when the gate takes too long and the start may not be queued', async () => {
    const { seams } = slowLine(15_000, [ADMITTED], 0);

    const error = await admitProviderSubmission({ generationId: GENERATION_ID, ...seams }).catch((thrown) => thrown);

    expect(error).toMatchObject({ status: 429 });
    expect(getPublicGenerationStartFailure(error).code).toBe('provider_busy');
  });
});

describe('the queue scope', () => {
  it('is closed unless a caller opens it', () => {
    expect(providerSubmissionMayQueue()).toBe(false);
  });

  it('reaches a submission made anywhere inside it, across awaits', async () => {
    const { rpc, seams } = line([refused('rate_limited', 2)]);

    const verdict = await withProviderSubmissionQueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(providerSubmissionMayQueue()).toBe(true);
      return admitProviderSubmission({ generationId: GENERATION_ID, ...seams });
    });

    expect(verdict).toMatchObject({ allowed: false, reason: 'rate_limited' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(providerSubmissionMayQueue()).toBe(false);
  });

  it('is closed again inside a run step, which is never queued', async () => {
    await withProviderSubmissionQueue(() => withProviderAdmissionTurn(null, async () => {
      expect(providerSubmissionMayQueue()).toBe(false);
    }));
  });
});

describe('a run step\'s turn', () => {
  it('is nothing outside a step, and nothing for a creator\'s start', () => {
    expect(providerAdmissionTurnSinceMs()).toBeNull();
    expect(withProviderSubmissionQueue(() => providerAdmissionTurnSinceMs())).toBeNull();
  });

  it('dates the step\'s place in line from when it was first turned away, without queueing it', async () => {
    // A step holds no ticket: its own retry brings it back. Behind every
    // ticket on every retry it would never get in while creators keep
    // arriving. It is behind only the tickets older than its first refusal.
    const firstRefusedAt = Date.parse('2026-11-14T11:40:00Z');
    const { rpc, pauses, seams } = line([refused('rate_limited', 2)]);

    await withProviderAdmissionTurn(firstRefusedAt, async () => {
      expect(providerAdmissionTurnSinceMs()).toBe(firstRefusedAt);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, ...seams }))
        .rejects.toMatchObject({ status: 429 });
    });

    expect(argsOfAsk(rpc, 0)).toMatchObject({ p_turn_since: '2026-11-14T11:40:00.000Z' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });

  it('has no turn yet on a step\'s first try', async () => {
    const { rpc, seams } = line([ADMITTED]);

    await withProviderAdmissionTurn(null, () => admitProviderSubmission({ generationId: GENERATION_ID, ...seams }));

    expect(argsOfAsk(rpc, 0)).toMatchObject({ p_turn_since: null });
    expect(withProviderAdmissionTurn(Number.NaN, () => providerAdmissionTurnSinceMs())).toBeNull();
  });

  it('is what both run workers start their steps with', () => {
    for (const worker of ['src/lib/workflow-runner.ts', 'src/lib/template-run-service.ts']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), worker), 'utf8');
      expect(source).toMatch(/withProviderAdmissionTurn\(stepBusySince\((queuedStep|step)\), \(\) => executeWorkflowRunnableNode\(/);
      expect(source.split('await executeWorkflowRunnableNode(').length - 1).toBe(0);
    }
  });
});

describe('the queue\'s policy', () => {
  const {
    queueMaxAgeMs, queueMax, queueUserMax, queueDriveBudgetMs, queuePollMs, rateWindowSeconds,
  } = PROVIDER_ADMISSION_POLICY;

  it('refunds a queued run long before its signed input links run out', () => {
    // The stored provider request carries links to the creator's inputs signed
    // for an hour. A run sent after that would be refused by the provider for
    // inputs it can no longer read.
    const helpers = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/server-helpers.ts'), 'utf8');
    const signed = /mediaSignatureSeconds\((\d+)\)/.exec(helpers);
    expect(signed).not.toBeNull();

    expect(queueMaxAgeMs).toBeGreaterThan(0);
    expect(queueMaxAgeMs).toBeLessThanOrEqual((Number(signed![1]) * 1000) / 2);
  });

  it('ends a queued run itself, before the reaper would settle it from under the queue', () => {
    expect(queueMaxAgeMs).toBeLessThan(STALLED_GENERATION_START_FAILURE_AFTER_MINUTES * 60 * 1000);
  });

  it('drives a queued run for less time than the start route is given', () => {
    // The request that queued the run goes on asking after it has answered,
    // inside the route's own time. It needs room to create the provider task
    // once the place comes.
    const route = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/generations/route.ts'), 'utf8');
    const declared = /export const maxDuration = (\d+);/.exec(route);
    expect(declared).not.toBeNull();

    expect(queueDriveBudgetMs).toBeGreaterThanOrEqual(rateWindowSeconds * 1000);
    expect(queueDriveBudgetMs + 45_000).toBeLessThanOrEqual(Number(declared![1]) * 1000);
  });

  it('holds one creator to a small share of the queue', () => {
    expect(queueUserMax).toBeGreaterThanOrEqual(1);
    expect(queueUserMax).toBeLessThan(queueMax);
  });

  it('looks at the queue again several times inside one rate window', () => {
    // A place that opens for the run at the head of the queue stays empty
    // until something looks.
    expect(queuePollMs).toBeGreaterThanOrEqual(500);
    expect(queuePollMs * 4).toBeLessThanOrEqual(rateWindowSeconds * 1000);
  });
});

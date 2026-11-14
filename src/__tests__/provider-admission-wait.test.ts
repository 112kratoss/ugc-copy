import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { getPublicGenerationStartFailure } from '@/lib/generation-public-failure';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  admitProviderSubmission,
  PROVIDER_ADMISSION_POLICY,
  providerAdmissionWaitBudgetMs,
  withProviderAdmissionWait,
} from '@/lib/provider-admission';

const GENERATION_ID = 'e2000000-0000-4000-8000-000000000001';

const ADMITTED = {
  allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 3, waiting: false, waitersAhead: 0,
};

function refused(reason: string, retryAfterSeconds: number, waiting = true) {
  return { allowed: false, reason, state: 'closed', retryAfterSeconds, inFlight: 50, waiting, waitersAhead: 2 };
}

/**
 * A database that answers each ask in turn (an `Error` is an ask that got no
 * answer), and a clock that only the pauses between asks move.
 */
function line(answers: unknown[]) {
  let clock = 0;
  const pauses: number[] = [];
  const rpc = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
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

function argsOfAsk(rpc: ReturnType<typeof line>['rpc'], ask: number) {
  return (rpc.mock.calls[ask] as unknown as [string, Record<string, unknown>])[1];
}

describe('waiting in line for provider admission', () => {
  it('does not wait unless the caller asked to', async () => {
    // A template or workflow step has a durable retry of its own and a worker
    // whose time every step in its batch shares. It is refused at once, as
    // before, and takes no ticket.
    const { rpc, pauses, seams } = line([refused('rate_limited', 2, false)]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, ...seams }))
      .rejects.toMatchObject({ status: 429 });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(argsOfAsk(rpc, 0).p_wait).toBe(false);
    expect(pauses).toEqual([]);
  });

  it('asks again when the refusal said a place opens, and is admitted', async () => {
    const { rpc, pauses, seams } = line([refused('rate_limited', 2), ADMITTED]);

    const verdict = await admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams });

    expect(verdict).toMatchObject({ allowed: true, reason: 'admitted', waitedMs: 2_000 });
    expect(pauses).toEqual([2_000]);
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const ask of [0, 1]) {
      expect(argsOfAsk(rpc, ask)).toMatchObject({
        p_generation_id: GENERATION_ID,
        p_wait: true,
        p_waiter_ttl_seconds: PROVIDER_ADMISSION_POLICY.waiterTtlSeconds,
      });
    }
  });

  it('never sleeps past the heartbeat its ticket needs', async () => {
    // A full window says "twelve seconds". Sleeping that long would let the
    // ticket's heartbeat lapse and hand the turn to whoever is behind.
    const { pauses, seams } = line([refused('rate_limited', 12), refused('max_in_flight', 15), ADMITTED]);

    await admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams });

    expect(pauses).toEqual([PROVIDER_ADMISSION_POLICY.waitPollMaxMs, PROVIDER_ADMISSION_POLICY.waitPollMaxMs]);
  });

  it('waits for each of the three capacity refusals', async () => {
    for (const reason of ['rate_limited', 'model_rate_limited', 'max_in_flight']) {
      const { rpc, seams } = line([refused(reason, 1), ADMITTED]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams }))
        .resolves.toMatchObject({ allowed: true });
      expect(rpc).toHaveBeenCalledTimes(2);
    }
  });

  it('gives up when its budget is spent, as a refusal that refunds', async () => {
    const { rpc, pauses, seams } = line([refused('max_in_flight', 15)]);

    const error = await admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 10_000, ...seams })
      .catch((thrown) => thrown);

    // 4 s + 4 s + the 2 s that were left, then the ask that found the budget spent.
    expect(pauses).toEqual([4_000, 4_000, 2_000]);
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(GenerationServiceError);
    expect(error).toMatchObject({ status: 429 });
    expect(getPublicGenerationStartFailure(error).code).toBe('provider_busy');
    // The one error type the settle helper would hold the credits for.
    expect(isExternalServiceTimeoutError(error)).toBe(false);
  });

  it('does not wait on the breaker: nothing in line clears a provider outage', async () => {
    for (const reason of ['circuit_open', 'circuit_probe_in_flight']) {
      const { rpc, pauses, seams } = line([refused(reason, 30, false)]);
      await expect(admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams }))
        .rejects.toBeInstanceOf(GenerationServiceError);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(pauses).toEqual([]);
    }
  });

  it('does not wait when the database gave it no ticket', async () => {
    // The database decides who is in line. A refusal without a ticket (a
    // function from before the line, say) is final: asking again would be
    // barging, not waiting.
    const { rpc, seams } = line([refused('rate_limited', 2, false)]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams }))
      .rejects.toMatchObject({ status: 429 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('cannot wait without a generation: the row is its ticket', async () => {
    const { rpc, pauses, seams } = line([refused('rate_limited', 2)]);

    await expect(admitProviderSubmission({ waitBudgetMs: 45_000, ...seams })).rejects.toMatchObject({ status: 429 });

    expect(rpc).toHaveBeenCalledWith('admit_provider_submission', expect.any(Object));
    expect(argsOfAsk(rpc, 0)).not.toHaveProperty('p_wait');
    expect(argsOfAsk(rpc, 0)).not.toHaveProperty('p_waiter_ttl_seconds');
    expect(pauses).toEqual([]);
  });

  it('still fails open when the first ask gets no answer', async () => {
    const { seams } = line([new Error('relation does not exist')]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams }))
      .resolves.toMatchObject({ allowed: true, state: 'unknown', waitedMs: 0 });
  });

  it('keeps waiting, and does not fail open, when a later ask gets no answer', async () => {
    // One failed ask letting a waiting start through would send the whole line
    // at once, at the moment the database is struggling. The gate's last word
    // was "no place yet", and it stands until the gate says otherwise.
    const { rpc, pauses, seams } = line([refused('rate_limited', 3), new Error('fetch failed'), ADMITTED]);

    const verdict = await admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams });

    expect(verdict).toMatchObject({ allowed: true, state: 'closed', waitedMs: 6_000 });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([3_000, 3_000]);
  });

  it('gives up as refused when the asks stop being answered', async () => {
    const { seams } = line([refused('rate_limited', 4), new Error('fetch failed')]);

    await expect(admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 9_000, ...seams }))
      .rejects.toMatchObject({ status: 429 });
  });

  it('never spins: a hint that rounds to nothing still pauses', async () => {
    const { pauses, seams } = line([refused('rate_limited', 0), ADMITTED]);

    await admitProviderSubmission({ generationId: GENERATION_ID, waitBudgetMs: 45_000, ...seams });

    expect(pauses).toEqual([PROVIDER_ADMISSION_POLICY.waitPollMaxMs]);
  });
});

describe('the wait scope', () => {
  it('is nothing unless a caller opens it', () => {
    expect(providerAdmissionWaitBudgetMs()).toBe(0);
  });

  it('reaches a submission made anywhere inside it, across awaits', async () => {
    const seen = await withProviderAdmissionWait(45_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return providerAdmissionWaitBudgetMs();
    });

    expect(seen).toBe(45_000);
    expect(providerAdmissionWaitBudgetMs()).toBe(0);
  });

  it('is what a submission waits on when it names no budget of its own', async () => {
    const { rpc, seams } = line([refused('rate_limited', 1), ADMITTED]);

    await withProviderAdmissionWait(45_000, () => admitProviderSubmission({ generationId: GENERATION_ID, ...seams }));

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(argsOfAsk(rpc, 0).p_wait).toBe(true);
  });

  it('holds a negative or fractional budget to a whole number of milliseconds', () => {
    expect(withProviderAdmissionWait(-5, () => providerAdmissionWaitBudgetMs())).toBe(0);
    expect(withProviderAdmissionWait(1500.7, () => providerAdmissionWaitBudgetMs())).toBe(1500);
  });
});

describe('the waiting policy', () => {
  const { waitBudgetMs, agentWaitBudgetMs, waitPollMaxMs, waiterTtlSeconds, rateWindowSeconds } = PROVIDER_ADMISSION_POLICY;

  it('ends well before the app abandons the start', () => {
    // The wait is spent inside the start's request. The app gives a start
    // GENERATION_START_TIMEOUT_MS, and a start that is cut off while the server
    // goes on to run it reads as a failure the creator was charged for.
    const apiClient = fs.readFileSync(path.resolve(process.cwd(), 'ugc-mobile/lib/api-client.ts'), 'utf8');
    const declared = /const GENERATION_START_TIMEOUT_MS = ([\d_]+);/.exec(apiClient);
    expect(declared).not.toBeNull();
    const appTimeoutMs = Number(declared![1].replaceAll('_', ''));

    expect(waitBudgetMs).toBeGreaterThan(0);
    expect(waitBudgetMs).toBeLessThanOrEqual(appTimeoutMs / 2);
  });

  it('covers at least three rate windows, so a burst three windows deep is served', () => {
    expect(waitBudgetMs).toBeGreaterThanOrEqual(3 * rateWindowSeconds * 1000);
  });

  it('gives an agent no longer than a creator', () => {
    expect(agentWaitBudgetMs).toBeGreaterThan(0);
    expect(agentWaitBudgetMs).toBeLessThanOrEqual(waitBudgetMs);
  });

  it('keeps a ticket alive through one slow ask', () => {
    // The heartbeat is the ask itself, at most waitPollMaxMs apart. A ticket
    // that lapsed between two asks would lose its turn to the start behind it.
    expect(waiterTtlSeconds * 1000).toBeGreaterThanOrEqual(3 * waitPollMaxMs);
    expect(waitPollMaxMs).toBeLessThan(rateWindowSeconds * 1000);
  });
});

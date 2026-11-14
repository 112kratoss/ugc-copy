import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { getPublicGenerationStartFailure } from '@/lib/generation-public-failure';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  claimQueuedProviderSubmission,
  enqueueProviderSubmission,
} from '@/lib/generation-submission-queue-store';
import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

const GENERATION_ID = 'e2000000-0000-4000-8000-000000000001';

const TASK = {
  endpoint: 'https://api.kie.ai/api/v1/jobs/createTask',
  body: { model: 'nano-banana-2', input: { prompt: 'a paper boat' } },
  callbackUrl: 'https://example.invalid/callback?generationId=e2000000',
  modelId: 'nano-banana-2',
};

function client(answer: { data?: unknown; error?: unknown } | Error) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    if (answer instanceof Error) throw answer;
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  return { rpc };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('queueing a generation start', () => {
  it('stores the request as it would have been sent, under the limits the app owns', async () => {
    const queue = client({ data: { status: 'queued', queuedAt: '2026-11-15T10:00:00.250Z', ahead: 3 } });

    await expect(enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: queue as never }))
      .resolves.toEqual({ queuedAtMs: Date.parse('2026-11-15T10:00:00.250Z'), ahead: 3 });

    expect(queue.rpc).toHaveBeenCalledWith('enqueue_provider_submission', {
      p_generation_id: GENERATION_ID,
      p_service: 'kie',
      p_model: 'nano-banana-2',
      p_endpoint: TASK.endpoint,
      // The callback address travels with the body, as it is sent.
      p_request: { ...TASK.body, callBackUrl: TASK.callbackUrl },
      p_queue_max: PROVIDER_ADMISSION_POLICY.queueMax,
      p_user_queue_max: PROVIDER_ADMISSION_POLICY.queueUserMax,
    });
  });

  it.each([
    ['queue_full', 'Too many generations are waiting to start'],
    ['user_queue_full', 'You already have several generations waiting to start'],
    ['not_queueable', 'Too many generations are waiting to start'],
    ['missing', 'Too many generations are waiting to start'],
  ])('refuses a start the queue will not take (%s) as busy, which its caller refunds', async (status, words) => {
    const error = await enqueueProviderSubmission({
      generationId: GENERATION_ID, task: TASK, client: client({ data: { status } }) as never,
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(GenerationServiceError);
    expect(error).toMatchObject({ status: 429 });
    expect(error.message).toContain(words);
    expect(error.message).toContain('No credits were charged');
    expect(getPublicGenerationStartFailure(error).code).toBe('provider_busy');
    // The one error type the settle helper would hold the credits for.
    expect(isExternalServiceTimeoutError(error)).toBe(false);
  });

  it('cannot fail open: a queue it could not reach is a refusal, never a "queued" for nothing', async () => {
    // Failing open on the gate sends the run. Here it would answer queued for
    // a run nothing holds a request for, which would then never start.
    for (const down of [new Error('fetch failed'), { error: { message: 'relation does not exist' } }]) {
      const queue = client(down);
      await expect(enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: queue as never }))
        .rejects.toMatchObject({ status: 429 });
      // Asked twice: the first answer may only have been lost on its way back.
      expect(queue.rpc).toHaveBeenCalledTimes(2);
    }
  });

  /** A queue whose first answer is lost and whose second is `second`. */
  function lostThen(second: { data?: unknown; error?: unknown }) {
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: second.data ?? null, error: second.error ?? null }));
    rpc.mockRejectedValueOnce(new Error('fetch failed'));
    return { rpc };
  }

  it('asks again when the answer was lost, and keeps the place the first ask took', async () => {
    // The row may have been written before the answer was lost. A start that
    // refunded itself there would leave a request queued for a run nobody is
    // paying for. Asked again, a run already queued answers with its place.
    const queue = lostThen({ data: { status: 'queued', queuedAt: '2026-11-15T10:00:00.250Z', replayed: true } });

    await expect(enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: queue as never }))
      .resolves.toEqual({ queuedAtMs: Date.parse('2026-11-15T10:00:00.250Z'), ahead: null });
    expect(queue.rpc).toHaveBeenCalledTimes(2);
  });

  it('answers queued when the lost ask did queue it and a pass has taken it to send since', async () => {
    // Asked again it is "not queueable": reserved or attached, because it is
    // on its way to the provider. Refusing here would refund a run being sent.
    const queue = lostThen({ data: { status: 'not_queueable' } });

    await expect(enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: queue as never }))
      .resolves.toMatchObject({ ahead: null });
  });

  it('still refuses a start the queue will not take when asked the second time', async () => {
    for (const status of ['queue_full', 'user_queue_full', 'missing']) {
      await expect(enqueueProviderSubmission({
        generationId: GENERATION_ID, task: TASK, client: lostThen({ data: { status } }) as never,
      })).rejects.toMatchObject({ status: 429 });
    }
  });

  it('asks once when the queue answers, whatever it says', async () => {
    for (const status of ['queued', 'queue_full', 'not_queueable']) {
      const queue = client({ data: { status, queuedAt: '2026-11-15T10:00:00.250Z' } });
      await enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: queue as never }).catch(() => undefined);
      expect(queue.rpc).toHaveBeenCalledTimes(1);
    }
  });
});

describe('claiming a queued start', () => {
  it('hands back the request ready to send, the callback apart from the body', async () => {
    const queue = client({
      data: {
        generationId: GENERATION_ID,
        userId: 'user-1',
        service: 'kie',
        model: 'nano-banana-2',
        endpoint: TASK.endpoint,
        request: { ...TASK.body, callBackUrl: TASK.callbackUrl },
        queuedAt: '2026-11-15T10:00:00.250Z',
        sendable: true,
      },
    });

    await expect(claimQueuedProviderSubmission(queue as never, GENERATION_ID)).resolves.toEqual({
      generationId: GENERATION_ID,
      userId: 'user-1',
      task: TASK,
      queuedAtMs: Date.parse('2026-11-15T10:00:00.250Z'),
      sendable: true,
    });
    expect(queue.rpc).toHaveBeenCalledWith('claim_queued_provider_submission', { p_generation_id: GENERATION_ID });
  });

  it('says a claimed request may be sent only on the database\'s own word', async () => {
    // A generation settled, attached or marked unknown while its row waited
    // holds no credits for a send. Anything but `true` reads as that.
    const row = {
      generationId: GENERATION_ID, userId: 'user-1', service: 'kie', model: 'nano-banana-2',
      endpoint: TASK.endpoint, request: { ...TASK.body, callBackUrl: TASK.callbackUrl }, queuedAt: '2026-11-15T10:00:00.250Z',
    };
    for (const sendable of [false, undefined, null, 'true', 1]) {
      await expect(claimQueuedProviderSubmission(client({ data: { ...row, sendable } }) as never, GENERATION_ID))
        .resolves.toMatchObject({ sendable: false });
    }
  });

  it('answers null when there is nothing to claim: never queued, or claimed by something else', async () => {
    await expect(claimQueuedProviderSubmission(client({ data: null }) as never, GENERATION_ID)).resolves.toBeNull();
  });

  it('throws when the queue could not be asked, so its caller does not act as if it held the request', async () => {
    await expect(claimQueuedProviderSubmission(
      client({ error: { message: 'connection reset' } }) as never, GENERATION_ID,
    )).rejects.toMatchObject({ message: 'connection reset' });
  });
});

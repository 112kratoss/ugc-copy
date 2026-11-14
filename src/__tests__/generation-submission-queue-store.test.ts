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
      await expect(enqueueProviderSubmission({ generationId: GENERATION_ID, task: TASK, client: client(down) as never }))
        .rejects.toMatchObject({ status: 429 });
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
      },
    });

    await expect(claimQueuedProviderSubmission(queue as never, GENERATION_ID)).resolves.toEqual({
      generationId: GENERATION_ID,
      userId: 'user-1',
      task: TASK,
      queuedAtMs: Date.parse('2026-11-15T10:00:00.250Z'),
    });
    expect(queue.rpc).toHaveBeenCalledWith('claim_queued_provider_submission', { p_generation_id: GENERATION_ID });
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

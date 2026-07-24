import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachGenerationProviderTask: vi.fn(),
  enqueueGenerationCompletionJob: vi.fn(),
  processGenerationCompletionJobs: vi.fn(),
}));

vi.mock('@/lib/generation-services', () => ({
  attachGenerationProviderTask: (...args: unknown[]) => mocks.attachGenerationProviderTask(...args),
}));

vi.mock('@/lib/generation-completion-jobs', () => ({
  enqueueGenerationCompletionJob: (...args: unknown[]) => mocks.enqueueGenerationCompletionJob(...args),
  processGenerationCompletionJobs: (...args: unknown[]) => mocks.processGenerationCompletionJobs(...args),
}));

function signedKieRequest(
  payload: Record<string, unknown>,
  timestamp = '1782039000',
  path = 'http://localhost/api/webhooks/kie',
  headers: Record<string, string> = {},
) {
  const rawBody = JSON.stringify(payload);
  const generationId = new URL(path).searchParams.get('generationId')?.trim() ?? '';
  const signature = createHmac('sha256', 'hmac-key')
    .update(JSON.stringify(['kie-webhook-v2', 'task-1', timestamp, generationId, rawBody]))
    .digest('base64');

  return new Request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-payload-signature': signature,
      ...headers,
    },
    body: rawBody,
  });
}

describe('kie webhook service', () => {
  const serviceClient = { service: 'supabase' };
  const createServiceClient = vi.fn(() => serviceClient);
  const scheduleAfter = vi.fn((callback: () => Promise<void> | void) => callback());

  beforeEach(() => {
    vi.resetModules();
    createServiceClient.mockClear();
    scheduleAfter.mockClear();
    mocks.attachGenerationProviderTask.mockReset();
    mocks.enqueueGenerationCompletionJob.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    mocks.attachGenerationProviderTask.mockResolvedValue('attached');
    mocks.enqueueGenerationCompletionJob.mockResolvedValue('job-1');
    mocks.processGenerationCompletionJobs.mockResolvedValue({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
  });

  it('rejects oversized payloads before JSON parsing or privileged service work', async () => {
    const { handleKieWebhookForRoute } = await import('@/lib/kie-webhook-service');
    const result = await handleKieWebhookForRoute({
      createServiceClient,
      env: { KIE_WEBHOOK_HMAC_KEY: 'hmac-key' },
      nowSeconds: 1782039000,
      request: signedKieRequest(
        { data: { taskId: 'task-1', state: 'success' } },
        '1782039000',
        'http://localhost/api/webhooks/kie',
        { 'content-length': '262145' },
      ),
      scheduleAfter,
    });

    expect(result).toEqual({
      body: { error: 'Webhook payload is too large.' },
      status: 413,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(mocks.enqueueGenerationCompletionJob).not.toHaveBeenCalled();
    expect(scheduleAfter).not.toHaveBeenCalled();
  });

  it('authenticates, enqueues, and schedules provider completion processing', async () => {
    const { handleKieWebhookForRoute } = await import('@/lib/kie-webhook-service');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const result = await handleKieWebhookForRoute({
      createServiceClient,
      env: { KIE_WEBHOOK_HMAC_KEY: 'hmac-key' },
      nowSeconds: 1782039000,
      request: signedKieRequest(payload),
      scheduleAfter,
    });

    expect(result).toEqual({
      body: { received: true, predictionId: 'task-1' },
      status: 200,
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalledWith(serviceClient, {
      predictionId: 'task-1',
      payload,
    });
    expect(scheduleAfter).toHaveBeenCalledTimes(1);
    expect(mocks.processGenerationCompletionJobs).toHaveBeenCalledWith({
      supabase: serviceClient,
      creditSupabase: serviceClient,
      lockedBy: 'kie-webhook:task-1:1782039000000',
      limit: 5,
      predictionId: 'task-1',
    });
  });

  it('adds callback generation metadata after attaching a provider task id', async () => {
    const { handleKieWebhookForRoute } = await import('@/lib/kie-webhook-service');
    const payload = {
      data: { taskId: 'task-1', state: 'success' },
      magicbooklet: { existing: true },
    };
    const result = await handleKieWebhookForRoute({
      createServiceClient,
      env: { KIE_WEBHOOK_HMAC_KEY: 'hmac-key' },
      nowSeconds: 1782039000,
      request: signedKieRequest(payload, '1782039000', 'http://localhost/api/webhooks/kie?generationId=gen-1'),
      scheduleAfter,
    });

    expect(result.status).toBe(200);
    expect(mocks.attachGenerationProviderTask).toHaveBeenCalledWith(serviceClient, {
      generationId: 'gen-1',
      predictionId: 'task-1',
    });
    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalledWith(serviceClient, {
      predictionId: 'task-1',
      payload: {
        ...payload,
        magicbooklet: {
          existing: true,
          callbackGenerationId: 'gen-1',
        },
      },
    });
  });

  it('does not enqueue completion work when provider task attachment is skipped', async () => {
    mocks.attachGenerationProviderTask.mockResolvedValueOnce('already_settled');
    const { handleKieWebhookForRoute } = await import('@/lib/kie-webhook-service');
    const result = await handleKieWebhookForRoute({
      createServiceClient,
      env: { KIE_WEBHOOK_HMAC_KEY: 'hmac-key' },
      nowSeconds: 1782039000,
      request: signedKieRequest(
        { data: { taskId: 'task-1', state: 'success' } },
        '1782039000',
        'http://localhost/api/webhooks/kie?generationId=gen-1',
      ),
      scheduleAfter,
    });

    expect(result).toEqual({
      body: { received: true, predictionId: 'task-1' },
      status: 200,
    });
    expect(mocks.enqueueGenerationCompletionJob).not.toHaveBeenCalled();
    expect(scheduleAfter).not.toHaveBeenCalled();
  });
});

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachGenerationProviderTask: vi.fn(),
  enqueueGenerationCompletionJob: vi.fn(),
  processGenerationCompletionJobs: vi.fn(),
  processGenerationOutputImportJobs: vi.fn(),
  processTemplateRunJobs: vi.fn(),
  processWorkflowRunStepJobs: vi.fn(),
}));

vi.mock('@/lib/generation-services', () => ({
  attachGenerationProviderTask: (...args: unknown[]) => mocks.attachGenerationProviderTask(...args),
}));

vi.mock('@/lib/generation-completion-jobs', () => ({
  enqueueGenerationCompletionJob: (...args: unknown[]) => mocks.enqueueGenerationCompletionJob(...args),
  processGenerationCompletionJobs: (...args: unknown[]) => mocks.processGenerationCompletionJobs(...args),
}));

vi.mock('@/lib/workflow-run-jobs-processor', () => ({
  WORKFLOW_RUN_STEP_BATCH_LIMIT: 10,
  processWorkflowRunStepJobs: (...args: unknown[]) => mocks.processWorkflowRunStepJobs(...args),
}));

vi.mock('@/lib/template-run-jobs-processor', () => ({
  TEMPLATE_RUN_JOB_BATCH_LIMIT: 10,
  processTemplateRunJobs: (...args: unknown[]) => mocks.processTemplateRunJobs(...args),
}));

vi.mock('@/lib/generation-output-import-jobs-processor', () => ({
  GENERATION_OUTPUT_IMPORT_BATCH_LIMIT: 4,
  processGenerationOutputImportJobs: (...args: unknown[]) => (
    mocks.processGenerationOutputImportJobs(...args)
  ),
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
  const rpc = vi.fn(async () => ({ data: { status: 'not_applicable' }, error: null }));
  const serviceClient = { service: 'supabase', rpc };
  const createServiceClient = vi.fn(() => serviceClient);
  const scheduleAfter = vi.fn((callback: () => Promise<void> | void) => callback());

  beforeEach(() => {
    vi.resetModules();
    createServiceClient.mockClear();
    scheduleAfter.mockClear();
    rpc.mockClear();
    mocks.attachGenerationProviderTask.mockReset();
    mocks.enqueueGenerationCompletionJob.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    mocks.processGenerationOutputImportJobs.mockReset();
    mocks.processTemplateRunJobs.mockReset();
    mocks.processWorkflowRunStepJobs.mockReset();
    mocks.attachGenerationProviderTask.mockResolvedValue('attached');
    mocks.enqueueGenerationCompletionJob.mockResolvedValue('job-1');
    mocks.processGenerationCompletionJobs.mockResolvedValue({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    mocks.processGenerationOutputImportJobs.mockResolvedValue({ claimed: 1, completed: 1 });
    mocks.processWorkflowRunStepJobs.mockResolvedValue({ claimed: 1, advanced: 1 });
    mocks.processTemplateRunJobs.mockResolvedValue({ claimed: 1, completed: 1 });
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
    await vi.waitFor(() => {
      expect(mocks.processWorkflowRunStepJobs).toHaveBeenCalledWith({
        supabase: serviceClient,
        lockedBy: 'kie-webhook:task-1:1782039000000:workflow',
        limit: 2,
      });
      expect(mocks.processTemplateRunJobs).toHaveBeenCalledWith({
        client: serviceClient,
        lockedBy: 'kie-webhook:task-1:1782039000000:template',
        limit: 2,
      });
    });
    expect(mocks.processGenerationOutputImportJobs).toHaveBeenCalledWith({
      client: serviceClient,
      lockedBy: 'kie-webhook:task-1:1782039000000:output-import',
      limit: 1,
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

  it('offers a skipped callback for reconciliation before dropping it', async () => {
    // The residual F14 race: the grace window shrinks it but cannot remove it.
    // A callback that lands after the reaper refunded is a real discrepancy --
    // the provider ran the task and will bill for it -- so it has to leave an
    // artifact that outlives the request, not just a log line.
    mocks.attachGenerationProviderTask.mockResolvedValueOnce('already_settled');
    rpc.mockResolvedValueOnce({
      data: { status: 'recorded', refunded_credits: 40 },
      error: null,
    } as never);

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

    expect(rpc).toHaveBeenCalledWith('record_provider_submission_reconciliation', {
      p_generation_id: 'gen-1',
      p_prediction_id: 'task-1',
    });
    // Still a 200: the provider must not retry a payload we can no longer use.
    expect(result.status).toBe(200);
    expect(mocks.enqueueGenerationCompletionJob).not.toHaveBeenCalled();
  });

  it('never fails the webhook when reconciliation bookkeeping errors', async () => {
    mocks.attachGenerationProviderTask.mockResolvedValueOnce('already_settled');
    rpc.mockRejectedValueOnce(new Error('ledger unavailable') as never);

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
  });

  it('leaves the normal completion path free of reconciliation work', async () => {
    // A callback that attaches cleanly is not a discrepancy. Pinned because the
    // reconciliation call sits on the shared webhook path: if it ever fired here
    // it would add an RPC round-trip to every successful generation.
    const { handleKieWebhookForRoute } = await import('@/lib/kie-webhook-service');
    await handleKieWebhookForRoute({
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

    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn((callback: () => Promise<void> | void) => callback()),
  createServiceClient: vi.fn(),
  enqueueGenerationCompletionJob: vi.fn(),
  processGenerationCompletionJobs: vi.fn(),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: mocks.after,
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

vi.mock('@/lib/generation-completion-jobs', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-completion-jobs')>(
    '@/lib/generation-completion-jobs',
  );
  return {
    ...actual,
    enqueueGenerationCompletionJob: (...args: unknown[]) => mocks.enqueueGenerationCompletionJob(...args),
    processGenerationCompletionJobs: (...args: unknown[]) => mocks.processGenerationCompletionJobs(...args),
  };
});

function createServiceClientMock() {
  const updateEq = vi.fn(() => ({ is: updateIs }));
  const updateIs = vi.fn(async () => ({ data: null, error: null }));
  const update = vi.fn(() => ({ eq: updateEq }));
  const from = vi.fn(() => ({ update }));
  const rpc = vi.fn(async (): Promise<{
    data: {
      status: string;
      generation_id: string;
      prediction_id: string | null;
    };
    error: null;
  }> => ({
    data: { status: 'attached', generation_id: 'gen-1', prediction_id: 'task-1' },
    error: null,
  }));
  const client = { service: 'supabase', from, rpc };
  return { client, from, update, updateEq, updateIs, rpc };
}

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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/webhooks/kie route', () => {
  let serviceClientMock: ReturnType<typeof createServiceClientMock>;

  beforeEach(() => {
    vi.resetModules();
    mocks.after.mockClear();
    mocks.createServiceClient.mockReset();
    mocks.enqueueGenerationCompletionJob.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    serviceClientMock = createServiceClientMock();
    mocks.createServiceClient.mockReturnValue(serviceClientMock.client);
    mocks.enqueueGenerationCompletionJob.mockResolvedValue('job-1');
    mocks.processGenerationCompletionJobs.mockResolvedValue({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1782039000000));
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates, enqueues, and schedules provider completion processing', async () => {
    const { POST } = await import('@/app/api/webhooks/kie/route');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const response = await POST(signedKieRequest(payload, '1782039000', 'http://localhost/api/webhooks/kie', {
      'x-request-id': 'kie-webhook-success-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'kie-webhook-success-1');
    await expect(response.json()).resolves.toEqual({
      received: true,
      predictionId: 'task-1',
    });
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalledWith(
      serviceClientMock.client,
      {
        predictionId: 'task-1',
        payload,
      },
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.processGenerationCompletionJobs).toHaveBeenCalledWith({
      supabase: serviceClientMock.client,
      creditSupabase: serviceClientMock.client,
      lockedBy: expect.stringMatching(/^kie-webhook:/),
      limit: 5,
      predictionId: 'task-1',
    });
  });

  it('rejects oversized signed payloads before service-role work', async () => {
    const { POST } = await import('@/app/api/webhooks/kie/route');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const response = await POST(signedKieRequest(
      payload,
      '1782039000',
      'http://localhost/api/webhooks/kie',
      {
        'content-length': '262145',
        'x-request-id': 'kie-webhook-too-large-1',
      },
    ));

    expect(response.status).toBe(413);
    expectPrivateNoStoreTraceHeaders(response, 'kie-webhook-too-large-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.enqueueGenerationCompletionJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('reattaches provider task ids to callback generation ids before processing completion jobs', async () => {
    const { POST } = await import('@/app/api/webhooks/kie/route');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const response = await POST(signedKieRequest(
      payload,
      '1782039000',
      'http://localhost/api/webhooks/kie?generationId=gen-1',
    ));

    expect(response.status).toBe(200);
    expect(serviceClientMock.rpc).toHaveBeenCalledWith('attach_generation_provider_task', {
      p_generation_id: 'gen-1',
      p_prediction_id: 'task-1',
    });
    expect(serviceClientMock.from).not.toHaveBeenCalledWith('generations');
    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalledWith(
      serviceClientMock.client,
      {
        predictionId: 'task-1',
        payload: {
          ...payload,
          magicbooklet: {
            callbackGenerationId: 'gen-1',
          },
        },
      },
    );
  });

  it('does not enqueue completion work when a callback generation id is already terminal', async () => {
    serviceClientMock.rpc.mockResolvedValueOnce({
      data: {
        status: 'already_settled',
        generation_id: 'gen-1',
        prediction_id: null,
      },
      error: null,
    });

    const { POST } = await import('@/app/api/webhooks/kie/route');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const response = await POST(signedKieRequest(
      payload,
      '1782039000',
      'http://localhost/api/webhooks/kie?generationId=gen-1',
    ));

    expect(response.status).toBe(200);
    expect(serviceClientMock.rpc).toHaveBeenCalledWith('attach_generation_provider_task', {
      p_generation_id: 'gen-1',
      p_prediction_id: 'task-1',
    });
    expect(mocks.enqueueGenerationCompletionJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

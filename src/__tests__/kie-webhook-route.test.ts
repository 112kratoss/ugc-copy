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

function signedKieRequest(payload: Record<string, unknown>, timestamp = '1782039000') {
  const signature = createHmac('sha256', 'hmac-key')
    .update(`task-1.${timestamp}`)
    .digest('base64');

  return new Request('http://localhost/api/webhooks/kie', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    },
    body: JSON.stringify(payload),
  });
}

describe('/api/webhooks/kie route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.after.mockClear();
    mocks.createServiceClient.mockReset();
    mocks.enqueueGenerationCompletionJob.mockReset();
    mocks.processGenerationCompletionJobs.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
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
    delete process.env.WEBHOOK_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates, enqueues, and schedules provider completion processing', async () => {
    const { POST } = await import('@/app/api/webhooks/kie/route');
    const payload = { data: { taskId: 'task-1', state: 'success' } };
    const response = await POST(signedKieRequest(payload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      predictionId: 'task-1',
    });
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueGenerationCompletionJob).toHaveBeenCalledWith(
      { service: 'supabase' },
      {
        predictionId: 'task-1',
        payload,
      },
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.processGenerationCompletionJobs).toHaveBeenCalledWith({
      supabase: { service: 'supabase' },
      creditSupabase: { service: 'supabase' },
      lockedBy: expect.stringMatching(/^kie-webhook:/),
      limit: 5,
      predictionId: 'task-1',
    });
  });
});

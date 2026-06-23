import { describe, expect, it, vi } from 'vitest';

describe('KIE webhook route adapter service', () => {
  it('delegates webhook handling and applies private route headers', async () => {
    const createServiceClient = vi.fn(() => ({ service: 'supabase-admin' }));
    const handleKieWebhookForRoute = vi.fn(async () => ({
      body: { received: true, predictionId: 'task-1' },
      status: 202,
    }));
    const scheduleAfter = vi.fn();
    const request = new Request('http://localhost/api/webhooks/kie', {
      method: 'POST',
      headers: { 'x-request-id': 'kie-adapter-1' },
      body: JSON.stringify({ data: { taskId: 'task-1' } }),
    });
    const { createKieWebhookRouteHandlers } = await import(
      '@/lib/kie-webhook-route-adapter-service'
    );

    const { POST } = createKieWebhookRouteHandlers({
      dependencies: {
        createServiceClient,
        handleKieWebhookForRoute,
        scheduleAfter,
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('kie-adapter-1');
    await expect(response.json()).resolves.toEqual({
      received: true,
      predictionId: 'task-1',
    });
    expect(handleKieWebhookForRoute).toHaveBeenCalledWith({
      createServiceClient,
      request,
      scheduleAfter,
    });
  });
});

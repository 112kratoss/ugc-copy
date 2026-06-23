import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postWorkflowBlueprintRouteResponse } from '@/lib/workflow-blueprint-route-adapter-service';

describe('workflow blueprint route adapter service', () => {
  it('delegates blueprint planning with provider trace context and private headers', async () => {
    const userSupabase = { auth: 'user' } as unknown as SupabaseClient;
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClient = vi.fn(() => userSupabase);
    const withProviderFetchRequestId = vi.fn((_: string, operation: () => Promise<Response>) => operation());
    const planWorkflowBlueprintForRoute = vi.fn(async (input) => {
      await expect(input.readRequestBody()).resolves.toEqual({ productName: 'Creator Kit' });
      expect(input.createAdminSupabase()).toBe(adminSupabase);
      expect(input.createUserSupabase()).toBe(userSupabase);
      return {
        ok: true as const,
        body: {
          blueprint: { title: 'Launch workflow' },
          remainingCredits: 94,
        },
      };
    });

    const request = new Request('https://app.example/api/workflow-blueprint', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'workflow-blueprint-adapter-1',
      },
      body: JSON.stringify({ productName: 'Creator Kit' }),
    });
    const response = await postWorkflowBlueprintRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        kieApiKey: 'test-kie-key',
        planWorkflowBlueprintForRoute,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-blueprint-adapter-1');
    await expect(response.json()).resolves.toMatchObject({
      blueprint: { title: 'Launch workflow' },
      remainingCredits: 94,
    });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('workflow-blueprint-adapter-1', expect.any(Function));
    expect(planWorkflowBlueprintForRoute).toHaveBeenCalledWith({
      request,
      createAdminSupabase: expect.any(Function),
      createUserSupabase: expect.any(Function),
      kieApiKey: 'test-kie-key',
      readRequestBody: expect.any(Function),
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createUserClient).toHaveBeenCalledWith(request);
  });

  it('maps blueprint rate limits into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-23T03:00:00.000Z',
    });
    const withProviderFetchRequestId = vi.fn((_: string, operation: () => Promise<Response>) => operation());

    const response = await postWorkflowBlueprintRouteResponse({
      request: new Request('https://app.example/api/workflow-blueprint', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-blueprint-limit-1' },
        body: JSON.stringify({ productName: 'Creator Kit' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => ({ auth: 'user' }) as unknown as SupabaseClient),
        kieApiKey: 'test-kie-key',
        planWorkflowBlueprintForRoute: vi.fn(async () => ({
          ok: false as const,
          body: { error: rateLimitError.message },
          status: 429,
          rateLimitError,
        })),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-blueprint-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 30,
    });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('workflow-blueprint-limit-1', expect.any(Function));
  });

  it('preserves blueprint service validation failure bodies and statuses', async () => {
    const response = await postWorkflowBlueprintRouteResponse({
      request: new Request('https://app.example/api/workflow-blueprint', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => ({ auth: 'user' }) as unknown as SupabaseClient),
        kieApiKey: 'test-kie-key',
        planWorkflowBlueprintForRoute: vi.fn(async () => ({
          ok: false as const,
          body: { error: 'Product name, audience, and primary message are required.' },
          status: 400,
        })),
        withProviderFetchRequestId: vi.fn((_: string, operation: () => Promise<Response>) => operation()),
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'Product name, audience, and primary message are required.',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postContactRouteResponse } from '@/lib/contact-route-adapter-service';
import type { ContactSubmissionRouteResult } from '@/lib/contact-submission-service';

function createAdminClient() {
  return { kind: 'admin' } as unknown as SupabaseClient;
}

describe('contact route adapter service', () => {
  it('delegates contact submissions with lazy body, rate-limit key, admin handoff, and private headers', async () => {
    const adminSupabase = createAdminClient();
    const createServiceClient = vi.fn(() => adminSupabase);
    // Typed with the real signature so `mock.calls` is a tuple of its actual
    // arguments. Written bare, vi.fn() infers a zero-argument mock, `calls`
    // types as the empty tuple, and reading calls[0][0] below cannot compile.
    const submitContactMessageForRoute = vi.fn<
      typeof import('@/lib/contact-submission-service').submitContactMessageForRoute
    >(
      async (): Promise<ContactSubmissionRouteResult> => ({
        ok: true,
        body: { success: true },
      }),
    );
    const request = new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.10, 10.0.0.1',
        'x-request-id': 'contact-adapter-success-1',
      },
      body: JSON.stringify({
        name: 'Athul',
        email: 'athul@example.com',
        message: 'Hello',
      }),
    });

    const response = await postContactRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        submitContactMessageForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('contact-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(submitContactMessageForRoute).toHaveBeenCalledTimes(1);

    const serviceInput = submitContactMessageForRoute.mock.calls[0][0];
    expect(serviceInput.rateLimitKey).toBe('203.0.113.10');
    expect(serviceInput.createAdminSupabase()).toBe(adminSupabase);
    await expect(serviceInput.readBody()).resolves.toEqual({
      ok: true,
      value: {
        name: 'Athul',
        email: 'athul@example.com',
        message: 'Hello',
      },
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('maps rate-limited submissions through the shared backend rate-limit response', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 37,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postContactRouteResponse({
      request: new Request('http://localhost/api/contact', {
        method: 'POST',
        headers: { 'x-request-id': 'contact-adapter-rate-limit-1' },
        body: JSON.stringify({
          name: 'Athul',
          email: 'athul@example.com',
          message: 'Hello',
        }),
      }),
      dependencies: {
        createServiceClient: () => createAdminClient(),
        submitContactMessageForRoute: vi.fn(
          async (): Promise<ContactSubmissionRouteResult> => ({
            ok: false,
            status: 429,
            body: { error: 'Too many contact submissions.' },
            rateLimitError,
          }),
        ),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('contact-adapter-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 37,
      limit: 10,
    });
  });
});

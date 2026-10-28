import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postGenerationModelQuoteBatchRouteResponse } from '@/lib/generation-model-quote-batch-route-adapter-service';
import type { GenerationModelQuoteBatchServiceResult } from '@/lib/generation-model-quote-batch-service';

const run = { kind: 'video', modelId: 'seedance-2-mini', settings: { duration: 5 } };

function batchRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/generation-models/quotes', { method: 'POST', headers, body });
}

describe('generation model quote batch route adapter service', () => {
  it('prices the list by the caller\'s network, for the platform it names, with private headers', async () => {
    const rateLimitClient = { kind: 'rate-limit-client' } as unknown as SupabaseClient;
    const createGenerationModelQuoteBatch = vi.fn(async (): Promise<GenerationModelQuoteBatchServiceResult> => ({
      ok: true,
      quotes: [{
        ok: true,
        quote: { modelId: 'seedance-2-mini', catalogRevision: 'rev-1', normalizedSettings: { duration: 5 }, costCredits: 19 },
      }],
    }));

    const response = await postGenerationModelQuoteBatchRouteResponse({
      request: batchRequest(JSON.stringify({ quotes: [run] }), {
        'x-forwarded-for': '203.0.113.10, 10.0.0.5',
        'x-magicbooklet-client': 'mobile',
        'x-request-id': 'quote-batch-1',
      }),
      dependencies: { createGenerationModelQuoteBatch, createServiceClient: vi.fn(() => rateLimitClient) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-batch-1');
    await expect(response.json()).resolves.toEqual({
      quotes: [{ ok: true, quote: expect.objectContaining({ costCredits: 19 }) }],
    });
    expect(createGenerationModelQuoteBatch).toHaveBeenCalledWith({
      body: { quotes: [run] },
      platform: 'mobile',
      rateLimitClient,
      rateLimitKey: '203.0.113.10',
    });
  });

  it('passes on a refused list with the rate limit\'s headers', async () => {
    const response = await postGenerationModelQuoteBatchRouteResponse({
      request: batchRequest(JSON.stringify({ quotes: [run] })),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createGenerationModelQuoteBatch: vi.fn(async (): Promise<GenerationModelQuoteBatchServiceResult> => ({
          ok: false,
          status: 429,
          code: 'RATE_LIMITED',
          error: 'Too many requests.',
          fieldErrors: {},
          retryAfterSeconds: 30,
          limit: 120,
          remaining: 0,
          resetAt: '2026-10-28T12:00:00.000Z',
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 30, limit: 120 });
  });

  it('refuses a body too large to be a creator\'s list before reading it as JSON', async () => {
    const createGenerationModelQuoteBatch = vi.fn();
    const oversized = JSON.stringify({ quotes: [run], padding: 'x'.repeat(70 * 1024) });

    for (const request of [
      batchRequest(oversized),
      batchRequest('{}', { 'content-length': String(1024 * 1024) }),
    ]) {
      const response = await postGenerationModelQuoteBatchRouteResponse({
        request,
        dependencies: { createGenerationModelQuoteBatch, createServiceClient: vi.fn(() => ({}) as SupabaseClient) },
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_QUOTE_BATCH' });
    }
    expect(createGenerationModelQuoteBatch).not.toHaveBeenCalled();
  });

  it('answers a body that is not JSON as the caller\'s mistake, and logs only what is not', async () => {
    const logError = vi.fn();
    const notJson = await postGenerationModelQuoteBatchRouteResponse({
      request: batchRequest('{quotes'),
      dependencies: { logError, createServiceClient: vi.fn(() => ({}) as SupabaseClient) },
    });
    expect(notJson.status).toBe(422);
    expect(logError).not.toHaveBeenCalled();

    const failing = await postGenerationModelQuoteBatchRouteResponse({
      request: batchRequest(JSON.stringify({ quotes: [run] })),
      dependencies: {
        logError,
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createGenerationModelQuoteBatch: vi.fn(async () => { throw new Error('boom'); }),
      },
    });
    expect(failing.status).toBe(422);
    await expect(failing.json()).resolves.toEqual({
      code: 'INVALID_QUOTE_BATCH', error: 'The quote request could not be processed.', fieldErrors: {},
    });
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

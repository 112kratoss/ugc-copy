import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postGenerationModelQuoteRouteResponse } from '@/lib/generation-model-quote-route-adapter-service';
import type { GenerationModelQuoteServiceResult } from '@/lib/generation-model-quote-service';

describe('generation model quote route adapter service', () => {
  it('delegates valid quote requests with the forwarded IP rate-limit key and private headers', async () => {
    const rateLimitClient = { kind: 'rate-limit-client' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => rateLimitClient);
    const createGenerationModelQuote = vi.fn(async (): Promise<GenerationModelQuoteServiceResult> => ({
      ok: true,
      quote: {
        modelId: 'kling-2.6',
        catalogRevision: 'generation-models-v1-test',
        normalizedSettings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
        costCredits: 90,
      },
    }));
    const body = {
      kind: 'motion',
      modelId: 'kling-2.6',
      settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
      inputCounts: { images: 1, videos: 1, audios: 0 },
      catalogRevision: 'generation-models-v1-test',
    };

    const response = await postGenerationModelQuoteRouteResponse({
      request: new Request('http://localhost/api/generation-models/quote', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.10, 10.0.0.5',
          'x-request-id': 'quote-adapter-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createGenerationModelQuote,
        createServiceClient,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-adapter-success-1');
    await expect(response.json()).resolves.toMatchObject({
      modelId: 'kling-2.6',
      costCredits: 90,
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createGenerationModelQuote).toHaveBeenCalledWith({
      body,
      platform: 'web',
      rateLimitClient,
      rateLimitKey: '203.0.113.10',
    });
  });

  it('maps structured quote failures with retry headers without leaking request secrets', async () => {
    const createGenerationModelQuote = vi.fn(async (): Promise<GenerationModelQuoteServiceResult> => ({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      error: 'Too many quote requests.',
      fieldErrors: {},
      retryAfterSeconds: 25,
      limit: 240,
      remaining: 0,
      resetAt: '2026-06-23T05:30:00.000Z',
    }));

    const response = await postGenerationModelQuoteRouteResponse({
      request: new Request('http://localhost/api/generation-models/quote', {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'x-real-ip': '198.51.100.24',
          'x-request-id': 'quote-adapter-limit-1',
        },
        body: JSON.stringify({
          kind: 'image',
          modelId: 'nano-banana-2',
        }),
      }),
      dependencies: {
        createGenerationModelQuote,
        createServiceClient: vi.fn(
          () => ({ kind: 'rate-limit-client' }) as unknown as SupabaseClient
        ),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('240');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-23T05:30:00.000Z');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-adapter-limit-1');
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 25,
      limit: 240,
      resetAt: '2026-06-23T05:30:00.000Z',
    });
    expect(createGenerationModelQuote).toHaveBeenCalledWith(expect.objectContaining({
      rateLimitKey: '198.51.100.24',
    }));
  });

  it('rejects malformed JSON before creating privileged clients or quoting', async () => {
    const createServiceClient = vi.fn();
    const createGenerationModelQuote = vi.fn();
    const logError = vi.fn();

    const response = await postGenerationModelQuoteRouteResponse({
      request: new Request('http://localhost/api/generation-models/quote', {
        method: 'POST',
        headers: { 'x-request-id': 'quote-adapter-malformed-1' },
        body: '{',
      }),
      dependencies: {
        createGenerationModelQuote,
        createServiceClient,
        logError,
      },
    });

    expect(response.status).toBe(422);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-adapter-malformed-1');
    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_MODEL_SETTINGS',
      error: 'The quote request could not be processed.',
      fieldErrors: {},
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createGenerationModelQuote).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('Generation model quote failed:', expect.any(SyntaxError));
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  createGenerationModelQuote,
  type GenerationModelQuoteRateLimitClient,
} from '@/lib/generation-model-quote-service';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';

function createRateLimitClient(
  data: {
    allowed: boolean;
    remaining?: number;
    retryAfterSeconds?: number;
    resetAt?: string;
  } = { allowed: true },
) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed: data.allowed,
      limit: 240,
      remaining: data.remaining ?? (data.allowed ? 239 : 0),
      retryAfterSeconds: data.retryAfterSeconds ?? 0,
      resetAt: data.resetAt ?? '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));

  return {
    client: { rpc } satisfies GenerationModelQuoteRateLimitClient,
    rpc,
  };
}

function createFailingRateLimitClient() {
  const rpc = vi.fn(async () => ({
    data: null,
    error: new Error('database unavailable'),
  }));

  return {
    client: { rpc } satisfies GenerationModelQuoteRateLimitClient,
    rpc,
  };
}

describe('createGenerationModelQuote', () => {
  const catalogRevision = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 }).revision;

  it('validates the required quote identity before touching rate-limit state', async () => {
    const rateLimit = createRateLimitClient();

    const result = await createGenerationModelQuote({
      body: { kind: 'voice', modelId: '' },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimit.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      code: 'INVALID_MODEL_SETTINGS',
      error: 'A valid kind and modelId are required.',
      fieldErrors: {},
    });
    expect(rateLimit.rpc).not.toHaveBeenCalled();
  });

  it('enforces quote rate limits before returning authoritative catalog pricing', async () => {
    const rateLimit = createRateLimitClient();

    const result = await createGenerationModelQuote({
      body: {
        kind: 'motion',
        modelId: 'kling-2.6',
        settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
        inputCounts: { images: 1, videos: 1, audios: 0 },
        catalogRevision,
      },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimit.client,
    });

    expect(rateLimit.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-model:quote',
      p_subject_key: '203.0.113.10',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(result).toMatchObject({
      ok: true,
      quote: {
        modelId: 'kling-2.6',
        catalogRevision,
        costCredits: 90,
      },
    });
  });

  it('returns structured rate-limit and catalog validation failures', async () => {
    const deniedRateLimit = createRateLimitClient({
      allowed: false,
      retryAfterSeconds: 25,
      resetAt: '2026-06-22T06:30:00.000Z',
    });

    await expect(createGenerationModelQuote({
      body: {
        kind: 'motion',
        modelId: 'kling-2.6',
        settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
      },
      rateLimitKey: '198.51.100.24',
      rateLimitClient: deniedRateLimit.client,
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 25,
      limit: 240,
    });

    const allowedRateLimit = createRateLimitClient();
    await expect(createGenerationModelQuote({
      body: {
        kind: 'image',
        modelId: 'grok-imagine-image',
        settings: { aspectRatio: '21:9', resolution: '1K' },
      },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: allowedRateLimit.client,
    })).resolves.toMatchObject({
      ok: false,
      status: 422,
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { aspectRatio: expect.any(String) },
    });
  });

  it('returns a stable failure when the rate-limit check cannot be completed', async () => {
    const rateLimit = createFailingRateLimitClient();

    await expect(createGenerationModelQuote({
      body: {
        kind: 'motion',
        modelId: 'kling-2.6',
        settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
      },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimit.client,
    })).resolves.toEqual({
      ok: false,
      status: 500,
      code: 'RATE_LIMIT_CHECK_FAILED',
      error: 'Failed to check quote limits.',
      fieldErrors: {},
    });
  });
});

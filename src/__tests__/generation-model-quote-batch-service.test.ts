import { afterEach, describe, expect, it, vi } from 'vitest';

import * as backendLogger from '@/lib/backend-logger';
import { buildGenerationModelCatalog, type GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import * as catalogStore from '@/lib/generation-model-catalog-store';
import {
  createGenerationModelQuoteBatch,
  GENERATION_MODEL_QUOTE_BATCH_MAX,
} from '@/lib/generation-model-quote-batch-service';
import { createGenerationModelQuote, type GenerationModelQuoteRateLimitClient } from '@/lib/generation-model-quote-service';

/**
 * Many runs priced in one request (`POST /api/generation-models/quotes`), for the
 * creators' model list and settings: each run as the single quote prices it, counted
 * once against a limit of its own.
 */
function rateLimitClient(data: { allowed: boolean; retryAfterSeconds?: number } = { allowed: true }) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed: data.allowed,
      limit: 120,
      remaining: data.allowed ? 119 : 0,
      retryAfterSeconds: data.retryAfterSeconds ?? 0,
      resetAt: '2026-10-28T12:00:00.000Z',
    },
    error: null,
  }));
  return { client: { rpc } satisfies GenerationModelQuoteRateLimitClient, rpc };
}

const catalogRevision = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }).revision;
const miniRun = (settings: Record<string, unknown> = {}): GenerationModelQuoteInput => ({
  schemaVersion: 2,
  kind: 'video',
  modelId: 'seedance-2-mini',
  settings: { aspectRatio: '9:16', resolution: '480p', duration: 5, sound: false, referenceMode: 'frames', ...settings },
  inputCounts: { images: 0, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
  inputMetadata: { slots: {}, referenceVideoDurationsSeconds: [] },
  catalogRevision,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createGenerationModelQuoteBatch', () => {
  it('refuses whole a list that is not one, is empty or is too long, before counting it', async () => {
    const rateLimit = rateLimitClient();
    for (const body of [null, [], { quotes: [] }, { quotes: 'run' }, { quotes: Array(GENERATION_MODEL_QUOTE_BATCH_MAX + 1).fill(miniRun()) }]) {
      await expect(createGenerationModelQuoteBatch({ body, rateLimitKey: '203.0.113.10', rateLimitClient: rateLimit.client }))
        .resolves.toEqual({
          ok: false,
          status: 422,
          code: 'INVALID_QUOTE_BATCH',
          error: `Send between 1 and ${GENERATION_MODEL_QUOTE_BATCH_MAX} runs to price.`,
          fieldErrors: {},
        });
    }
    expect(rateLimit.rpc).not.toHaveBeenCalled();
  });

  it('prices each run as the single quote does, in its place, and counts the request once against its own limit', async () => {
    const rateLimit = rateLimitClient();
    const runs = [miniRun(), miniRun({ duration: 15 }), miniRun({ resolution: '720p' })];

    const result = await createGenerationModelQuoteBatch({
      body: { quotes: runs },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimit.client,
    });

    expect(rateLimit.rpc).toHaveBeenCalledTimes(1);
    expect(rateLimit.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-model:quote-batch',
      p_subject_key: '203.0.113.10',
      p_limit: 120,
      p_window_seconds: 600,
    });
    const singles = await Promise.all(runs.map((run) => createGenerationModelQuote({
      body: run,
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimitClient().client,
    })));
    expect(result).toEqual({ ok: true, quotes: singles.map((single) => ({ ok: true, quote: single.ok ? single.quote : null })) });
    const costs = singles.map((single) => (single.ok ? single.quote.costCredits : null));
    // Longer and sharper runs cost more: the three are three prices, not one.
    expect(new Set(costs).size).toBe(3);
  });

  it('answers a run the catalog refuses, or one with no model, in its own place beside the prices', async () => {
    const result = await createGenerationModelQuoteBatch({
      body: { quotes: [miniRun({ resolution: '4k' }), { kind: 'voice', modelId: 'x' }, miniRun(), 'run'] },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimitClient().client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quotes).toHaveLength(4);
    expect(result.quotes[0]).toMatchObject({
      ok: false, status: 422, code: 'INVALID_MODEL_SETTINGS', fieldErrors: { resolution: expect.any(String) },
    });
    expect(result.quotes[1]).toEqual({
      ok: false, status: 422, code: 'INVALID_MODEL_SETTINGS', error: 'A valid kind and modelId are required.', fieldErrors: {},
    });
    expect(result.quotes[2]).toMatchObject({ ok: true, quote: { modelId: 'seedance-2-mini' } });
    expect(result.quotes[3]).toMatchObject({ ok: false, code: 'INVALID_MODEL_SETTINGS' });
  });

  it('says the catalog is unavailable for each run, and logs it once, when the published catalog cannot be read', async () => {
    vi.spyOn(catalogStore, 'quotePublishedGenerationModels').mockImplementation(async (inputs) => (
      inputs.map(() => ({ status: 'rejected' as const, reason: new Error('release read failed') }))
    ));
    const logError = vi.spyOn(backendLogger, 'logBackendError').mockImplementation(() => undefined);

    const result = await createGenerationModelQuoteBatch({
      body: { quotes: [miniRun(), miniRun({ duration: 6 })] },
      rateLimitKey: '203.0.113.10',
      rateLimitClient: rateLimitClient().client,
    });

    expect(result).toEqual({
      ok: true,
      quotes: [0, 1].map(() => ({
        ok: false,
        status: 503,
        code: 'CATALOG_UNAVAILABLE',
        error: 'Generation pricing is temporarily unavailable. Refresh the model catalog and try again.',
        fieldErrors: {},
      })),
    });
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('returns the rate limit\'s refusal, and a stable failure when the limit cannot be checked', async () => {
    await expect(createGenerationModelQuoteBatch({
      body: { quotes: [miniRun()] },
      rateLimitKey: '198.51.100.24',
      rateLimitClient: rateLimitClient({ allowed: false, retryAfterSeconds: 30 }).client,
    })).resolves.toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 30, limit: 120 });

    const failing = { rpc: vi.fn(async () => ({ data: null, error: new Error('database unavailable') })) };
    await expect(createGenerationModelQuoteBatch({
      body: { quotes: [miniRun()] },
      rateLimitKey: '198.51.100.24',
      rateLimitClient: failing,
    })).resolves.toEqual({
      ok: false, status: 500, code: 'RATE_LIMIT_CHECK_FAILED', error: 'Failed to check quote limits.', fieldErrors: {},
    });
  });
});

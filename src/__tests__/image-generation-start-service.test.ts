import { describe, expect, it, vi } from 'vitest';

import { buildGenerationModelCatalog, CatalogError } from '@/lib/generation-model-catalog';
import {
  startImageGenerationForRoute,
  type ImageGenerationStartRouteClient,
} from '@/lib/image-generation-start-service';

const startImageGenerationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/generation-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-services')>();
  return {
    ...actual,
    startImageGeneration: startImageGenerationMock,
  };
});

type SourceGenerationRow = {
  id: string;
  user_id: string;
  is_public: boolean;
};

function createClientMock({
  sourceGeneration = null,
  rateLimitAllowed = true,
}: {
  sourceGeneration?: SourceGenerationRow | null;
  rateLimitAllowed?: boolean;
} = {}) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'check_backend_rate_limit') {
      return {
        data: {
          allowed: rateLimitAllowed,
          limit: 30,
          remaining: rateLimitAllowed ? 29 : 0,
          retryAfterSeconds: rateLimitAllowed ? 0 : 45,
          resetAt: '2026-06-22T07:00:00.000Z',
        },
        error: null,
      };
    }

    if (fn === 'try_acquire_backend_job_lock') {
      return { data: true, error: null };
    }

    if (fn === 'release_backend_job_lock') {
      return { data: true, error: null };
    }

    return { data: null, error: null };
  });

  const from = vi.fn((table: string) => {
    if (table !== 'generations') {
      throw new Error(`Unexpected table access: ${table}`);
    }

    return {
      select() {
        const filters: Record<string, unknown> = {};
        const query = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          or() {
            return query;
          },
          async maybeSingle() {
            if (filters.id && sourceGeneration?.id === filters.id) {
              return { data: sourceGeneration, error: null };
            }

            return { data: null, error: null };
          },
        };

        return query;
      },
    };
  });

  return {
    rpc,
    from,
    client: { rpc, from } as unknown as ImageGenerationStartRouteClient,
  };
}

describe('startImageGenerationForRoute', () => {
  const catalogRevision = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 }).revision;

  it('rejects stale catalog revisions before rate limits or provider starts', async () => {
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await expect(startImageGenerationForRoute({
      request: new Request('http://localhost/api/generate-image'),
      body: {
        prompt: 'A product hero image',
        model: 'nano-banana-2',
        catalogRevision: 'stale-revision',
      },
      userId: 'user-1',
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    })).rejects.toBeInstanceOf(CatalogError);

    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(startImageGenerationMock).not.toHaveBeenCalled();
  });

  it('validates source access, rate limits, and starts with the server quote', async () => {
    startImageGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-image-1',
      generationId: 'gen-image-1',
      remainingCredits: 92,
      cost: 8,
    });
    const userClient = createClientMock({
      sourceGeneration: {
        id: 'source-1',
        user_id: 'creator-1',
        is_public: true,
      },
    });
    const adminClient = createClientMock();

    const result = await startImageGenerationForRoute({
      request: new Request('http://localhost/api/generate-image', {
        headers: { 'idempotency-key': 'image-start-1' },
      }),
      body: {
        prompt: 'A product hero image',
        model: 'nano-banana-2',
        aspectRatio: '1:1',
        resolution: '1K',
        outputFormat: 'png',
        googleSearch: true,
        imageUrls: ['https://example.com/reference.png'],
        sourceGenerationId: 'source-1',
        catalogRevision,
      },
      userId: 'user-1',
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    });

    expect(adminClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
      p_limit: 30,
    }));
    expect(startImageGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      model: 'nano-banana-2',
      prompt: 'A product hero image',
      imageUrls: ['https://example.com/reference.png'],
      elements: [],
      aspectRatio: '1:1',
      resolution: '1K',
      outputFormat: 'png',
      googleSearch: true,
      quotedCostCredits: 8,
      sourceGenerationId: 'source-1',
    }));
    expect(result).toEqual({
      success: true,
      predictionId: 'task-image-1',
      generationId: 'gen-image-1',
      status: 'processing',
      remainingCredits: 92,
      cost: 8,
    });
  });
});

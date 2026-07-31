import { describe, expect, it, vi } from 'vitest';

import { buildGenerationModelCatalog, CatalogError } from '@/lib/generation-model-catalog';
import {
  startVideoGenerationForRoute,
  type VideoGenerationStartRouteClient,
} from '@/lib/video-generation-start-service';

const startVideoGenerationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/generation-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-services')>();
  return {
    ...actual,
    startVideoGeneration: startVideoGenerationMock,
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

    if (fn === 'claim_generation_start_request') {
      return { data: 'claimed', error: null };
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
    client: { rpc, from } as unknown as VideoGenerationStartRouteClient,
  };
}

describe('startVideoGenerationForRoute', () => {
  const catalogRevision = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 }).revision;

  it('rejects stale catalog revisions before rate limits or provider starts', async () => {
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await expect(startVideoGenerationForRoute({
      request: new Request('http://localhost/api/generate-video'),
      body: {
        prompt: 'A cinematic product video',
        model: 'kling-3.0-video',
        catalogRevision: 'stale-revision',
      },
      userId: 'user-1',
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    })).rejects.toBeInstanceOf(CatalogError);

    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
  });

  it('validates source access, rate limits, and starts with the server quote', async () => {
    startVideoGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-video-1',
      generationId: 'gen-video-1',
      remainingCredits: 1576,
      cost: 100,
    });
    const userClient = createClientMock();
    // The source-generation row is readable only service-role since the
    // 2026-07-26 grant hardening, so the fixture lives on the admin client.
    const adminClient = createClientMock({
      sourceGeneration: {
        id: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        user_id: 'creator-1',
        is_public: true,
      },
    });

    const result = await startVideoGenerationForRoute({
      request: new Request('http://localhost/api/generate-video', {
        headers: { 'idempotency-key': 'video-start-1' },
      }),
      body: {
        prompt: 'A cinematic product video',
        model: 'kling-3.0-video',
        duration: 5,
        aspectRatio: '16:9',
        mode: 'std',
        sound: false,
        startImageUrl: 'https://example.com/start.png',
        endImageUrl: 'https://example.com/end.png',
        sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
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
    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      model: 'kling-3.0-video',
      prompt: 'A cinematic product video',
      imageUrls: ['https://example.com/start.png', 'https://example.com/end.png'],
      startImageUrl: 'https://example.com/start.png',
      endImageUrl: 'https://example.com/end.png',
      mode: 'std',
      aspectRatio: '16:9',
      sound: false,
      duration: 5,
      resolution: '720p',
      fixedLens: false,
      referenceMode: 'frames',
      quotedCostCredits: 70,
      sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
    }));
    expect(result).toEqual({
      success: true,
      predictionId: 'task-video-1',
      generationId: 'gen-video-1',
      status: 'processing',
      remainingCredits: 1576,
      cost: 100,
    });
  });

  it('forwards the server-only input-retention override without reading it from the body', async () => {
    startVideoGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-video-private-template',
      generationId: 'gen-video-private-template',
      remainingCredits: 80,
      cost: 20,
    });
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await startVideoGenerationForRoute({
      request: new Request('http://localhost/api/template-runs/run-1/start', {
        headers: { 'idempotency-key': 'video-private-template-start-1' },
      }),
      body: {
        prompt: 'A private template video',
        model: 'kling-3.0-video',
        // A public caller cannot override this through the request body.
        persistInputMedia: true,
      },
      userId: 'user-1',
      supabase: userClient.client,
      adminSupabase: adminClient.client,
      persistInputMedia: false,
    });

    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      persistInputMedia: false,
    }));
  });
});

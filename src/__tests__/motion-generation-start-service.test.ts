import { describe, expect, it, vi } from 'vitest';

import { buildGenerationModelCatalog, CatalogError } from '@/lib/generation-model-catalog';
import {
  startMotionGenerationForRoute,
  type MotionGenerationStartRouteClient,
} from '@/lib/motion-generation-start-service';

const startMotionGenerationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/generation-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-services')>();
  return {
    ...actual,
    startMotionGeneration: startMotionGenerationMock,
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
    client: { rpc, from } as unknown as MotionGenerationStartRouteClient,
  };
}

describe('startMotionGenerationForRoute', () => {
  const catalogRevision = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 }).revision;

  it('rejects stale catalog revisions before rate limits or provider starts', async () => {
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await expect(startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate'),
      body: {
        prompt: 'Transfer the performance naturally.',
        model: 'kling-2.6',
        characterImageUrl: 'https://signed.example.com/character.png',
        referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        catalogRevision: 'stale-revision',
      },
      userId: 'user-1',
      supabase: userClient.client,
      adminSupabase: adminClient.client,
    })).rejects.toBeInstanceOf(CatalogError);

    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(startMotionGenerationMock).not.toHaveBeenCalled();
  });

  it('validates source access, rate limits, and starts with the server quote', async () => {
    startMotionGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-motion-1',
      generationId: 'gen-motion-1',
      remainingCredits: 88,
      cost: 12,
    });
    const userClient = createClientMock({
      sourceGeneration: {
        id: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        user_id: 'creator-1',
        is_public: true,
      },
    });
    const adminClient = createClientMock();

    const result = await startMotionGenerationForRoute({
      request: new Request('http://localhost/api/generate', {
        headers: { 'idempotency-key': 'motion-start-1' },
      }),
      body: {
        prompt: 'Transfer the performance naturally.',
        model: 'kling-3.0',
        characterImageUrl: 'https://signed.example.com/character.png',
        referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        duration: 6,
        characterOrientation: 'image',
        mode: '1080p',
        characterImage: {
          kind: 'image',
          label: 'Character image',
          storagePath: 'uploads/user-1/character.png',
        },
        referenceVideo: {
          kind: 'video',
          label: 'Reference video',
          sourceGenerationId: 'source-video-1',
        },
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
    expect(startMotionGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      model: 'kling-3.0',
      prompt: 'Transfer the performance naturally.',
      referenceVideoUrl: 'https://signed.example.com/reference.mp4',
      characterImageUrl: 'https://signed.example.com/character.png',
      duration: 6,
      characterOrientation: 'image',
      mode: '1080p',
      quotedCostCredits: 162,
      sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
      characterImage: expect.objectContaining({
        kind: 'image',
        label: 'Character image',
      }),
      referenceVideo: expect.objectContaining({
        kind: 'video',
        label: 'Reference video',
      }),
    }));
    expect(result).toEqual({
      success: true,
      predictionId: 'task-motion-1',
      generationId: 'gen-motion-1',
      status: 'processing',
      remainingCredits: 88,
      cost: 12,
    });
  });
});

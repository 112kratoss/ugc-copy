import { describe, expect, it, vi } from 'vitest';

import { createRemixSourceRows } from '@/__tests__/fixtures/remix-source-rows';
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
  blocks = [],
}: {
  sourceGeneration?: SourceGenerationRow | null;
  rateLimitAllowed?: boolean;
  blocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
} = {}) {
  const remixSourceRows = createRemixSourceRows(sourceGeneration, { blocks });
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
      // Refuses any table but those Remix reads.
      return remixSourceRows.client.from(table);
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
      callerIsGuest: false,
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
        sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        catalogRevision,
      },
      userId: 'user-1',
      callerIsGuest: false,
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
      // An installed app still sends googleSearch: true. Nano Banana 2 no longer takes it
      // (2026-10-20), so the quote drops the value and the run starts without it.
      googleSearch: false,
      quotedCostCredits: 8,
      sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
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

  // Remix refuses a blocked pair, so the post is not credited with the run and
  // its creator is not told (`source-generation.ts`). The run itself starts.
  it('starts a run from a creator who blocked the caller as an ordinary one', async () => {
    startImageGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-image-2',
      generationId: 'gen-image-2',
      remainingCredits: 92,
      cost: 8,
    });
    const adminClient = createClientMock({
      sourceGeneration: {
        id: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        user_id: 'creator-1',
        is_public: true,
      },
      blocks: [{ blocker_user_id: 'creator-1', blocked_user_id: 'user-1' }],
    });

    const result = await startImageGenerationForRoute({
      request: new Request('http://localhost/api/generate-image', {
        headers: { 'idempotency-key': 'image-start-2' },
      }),
      body: {
        prompt: 'A product hero image',
        model: 'nano-banana-2',
        aspectRatio: '1:1',
        resolution: '1K',
        outputFormat: 'png',
        sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        catalogRevision,
      },
      userId: 'user-1',
      callerIsGuest: false,
      supabase: createClientMock().client,
      adminSupabase: adminClient.client,
    });

    // The last call: the mock keeps every test's calls, and another test's start
    // without a source would match too.
    expect(startImageGenerationMock).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: 'user-1',
      sourceGenerationId: null,
    }));
    expect(result).toMatchObject({ success: true, generationId: 'gen-image-2' });
  });

  it('forwards the server-only input-retention override without reading it from the body', async () => {
    startImageGenerationMock.mockResolvedValueOnce({
      predictionId: 'task-image-private-template',
      generationId: 'gen-image-private-template',
      remainingCredits: 90,
      cost: 5,
    });
    const userClient = createClientMock();
    const adminClient = createClientMock();

    await startImageGenerationForRoute({
      request: new Request('http://localhost/api/template-runs/run-1/frames', {
        headers: { 'idempotency-key': 'image-private-template-start-1' },
      }),
      body: {
        prompt: 'A private template frame',
        model: 'nano-banana-2',
        imageUrls: ['https://example.com/private-input.png'],
        // A public caller cannot override this through the request body.
        persistInputMedia: true,
      },
      userId: 'user-1',
      callerIsGuest: false,
      supabase: userClient.client,
      adminSupabase: adminClient.client,
      persistInputMedia: false,
    });

    expect(startImageGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      persistInputMedia: false,
    }));
  });
});

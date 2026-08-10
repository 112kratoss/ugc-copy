import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markHeldProviderSubmission } from '@/lib/generation-public-failure';

const startUnifiedGenerationForRouteMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/unified-generation-start-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/unified-generation-start-service')>();
  return {
    ...actual,
    startUnifiedGenerationForRoute: (...args: unknown[]) => (
      startUnifiedGenerationForRouteMock(...args)
    ),
  };
});

import { postUnifiedGenerationForRoute } from '@/lib/unified-generation-route-service';

describe('unified generation route service', () => {
  beforeEach(() => {
    startUnifiedGenerationForRouteMock.mockReset();
  });

  it('returns submission_pending with the held generation id after an ambiguous provider accept', async () => {
    const ambiguous = new TypeError('fetch failed');
    markHeldProviderSubmission(ambiguous, 'generation-held-unified-1');
    startUnifiedGenerationForRouteMock.mockRejectedValueOnce(ambiguous);

    const result = await postUnifiedGenerationForRoute({
      request: new Request('http://localhost/api/generations', { method: 'POST' }),
      createUserSupabase: () => ({
        auth: {
          getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
        },
      }),
      createAdminSupabase: () => ({ kind: 'admin' }),
      kieApiKey: 'configured',
      readRequestBody: async () => ({ kind: 'image', modelId: 'nano-banana-2-lite' }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { code: 'submission_pending', generationId: 'generation-held-unified-1' },
    });
  });

  it('authenticates and delegates the generic request without accepting a client cost', async () => {
    const userClient = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    };
    const adminClient = { kind: 'admin' };
    const body = {
      kind: 'video',
      modelId: 'remote-video',
      catalogRevision: 'catalog-v2',
      settings: { duration: 5 },
      cost: 1,
    };
    startUnifiedGenerationForRouteMock.mockResolvedValue({
      success: true,
      predictionId: 'task-1',
      generationId: 'generation-1',
      status: 'processing',
      remainingCredits: 100,
      cost: 42,
      catalogRevision: 'catalog-v2',
      modelId: 'remote-video',
    });

    const result = await postUnifiedGenerationForRoute({
      request: new Request('http://localhost/api/generations', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'request-1' },
      }),
      createUserSupabase: () => userClient,
      createAdminSupabase: () => adminClient,
      kieApiKey: 'configured',
      readRequestBody: async () => body,
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        cost: 42,
        modelId: 'remote-video',
      },
    });
    expect(startUnifiedGenerationForRouteMock).toHaveBeenCalledWith({
      request: expect.any(Request),
      body,
      userId: 'user-1',
      supabase: userClient,
      adminSupabase: adminClient,
    });
  });

  it('fails before privileged work when the user is unauthenticated', async () => {
    const createAdminSupabase = vi.fn();
    const readRequestBody = vi.fn();

    const result = await postUnifiedGenerationForRoute({
      request: new Request('http://localhost/api/generations', { method: 'POST' }),
      createUserSupabase: () => ({
        auth: {
          getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
        },
      }),
      createAdminSupabase,
      kieApiKey: 'configured',
      readRequestBody,
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate media.' },
      status: 401,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(startUnifiedGenerationForRouteMock).not.toHaveBeenCalled();
  });

  it('fails closed when the provider configuration is unavailable', async () => {
    const result = await postUnifiedGenerationForRoute({
      request: new Request('http://localhost/api/generations', { method: 'POST' }),
      createUserSupabase: () => ({
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: { id: 'user-1' } },
            error: null,
          })),
        },
      }),
      createAdminSupabase: vi.fn(),
      kieApiKey: '',
      readRequestBody: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      body: { code: 'GENERATION_SERVICE_UNAVAILABLE' },
    });
    expect(startUnifiedGenerationForRouteMock).not.toHaveBeenCalled();
  });
});

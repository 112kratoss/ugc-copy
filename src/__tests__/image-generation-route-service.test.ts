import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';

const mocks = vi.hoisted(() => ({
  getImageGenerationStatusForRoute: vi.fn(),
  startImageGenerationForRoute: vi.fn(),
}));

vi.mock('@/lib/image-generation-start-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image-generation-start-service')>();
  return {
    ...actual,
    startImageGenerationForRoute: (...args: unknown[]) => mocks.startImageGenerationForRoute(...args),
  };
});

vi.mock('@/lib/image-generation-status-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image-generation-status-service')>();
  return {
    ...actual,
    getImageGenerationStatusForRoute: (...args: unknown[]) => mocks.getImageGenerationStatusForRoute(...args),
  };
});

function createUserSupabaseMock(user: { id: string } | null = { id: 'user-1' }) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: user ? null : new Error('missing session'),
      })),
    },
  };
}

describe('image generation route service', () => {
  const adminSupabase = { service: 'admin' };
  let createAdminSupabase: Mock<() => unknown>;
  let createUserSupabase: Mock<() => unknown>;

  beforeEach(() => {
    mocks.startImageGenerationForRoute.mockReset();
    mocks.getImageGenerationStatusForRoute.mockReset();
    mocks.startImageGenerationForRoute.mockResolvedValue({
      success: true,
      predictionId: 'task-image-1',
      generationId: 'gen-image-1',
      status: 'processing',
      remainingCredits: 92,
      cost: 8,
    });
    mocks.getImageGenerationStatusForRoute.mockResolvedValue({
      ok: true,
      body: {
        status: 'processing',
        output: null,
      },
    });
    createAdminSupabase = vi.fn(() => adminSupabase);
    createUserSupabase = vi.fn(() => createUserSupabaseMock());
  });

  it('authenticates image starts before parsing request JSON or creating privileged clients', async () => {
    createUserSupabase.mockReturnValueOnce(createUserSupabaseMock(null));
    const { postImageGenerationForRoute } = await import('@/lib/image-generation-route-service');
    const readRequestBody = vi.fn(async () => {
      throw new Error('body should not be read');
    });

    const result = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody,
      request: new Request('http://localhost/api/generate-image'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate images' },
      status: 401,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startImageGenerationForRoute).not.toHaveBeenCalled();
  });

  it('fails closed on missing provider configuration before body parsing or provider work', async () => {
    const readRequestBody = vi.fn(async () => ({ model: 'nano-banana-2' }));
    const { postImageGenerationForRoute } = await import('@/lib/image-generation-route-service');
    const result = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody,
      request: new Request('http://localhost/api/generate-image'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Server configuration error: API key missing' },
      status: 500,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startImageGenerationForRoute).not.toHaveBeenCalled();
  });

  it('maps catalog and rate-limit errors without losing stable response details', async () => {
    const { postImageGenerationForRoute } = await import('@/lib/image-generation-route-service');
    mocks.startImageGenerationForRoute.mockRejectedValueOnce(
      new CatalogError('The model catalog changed.', 'CATALOG_CHANGED', 409),
    );

    const staleCatalog = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image'),
      readRequestBody: async () => ({ model: 'nano-banana-2' }),
    });

    const rateLimitState = {
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-22T07:00:00.000Z',
    };
    mocks.startImageGenerationForRoute.mockRejectedValueOnce(new BackendRateLimitError(rateLimitState));
    const rateLimited = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image'),
      readRequestBody: async () => ({ model: 'nano-banana-2' }),
    });

    expect(staleCatalog).toEqual({
      ok: false,
      body: {
        error: 'The model catalog changed.',
        code: 'CATALOG_CHANGED',
        fieldErrors: {},
      },
      status: 409,
    });
    expect(rateLimited).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(BackendRateLimitError),
    });
  });

  it('validates status ids before auth and delegates authenticated status checks', async () => {
    const { getImageGenerationForRoute } = await import('@/lib/image-generation-route-service');
    const missingId = await getImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image'),
    });

    const found = await getImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
    });

    expect(missingId).toEqual({
      ok: false,
      body: { error: 'Missing prediction ID' },
      status: 400,
    });
    expect(createUserSupabase).toHaveBeenCalledTimes(1);
    expect(found).toEqual({
      ok: true,
      body: {
        status: 'processing',
        output: null,
      },
    });
    expect(mocks.getImageGenerationStatusForRoute).toHaveBeenCalledWith({
      request: expect.any(Request),
      predictionId: 'task-image-1',
      userId: 'user-1',
      supabase: expect.any(Object),
      createAdminSupabase,
      kieApiKey: 'kie-key',
    });
  });
});

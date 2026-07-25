import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';

const mocks = vi.hoisted(() => ({
  getVideoGenerationStatusForRoute: vi.fn(),
  startVideoGenerationForRoute: vi.fn(),
}));

vi.mock('@/lib/video-generation-start-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/video-generation-start-service')>();
  return {
    ...actual,
    startVideoGenerationForRoute: (...args: unknown[]) => mocks.startVideoGenerationForRoute(...args),
  };
});

vi.mock('@/lib/video-generation-status-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/video-generation-status-service')>();
  return {
    ...actual,
    getVideoGenerationStatusForRoute: (...args: unknown[]) => mocks.getVideoGenerationStatusForRoute(...args),
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

describe('video generation route service', () => {
  const adminSupabase = { service: 'admin' };
  let createAdminSupabase: Mock<() => unknown>;
  let createUserSupabase: Mock<() => unknown>;

  beforeEach(() => {
    mocks.startVideoGenerationForRoute.mockReset();
    mocks.getVideoGenerationStatusForRoute.mockReset();
    mocks.startVideoGenerationForRoute.mockResolvedValue({
      success: true,
      predictionId: 'task-video-1',
      generationId: 'gen-video-1',
      status: 'processing',
      remainingCredits: 1576,
      cost: 100,
    });
    mocks.getVideoGenerationStatusForRoute.mockResolvedValue({
      ok: true,
      body: {
        status: 'processing',
        output: null,
      },
    });
    createAdminSupabase = vi.fn(() => adminSupabase);
    createUserSupabase = vi.fn(() => createUserSupabaseMock());
  });

  it('authenticates video starts before parsing request JSON or creating privileged clients', async () => {
    createUserSupabase.mockReturnValueOnce(createUserSupabaseMock(null));
    const { postVideoGenerationForRoute } = await import('@/lib/video-generation-route-service');
    const readRequestBody = vi.fn(async () => {
      throw new Error('body should not be read');
    });

    const result = await postVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody,
      request: new Request('http://localhost/api/generate-video'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate videos' },
      status: 401,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startVideoGenerationForRoute).not.toHaveBeenCalled();
  });

  it('fails closed on missing provider configuration before body parsing or provider work', async () => {
    const readRequestBody = vi.fn(async () => ({ model: 'kling-3.0-video' }));
    const { postVideoGenerationForRoute } = await import('@/lib/video-generation-route-service');
    const result = await postVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody,
      request: new Request('http://localhost/api/generate-video'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Server configuration error: API key missing' },
      status: 500,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startVideoGenerationForRoute).not.toHaveBeenCalled();
  });

  it('maps catalog and rate-limit errors without losing stable response details', async () => {
    const { postVideoGenerationForRoute } = await import('@/lib/video-generation-route-service');
    mocks.startVideoGenerationForRoute.mockRejectedValueOnce(
      new CatalogError('The model catalog changed.', 'CATALOG_CHANGED', 409),
    );

    const staleCatalog = await postVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-video'),
      readRequestBody: async () => ({ model: 'kling-3.0-video' }),
    });

    const rateLimitState = {
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-22T07:00:00.000Z',
    };
    mocks.startVideoGenerationForRoute.mockRejectedValueOnce(new BackendRateLimitError(rateLimitState));
    const rateLimited = await postVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-video'),
      readRequestBody: async () => ({ model: 'kling-3.0-video' }),
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
    const { getVideoGenerationForRoute } = await import('@/lib/video-generation-route-service');
    const missingId = await getVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-video'),
    });

    const found = await getVideoGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-video?id=task-video-1'),
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
    expect(mocks.getVideoGenerationStatusForRoute).toHaveBeenCalledWith({
      request: expect.any(Request),
      predictionId: 'task-video-1',
      userId: 'user-1',
      supabase: expect.any(Object),
      createAdminSupabase,
      kieApiKey: 'kie-key',
    });
  });
});

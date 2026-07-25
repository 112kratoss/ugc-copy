import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';

const mocks = vi.hoisted(() => ({
  getMotionGenerationStatusForRoute: vi.fn(),
  startMotionGenerationForRoute: vi.fn(),
}));

vi.mock('@/lib/motion-generation-start-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/motion-generation-start-service')>();
  return {
    ...actual,
    startMotionGenerationForRoute: (...args: unknown[]) => mocks.startMotionGenerationForRoute(...args),
  };
});

vi.mock('@/lib/motion-generation-status-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/motion-generation-status-service')>();
  return {
    ...actual,
    getMotionGenerationStatusForRoute: (...args: unknown[]) => mocks.getMotionGenerationStatusForRoute(...args),
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

describe('motion generation route service', () => {
  const adminSupabase = { service: 'admin' };
  let createAdminSupabase: Mock<() => unknown>;
  let createUserSupabase: Mock<() => unknown>;

  beforeEach(() => {
    mocks.startMotionGenerationForRoute.mockReset();
    mocks.getMotionGenerationStatusForRoute.mockReset();
    mocks.startMotionGenerationForRoute.mockResolvedValue({
      success: true,
      predictionId: 'task-motion-1',
      generationId: 'gen-motion-1',
      status: 'processing',
      remainingCredits: 88,
      cost: 12,
    });
    mocks.getMotionGenerationStatusForRoute.mockResolvedValue({
      ok: true,
      body: {
        status: 'processing',
        output: null,
      },
    });
    createAdminSupabase = vi.fn(() => adminSupabase);
    createUserSupabase = vi.fn(() => createUserSupabaseMock());
  });

  it('authenticates motion starts before parsing request JSON or creating privileged clients', async () => {
    createUserSupabase.mockReturnValueOnce(createUserSupabaseMock(null));
    const { postMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');
    const result = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody: vi.fn(async () => {
        throw new Error('body should not be read');
      }),
      request: new Request('http://localhost/api/generate'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate videos' },
      status: 401,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startMotionGenerationForRoute).not.toHaveBeenCalled();
  });

  it('fails closed on missing provider configuration before body parsing or provider work', async () => {
    const readRequestBody = vi.fn(async () => ({ model: 'kling-3.0' }));
    const { postMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');
    const result = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      readRequestBody,
      request: new Request('http://localhost/api/generate'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Server configuration error: API key missing' },
      status: 500,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.startMotionGenerationForRoute).not.toHaveBeenCalled();
  });

  it('maps catalog and rate-limit errors without losing stable response details', async () => {
    const { postMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');
    mocks.startMotionGenerationForRoute.mockRejectedValueOnce(
      new CatalogError('The model catalog changed.', 'CATALOG_CHANGED', 409),
    );

    const staleCatalog = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate'),
      readRequestBody: async () => ({ model: 'kling-3.0' }),
    });

    const rateLimitState = {
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-22T07:00:00.000Z',
    };
    mocks.startMotionGenerationForRoute.mockRejectedValueOnce(new BackendRateLimitError(rateLimitState));
    const rateLimited = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate'),
      readRequestBody: async () => ({ model: 'kling-3.0' }),
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
    const { getMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');
    const missingId = await getMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate'),
    });

    const found = await getMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate?id=task-motion-1'),
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
    expect(mocks.getMotionGenerationStatusForRoute).toHaveBeenCalledWith({
      request: expect.any(Request),
      predictionId: 'task-motion-1',
      userId: 'user-1',
      supabase: expect.any(Object),
      createAdminSupabase,
      kieApiKey: 'kie-key',
    });
  });
});

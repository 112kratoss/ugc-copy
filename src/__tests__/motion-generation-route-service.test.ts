import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import {
  markHeldProviderSubmission,
  markRefundedGenerationStart,
} from '@/lib/generation-public-failure';
import { GenerationServiceError } from '@/lib/generation-services';
import { MotionGenerationStartValidationError } from '@/lib/motion-generation-start-service';
import { ReferenceDurationChangedError } from '@/lib/unified-generation-start-service';

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

  it('returns submission_pending with the held generation id after an ambiguous provider accept', async () => {
    const ambiguous = new TypeError('fetch failed');
    markHeldProviderSubmission(ambiguous, 'generation-held-motion-1');
    mocks.startMotionGenerationForRoute.mockRejectedValueOnce(ambiguous);
    const { postMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');

    const result = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'preview-provider-key',
      readRequestBody: async () => ({ model: 'kling-2.6/motion-control', prompt: 'portrait' }),
      request: new Request('http://localhost/api/generate'),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { code: 'submission_pending', generationId: 'generation-held-motion-1' },
    });
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
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate videos' },
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

    // The same answer as POST /api/generations: nothing was reserved.
    expect(result).toEqual({
      ok: false,
      body: {
        code: 'GENERATION_SERVICE_UNAVAILABLE',
        error: 'Generation is temporarily unavailable.',
      },
      status: 503,
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
      body: { code: 'RATE_LIMITED' },
      rateLimitError: expect.any(BackendRateLimitError),
    });
  });

  it.each([
    {
      name: 'a provider rejection at task creation',
      error: (() => {
        const error = new Error('Your prompt was flagged by the safety filter.');
        markRefundedGenerationStart(error, 'generation-refunded-motion-1');
        return error;
      })(),
      status: 422,
      body: {
        code: 'provider_rejected',
        error: 'The generation provider could not accept this request. Check your prompt and inputs, then try again. No credits were used.',
      },
    },
    {
      name: 'a balance the hold could not take',
      error: new GenerationServiceError('Insufficient credits. This action costs 12 credits.', 402),
      status: 402,
      body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 12 credits.' },
    },
    {
      name: 'a busy provider',
      error: new GenerationServiceError('The generation provider is busy right now. Please retry shortly.', 429, 'provider_busy'),
      status: 429,
      body: { code: 'provider_busy', error: 'The generation provider is busy right now. Please retry shortly.' },
    },
    {
      name: 'a body that is not JSON',
      error: new SyntaxError('Unexpected token < in JSON'),
      status: 422,
      body: {
        code: 'INVALID_GENERATION_REQUEST',
        error: 'The generation request could not be processed.',
        fieldErrors: {},
      },
    },
    {
      name: 'a request missing its clip',
      error: new MotionGenerationStartValidationError('Missing referenceVideoUrl or characterImageUrl'),
      status: 400,
      body: { code: 'INVALID_GENERATION_REQUEST', error: 'Missing referenceVideoUrl or characterImageUrl' },
    },
    {
      name: 'a clip whose length cannot be read',
      error: new MotionGenerationStartValidationError(
        'The length of a reference file could not be verified. Upload it again, then retry.',
        422,
      ),
      status: 422,
      body: {
        code: 'INVALID_GENERATION_REQUEST',
        error: 'The length of a reference file could not be verified. Upload it again, then retry.',
      },
    },
    {
      name: 'a clip longer than the length it was priced for',
      error: new ReferenceDurationChangedError([{ index: 0, slot: 'referenceVideo', durationSeconds: 9.4 }], 11, 110),
      status: 409,
      body: {
        code: 'REFERENCE_DURATION_CHANGED',
        error: expect.stringContaining('Check the updated cost'),
        costCredits: 110,
        quotedCostCredits: 11,
        inputs: [{ index: 0, slot: 'referenceVideo', durationSeconds: 9.4 }],
      },
    },
    {
      name: 'a failure nobody classified',
      error: new Error('Unexpected settlement shape'),
      status: 500,
      body: { code: 'GENERATION_START_FAILED', error: 'Failed to start video generation' },
    },
  ])('answers $name as POST /api/generations does', async ({ error, status, body }) => {
    mocks.startMotionGenerationForRoute.mockRejectedValueOnce(error);
    const { postMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');

    const result = await postMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate'),
      readRequestBody: async () => ({ model: 'any-model' }),
    });

    expect(result).toEqual({ ok: false, status, body });
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

  it('hands a status check the scheduler it was given, and none when it was given none', async () => {
    // A poll that finds a provider failure tells the creator's devices. The
    // route has someone waiting on the poll, so it brings somewhere to run that
    // once the poll is answered.
    const { getMotionGenerationForRoute } = await import('@/lib/motion-generation-route-service');
    const runAfterResponse = vi.fn();

    await getMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate?id=task-motion-1'),
      runAfterResponse,
    });
    await getMotionGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate?id=task-motion-1'),
    });

    expect(mocks.getMotionGenerationStatusForRoute.mock.calls.map(([input]) => input.runAfterResponse))
      .toEqual([runAfterResponse, undefined]);
    expect(runAfterResponse).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import {
  markHeldProviderSubmission,
  markRefundedGenerationStart,
} from '@/lib/generation-public-failure';
import { GenerationServiceError } from '@/lib/generation-services';

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

  it.each(['submissionPending', 'submissionUnconfirmed'] as const)('returns the recovery contract for %s', async (variant) => {
    const ambiguous = new TypeError('fetch failed');
    markHeldProviderSubmission(ambiguous, 'generation-held-image-1', { confirmed: variant === 'submissionPending' });
    mocks.startImageGenerationForRoute.mockRejectedValueOnce(ambiguous);
    const { postImageGenerationForRoute } = await import('@/lib/image-generation-route-service');

    const result = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'preview-provider-key',
      readRequestBody: async () => ({ model: 'nano-banana-2-lite', prompt: 'portrait' }),
      request: new Request('http://localhost/api/generate-image'),
    });

    expect(result).toMatchObject({
      ok: false,
      status: mobileApiContract.endpoints.startImageGeneration.errors[variant].status,
      body: mobileApiContract.endpoints.startImageGeneration.errors[variant].response,
    });
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
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate images' },
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
      body: { code: 'RATE_LIMITED' },
      rateLimitError: expect.any(BackendRateLimitError),
    });
  });

  it.each([
    {
      name: 'a provider rejection at task creation',
      error: (() => {
        const error = new Error('Your prompt was flagged by the safety filter.');
        markRefundedGenerationStart(error, 'generation-refunded-image-1');
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
      name: 'a failure nobody classified',
      error: new Error('Unexpected settlement shape'),
      status: 500,
      body: { code: 'GENERATION_START_FAILED', error: 'Failed to start image generation' },
    },
  ])('answers $name as POST /api/generations does', async ({ error, status, body }) => {
    mocks.startImageGenerationForRoute.mockRejectedValueOnce(error);
    const { postImageGenerationForRoute } = await import('@/lib/image-generation-route-service');

    const result = await postImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate'),
      readRequestBody: async () => ({ model: 'any-model' }),
    });

    expect(result).toEqual({ ok: false, status, body });
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
      // No user client is forwarded: the status service reads and writes
      // service-role throughout, because the generations column grants and the
      // generated_images bucket policies both deny `authenticated`.
      createAdminSupabase,
      kieApiKey: 'kie-key',
    });
  });

  it('hands a status check the scheduler it was given, and none when it was given none', async () => {
    // A poll that finds a provider failure tells the creator's devices. The
    // route has someone waiting on the poll, so it brings somewhere to run that
    // once the poll is answered.
    const { getImageGenerationForRoute } = await import('@/lib/image-generation-route-service');
    const runAfterResponse = vi.fn();

    await getImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
      runAfterResponse,
    });
    await getImageGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
    });

    expect(mocks.getImageGenerationStatusForRoute.mock.calls.map(([input]) => input.runAfterResponse))
      .toEqual([runAfterResponse, undefined]);
    expect(runAfterResponse).not.toHaveBeenCalled();
  });
});

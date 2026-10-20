import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import { GenerationProviderAdapterError } from '@/lib/generation-model-adapters';
import {
  GENERATION_PROMPT_BLOCKED_MESSAGE,
  markGenerationStartInProgress,
  markGenerationStartRefusal,
  markHeldProviderSubmission,
  markRefundedGenerationStart,
} from '@/lib/generation-public-failure';
import { GenerationServiceError } from '@/lib/generation-services';
import { GenerationStartIdempotencyError } from '@/lib/generation-start-idempotency';
import { SourceGenerationValidationError } from '@/lib/source-generation';

const startUnifiedGenerationForRouteMock = vi.hoisted(() => vi.fn());
const reportKieInsufficientCreditsRefusalMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/kie-account-balance-refusal', () => ({
  reportKieInsufficientCreditsRefusal: (...args: unknown[]) => reportKieInsufficientCreditsRefusalMock(...args),
}));

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
import {
  ReferenceDurationChangedError,
  UnifiedGenerationRequestError,
} from '@/lib/unified-generation-start-service';

/** A start the service refused with `error`, as the route answers it. */
async function postRefusedStart(error: unknown) {
  startUnifiedGenerationForRouteMock.mockRejectedValueOnce(error);
  return postUnifiedGenerationForRoute({
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
}

/** A provider's rejection at task creation, after the start settled its hold. */
function refundedProviderRejection(message: string, generationId = 'generation-refunded-1') {
  const error = new Error(message);
  markRefundedGenerationStart(error, generationId);
  return error;
}

describe('unified generation route service', () => {
  beforeEach(() => {
    startUnifiedGenerationForRouteMock.mockReset();
    reportKieInsufficientCreditsRefusalMock.mockReset();
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
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate media.' },
      status: 401,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(startUnifiedGenerationForRouteMock).not.toHaveBeenCalled();
  });

  it('hands measured reference lengths back as a 409 the client can re-quote from', async () => {
    startUnifiedGenerationForRouteMock.mockRejectedValueOnce(new ReferenceDurationChangedError(
      [{ index: 0, slot: 'videoReferences', durationSeconds: 10 }],
      50,
      150,
    ));

    const result = await postUnifiedGenerationForRoute({
      request: new Request('http://localhost/api/generations', { method: 'POST' }),
      createUserSupabase: () => ({
        auth: {
          getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
        },
      }),
      createAdminSupabase: () => ({ kind: 'admin' }),
      kieApiKey: 'configured',
      readRequestBody: async () => ({ kind: 'video', modelId: 'seedance-2' }),
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        code: 'REFERENCE_DURATION_CHANGED',
        error: expect.stringContaining('Check the updated cost'),
        costCredits: 150,
        quotedCostCredits: 50,
        inputs: [{ index: 0, slot: 'videoReferences', durationSeconds: 10 }],
      },
    });
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

  describe('a refused start names what happened (C1)', () => {
    let logs: BackendLogRecord[];
    let restoreLogSink: () => void;

    beforeEach(() => {
      logs = [];
      restoreLogSink = setBackendLogSink((record) => {
        logs.push(record);
      });
    });

    afterEach(() => {
      restoreLogSink();
    });

    it('answers a blocked prompt with prompt_blocked and the copy that says nothing was used', async () => {
      const result = await postRefusedStart(
        new GenerationServiceError(GENERATION_PROMPT_BLOCKED_MESSAGE, 422, 'prompt_blocked'),
      );

      expect(result).toEqual({
        ok: false,
        status: 422,
        body: { code: 'prompt_blocked', error: GENERATION_PROMPT_BLOCKED_MESSAGE },
      });
    });

    it('answers a balance the hold could not take with insufficient_credits', async () => {
      const result = await postRefusedStart(
        new GenerationServiceError('Insufficient credits. This action costs 12 credits.', 402),
      );

      expect(result).toEqual({
        ok: false,
        status: 402,
        body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 12 credits.' },
      });
    });

    it('tells a busy provider apart from our own start limit', async () => {
      const busy = await postRefusedStart(new GenerationServiceError(
        'The generation provider is busy right now. Please retry shortly.',
        429,
        'provider_busy',
      ));
      const limited = await postRefusedStart(new BackendRateLimitError({
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: '2026-10-13T07:00:00.000Z',
      }));

      expect(busy).toEqual({
        ok: false,
        status: 429,
        body: {
          code: 'provider_busy',
          error: 'The generation provider is busy right now. Please retry shortly.',
        },
      });
      expect(limited).toMatchObject({
        ok: false,
        status: 429,
        body: { code: 'RATE_LIMITED' },
        rateLimitError: expect.any(BackendRateLimitError),
      });
    });

    it('answers a provider rejection at task creation as provider_rejected, and keeps its words in the log', async () => {
      // `createKieTask` throws a plain Error with the provider's text for a
      // body-level rejection; the start then fails the row and returns the hold.
      const providerText = 'Your prompt was flagged by the safety filter (request 4f1c-kling).';
      const result = await postRefusedStart(refundedProviderRejection(providerText));

      expect(result).toEqual({
        ok: false,
        status: 422,
        body: {
          code: 'provider_rejected',
          error: 'The generation provider could not accept this request. Check your prompt and inputs, then try again. No credits were used.',
        },
      });
      expect(JSON.stringify(result)).not.toContain('4f1c-kling');
      expect(logs).toEqual([
        expect.objectContaining({
          level: 'error',
          msg: 'unified_generation_start_failed',
          failureCode: 'provider_rejected',
          generationId: 'generation-refunded-1',
          errorMessage: providerText,
        }),
      ]);
    });

    it('keeps an unclassified failure a 500 a client checks again, with a code', async () => {
      const result = await postRefusedStart(new Error('Unexpected settlement shape'));

      expect(result).toEqual({
        ok: false,
        status: 500,
        body: { code: 'GENERATION_START_FAILED', error: 'Failed to start generation.' },
      });
      expect(logs).toEqual([
        expect.objectContaining({ msg: 'unified_generation_start_failed' }),
      ]);
    });

    it('does not call a lost connection a refusal unless the hold was returned', async () => {
      // The start holds a submission whose fate is unknown and marks it; one it
      // could not settle carries no mark. Neither is a definitive refusal.
      const unsettled = await postRefusedStart(new TypeError('fetch failed'));
      const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      markRefundedGenerationStart(refused, 'generation-refunded-2');
      const refunded = await postRefusedStart(refused);

      expect(unsettled).toMatchObject({ status: 500, body: { code: 'GENERATION_START_FAILED' } });
      expect(refunded).toEqual({
        ok: false,
        status: 503,
        body: {
          code: 'provider_unavailable',
          error: 'The generation provider is temporarily unavailable. Try again in a moment. No credits were used.',
        },
      });
    });

    it('reads a provider out of balance as an outage, never as the creator short of credits', async () => {
      const result = await postRefusedStart(refundedProviderRejection('Insufficient credits on this account'));

      expect(result).toMatchObject({ status: 503, body: { code: 'provider_unavailable' } });
    });

    it('tells the operator at once when the provider account itself is out of credits', async () => {
      await postRefusedStart(refundedProviderRejection('Insufficient credits on this account'));

      expect(reportKieInsufficientCreditsRefusalMock).toHaveBeenCalledTimes(1);
    });

    it('does not report the creator\'s own short balance, or any other refusal, as the provider running dry', async () => {
      await postRefusedStart(new GenerationServiceError('Insufficient credits. This action costs 12 credits.', 402));
      await postRefusedStart(refundedProviderRejection('image_input is invalid: image size too small'));
      await postRefusedStart(refundedProviderRejection('Your prompt was flagged by the safety filter.'));
      const held = new TypeError('fetch failed');
      markHeldProviderSubmission(held, 'generation-held-3');
      await postRefusedStart(held);

      expect(reportKieInsufficientCreditsRefusalMock).not.toHaveBeenCalled();
    });

    it('still answers the creator when reporting the empty provider account fails', async () => {
      reportKieInsufficientCreditsRefusalMock.mockImplementationOnce(() => {
        throw new Error('scheduler unavailable');
      });

      const result = await postRefusedStart(refundedProviderRejection('Insufficient credits on this account'));

      expect(result).toEqual({
        ok: false,
        status: 503,
        body: {
          code: 'provider_unavailable',
          error: 'The generation provider is temporarily unavailable. Try again in a moment. No credits were used.',
        },
      });
    });

    it('answers an upload the provider could not read with invalid_input_media', async () => {
      const result = await postRefusedStart(refundedProviderRejection('image_input is invalid: image size too small'));

      expect(result).toEqual({
        ok: false,
        status: 422,
        body: {
          code: 'invalid_input_media',
          error: 'The generation model could not read one of your uploads. Replace it, then try again. No credits were used.',
        },
      });
    });

    it.each([
      {
        name: 'a price that changed under a multi-shot run',
        error: new GenerationServiceError(
          'The price of this run changed. Check the updated cost and generate again.',
          409,
          'cost_changed',
        ),
        status: 409,
        code: 'cost_changed',
      },
      {
        name: 'an own upload that has expired',
        error: new GenerationServiceError('This reference upload has expired. Add it again.', 400, 'invalid_input_media'),
        status: 400,
        code: 'invalid_input_media',
      },
      {
        name: 'a service whose setup is incomplete',
        error: new GenerationServiceError('Generation setup is incomplete.', 503, 'service_misconfigured'),
        status: 503,
        code: 'service_misconfigured',
      },
      {
        name: 'a prompt the service refuses',
        error: new GenerationServiceError('Prompt is too long.', 400),
        status: 400,
        code: 'INVALID_GENERATION_REQUEST',
      },
      {
        name: 'a key that ended with a failed start',
        error: (() => {
          const error = new GenerationServiceError('This idempotency key was already used by a failed generation start. Retry with a new key.', 409);
          markGenerationStartRefusal(error, 'key_already_used');
          return error;
        })(),
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      },
      {
        name: 'a start still unresolved under the key',
        error: (() => {
          const error = new GenerationServiceError('A generation with this idempotency key is already starting. Retry shortly.', 409);
          markGenerationStartInProgress(error, 'generation-active-1');
          return error;
        })(),
        status: 409,
        code: 'GENERATION_START_IN_PROGRESS',
      },
      {
        name: 'an account without a credit profile',
        error: new GenerationServiceError('Could not find a credit profile for this account.', 401),
        status: 401,
        code: 'UNAUTHORIZED',
      },
      {
        name: 'a provider task that could not be recorded',
        error: new GenerationServiceError('Failed to attach provider task to generation.', 500),
        status: 500,
        code: 'GENERATION_START_FAILED',
      },
    ])('names $name with $code, in the service\'s words', async ({ error, status, code }) => {
      const result = await postRefusedStart(error);

      expect(result).toEqual({ ok: false, status, body: { code, error: error.message } });
    });

    it.each([
      ['a catalog that changed', new CatalogError('The model catalog changed.', 'CATALOG_CHANGED', 409)],
      ['a measured reference that raised the price', new ReferenceDurationChangedError([], 50, 150)],
      ['a malformed request', new UnifiedGenerationRequestError('Invalid generation request.', 422)],
      ['an unreadable remix source', new SourceGenerationValidationError('Source generation not found or inaccessible.')],
      ['a remix source that could not be checked', new SourceGenerationValidationError('Failed to validate the remix source.', 500)],
      ['a reused key', new GenerationStartIdempotencyError('Key reused.', 409, 'IDEMPOTENCY_KEY_REUSED')],
      ['a rejecting adapter', new GenerationProviderAdapterError('Unsupported setting.', 400)],
      ['an unavailable adapter', new GenerationProviderAdapterError('Adapter down.', 503)],
      ['a held submission', (() => {
        const error = new TypeError('fetch failed');
        markHeldProviderSubmission(error, 'generation-held-2');
        return error;
      })()],
      ['a body that is not JSON', new SyntaxError('Unexpected token < in JSON')],
      ['a thrown string', 'boom'],
    ])('gives %s a code and an error', async (_name, error) => {
      const result = await postRefusedStart(error);

      expect(result.ok).toBe(false);
      expect(result.body).toEqual(expect.objectContaining({
        code: expect.any(String),
        error: expect.any(String),
      }));
    });
  });
});

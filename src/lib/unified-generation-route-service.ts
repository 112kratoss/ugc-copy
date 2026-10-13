import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import { GenerationProviderAdapterError } from '@/lib/generation-model-adapters';
import { GenerationServiceError } from '@/lib/generation-services';
import {
  getGenerationStartRefusal,
  getHeldProviderSubmissionGenerationId,
  getPublicGenerationStartFailure,
  getRefundedStartGenerationId,
  normalizeGenerationStartFailureCode,
} from '@/lib/generation-public-failure';
import { GenerationStartIdempotencyError } from '@/lib/generation-start-idempotency';
import { SourceGenerationValidationError } from '@/lib/source-generation';
import {
  ReferenceDurationChangedError,
  UnifiedGenerationRequestError,
  startUnifiedGenerationForRoute,
} from '@/lib/unified-generation-start-service';

type RouteBody = Record<string, unknown>;

export type UnifiedGenerationRouteResult =
  | {
      ok: true;
      body: RouteBody;
    }
  | {
      ok: false;
      body: RouteBody;
      status: number;
      rateLimitError?: BackendRateLimitError;
    };

export interface UnifiedGenerationRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  kieApiKey?: string;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
}

async function readBody(input: UnifiedGenerationRouteInput): Promise<Record<string, unknown>> {
  const body = input.readRequestBody
    ? await input.readRequestBody()
    : await input.request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
      body: 'The request body must be an object.',
    });
  }
  return body as Record<string, unknown>;
}

/** What every start route answers when a start throws: a `code` and an `error`, always. */
export type GenerationStartRouteFailure = Extract<UnifiedGenerationRouteResult, { ok: false }>;

/**
 * A start that failed for a reason with no code of its own. On a 5xx nobody
 * can say whether a run began, so a caller keeps its key and checks again.
 */
const GENERATION_START_FAILED_CODE = 'GENERATION_START_FAILED';

/**
 * What the creator is told when the provider turned a start away after the
 * credit hold, and the hold was returned. `getPublicGenerationStartFailure`
 * words the same refusals for a template or workflow step.
 */
const REFUSED_START_ANSWERS = {
  provider_rejected: {
    status: 422,
    message: 'The generation provider could not accept this request. Check your prompt and inputs, then try again. No credits were used.',
  },
  invalid_input_media: {
    status: 422,
    message: 'The generation model could not read one of your uploads. Replace it, then try again. No credits were used.',
  },
  provider_busy: {
    status: 429,
    message: 'The generation provider is busy right now. Try again in a moment. No credits were used.',
  },
  provider_unavailable: {
    status: 503,
    message: 'The generation provider is temporarily unavailable. Try again in a moment. No credits were used.',
  },
} as const;

function refusedStartCode(error: unknown): keyof typeof REFUSED_START_ANSWERS {
  const { code } = getPublicGenerationStartFailure(error);
  if (code === 'invalid_input_media' || code === 'provider_busy' || code === 'provider_unavailable') {
    return code;
  }
  // The creator's hold went through, so a balance the provider calls short is
  // the service's own account, not theirs.
  return code === 'insufficient_credits' ? 'provider_unavailable' : 'provider_rejected';
}

function generationServiceErrorCode(error: GenerationServiceError): string {
  // `cost_changed` refuses a start before anything is held, so it is not one
  // of the public codes a run can fail with; it is matched on its own first.
  const failureCode: unknown = error.failureCode;
  if (failureCode === 'cost_changed') return failureCode;
  const publicCode = normalizeGenerationStartFailureCode(failureCode);
  if (publicCode) return publicCode;

  switch (error.status) {
    case 400:
    case 422:
      return 'INVALID_GENERATION_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 402:
      return 'insufficient_credits';
    case 409: {
      // The start function's refusals are marked; its one unmarked 409 is a
      // start still unresolved under this key, which a caller checks again.
      const refusal = getGenerationStartRefusal(error);
      if (refusal === 'key_already_used') return 'IDEMPOTENCY_KEY_REUSED';
      return refusal ? 'INVALID_GENERATION_REQUEST' : 'GENERATION_START_IN_PROGRESS';
    }
    case 429:
      return 'provider_busy';
    default:
      return GENERATION_START_FAILED_CODE;
  }
}

/**
 * The one answer of POST /api/generations, /generate, /generate-image and
 * /generate-video to a start that threw, so both apps can choose what to offer
 * from `code`. A route passes the event it logs under and its own words for a
 * failure nobody classified.
 */
export function mapGenerationStartRouteError(
  error: unknown,
  { logEvent, fallbackMessage }: { logEvent: string; fallbackMessage: string },
): GenerationStartRouteFailure {
  if (error instanceof CatalogError) {
    return {
      ok: false,
      body: {
        code: error.code,
        error: error.message,
        fieldErrors: error.fieldErrors,
      },
      status: error.status,
    };
  }
  if (error instanceof ReferenceDurationChangedError) {
    // The measured lengths travel back so a client can re-quote with them
    // instead of repeating the length it measured itself.
    return {
      ok: false,
      body: {
        code: error.code,
        error: error.message,
        costCredits: error.costCredits,
        quotedCostCredits: error.quotedCostCredits,
        inputs: error.inputs,
      },
      status: error.status,
    };
  }
  if (error instanceof UnifiedGenerationRequestError) {
    return {
      ok: false,
      body: {
        code: 'INVALID_GENERATION_REQUEST',
        error: error.message,
        fieldErrors: error.fieldErrors,
      },
      status: error.status,
    };
  }
  if (error instanceof SourceGenerationValidationError) {
    return {
      ok: false,
      body: {
        code: error.status < 500 ? 'INVALID_GENERATION_REQUEST' : GENERATION_START_FAILED_CODE,
        error: error.message,
      },
      status: error.status,
    };
  }
  if (error instanceof GenerationStartIdempotencyError) {
    return {
      ok: false,
      body: { code: error.code, error: error.message },
      status: error.status,
    };
  }
  if (error instanceof BackendRateLimitError) {
    return {
      ok: false,
      body: { code: 'RATE_LIMITED', error: error.message },
      status: error.status,
      rateLimitError: error,
    };
  }
  if (error instanceof GenerationProviderAdapterError) {
    return {
      ok: false,
      body: {
        code: error.status < 500
          ? 'INVALID_GENERATION_REQUEST'
          : 'GENERATION_ADAPTER_UNAVAILABLE',
        error: error.status < 500
          ? error.message
          : 'This model is temporarily unavailable.',
      },
      status: error.status,
    };
  }
  const publicFailure = getPublicGenerationStartFailure(error);
  if (publicFailure.code === 'submission_pending') {
    return {
      ok: false,
      body: {
        code: publicFailure.code,
        error: publicFailure.message,
        generationId: getHeldProviderSubmissionGenerationId(error),
      },
      status: 409,
    };
  }
  if (error instanceof GenerationServiceError) {
    if (error.status >= 500) logBackendError(logEvent, { error });
    return {
      ok: false,
      body: { code: generationServiceErrorCode(error), error: error.message },
      status: error.status,
    };
  }
  // Any other error is a refusal only when the start's settlement says so: it
  // marks the error once the generation is failed and its hold returned. That
  // is how the provider's own rejections arrive (a plain `Error` carrying its
  // text), and nothing of that start is left running or reserved.
  const refundedGenerationId = getRefundedStartGenerationId(error);
  if (refundedGenerationId) {
    const code = refusedStartCode(error);
    // The provider's words go to the log only: they can carry model ids, URLs
    // or the prompt.
    logBackendError(logEvent, { failureCode: code, generationId: refundedGenerationId, error });
    return {
      ok: false,
      body: { code, error: REFUSED_START_ANSWERS[code].message },
      status: REFUSED_START_ANSWERS[code].status,
    };
  }
  if (error instanceof SyntaxError) {
    return {
      ok: false,
      body: {
        code: 'INVALID_GENERATION_REQUEST',
        error: 'The generation request could not be processed.',
        fieldErrors: {},
      },
      status: 422,
    };
  }

  logBackendError(logEvent, { error });
  return {
    ok: false,
    body: { code: GENERATION_START_FAILED_CODE, error: fallbackMessage },
    status: 500,
  };
}

export async function postUnifiedGenerationForRoute(
  input: UnifiedGenerationRouteInput,
): Promise<UnifiedGenerationRouteResult> {
  const supabase = input.createUserSupabase() as SupabaseClient;
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);
  if (authError || !user) {
    return {
      ok: false,
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate media.' },
      status: 401,
    };
  }

  if (!input.kieApiKey) {
    logBackendError('kie_ai_api_key_not_found_in_environment_variables');
    return {
      ok: false,
      body: {
        code: 'GENERATION_SERVICE_UNAVAILABLE',
        error: 'Generation is temporarily unavailable.',
      },
      status: 503,
    };
  }

  try {
    const body = await readBody(input);
    const payload = await startUnifiedGenerationForRoute({
      request: input.request,
      body,
      userId: user.id,
      supabase,
      adminSupabase: input.createAdminSupabase() as SupabaseClient,
    });
    return { ok: true, body: payload };
  } catch (error) {
    return mapGenerationStartRouteError(error, {
      logEvent: 'unified_generation_start_failed',
      fallbackMessage: 'Failed to start generation.',
    });
  }
}

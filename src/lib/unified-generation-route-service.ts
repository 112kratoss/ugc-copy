import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import { GenerationProviderAdapterError } from '@/lib/generation-model-adapters';
import { GenerationServiceError } from '@/lib/generation-services';
import {
  getHeldProviderSubmissionGenerationId,
  getPublicGenerationStartFailure,
} from '@/lib/generation-public-failure';
import { GenerationStartIdempotencyError } from '@/lib/generation-start-idempotency';
import { SourceGenerationValidationError } from '@/lib/source-generation';
import {
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

function mapUnifiedGenerationError(error: unknown): UnifiedGenerationRouteResult {
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
    return { ok: false, body: { error: error.message }, status: error.status };
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
      body: { error: error.message },
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
    return {
      ok: false,
      body: { error: error.message },
      status: error.status,
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

  logBackendError('unified_generation_start_failed', { error: error });
  return {
    ok: false,
    body: { error: 'Failed to start generation.' },
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
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return {
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate media.' },
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
    return mapUnifiedGenerationError(error);
  }
}

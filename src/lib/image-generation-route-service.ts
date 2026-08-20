import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
} from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import {
  GenerationServiceError,
} from '@/lib/generation-services';
import {
  getHeldProviderSubmissionGenerationId,
  getPublicGenerationStartFailure,
} from '@/lib/generation-public-failure';
import {
  GenerationStartIdempotencyError,
} from '@/lib/generation-start-idempotency';
import {
  getImageGenerationStatusForRoute,
} from '@/lib/image-generation-status-service';
import {
  startImageGenerationForRoute,
} from '@/lib/image-generation-start-service';
import { SourceGenerationValidationError } from '@/lib/source-generation';

type RouteBody = Record<string, unknown>;

export type ImageGenerationRouteResult =
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

type ImageRouteSupabaseClient = SupabaseClient;

export interface ImageGenerationRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  kieApiKey?: string;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
}

async function getAuthenticatedUserId(supabase: ImageRouteSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  return authError || !user ? null : user.id;
}

async function readRequestBody(input: ImageGenerationRouteInput) {
  const body = input.readRequestBody ? await input.readRequestBody() : await input.request.json();
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function mapImageStartError(error: unknown): ImageGenerationRouteResult {
  if (error instanceof CatalogError) {
    return {
      ok: false,
      body: {
        error: error.message,
        code: error.code,
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

  logBackendError('error_starting_image_generation', { error: error });
  if (error instanceof GenerationServiceError) {
    return { ok: false, body: { error: error.message }, status: error.status };
  }

  // Unexpected errors stay in the backend logs; clients get a fixed message.
  return {
    ok: false,
    body: { error: 'Failed to start image generation' },
    status: 500,
  };
}

export async function postImageGenerationForRoute(
  input: ImageGenerationRouteInput,
): Promise<ImageGenerationRouteResult> {
  const supabase = input.createUserSupabase() as ImageRouteSupabaseClient;
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) {
    return {
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate images' },
      status: 401,
    };
  }

  if (!input.kieApiKey) {
    logBackendError('kie_ai_api_key_not_found_in_environment_variables');
    return {
      ok: false,
      body: { error: 'Server configuration error: API key missing' },
      status: 500,
    };
  }

  try {
    const body = await readRequestBody(input);
    const payload = await startImageGenerationForRoute({
      request: input.request,
      body,
      userId,
      supabase,
      adminSupabase: input.createAdminSupabase() as ImageRouteSupabaseClient,
    });

    return { ok: true, body: payload };
  } catch (error) {
    return mapImageStartError(error);
  }
}

export async function getImageGenerationForRoute(
  input: ImageGenerationRouteInput,
): Promise<ImageGenerationRouteResult> {
  const { searchParams } = new URL(input.request.url);
  const predictionId = searchParams.get('id');

  if (!predictionId) {
    return {
      ok: false,
      body: { error: 'Missing prediction ID' },
      status: 400,
    };
  }

  try {
    const supabase = input.createUserSupabase() as ImageRouteSupabaseClient;
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return {
        ok: false,
        body: { error: 'Unauthorized: Please log in to check generation status' },
        status: 401,
      };
    }

    const result = await getImageGenerationStatusForRoute({
      request: input.request,
      predictionId,
      userId,
      createAdminSupabase: input.createAdminSupabase as () => ImageRouteSupabaseClient,
      kieApiKey: input.kieApiKey,
    });

    if (!result.ok) {
      return { ok: false, body: result.body, status: result.status };
    }

    return { ok: true, body: result.body };
  } catch (error) {
    logBackendError('error_fetching_image_status', { error: error });
    return {
      ok: false,
      body: { error: 'Failed to fetch generation status' },
      status: 500,
    };
  }
}

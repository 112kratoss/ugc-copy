import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
} from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  getImageGenerationStatusForRoute,
} from '@/lib/image-generation-status-service';
import {
  startImageGenerationForRoute,
} from '@/lib/image-generation-start-service';
import { mapGenerationStartRouteError } from '@/lib/unified-generation-route-service';

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
  /** Where a status check sends the notification for an image it finds failed, once it has answered. */
  runAfterResponse?: RunAfterResponse;
}

async function getAuthenticatedUser(supabase: ImageRouteSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  return authError || !user ? null : user;
}

async function readRequestBody(input: ImageGenerationRouteInput) {
  const body = input.readRequestBody ? await input.readRequestBody() : await input.request.json();
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function mapImageStartError(error: unknown): ImageGenerationRouteResult {
  return mapGenerationStartRouteError(error, {
    logEvent: 'error_starting_image_generation',
    fallbackMessage: 'Failed to start image generation',
  });
}

export async function postImageGenerationForRoute(
  input: ImageGenerationRouteInput,
): Promise<ImageGenerationRouteResult> {
  const supabase = input.createUserSupabase() as ImageRouteSupabaseClient;
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return {
      ok: false,
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate images' },
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
    const body = await readRequestBody(input);
    const payload = await startImageGenerationForRoute({
      request: input.request,
      body,
      userId: user.id,
      callerIsGuest: isGuestUser(user),
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
    const userId = (await getAuthenticatedUser(supabase))?.id;
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
      runAfterResponse: input.runAfterResponse,
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

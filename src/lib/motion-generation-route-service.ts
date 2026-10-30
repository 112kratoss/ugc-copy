import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
} from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  getMotionGenerationStatusForRoute,
} from '@/lib/motion-generation-status-service';
import {
  MotionGenerationStartValidationError,
  startMotionGenerationForRoute,
} from '@/lib/motion-generation-start-service';
import { mapGenerationStartRouteError } from '@/lib/unified-generation-route-service';

type RouteBody = Record<string, unknown>;

export type MotionGenerationRouteResult =
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

type MotionRouteSupabaseClient = SupabaseClient;

export interface MotionGenerationRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  kieApiKey?: string;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
  /** Where a status check sends the notification for a motion render it finds failed, once it has answered. */
  runAfterResponse?: RunAfterResponse;
}

async function getAuthenticatedUser(supabase: MotionRouteSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  return authError || !user ? null : user;
}

async function getAuthenticatedUserId(supabase: MotionRouteSupabaseClient) {
  return (await getAuthenticatedUser(supabase))?.id ?? null;
}

async function readRequestBody(input: MotionGenerationRouteInput) {
  const body = input.readRequestBody ? await input.readRequestBody() : await input.request.json();
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function mapMotionStartError(error: unknown): MotionGenerationRouteResult {
  if (error instanceof MotionGenerationStartValidationError) {
    return {
      ok: false,
      body: { code: 'INVALID_GENERATION_REQUEST', error: error.message },
      status: error.status,
    };
  }

  return mapGenerationStartRouteError(error, {
    logEvent: 'error_starting_video_generation',
    fallbackMessage: 'Failed to start video generation',
  });
}

export async function postMotionGenerationForRoute(
  input: MotionGenerationRouteInput,
): Promise<MotionGenerationRouteResult> {
  const supabase = input.createUserSupabase() as MotionRouteSupabaseClient;
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    return {
      ok: false,
      body: { code: 'UNAUTHORIZED', error: 'Unauthorized: Please log in to generate videos' },
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
    const payload = await startMotionGenerationForRoute({
      request: input.request,
      body,
      userId: user.id,
      callerIsGuest: isGuestUser(user),
      supabase,
      adminSupabase: input.createAdminSupabase() as MotionRouteSupabaseClient,
    });

    return { ok: true, body: payload };
  } catch (error) {
    return mapMotionStartError(error);
  }
}

export async function getMotionGenerationForRoute(
  input: MotionGenerationRouteInput,
): Promise<MotionGenerationRouteResult> {
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
    const supabase = input.createUserSupabase() as MotionRouteSupabaseClient;
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return {
        ok: false,
        body: { error: 'Unauthorized: Please log in to check generation status' },
        status: 401,
      };
    }

    const result = await getMotionGenerationStatusForRoute({
      request: input.request,
      predictionId,
      userId,
      supabase,
      createAdminSupabase: input.createAdminSupabase as () => MotionRouteSupabaseClient,
      kieApiKey: input.kieApiKey,
      runAfterResponse: input.runAfterResponse,
    });

    if (!result.ok) {
      return { ok: false, body: result.body, status: result.status };
    }

    return { ok: true, body: result.body };
  } catch (error) {
    logBackendError('error_fetching_prediction', { error: error });
    return {
      ok: false,
      body: { error: 'Failed to fetch prediction status' },
      status: 500,
    };
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
} from '@/lib/backend-rate-limit';
import { CatalogError } from '@/lib/generation-model-catalog';
import {
  GenerationServiceError,
} from '@/lib/generation-services';
import {
  GenerationStartIdempotencyError,
} from '@/lib/generation-start-idempotency';
import { SourceGenerationValidationError } from '@/lib/source-generation';
import {
  getVideoGenerationStatusForRoute,
} from '@/lib/video-generation-status-service';
import {
  startVideoGenerationForRoute,
} from '@/lib/video-generation-start-service';

type RouteBody = Record<string, unknown>;

export type VideoGenerationRouteResult =
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

type VideoRouteSupabaseClient = SupabaseClient;

export interface VideoGenerationRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  kieApiKey?: string;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
}

async function getAuthenticatedUserId(supabase: VideoRouteSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

async function readRequestBody(input: VideoGenerationRouteInput) {
  const body = input.readRequestBody ? await input.readRequestBody() : await input.request.json();
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function mapVideoStartError(error: unknown): VideoGenerationRouteResult {
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

  console.error('Error starting video generation:', error);
  const message = error instanceof Error ? error.message : 'Failed to start video generation';
  const status = error instanceof GenerationServiceError ? error.status : 500;
  return {
    ok: false,
    body: { error: message },
    status,
  };
}

export async function postVideoGenerationForRoute(
  input: VideoGenerationRouteInput,
): Promise<VideoGenerationRouteResult> {
  const supabase = input.createUserSupabase() as VideoRouteSupabaseClient;
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) {
    return {
      ok: false,
      body: { error: 'Unauthorized: Please log in to generate videos' },
      status: 401,
    };
  }

  if (!input.kieApiKey) {
    console.error('KIE_AI_API_KEY not found in environment variables');
    return {
      ok: false,
      body: { error: 'Server configuration error: API key missing' },
      status: 500,
    };
  }

  try {
    const body = await readRequestBody(input);
    const payload = await startVideoGenerationForRoute({
      request: input.request,
      body,
      userId,
      supabase,
      adminSupabase: input.createAdminSupabase() as VideoRouteSupabaseClient,
    });

    return { ok: true, body: payload };
  } catch (error) {
    return mapVideoStartError(error);
  }
}

export async function getVideoGenerationForRoute(
  input: VideoGenerationRouteInput,
): Promise<VideoGenerationRouteResult> {
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
    const supabase = input.createUserSupabase() as VideoRouteSupabaseClient;
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) {
      return {
        ok: false,
        body: { error: 'Unauthorized: Please log in to check generation status' },
        status: 401,
      };
    }

    const result = await getVideoGenerationStatusForRoute({
      request: input.request,
      predictionId,
      userId,
      supabase,
      createAdminSupabase: input.createAdminSupabase as () => VideoRouteSupabaseClient,
      kieApiKey: input.kieApiKey,
    });

    if (!result.ok) {
      return { ok: false, body: result.body, status: result.status };
    }

    return { ok: true, body: result.body };
  } catch (error) {
    console.error('Error fetching video status:', error);
    return {
      ok: false,
      body: { error: 'Failed to fetch generation status' },
      status: 500,
    };
  }
}

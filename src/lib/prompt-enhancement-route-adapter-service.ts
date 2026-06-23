import 'server-only';

import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  enhancePromptForUser,
  type PromptEnhancementResult,
} from '@/lib/prompt-enhancement-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PromptEnhancementRouteAdapterDependencies = {
  createUserClient?: typeof createUserClient;
  createServiceClient?: typeof createServiceClient;
  enhancePromptForUser?: typeof enhancePromptForUser;
};

function resolveDependencies(dependencies: PromptEnhancementRouteAdapterDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enhancePromptForUser: dependencies?.enhancePromptForUser ?? enhancePromptForUser,
  };
}

function createPromptEnhancementHeaders(
  request: Request,
  result?: Extract<PromptEnhancementResult, { ok: false }>,
) {
  const headers = new Headers(createPrivateNoStoreApiResponseHeaders(request));
  if (!result) return headers;

  if (result.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(result.retryAfterSeconds));
  }
  if (result.limit !== undefined) {
    headers.set('X-RateLimit-Limit', String(result.limit));
  }
  if (result.remaining !== undefined) {
    headers.set('X-RateLimit-Remaining', String(result.remaining));
  }
  if (result.resetAt) {
    headers.set('X-RateLimit-Reset', result.resetAt);
  }

  return headers;
}

function createJsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: createPromptEnhancementHeaders(request),
  });
}

function createPromptEnhancementErrorResponse(
  request: Request,
  result: Extract<PromptEnhancementResult, { ok: false }>,
) {
  return NextResponse.json({
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    ...(result.required !== undefined ? { required: result.required } : {}),
    ...(result.remainingCredits !== undefined ? { remainingCredits: result.remainingCredits } : {}),
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...(result.resetAt ? { resetAt: result.resetAt } : {}),
  }, {
    status: result.status,
    headers: createPromptEnhancementHeaders(request, result),
  });
}

export async function postPromptEnhancementRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: PromptEnhancementRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    const supabase = resolvedDependencies.createUserClient(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return createJsonResponse(request, { error: 'Unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return createJsonResponse(request, { error: 'Prompt is required' }, 400);
    }

    const result = await resolvedDependencies.enhancePromptForUser({
      body,
      userId: user.id,
      request,
      client: resolvedDependencies.createServiceClient,
    });

    if (!result.ok) {
      return createPromptEnhancementErrorResponse(request, result);
    }

    return createJsonResponse(request, result.response);
  } catch (error) {
    console.error('[EnhancePrompt] Unexpected error:', error);
    return createJsonResponse(request, { error: 'Internal server error' }, 500);
  }
}

import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  createTemporaryMediaReadUrl,
  type TemporaryMediaReadUrlResult,
} from '@/lib/temporary-media-read-url';

type TemporaryMediaReadUrlRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createTemporaryMediaReadUrl?: typeof createTemporaryMediaReadUrl;
  createUserClient?: typeof createUserClient;
};

function resolveDependencies(dependencies: TemporaryMediaReadUrlRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createTemporaryMediaReadUrl: dependencies?.createTemporaryMediaReadUrl ?? createTemporaryMediaReadUrl,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
  };
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

function createTemporaryMediaReadUrlErrorResponse(
  result: TemporaryMediaReadUrlResult & { ok: false },
) {
  const headers = new Headers();
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

  return NextResponse.json({
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...(result.resetAt ? { resetAt: result.resetAt } : {}),
  }, { status: result.status, headers });
}

async function handleTemporaryMediaReadUrlPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const userId = await getAuthenticatedUserId(request, dependencies);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Media path is required.' }, { status: 400 });
  }

  const result = await dependencies.createTemporaryMediaReadUrl({
    body,
    userId,
    client: dependencies.createServiceClient,
  });

  if (!result.ok) {
    return createTemporaryMediaReadUrlErrorResponse(result);
  }

  return NextResponse.json(result.response);
}

export async function postTemporaryMediaReadUrlRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: TemporaryMediaReadUrlRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleTemporaryMediaReadUrlPOST(request, resolvedDependencies),
    request,
  );
}

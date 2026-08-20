import 'server-only';

import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
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
  requireIdentity?: typeof requireIdentity;
};

function resolveDependencies(dependencies: TemporaryMediaReadUrlRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createTemporaryMediaReadUrl: dependencies?.createTemporaryMediaReadUrl ?? createTemporaryMediaReadUrl,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
  };
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
  const userClient = dependencies.createUserClient(request);
  let serviceClient: ReturnType<typeof dependencies.createServiceClient> | null = null;
  const getServiceClient = () => {
    serviceClient ??= dependencies.createServiceClient();
    return serviceClient;
  };
  const identity = await dependencies.requireIdentity(userClient, getServiceClient);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.error, code: identity.code },
      { status: identity.status },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Media path is required.' }, { status: 400 });
  }

  const result = await dependencies.createTemporaryMediaReadUrl({
    body,
    userId: identity.identity.userId,
    client: getServiceClient,
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

import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  createWorkflowAssetReadUrl,
  type WorkflowAssetReadUrlResult,
} from '@/lib/workflow-asset-read-url';

type WorkflowAssetReadUrlRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  createWorkflowAssetReadUrl?: typeof createWorkflowAssetReadUrl;
};

function resolveDependencies(dependencies: WorkflowAssetReadUrlRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createWorkflowAssetReadUrl: dependencies?.createWorkflowAssetReadUrl ?? createWorkflowAssetReadUrl,
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

function createWorkflowAssetReadUrlErrorResponse(
  result: WorkflowAssetReadUrlResult & { ok: false },
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

async function handleWorkflowAssetReadUrlPOST(
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
    return NextResponse.json(
      { error: 'Workflow asset path is required.' },
      { status: 400 },
    );
  }

  const result = await dependencies.createWorkflowAssetReadUrl({
    body,
    userId,
    client: dependencies.createServiceClient,
  });

  if (!result.ok) {
    return createWorkflowAssetReadUrlErrorResponse(result);
  }

  return NextResponse.json(result.response);
}

export async function postWorkflowAssetReadUrlRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: WorkflowAssetReadUrlRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowAssetReadUrlPOST(request, resolvedDependencies),
    request,
  );
}

import 'server-only';

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  createWorkflowAssetUploadIntent,
  type WorkflowAssetUploadIntentResult,
} from '@/lib/workflow-asset-upload-sign';

type WorkflowAssetUploadSignRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUploadId?: () => string;
  createUserClient?: typeof createUserClient;
  createWorkflowAssetUploadIntent?: typeof createWorkflowAssetUploadIntent;
};

function resolveDependencies(dependencies: WorkflowAssetUploadSignRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUploadId: dependencies?.createUploadId ?? randomUUID,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createWorkflowAssetUploadIntent:
      dependencies?.createWorkflowAssetUploadIntent ?? createWorkflowAssetUploadIntent,
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

function createWorkflowAssetUploadSignErrorResponse(
  result: WorkflowAssetUploadIntentResult & { ok: false },
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

async function handleWorkflowAssetUploadSignPOST(
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
      { error: 'Invalid workflow asset upload metadata.' },
      { status: 400 },
    );
  }

  const result = await dependencies.createWorkflowAssetUploadIntent({
    body,
    userId,
    client: dependencies.createServiceClient,
    createUploadId: dependencies.createUploadId,
  });

  if (!result.ok) {
    return createWorkflowAssetUploadSignErrorResponse(result);
  }

  return NextResponse.json(result.response);
}

export async function postWorkflowAssetUploadSignRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: WorkflowAssetUploadSignRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowAssetUploadSignPOST(request, resolvedDependencies),
    request,
  );
}

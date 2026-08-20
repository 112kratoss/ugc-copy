import 'server-only';

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
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
  requireIdentity?: typeof requireIdentity;
};

function resolveDependencies(dependencies: WorkflowAssetUploadSignRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUploadId: dependencies?.createUploadId ?? randomUUID,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createWorkflowAssetUploadIntent:
      dependencies?.createWorkflowAssetUploadIntent ?? createWorkflowAssetUploadIntent,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
  };
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
    return NextResponse.json(
      { error: 'Invalid workflow asset upload metadata.' },
      { status: 400 },
    );
  }

  const result = await dependencies.createWorkflowAssetUploadIntent({
    body,
    userId: identity.identity.userId,
    client: getServiceClient,
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

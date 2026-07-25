import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { authenticateRequest, createServiceClient } from '@/lib/server-helpers';
import {
  createWorkflowShareForRoute,
  type WorkflowShareCreateRouteResult,
} from '@/lib/workflow-share-create-service';
import {
  importWorkflowShareForRoute,
  type WorkflowShareImportRouteResult,
} from '@/lib/workflow-share-import-service';
import {
  isWorkflowShareId,
  toWorkflowSharePreview,
  WORKFLOW_SHARE_SELECT,
  type WorkflowShareRow,
} from '@/lib/workflow-share';

type WorkflowShareCreateRouteContext = {
  params: Promise<{ id: string }>;
};

type WorkflowShareImportRouteContext = {
  params: Promise<{ shareId: string }>;
};

type WorkflowSharePreviewRouteContext = {
  params: Promise<{ shareId: string }>;
};

type WorkflowShareRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  createServiceClient?: typeof createServiceClient;
  createWorkflowShareForRoute?: typeof createWorkflowShareForRoute;
  importWorkflowShareForRoute?: typeof importWorkflowShareForRoute;
};

function resolveDependencies(dependencies: WorkflowShareRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createWorkflowShareForRoute: dependencies?.createWorkflowShareForRoute ?? createWorkflowShareForRoute,
    importWorkflowShareForRoute: dependencies?.importWorkflowShareForRoute ?? importWorkflowShareForRoute,
  };
}

function toJsonResponse(result: WorkflowShareCreateRouteResult | WorkflowShareImportRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleWorkflowShareCreatePOST(
  request: Request,
  context: WorkflowShareCreateRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const { supabase, userId } = auth;
  return toJsonResponse(await dependencies.createWorkflowShareForRoute({
    canvasId: id,
    origin: new URL(request.url).origin,
    serviceSupabase: dependencies.createServiceClient(),
    userId,
    userSupabase: supabase,
  }));
}

async function handleWorkflowShareImportPOST(
  request: Request,
  context: WorkflowShareImportRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { shareId } = await context.params;
  const { supabase, userId } = auth;
  return toJsonResponse(await dependencies.importWorkflowShareForRoute({
    origin: new URL(request.url).origin,
    serviceSupabase: dependencies.createServiceClient(),
    shareId,
    userId,
    userSupabase: supabase,
  }));
}

async function handleWorkflowSharePreviewGET(
  request: Request,
  context: WorkflowSharePreviewRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { shareId } = await context.params;
  if (!isWorkflowShareId(shareId)) {
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  const { data, error } = await auth.supabase
    .from('workflow_shares')
    .select(WORKFLOW_SHARE_SELECT)
    .eq('id', shareId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      logBackendError('failed_to_load_workflow_share_snapshot', { error: error });
    }
    return NextResponse.json({ error: 'Workflow share not found.' }, { status: 404 });
  }

  return NextResponse.json({
    share: toWorkflowSharePreview(data as unknown as WorkflowShareRow, new URL(request.url).origin),
  });
}

export async function postWorkflowShareCreateRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowShareCreateRouteContext;
  dependencies?: WorkflowShareRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowShareCreatePOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}

export async function getWorkflowSharePreviewRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowSharePreviewRouteContext;
  dependencies?: WorkflowShareRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowSharePreviewGET(request, context, resolveDependencies(dependencies)),
    request,
  );
}

export async function postWorkflowShareImportRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: WorkflowShareImportRouteContext;
  dependencies?: WorkflowShareRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleWorkflowShareImportPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}

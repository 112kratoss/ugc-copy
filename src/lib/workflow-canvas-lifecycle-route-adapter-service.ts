import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  authenticateRequest,
  type AuthResult,
} from '@/lib/server-helpers';
import { enforceWorkflowCanvasMutationRateLimit } from '@/lib/workflow-canvas-mutation-rate-limit';
import {
  listWorkflowCanvasHistoryForRoute,
  publishWorkflowCanvasForRoute,
  restoreWorkflowCanvasHistoryForRoute,
} from '@/lib/workflow-canvas-lifecycle-service';

type WorkflowCanvasLifecycleRouteResult =
  | Awaited<ReturnType<typeof listWorkflowCanvasHistoryForRoute>>
  | Awaited<ReturnType<typeof publishWorkflowCanvasForRoute>>
  | Awaited<ReturnType<typeof restoreWorkflowCanvasHistoryForRoute>>;

type WorkflowCanvasLifecycleRouteAdapterDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  enforceWorkflowCanvasMutationRateLimit?: typeof enforceWorkflowCanvasMutationRateLimit;
  listWorkflowCanvasHistoryForRoute?: typeof listWorkflowCanvasHistoryForRoute;
  publishWorkflowCanvasForRoute?: typeof publishWorkflowCanvasForRoute;
  restoreWorkflowCanvasHistoryForRoute?: typeof restoreWorkflowCanvasHistoryForRoute;
};

function resolveDependencies(dependencies: WorkflowCanvasLifecycleRouteAdapterDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    enforceWorkflowCanvasMutationRateLimit: dependencies?.enforceWorkflowCanvasMutationRateLimit
      ?? enforceWorkflowCanvasMutationRateLimit,
    listWorkflowCanvasHistoryForRoute: dependencies?.listWorkflowCanvasHistoryForRoute
      ?? listWorkflowCanvasHistoryForRoute,
    publishWorkflowCanvasForRoute: dependencies?.publishWorkflowCanvasForRoute
      ?? publishWorkflowCanvasForRoute,
    restoreWorkflowCanvasHistoryForRoute: dependencies?.restoreWorkflowCanvasHistoryForRoute
      ?? restoreWorkflowCanvasHistoryForRoute,
  };
}

function toJsonResponse(result: WorkflowCanvasLifecycleRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

function withPrivateNoStoreHeaders(response: Response, request: Request) {
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

async function authenticateWorkflowCanvasLifecycleRoute(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<
  | { type: 'response'; response: Response }
  | { type: 'auth'; auth: AuthResult }
> {
  const auth = await dependencies.authenticateRequest(request);
  if (auth instanceof Response) {
    return { type: 'response', response: auth };
  }

  return { type: 'auth', auth };
}

export async function getWorkflowCanvasHistoryRouteResponse({
  request,
  canvasId,
  dependencies,
}: {
  request: Request;
  canvasId: string;
  dependencies?: WorkflowCanvasLifecycleRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasLifecycleRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.listWorkflowCanvasHistoryForRoute({
      canvasId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

export async function publishWorkflowCanvasRouteResponse({
  request,
  canvasId,
  dependencies,
}: {
  request: Request;
  canvasId: string;
  dependencies?: WorkflowCanvasLifecycleRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasLifecycleRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  const rateLimitResponse = await resolvedDependencies.enforceWorkflowCanvasMutationRateLimit(
    auth.auth.userId,
    'Failed to publish workflow canvas.',
  );
  if (rateLimitResponse) return withPrivateNoStoreHeaders(rateLimitResponse, request);

  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.publishWorkflowCanvasForRoute({
      canvasId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

export async function restoreWorkflowCanvasHistoryRouteResponse({
  request,
  canvasId,
  entryId,
  dependencies,
}: {
  request: Request;
  canvasId: string;
  entryId: string;
  dependencies?: WorkflowCanvasLifecycleRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasLifecycleRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  const rateLimitResponse = await resolvedDependencies.enforceWorkflowCanvasMutationRateLimit(
    auth.auth.userId,
    'Failed to restore workflow history.',
  );
  if (rateLimitResponse) return withPrivateNoStoreHeaders(rateLimitResponse, request);

  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.restoreWorkflowCanvasHistoryForRoute({
      canvasId,
      entryId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

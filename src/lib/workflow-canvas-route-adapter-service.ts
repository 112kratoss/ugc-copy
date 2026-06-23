import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  authenticateRequest,
  type AuthResult,
} from '@/lib/server-helpers';
import {
  deleteWorkflowCanvasForRoute,
  getWorkflowCanvasForRoute,
  patchWorkflowCanvasForRoute,
  type WorkflowCanvasDeleteRouteResult,
  type WorkflowCanvasGetRouteResult,
  type WorkflowCanvasPatchRouteResult,
} from '@/lib/workflow-canvas-route-service';
import { enforceWorkflowCanvasMutationRateLimit } from '@/lib/workflow-canvas-mutation-rate-limit';

type WorkflowCanvasRouteResult =
  | WorkflowCanvasGetRouteResult
  | WorkflowCanvasPatchRouteResult
  | WorkflowCanvasDeleteRouteResult;

type PatchOptions = {
  skipRateLimit?: boolean;
};

type WorkflowCanvasRouteContext = {
  params: Promise<{ id: string }>;
};

type WorkflowCanvasRouteAdapterDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  enforceWorkflowCanvasMutationRateLimit?: typeof enforceWorkflowCanvasMutationRateLimit;
  getWorkflowCanvasForRoute?: typeof getWorkflowCanvasForRoute;
  patchWorkflowCanvasForRoute?: typeof patchWorkflowCanvasForRoute;
  deleteWorkflowCanvasForRoute?: typeof deleteWorkflowCanvasForRoute;
};

function resolveDependencies(dependencies: WorkflowCanvasRouteAdapterDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    enforceWorkflowCanvasMutationRateLimit: dependencies?.enforceWorkflowCanvasMutationRateLimit
      ?? enforceWorkflowCanvasMutationRateLimit,
    getWorkflowCanvasForRoute: dependencies?.getWorkflowCanvasForRoute ?? getWorkflowCanvasForRoute,
    patchWorkflowCanvasForRoute: dependencies?.patchWorkflowCanvasForRoute ?? patchWorkflowCanvasForRoute,
    deleteWorkflowCanvasForRoute: dependencies?.deleteWorkflowCanvasForRoute ?? deleteWorkflowCanvasForRoute,
  };
}

function toJsonResponse(result: WorkflowCanvasRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

function withPrivateNoStoreHeaders(response: Response, request: Request) {
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

async function authenticateWorkflowCanvasRoute(
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

export async function getWorkflowCanvasRouteResponse({
  request,
  canvasId,
  dependencies,
}: {
  request: Request;
  canvasId: string;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.getWorkflowCanvasForRoute({
      canvasId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

export async function getWorkflowCanvasRouteContextResponse({
  request,
  context,
  dependencies,
}: {
  request: Request;
  context: WorkflowCanvasRouteContext;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const { id } = await context.params;
  return getWorkflowCanvasRouteResponse({ request, canvasId: id, dependencies });
}

export async function patchWorkflowCanvasRouteResponse({
  request,
  canvasId,
  options = {},
  dependencies,
}: {
  request: Request;
  canvasId: string;
  options?: PatchOptions;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  if (!options.skipRateLimit) {
    const rateLimitResponse = await resolvedDependencies.enforceWorkflowCanvasMutationRateLimit(
      auth.auth.userId,
      'Failed to update workflow canvas.',
    );
    if (rateLimitResponse) return withPrivateNoStoreHeaders(rateLimitResponse, request);
  }

  const body = await request.json().catch(() => ({}));
  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.patchWorkflowCanvasForRoute({
      body,
      canvasId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

export async function patchWorkflowCanvasRouteContextResponse({
  request,
  context,
  options = {},
  dependencies,
}: {
  request: Request;
  context: WorkflowCanvasRouteContext;
  options?: PatchOptions;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const { id } = await context.params;
  return patchWorkflowCanvasRouteResponse({
    request,
    canvasId: id,
    options,
    dependencies,
  });
}

export async function deleteWorkflowCanvasRouteResponse({
  request,
  canvasId,
  dependencies,
}: {
  request: Request;
  canvasId: string;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasRoute(request, resolvedDependencies);
  if (auth.type === 'response') return withPrivateNoStoreHeaders(auth.response, request);

  const rateLimitResponse = await resolvedDependencies.enforceWorkflowCanvasMutationRateLimit(
    auth.auth.userId,
    'Failed to delete workflow canvas.',
  );
  if (rateLimitResponse) return withPrivateNoStoreHeaders(rateLimitResponse, request);

  return withPrivateNoStoreHeaders(
    toJsonResponse(await resolvedDependencies.deleteWorkflowCanvasForRoute({
      canvasId,
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    })),
    request,
  );
}

export async function deleteWorkflowCanvasRouteContextResponse({
  request,
  context,
  dependencies,
}: {
  request: Request;
  context: WorkflowCanvasRouteContext;
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
}): Promise<Response> {
  const { id } = await context.params;
  return deleteWorkflowCanvasRouteResponse({ request, canvasId: id, dependencies });
}

export function createWorkflowCanvasRouteHandlers({
  dependencies,
}: {
  dependencies?: WorkflowCanvasRouteAdapterDependencies;
} = {}) {
  return {
    DELETE(request: Request, context: WorkflowCanvasRouteContext) {
      return deleteWorkflowCanvasRouteContextResponse({ request, context, dependencies });
    },
    GET(request: Request, context: WorkflowCanvasRouteContext) {
      return getWorkflowCanvasRouteContextResponse({ request, context, dependencies });
    },
    PATCH(
      request: Request,
      context: WorkflowCanvasRouteContext,
      options: PatchOptions = {},
    ) {
      return patchWorkflowCanvasRouteContextResponse({
        request,
        context,
        options,
        dependencies,
      });
    },
  };
}

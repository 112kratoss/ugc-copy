import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  authenticateRequest,
  createServiceClient,
  type AuthResult,
} from '@/lib/server-helpers';
import {
  createWorkflowCanvasForRoute,
  listWorkflowCanvasesForRoute,
  type WorkflowCanvasCollectionRouteResult,
} from '@/lib/workflow-canvas-collection-service';

type WorkflowCanvasCollectionRouteAdapterDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  createServiceClient?: typeof createServiceClient;
  createWorkflowCanvasForRoute?: typeof createWorkflowCanvasForRoute;
  listWorkflowCanvasesForRoute?: typeof listWorkflowCanvasesForRoute;
};

function resolveDependencies(
  dependencies: WorkflowCanvasCollectionRouteAdapterDependencies | undefined,
) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createWorkflowCanvasForRoute:
      dependencies?.createWorkflowCanvasForRoute ?? createWorkflowCanvasForRoute,
    listWorkflowCanvasesForRoute:
      dependencies?.listWorkflowCanvasesForRoute ?? listWorkflowCanvasesForRoute,
  };
}

function toJsonResponse(result: WorkflowCanvasCollectionRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function authenticateWorkflowCanvasCollectionRoute(
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

async function readWorkflowCanvasCreateBody(request: Request) {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

export async function getWorkflowCanvasCollectionRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: WorkflowCanvasCollectionRouteAdapterDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateWorkflowCanvasCollectionRoute(request, resolvedDependencies);
  const response = auth.type === 'response'
    ? auth.response
    : toJsonResponse(await resolvedDependencies.listWorkflowCanvasesForRoute({
      supabase: auth.auth.supabase,
      userId: auth.auth.userId,
    }));

  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export async function postWorkflowCanvasCollectionRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: WorkflowCanvasCollectionRouteAdapterDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const response = await handleWorkflowCanvasCollectionPOST({
    dependencies: resolvedDependencies,
    request,
  });

  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

async function handleWorkflowCanvasCollectionPOST({
  dependencies,
  request,
}: {
  dependencies: ReturnType<typeof resolveDependencies>;
  request: Request;
}) {
  const auth = await authenticateWorkflowCanvasCollectionRoute(request, dependencies);
  if (auth.type === 'response') return auth.response;
  const serviceClient = dependencies.createServiceClient();

  return toJsonResponse(await dependencies.createWorkflowCanvasForRoute({
    supabase: auth.auth.supabase,
    uploadClient: serviceClient,
    rateLimitClient: serviceClient,
    userId: auth.auth.userId,
    readBody: () => readWorkflowCanvasCreateBody(request),
  }));
}

export function createWorkflowCanvasCollectionRouteHandlers({
  dependencies,
}: {
  dependencies?: WorkflowCanvasCollectionRouteAdapterDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getWorkflowCanvasCollectionRouteResponse({ dependencies, request });
    },
    POST(request: Request) {
      return postWorkflowCanvasCollectionRouteResponse({ dependencies, request });
    },
  };
}

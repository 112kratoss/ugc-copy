import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { logBackendRouteError } from '@/lib/backend-logger';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getViewerUnlockDetail } from '@/lib/viewer-unlock-detail';
import {
  createViewerUnlockFileUrl,
  type ViewerUnlockFileUrlClient,
} from '@/lib/viewer-unlock-file-url-service';

type ViewerUnlockRouteContext = { params: Promise<{ unlockId: string }> };

type ViewerUnlockRouteDependencies = {
  createServiceClient?: () => ViewerUnlockFileUrlClient;
  createUserClient?: typeof createUserClient;
  createViewerUnlockFileUrl?: typeof createViewerUnlockFileUrl;
  getViewerUnlockDetail?: typeof getViewerUnlockDetail;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies?: ViewerUnlockRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient
      ?? (createServiceClient as () => ViewerUnlockFileUrlClient),
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createViewerUnlockFileUrl: dependencies?.createViewerUnlockFileUrl ?? createViewerUnlockFileUrl,
    getViewerUnlockDetail: dependencies?.getViewerUnlockDetail ?? getViewerUnlockDetail,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function authenticate(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const client = dependencies.createUserClient(request);
  const { data: { user }, error } = await client.auth.getUser();
  return error ? null : user;
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function getViewerUnlockDetailRouteResponse({
  context,
  dependencies: dependencyOverrides,
  request,
}: {
  context: ViewerUnlockRouteContext;
  dependencies?: ViewerUnlockRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(dependencyOverrides);
  let response: NextResponse;

  try {
    const user = await authenticate(request, dependencies);
    if (!user) {
      response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    } else {
      const { unlockId } = await context.params;
      const unlock = isUuid(unlockId)
        ? await dependencies.getViewerUnlockDetail({
            adminSupabase: dependencies.createServiceClient(),
            unlockId,
            viewerUserId: user.id,
            countryCode: request.headers.get('x-vercel-ip-country'),
          })
        : null;

      response = unlock
        ? NextResponse.json({ success: true, unlock })
        : NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
    }
  } catch (error) {
    dependencies.logError('Viewer unlock detail error:', error);
    response = NextResponse.json({ error: 'Failed to load this unlock.' }, { status: 500 });
  }

  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export async function postViewerUnlockFileUrlRouteResponse({
  context,
  dependencies: dependencyOverrides,
  request,
}: {
  context: ViewerUnlockRouteContext;
  dependencies?: ViewerUnlockRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(dependencyOverrides);
  let response: NextResponse;

  try {
    const user = await authenticate(request, dependencies);
    if (!user) {
      response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    } else {
      const { unlockId } = await context.params;
      if (!isUuid(unlockId)) {
        response = NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
      } else {
        const adminSupabase = dependencies.createServiceClient();
        const result = await dependencies.createViewerUnlockFileUrl({
          adminSupabase,
          body: await readJsonBody(request),
          countryCode: request.headers.get('x-vercel-ip-country'),
          rateLimitKey: `${user.id}:${getClientNetworkKey(request.headers)}`,
          unlockId,
          viewerUserId: user.id,
        });

        if (!result.ok && 'rateLimitError' in result) {
          response = createBackendRateLimitResponse(result.rateLimitError);
        } else if (!result.ok) {
          response = NextResponse.json(result.body, { status: result.status });
        } else {
          response = NextResponse.json(result.body);
        }
      }
    }
  } catch (error) {
    dependencies.logError('Viewer unlock file URL error:', error);
    response = NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export function createViewerUnlockDetailRouteHandlers({
  dependencies,
}: { dependencies?: ViewerUnlockRouteDependencies } = {}) {
  return {
    GET(request: Request, context: ViewerUnlockRouteContext) {
      return getViewerUnlockDetailRouteResponse({ request, context, dependencies });
    },
  };
}

export function createViewerUnlockFileUrlRouteHandlers({
  dependencies,
}: { dependencies?: ViewerUnlockRouteDependencies } = {}) {
  return {
    POST(request: Request, context: ViewerUnlockRouteContext) {
      return postViewerUnlockFileUrlRouteResponse({ request, context, dependencies });
    },
  };
}

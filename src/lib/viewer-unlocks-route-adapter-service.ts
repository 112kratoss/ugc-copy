import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { listViewerUnlocks } from '@/lib/viewer-unlocks';

type ViewerUnlocksRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listViewerUnlocks?: typeof listViewerUnlocks;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ViewerUnlocksRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listViewerUnlocks: dependencies?.listViewerUnlocks ?? listViewerUnlocks,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function parseIntegerParam(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function handleViewerUnlocksGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const searchParams = new URL(request.url).searchParams;
    const page = await dependencies.listViewerUnlocks({
      adminSupabase: dependencies.createServiceClient(),
      // Always the caller's own id. The library is never addressable by user.
      viewerUserId: user.id,
      limit: parseIntegerParam(searchParams.get('limit')),
      offset: parseIntegerParam(searchParams.get('offset')),
    });

    return NextResponse.json({ success: true, ...page });
  } catch (error) {
    dependencies.logError('Failed to load viewer unlocks:', error);
    return NextResponse.json({ error: 'Failed to load your unlocks.' }, { status: 500 });
  }
}

export async function getViewerUnlocksRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ViewerUnlocksRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleViewerUnlocksGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createViewerUnlocksRouteHandlers({
  dependencies,
}: {
  dependencies?: ViewerUnlocksRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getViewerUnlocksRouteResponse({ dependencies, request });
    },
  };
}

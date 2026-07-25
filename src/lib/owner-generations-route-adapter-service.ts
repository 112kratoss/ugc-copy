import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  listOwnerGenerationsForRoute,
  type OwnerGenerationsRoutePayload,
} from '@/lib/owner-generations-route-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type OwnerGenerationsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listOwnerGenerationsForRoute?: typeof listOwnerGenerationsForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: OwnerGenerationsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listOwnerGenerationsForRoute:
      dependencies?.listOwnerGenerationsForRoute ?? listOwnerGenerationsForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function getRequestSearchParams(request: Request) {
  const nextUrl = (request as Request & { nextUrl?: { searchParams?: URLSearchParams } }).nextUrl;
  if (nextUrl?.searchParams) {
    return nextUrl.searchParams;
  }

  return new URL(request.url).searchParams;
}

async function handleOwnerGenerationsGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<Response> {
  try {
    const supabase = dependencies.createUserClient(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload: OwnerGenerationsRoutePayload = await dependencies.listOwnerGenerationsForRoute({
      userId: user.id,
      supabase,
      getAdminSupabase: dependencies.createServiceClient,
      searchParams: getRequestSearchParams(request),
    });

    return NextResponse.json(payload);
  } catch (error) {
    dependencies.logError('Error fetching generations:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function getOwnerGenerationsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: OwnerGenerationsRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleOwnerGenerationsGET(request, resolvedDependencies),
    request,
  );
}

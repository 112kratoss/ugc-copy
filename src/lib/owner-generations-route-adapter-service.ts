import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  OWNER_GENERATIONS_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  listOwnerGenerationsForRoute,
  type OwnerGenerationsRoutePayload,
} from '@/lib/owner-generations-route-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type OwnerGenerationsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  listOwnerGenerationsForRoute?: typeof listOwnerGenerationsForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: OwnerGenerationsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
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

    // The studio polls this every 30 seconds while a generation runs, so the
    // budget is sized for several open tabs rather than for one. It exists to
    // stop a runaway client, not to interrupt normal polling.
    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...OWNER_GENERATIONS_READ_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Owner generations rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check generation read limits.' }, { status: 500 });
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

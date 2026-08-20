import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { parsePositiveInt } from '@/lib/showcase';
import {
  DEFAULT_SAVED_MEDIA_LIMIT,
  MAX_SAVED_MEDIA_LIMIT,
  getSavedMediaFeedForRoute,
} from '@/lib/showcase-saved-media-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ShowcaseSavedMediaRouteDependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: typeof createUserClient;
  getSavedMediaFeedForRoute?: typeof getSavedMediaFeedForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ShowcaseSavedMediaRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getSavedMediaFeedForRoute:
      dependencies?.getSavedMediaFeedForRoute ?? getSavedMediaFeedForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function getSavedMediaQuery(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  return {
    limit: Math.min(
      parsePositiveInt(searchParams.get('limit'), DEFAULT_SAVED_MEDIA_LIMIT),
      MAX_SAVED_MEDIA_LIMIT,
    ),
    offset: parsePositiveInt(searchParams.get('offset'), 0),
  };
}

async function handleShowcaseSavedMediaGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await getVerifiedAuthUserResult(supabase);

    // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { limit, offset } = getSavedMediaQuery(request);
    const result = await dependencies.getSavedMediaFeedForRoute({
      createAdminSupabase: dependencies.createServiceClient,
      limit,
      offset,
      userId: user.id,
      userSupabase: supabase,
    });

    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    dependencies.logError('Saved media feed error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function getShowcaseSavedMediaRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseSavedMediaRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseSavedMediaGET(request, resolveDependencies(dependencies)),
    request,
  );
}

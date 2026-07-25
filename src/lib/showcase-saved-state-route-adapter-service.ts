import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  getShowcaseSavedStateForRoute,
  parseShowcaseSavedStateIds,
  type ShowcaseSavedStateRouteResult,
} from '@/lib/showcase-saved-state-service';
import { createUserClient } from '@/lib/server-helpers';

type ShowcaseSavedStateRouteDependencies = {
  createUserClient?: typeof createUserClient;
  getShowcaseSavedStateForRoute?: typeof getShowcaseSavedStateForRoute;
  logError?: typeof logBackendRouteError;
  parseShowcaseSavedStateIds?: typeof parseShowcaseSavedStateIds;
};

function resolveDependencies(dependencies: ShowcaseSavedStateRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getShowcaseSavedStateForRoute:
      dependencies?.getShowcaseSavedStateForRoute ?? getShowcaseSavedStateForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
    parseShowcaseSavedStateIds:
      dependencies?.parseShowcaseSavedStateIds ?? parseShowcaseSavedStateIds,
  };
}

function toJsonResponse(result: ShowcaseSavedStateRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

function getIdsParam(request: Request) {
  return new URL(request.url).searchParams.get('ids');
}

async function handleShowcaseSavedStateGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return toJsonResponse(await dependencies.getShowcaseSavedStateForRoute({
      ids: dependencies.parseShowcaseSavedStateIds(getIdsParam(request)),
      userId: user.id,
      userSupabase: supabase,
    }));
  } catch (error) {
    dependencies.logError('Showcase saved-state error:', error);
    return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
  }
}

export async function getShowcaseSavedStateRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseSavedStateRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseSavedStateGET(request, resolveDependencies(dependencies)),
    request,
  );
}

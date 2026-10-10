import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  getShowcaseViewerExclusionsForRoute,
  parseShowcaseViewerExclusionItems,
} from '@/lib/showcase-viewer-exclusions-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ShowcaseViewerExclusionsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getShowcaseViewerExclusionsForRoute?: typeof getShowcaseViewerExclusionsForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ShowcaseViewerExclusionsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getShowcaseViewerExclusionsForRoute:
      dependencies?.getShowcaseViewerExclusionsForRoute ?? getShowcaseViewerExclusionsForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function handleShowcaseViewerExclusionsPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const {
      data: { user },
      error: authError,
    } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));

    // Registered-only per route-identity-policy.ts: blocks and feed
    // preferences are kept for registered accounts, and a guest holds a valid
    // JWT, so `!user` alone does not say "not registered".
    if (authError || !user || isGuestUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const items = parseShowcaseViewerExclusionItems(await request.json().catch(() => null));
    if (!items) {
      return NextResponse.json({ error: 'Send the posts to check as `items`.' }, { status: 400 });
    }

    const result = await dependencies.getShowcaseViewerExclusionsForRoute({
      adminSupabase: dependencies.createServiceClient(),
      items,
      viewerUserId: user.id,
    });
    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    dependencies.logError('Showcase viewer exclusions error:', error);
    return NextResponse.json({ error: 'Failed to check the viewer\'s feed exclusions' }, { status: 500 });
  }
}

export async function postShowcaseViewerExclusionsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseViewerExclusionsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseViewerExclusionsPOST(request, resolveDependencies(dependencies)),
    request,
  );
}

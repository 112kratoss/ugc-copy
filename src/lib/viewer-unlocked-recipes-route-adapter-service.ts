import 'server-only';
import { NextResponse } from 'next/server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * More recipes than this and the rest keep their price on the catalog's cards;
 * the post page and the library still say "Unlocked".
 */
export const VIEWER_UNLOCKED_RECIPE_IDS_LIMIT = 1000;

/**
 * The ids of the recipes this viewer has, bought or opened free: the
 * purchases by buyer, as the feed reads them for its "Unlocked" chips
 * (`attachViewerStateToFeed`). The marketplace catalog is one cached page for
 * everyone, so the viewer's own state is read apart from it, here.
 */
export async function listViewerUnlockedRecipeIds({
  adminSupabase,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string;
}): Promise<string[]> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('buyer_user_id', viewerUserId)
    .limit(VIEWER_UNLOCKED_RECIPE_IDS_LIMIT);
  if (error) throw error;

  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ bundle_id?: unknown }>) {
    if (typeof row.bundle_id === 'string') ids.add(row.bundle_id);
  }
  return Array.from(ids);
}

type ViewerUnlockedRecipesRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listViewerUnlockedRecipeIds?: typeof listViewerUnlockedRecipeIds;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ViewerUnlockedRecipesRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listViewerUnlockedRecipeIds: dependencies?.listViewerUnlockedRecipeIds ?? listViewerUnlockedRecipeIds,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function handleViewerUnlockedRecipesGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const bundleIds = await dependencies.listViewerUnlockedRecipeIds({
      adminSupabase: dependencies.createServiceClient(),
      // Always the caller's own id, never addressable by user.
      viewerUserId: user.id,
    });
    return NextResponse.json({ success: true, bundleIds });
  } catch (error) {
    dependencies.logError('Failed to load viewer unlocked recipe ids:', error);
    return NextResponse.json({ error: 'Failed to load your unlocked recipes.' }, { status: 500 });
  }
}

export async function getViewerUnlockedRecipesRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ViewerUnlockedRecipesRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleViewerUnlockedRecipesGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createViewerUnlockedRecipesRouteHandlers({
  dependencies,
}: {
  dependencies?: ViewerUnlockedRecipesRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getViewerUnlockedRecipesRouteResponse({ dependencies, request });
    },
  };
}

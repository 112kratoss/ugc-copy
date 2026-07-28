import 'server-only';

import { logBackendError } from '@/lib/backend-logger';
import {
  toHomeWorkspaceGenerationView,
  selectWhatsNewModels,
  type HomeWhatsNewModel,
  type HomeWorkspaceGenerationView,
} from '@/lib/home-dashboard';
import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION } from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';
import { listOwnerGenerationsForRoute } from '@/lib/owner-generations-route-service';
import { FEED_PAGE_SIZE, type FeedChip } from '@/lib/post-feed-chips';
import { createServiceClient } from '@/lib/server-helpers';
import type { ShowcaseFeedPage } from '@/lib/showcase';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';

/**
 * Loaders for the signed-in home dashboard (`src/app/home/page.tsx`). Every
 * loader degrades instead of throwing: the dashboard renders empty sections,
 * never an error page, when a data source is unavailable. This is also the
 * E2E-bypass path — the `workflow-user` id is not a UUID, so the generations
 * query errors and the workspace card falls back to its empty state
 * (precedent: src/app/profile/load-owner-profile.ts).
 */

const HOME_WORKSPACE_FETCH_LIMIT = 12;

export async function loadHomeWorkspaceGenerations({
  userId,
}: {
  userId: string;
}): Promise<HomeWorkspaceGenerationView[]> {
  try {
    const serviceClient = createServiceClient();
    const payload = await listOwnerGenerationsForRoute({
      userId,
      supabase: serviceClient,
      getAdminSupabase: () => serviceClient,
      searchParams: new URLSearchParams(`detail=summary&limit=${HOME_WORKSPACE_FETCH_LIMIT}`),
    });

    return payload.generations
      .map((row) => toHomeWorkspaceGenerationView(row))
      .filter((view): view is HomeWorkspaceGenerationView => view !== null);
  } catch (error) {
    logBackendError('home_dashboard_workspace_load_failed', { error });
    return [];
  }
}

export async function loadHomeWhatsNewModels(): Promise<HomeWhatsNewModel[]> {
  try {
    const snapshot = await loadPublishedGenerationModelCatalog({
      platform: 'web',
      schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    });

    return selectWhatsNewModels(snapshot.catalog.models);
  } catch (error) {
    logBackendError('home_dashboard_models_load_failed', { error });
    return [];
  }
}

export async function loadHomeFeed({
  viewerUserId,
  chip,
}: {
  viewerUserId: string;
  chip: FeedChip;
}): Promise<ShowcaseFeedPage | null> {
  try {
    return await getShowcaseFeedPage({
      category: 'all',
      sort: chip.sort,
      unlock: chip.unlock,
      resource: 'all',
      offset: 0,
      limit: FEED_PAGE_SIZE,
      viewerUserId,
      tool: null,
      countryCode: null,
    });
  } catch (error) {
    logBackendError('home_dashboard_feed_load_failed', { error });
    return null;
  }
}

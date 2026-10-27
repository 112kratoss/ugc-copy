'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';

import { NO_VIEWER_STATE, type MarketplaceViewerState } from './marketplace-card-access';

/**
 * The signed-in viewer's own recipes, read once per session token from
 * `/api/me/unlocked-recipes` and handed to the cards, which the cached
 * catalog cannot carry. A signed-out viewer is asked nothing; a failed read
 * leaves the price on the cards, and the post page still says "Unlocked".
 */
export function useViewerRecipeState(): MarketplaceViewerState {
  const { session, user } = useAuth();
  const token = session?.access_token ?? null;
  const [loaded, setLoaded] = useState<{ token: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void fetch('/api/me/unlocked-recipes', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { bundleIds?: unknown };
        const ids = Array.isArray(data.bundleIds)
          ? data.bundleIds.filter((id): id is string => typeof id === 'string')
          : [];
        setLoaded({ token, ids: new Set(ids) });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  return {
    viewerUserId: user?.id ?? null,
    unlockedBundleIds: loaded && loaded.token === token ? loaded.ids : NO_VIEWER_STATE.unlockedBundleIds,
  };
}

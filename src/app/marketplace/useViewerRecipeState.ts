'use client';

import { useMemo } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { useCreatorOwnershipResolver } from '@/lib/creator-ownership';
import { useViewerUnlockedRecipeIds } from '@/lib/viewer-unlocked-recipes';

import type { MarketplaceViewerState } from './marketplace-card-access';

/**
 * The signed-in viewer's own recipes, for the cards the cached catalog cannot label: those they have,
 * from `/api/me/unlocked-recipes` (`useViewerUnlockedRecipeIds`, one read shared by every list of
 * cards), and their own, from the first frame (`useCreatorOwnershipResolver`): this page's provider
 * checks the session afresh on every visit, a client navigation included, and until it named them a
 * seller's own cards read "Free recipe" and "View free recipe" (sweep of 2026-11-17). A signed-out
 * viewer is asked nothing; a failed read leaves the price on the cards, and the post page still says
 * "Unlocked".
 */
export function useViewerRecipeState(): MarketplaceViewerState {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const unlockedBundleIds = useViewerUnlockedRecipeIds();
  const ownershipOf = useCreatorOwnershipResolver();

  return useMemo(
    () => ({ viewerUserId: userId, unlockedBundleIds, ownershipOf }),
    [userId, unlockedBundleIds, ownershipOf],
  );
}

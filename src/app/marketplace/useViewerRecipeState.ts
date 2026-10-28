'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useAuth } from '@/components/AuthProvider';

import { NO_VIEWER_STATE, type MarketplaceViewerState } from './marketplace-card-access';

/**
 * A read this recent serves every list of cards that mounts (the interactive
 * browser taking over from the server-drawn shell) and survives a refreshed
 * token. A list that mounts after it reads again, so a recipe unlocked
 * meanwhile shows, drawing the last answer until the new one lands.
 */
const FRESH_FOR_MS = 30_000;

// One read per signed-in viewer for the page's life, shared by every list of
// cards: each draws the same words from its first frame (review of #568).
// Filled only in the browser, from an effect; the server never reads it.
const answers = new Map<string, { ids: ReadonlySet<string>; readAt: number }>();
const reading = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readUnlockedRecipes(userId: string, token: string) {
  const answer = answers.get(userId);
  if ((answer && Date.now() - answer.readAt < FRESH_FOR_MS) || reading.has(userId)) return;
  reading.add(userId);
  void fetch('/api/me/unlocked-recipes', { headers: { Authorization: `Bearer ${token}` } })
    .then(async (response) => {
      if (!response.ok) return;
      const data = (await response.json()) as { bundleIds?: unknown };
      const ids = Array.isArray(data.bundleIds)
        ? data.bundleIds.filter((id): id is string => typeof id === 'string')
        : [];
      answers.set(userId, { ids: new Set(ids), readAt: Date.now() });
      for (const listener of listeners) listener();
    })
    .catch(() => undefined)
    .finally(() => {
      reading.delete(userId);
    });
}

/**
 * The signed-in viewer's own recipes, from `/api/me/unlocked-recipes`, for the
 * cards the cached catalog cannot label. A signed-out viewer is asked nothing;
 * a failed read leaves the price on the cards, and the post page still says
 * "Unlocked".
 */
export function useViewerRecipeState(): MarketplaceViewerState {
  const { session, user } = useAuth();
  const userId = user?.id ?? null;
  const token = session?.access_token ?? null;
  const unlockedBundleIds = useSyncExternalStore(
    subscribe,
    () => (userId ? answers.get(userId)?.ids : undefined) ?? NO_VIEWER_STATE.unlockedBundleIds,
    // The page is drawn on the server for everyone and hydrated as drawn: the
    // viewer's recipes arrive after that.
    () => NO_VIEWER_STATE.unlockedBundleIds,
  );

  useEffect(() => {
    if (userId && token) readUnlockedRecipes(userId, token);
  }, [userId, token]);

  return useMemo(() => ({ viewerUserId: userId, unlockedBundleIds }), [userId, unlockedBundleIds]);
}

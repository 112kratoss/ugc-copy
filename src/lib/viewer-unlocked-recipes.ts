'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { useAuth } from '@/components/AuthProvider';

/**
 * A read this recent serves every list of cards that mounts (the Marketplace's interactive browser
 * taking over from its server-drawn shell, a creator page opened after it) and survives a refreshed
 * token. A list that mounts after it reads again, so a recipe unlocked meanwhile shows, drawing the
 * last answer until the new one lands.
 */
const FRESH_FOR_MS = 30_000;

const NO_RECIPES: ReadonlySet<string> = new Set();

// One read per signed-in viewer for the page's life, shared by every list of cards: each draws the
// same words from its first frame (review of #568). Filled only in the browser, from an effect; the
// server never reads it.
const answers = new Map<string, { ids: ReadonlySet<string>; readAt: number }>();
const reading = new Set<string>();
const listeners = new Set<() => void>();
// Moves on each time a recipe may have become the viewer's (`forgetViewerUnlockedRecipes`): every
// list of cards on the page reads their recipes again then, whatever its last answer's age.
let unlockedSince = 0;

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
 * A recipe has just become the viewer's (taken free, bought with credits or paid for): every list of
 * cards on the page reads their recipes again, and one that mounts later reads them too, so a tile
 * under the reel it was taken in says "Unlocked" once its read lands, and a list returned to within
 * `FRESH_FOR_MS` does not draw the answer from before. The last answer stands until then.
 */
export function forgetViewerUnlockedRecipes() {
  unlockedSince += 1;
  for (const answer of answers.values()) answer.readAt = 0;
  for (const listener of listeners) listener();
}

/**
 * The recipes the signed-in viewer has, bought or opened free, by id, from `/api/me/unlocked-recipes`:
 * for the cards of a page drawn once for everyone, which cannot say "Unlocked" (the Marketplace's
 * catalog, a creator page's first posts). A signed-out viewer is asked nothing; a failed read leaves
 * the price on the cards, and the post page still says "Unlocked". Empty on the server and in the
 * render that hydrates: the page is hydrated as it was drawn, and the viewer's recipes arrive after.
 * `enabled: false` asks nothing, for a page with no recipe on it.
 */
export function useViewerUnlockedRecipeIds({ enabled = true }: { enabled?: boolean } = {}): ReadonlySet<string> {
  const { session, user } = useAuth();
  const userId = enabled ? user?.id ?? null : null;
  const token = session?.access_token ?? null;
  const unlockedBundleIds = useSyncExternalStore(
    subscribe,
    () => (userId ? answers.get(userId)?.ids : undefined) ?? NO_RECIPES,
    () => NO_RECIPES,
  );
  const readAgainAfter = useSyncExternalStore(subscribe, () => unlockedSince, () => 0);

  useEffect(() => {
    if (userId && token) readUnlockedRecipes(userId, token);
  }, [userId, token, readAgainAfter]);

  return unlockedBundleIds;
}

/**
 * The items with each recipe the viewer has (`unlockedBundleIds`) marked as theirs, `viewerHasUnlocked`,
 * as a page read with their session marks it: its chips say "Unlocked" and the reel holds it as theirs
 * rather than offering it. Never unmarks one, and returns the same list, and each item it leaves, as it
 * was given, so a list with nothing to mark keeps its identity.
 */
export function withViewerUnlockedRecipes<T extends { asset?: { id: string; viewerHasUnlocked?: boolean } | null }>(
  items: T[],
  unlockedBundleIds: ReadonlySet<string>,
): T[] {
  if (unlockedBundleIds.size === 0) return items;
  let marked = false;
  const next = items.map((item) => {
    if (!item.asset || item.asset.viewerHasUnlocked || !unlockedBundleIds.has(item.asset.id)) return item;
    marked = true;
    return { ...item, asset: { ...item.asset, viewerHasUnlocked: true } };
  });
  return marked ? next : items;
}

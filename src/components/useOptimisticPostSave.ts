'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface SaveablePostItem {
  id: string;
  generationId?: string | null;
  isSaved?: boolean;
  saveCount: number;
}

interface UseOptimisticPostSaveOptions<TItem extends SaveablePostItem> {
  initialItems: TItem[];
  accessToken?: string | null;
  isSignedIn: boolean;
  onAuthRequired: () => void;
  onError: (error: unknown) => void;
  /**
   * The server now holds another state for the post than before the viewer's
   * taps: once per run of taps, never for a run that ended where it began.
   */
  onSuccess?: (result: {
    id: string;
    isSaved: boolean;
    sourceSurface: string;
  }) => void | Promise<void>;
  sourceSurface: string;
}

interface SaveResponse {
  success?: boolean;
  error?: string;
  isSaved?: boolean | null;
  saveCount?: number | null;
}

/**
 * One post's taps, from the first until the server holds what the newest one
 * asked for (or a request fails).
 *
 * The heart follows the finger, as the app's does: every tap flips it and moves
 * the count at once, and none waits for an answer. The server hears one request
 * for the post at a time. When it answers, a newest tap that asks for what the
 * server now holds needs nothing more; otherwise one more request carries it.
 * So a burst of taps costs one or two requests rather than one each (the route
 * allows 120 saves in 10 minutes, and a save can notify the creator), and no
 * two requests for one post race each other to the database.
 */
interface SaveRun {
  /** What the newest tap asked for. */
  wanted: boolean;
  /** What the server holds: as of the first tap, then as of its last answer. */
  held: boolean;
  /** The server's count for `held`, once an answer has given one. */
  heldCount: number | null;
  /** What the server held before the first tap. */
  startedFrom: boolean;
  /** The newest tap's: a later request goes out as it would have. */
  accessToken: string;
  sourceSurface: string;
}

function deriveSavedIds(items: SaveablePostItem[]) {
  return new Set(items.filter((item) => item.isSaved).map((item) => item.id));
}

function getSavedStateLookupIds(items: SaveablePostItem[]) {
  return Array.from(new Set(
    items.flatMap((item) => [item.id, item.generationId]).filter((id): id is string => Boolean(id))
  ));
}

function updateSavedIds(current: Set<string>, id: string, shouldSave: boolean) {
  const next = new Set(current);
  if (shouldSave) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function updateSaveCount<TItem extends SaveablePostItem>(
  items: TItem[],
  id: string,
  delta: number
) {
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          saveCount: Math.max(0, item.saveCount + delta),
        }
      : item
  );
}

function setSaveCount<TItem extends SaveablePostItem>(
  items: TItem[],
  id: string,
  saveCount: number
) {
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          saveCount: Math.max(0, saveCount),
        }
      : item
  );
}

async function requestSave(id: string, run: SaveRun, shouldSave: boolean) {
  const response = await fetch('/api/showcase/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${run.accessToken}`,
    },
    body: JSON.stringify({
      postId: id,
      shouldSave,
      sourceSurface: run.sourceSurface,
    }),
  });

  const data = await response.json() as SaveResponse;
  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to save showcase item');
  }
  return data;
}

export function useOptimisticPostSave<TItem extends SaveablePostItem>({
  initialItems,
  accessToken,
  isSignedIn,
  onAuthRequired,
  onError,
  onSuccess,
  sourceSurface,
}: UseOptimisticPostSaveOptions<TItem>) {
  const [items, setItems] = useState<TItem[]>(initialItems);
  const [savedItemIds, setSavedItemIds] = useState<Set<string>>(() => deriveSavedIds(initialItems));
  const runsRef = useRef(new Map<string, SaveRun>());
  const previousInitialItemsRef = useRef(initialItems);
  const savedStateLookupIds = useMemo(() => getSavedStateLookupIds(initialItems), [initialItems]);
  const savedStateLookupKey = savedStateLookupIds.join(',');

  useEffect(() => {
    if (previousInitialItemsRef.current === initialItems) {
      return;
    }

    previousInitialItemsRef.current = initialItems;
    // Server pagination/filter changes replace the optimistic snapshot. In an
    // effect, not adjusted while rendering: Explore resets the same state from
    // its own effect on a lane change, without the posts the viewer hid, and
    // the two land in one render. Reset during render, the lane's first page
    // would be drawn once with those posts in it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(initialItems);
    setSavedItemIds(deriveSavedIds(initialItems));
  }, [initialItems]);

  useEffect(() => {
    if (!accessToken || savedStateLookupIds.length === 0) {
      return;
    }

    const controller = new AbortController();

    const hydrateSavedState = async () => {
      try {
        const response = await fetch(`/api/showcase/saved-state?ids=${encodeURIComponent(savedStateLookupKey)}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          return;
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
          return;
        }

        const hydratedIds = new Set(data.filter((id): id is string => typeof id === 'string'));
        setSavedItemIds((current) => {
          const next = new Set(current);
          for (const item of initialItems) {
            if (hydratedIds.has(item.id) || (item.generationId && hydratedIds.has(item.generationId))) {
              next.add(item.id);
            }
          }
          return next;
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Failed to hydrate saved state:', error);
        }
      }
    };

    void hydrateSavedState();

    return () => {
      controller.abort();
    };
  }, [accessToken, initialItems, savedStateLookupIds.length, savedStateLookupKey]);

  // The saved set is derived from `initialItems` alone. A caller that adds
  // items later (another page, another lane) passes on the `isSaved` they
  // arrived with, or a saved post among them draws an empty heart and its
  // first tap "saves" it again.
  const addSavedItemIds = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSavedItemIds((current) => {
      if (ids.every((id) => current.has(id))) return current;
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const toggleSave = async (id: string, actionSourceSurface = sourceSurface) => {
    if (!isSignedIn || !accessToken) {
      onAuthRequired();
      return;
    }

    const runs = runsRef.current;
    const running = runs.get(id);
    const wanted = !(running ? running.wanted : savedItemIds.has(id));
    setSavedItemIds((previous) => updateSavedIds(previous, id, wanted));
    setItems((previous) => updateSaveCount(previous, id, wanted ? 1 : -1));

    if (running) {
      // The request on the wire sends this tap after it, if it still needs sending.
      running.wanted = wanted;
      running.accessToken = accessToken;
      running.sourceSurface = actionSourceSurface;
      return;
    }

    const run: SaveRun = {
      wanted,
      held: !wanted,
      heldCount: null,
      startedFrom: !wanted,
      accessToken,
      sourceSurface: actionSourceSurface,
    };
    runs.set(id, run);

    let failure: { error: unknown } | null = null;
    do {
      const shouldSave = run.wanted;
      try {
        const data = await requestSave(id, run, shouldSave);
        const held = typeof data.isSaved === 'boolean' ? data.isSaved : shouldSave;
        if (typeof data.saveCount === 'number') {
          run.heldCount = data.saveCount;
        } else if (run.heldCount !== null && held !== run.held) {
          run.heldCount += held ? 1 : -1;
        }
        run.held = held;
      } catch (error) {
        failure = { error };
      }
    } while (!failure && run.wanted !== run.held);
    // Before anything else is awaited: a tap from here on starts a run of its own.
    runs.delete(id);

    // What the server holds. After a failure that takes back the taps it never
    // heard; otherwise the heart is already there and the count becomes its.
    const { held, heldCount } = run;
    const unheard = Number(run.wanted) - Number(held);
    setSavedItemIds((previous) => updateSavedIds(previous, id, held));
    setItems((previous) => heldCount === null
      ? updateSaveCount(previous, id, -unheard)
      : setSaveCount(previous, id, heldCount));

    // A failure the viewer had already taken back has nothing left to say.
    if (failure && unheard !== 0) {
      onError(failure.error);
    }

    if (held !== run.startedFrom) {
      try {
        await onSuccess?.({ id, isSaved: held, sourceSurface: run.sourceSurface });
      } catch {
        // Feed telemetry is best effort and must never roll back a successful save.
      }
    }
  };

  return {
    items,
    setItems,
    savedItemIds,
    setSavedItemIds,
    addSavedItemIds,
    toggleSave,
  };
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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
  const [savingItemIds, setSavingItemIds] = useState<Set<string>>(() => new Set());
  const previousInitialItemsRef = useRef(initialItems);
  const savedStateLookupIds = useMemo(() => getSavedStateLookupIds(initialItems), [initialItems]);
  const savedStateLookupKey = savedStateLookupIds.join(',');

  useEffect(() => {
    if (previousInitialItemsRef.current === initialItems) {
      return;
    }

    previousInitialItemsRef.current = initialItems;
    // Server pagination/filter changes replace the optimistic snapshot.
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

  const toggleSave = async (id: string, actionSourceSurface = sourceSurface) => {
    if (!isSignedIn || !accessToken) {
      onAuthRequired();
      return;
    }

    if (savingItemIds.has(id)) {
      return;
    }

    const currentlySaved = savedItemIds.has(id);
    const nextSaved = !currentlySaved;
    const delta = currentlySaved ? -1 : 1;

    setSavingItemIds((previous) => updateSavedIds(previous, id, true));
    setSavedItemIds((previous) => updateSavedIds(previous, id, nextSaved));
    setItems((previous) => updateSaveCount(previous, id, delta));

    try {
      const response = await fetch('/api/showcase/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          postId: id,
          shouldSave: nextSaved,
          sourceSurface: actionSourceSurface,
        }),
      });

      const data = await response.json() as SaveResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to save showcase item');
      }

      if (typeof data.isSaved === 'boolean') {
        setSavedItemIds((previous) => updateSavedIds(previous, id, data.isSaved === true));
      }

      if (typeof data.saveCount === 'number') {
        setItems((previous) => setSaveCount(previous, id, data.saveCount as number));
      }

      try {
        await onSuccess?.({
          id,
          isSaved: typeof data.isSaved === 'boolean' ? data.isSaved : nextSaved,
          sourceSurface: actionSourceSurface,
        });
      } catch {
        // Feed telemetry is best effort and must never roll back a successful save.
      }
    } catch (error) {
      onError(error);
      setSavedItemIds((previous) => updateSavedIds(previous, id, currentlySaved));
      setItems((previous) => updateSaveCount(previous, id, -delta));
    } finally {
      setSavingItemIds((previous) => updateSavedIds(previous, id, false));
    }
  };

  return {
    items,
    setItems,
    savedItemIds,
    setSavedItemIds,
    savingItemIds,
    toggleSave,
  };
}

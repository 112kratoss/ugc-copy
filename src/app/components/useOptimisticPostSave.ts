'use client';

import { useEffect, useMemo, useState } from 'react';

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

export function useOptimisticPostSave<TItem extends SaveablePostItem>({
  initialItems,
  accessToken,
  isSignedIn,
  onAuthRequired,
  onError,
}: UseOptimisticPostSaveOptions<TItem>) {
  const [items, setItems] = useState<TItem[]>(initialItems);
  const [savedItemIds, setSavedItemIds] = useState<Set<string>>(() => deriveSavedIds(initialItems));
  const [savingItemIds, setSavingItemIds] = useState<Set<string>>(() => new Set());
  const savedStateLookupIds = useMemo(() => getSavedStateLookupIds(initialItems), [initialItems]);
  const savedStateLookupKey = savedStateLookupIds.join(',');

  useEffect(() => {
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

  const toggleSave = async (id: string) => {
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
        body: JSON.stringify({ generationId: id }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to save showcase item');
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

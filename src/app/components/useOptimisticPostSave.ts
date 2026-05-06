'use client';

import { useState } from 'react';

interface SaveablePostItem {
  id: string;
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

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { creatorSeesSaverFields, syncSaverNotice, type SaverNoticeFields } from './saver-notice';
import { useAuth } from './AuthProvider';

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
   * The server holds a new state for the post: told when taps settle, never
   * for taps that ended where they began. A tap made while this is told waits
   * for it, so its request cannot reach the server before the feed's save
   * event does (the server checks that event against the saved state).
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
 * A post's taps while its saves are with the server.
 *
 * The heart follows the finger, as the app's Home card does: every tap flips
 * it and moves the count at once, and none waits for an answer. The app queues
 * one request per tap (`ugc-mobile/lib/use-showcase-save-mutation.ts`, ordered
 * by `ugc-mobile/lib/showcase-save-intent.ts`). A run sends one request at a
 * time and, when it answers, the newest tap only if it came meanwhile and
 * still differs from what the server holds: a burst within one round trip
 * costs one or two requests (the route allows 120 saves in 10 minutes, and a
 * save can notify the creator). Runs belong to one instance of the hook, where
 * the app's queue spans the app.
 */
interface SaveRun {
  /** What the newest tap asked for. */
  wanted: boolean;
  /** The newest tap's, so a later request goes out as it would have. */
  accessToken: string;
  sourceSurface: string;
  /**
   * What the newest tap's save may tell its creator about who saved, decided
   * when that tap was made: a request sent later must not name someone who was
   * told only after tapping (`saver-notice.ts`).
   */
  saverFields: SaverNoticeFields;
}

function deriveSavedIds(items: SaveablePostItem[]) {
  return new Set(items.filter((item) => item.isSaved).map((item) => item.id));
}

function getSavedStateLookupIds(items: SaveablePostItem[]) {
  return Array.from(new Set(
    items.flatMap((item) => [item.id, item.generationId]).filter((id): id is string => Boolean(id))
  ));
}

// These three hand back what they were given when nothing moves, so a settle
// that agrees with what is drawn costs no render.
function updateSavedIds(current: Set<string>, id: string, shouldSave: boolean) {
  if (current.has(id) === shouldSave) {
    return current;
  }
  const next = new Set(current);
  if (shouldSave) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function withSaveCount<TItem extends SaveablePostItem>(
  items: TItem[],
  id: string,
  countFrom: (saveCount: number) => number
) {
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== id) return item;
    const saveCount = Math.max(0, countFrom(item.saveCount));
    if (saveCount === item.saveCount) return item;
    changed = true;
    return { ...item, saveCount };
  });
  return changed ? next : items;
}

function updateSaveCount<TItem extends SaveablePostItem>(items: TItem[], id: string, delta: number) {
  return withSaveCount(items, id, (saveCount) => saveCount + delta);
}

function setSaveCount<TItem extends SaveablePostItem>(items: TItem[], id: string, saveCount: number) {
  return withSaveCount(items, id, () => saveCount);
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
      ...(shouldSave ? run.saverFields : {}),
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

  // Whether the signed-in account has been told, from the server as well as
  // this browser, before its first tap needs the answer (`saver-notice.ts`),
  // remembered per account, so a browser two people share tells each.
  const { user, session, saverNoticeRecord } = useAuth();
  const viewerId = user?.id ?? null;
  const viewerToken = session?.access_token ?? null;
  useEffect(() => {
    syncSaverNotice(viewerId, viewerToken, saverNoticeRecord);
  }, [viewerId, viewerToken, saverNoticeRecord]);

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

    // From the heart the viewer sees: a lane change or the saved-state read
    // may have drawn it anew since this post's last tap.
    const wanted = !savedItemIds.has(id);
    // Decided now, at the tap, whenever its request goes out.
    const saverFields = creatorSeesSaverFields(viewerId, wanted, viewerToken);
    setSavedItemIds((previous) => updateSavedIds(previous, id, wanted));
    setItems((previous) => updateSaveCount(previous, id, wanted ? 1 : -1));

    const runs = runsRef.current;
    const running = runs.get(id);
    if (running) {
      // The run sends this tap once what it has out is done, if it still needs sending.
      running.wanted = wanted;
      running.accessToken = accessToken;
      running.sourceSurface = actionSourceSurface;
      running.saverFields = saverFields;
      return;
    }

    const run: SaveRun = { wanted, accessToken, sourceSurface: actionSourceSurface, saverFields };
    runs.set(id, run);
    // What the server holds, as of the first tap and then of its last answer.
    let held = !wanted;
    let heldCount: number | null = null;
    let told = held;

    while (run.wanted !== held) {
      let failure: { error: unknown } | null = null;
      try {
        let asked: boolean;
        do {
          asked = run.wanted;
          const data = await requestSave(id, run, asked);
          held = typeof data.isSaved === 'boolean' ? data.isSaved : asked;
          heldCount = typeof data.saveCount === 'number' ? data.saveCount : null;
          // Again only for a tap made while that request was out.
        } while (run.wanted !== asked && run.wanted !== held);
      } catch (error) {
        failure = { error };
      }

      // What the server holds. After a failure that takes back the taps it
      // never heard; otherwise the heart is already there and the count
      // becomes its.
      const settled = held;
      const settledCount = heldCount;
      const unheard = Number(run.wanted) - Number(settled);
      run.wanted = settled;
      setSavedItemIds((previous) => updateSavedIds(previous, id, settled));
      setItems((previous) => settledCount === null
        ? updateSaveCount(previous, id, -unheard)
        : setSaveCount(previous, id, settledCount));

      // A failure the viewer had already taken back has nothing left to say.
      if (failure && unheard !== 0) {
        onError(failure.error);
      }

      // Told with the post still held here, so a tap made meanwhile waits for it.
      if (settled !== told) {
        told = settled;
        try {
          await onSuccess?.({ id, isSaved: settled, sourceSurface: run.sourceSurface });
        } catch {
          // Feed telemetry is best effort and must never roll back a successful save.
        }
      }
    }
    runs.delete(id);
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

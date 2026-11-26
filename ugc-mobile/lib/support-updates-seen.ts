import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

import type { MagicbookletApiClient } from './api-client';
import {
  SUPPORT_UPDATES_SEEN_STORAGE_KEY,
  supportUpdatesSeenValue,
} from './support-hub-policy/support-hub-policy';
import {
  SUPPORT_UPDATES_LATEST_QUERY_KEY,
  SUPPORT_UPDATES_LATEST_STALE_MS,
  readSupportUpdatesSeenAt,
  supportHubUnseenUpdates,
  supportUpdatesSeenToKeep,
} from './support-hub-view-model';

/**
 * When this phone last looked at Help & Support's Updates, for the unread dot
 * on the side menu's Help & Support row and on the Updates tab. It is kept on
 * the device (AsyncStorage, under the key the web keeps its own under in
 * localStorage) for a guest and an account alike, read once per run, and
 * shared by every screen that draws the dot, so a look at Updates takes the
 * dot off the menu at once.
 */

type SeenStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

export type SupportUpdatesSeen = { loaded: boolean; seenAt: string | null };

let current: SupportUpdatesSeen = { loaded: false, seenAt: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function commit(next: SupportUpdatesSeen) {
  if (next.loaded === current.loaded && next.seenAt === current.seenAt) return;
  current = next;
  for (const listener of listeners) listener();
}

export function readSupportUpdatesSeen(): SupportUpdatesSeen {
  return current;
}

export function subscribeToSupportUpdatesSeen(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads the marker kept on the device, once per run; a marker that cannot be read is no look yet. */
export function loadSupportUpdatesSeen(storage: SeenStorage = AsyncStorage): Promise<void> {
  if (current.loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      let kept: string | null = null;
      try {
        kept = readSupportUpdatesSeenAt(await storage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY));
      } catch {
        // Unreadable storage: the dot shows until the reader looks.
      }
      // A look marked while the read was out is never put back behind the one kept.
      commit({ loaded: true, seenAt: supportUpdatesSeenValue(current.seenAt, kept) });
      loading = null;
    })();
  }
  return loading;
}

/**
 * Updates has shown the newest update, published at `latestAt`: kept as the
 * last look, never earlier than one already kept (`supportUpdatesSeenValue`).
 */
export async function markSupportUpdatesSeen(latestAt: string | null, storage: SeenStorage = AsyncStorage): Promise<void> {
  await loadSupportUpdatesSeen(storage);
  const next = supportUpdatesSeenToKeep(latestAt, current.seenAt);
  if (!next) return;
  commit({ loaded: true, seenAt: next });
  try {
    await storage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, next);
  } catch {
    // Kept for this run; the dot may come back on the next launch.
  }
}

export function resetSupportUpdatesSeenForTests() {
  current = { loaded: false, seenAt: null };
  loading = null;
  listeners.clear();
}

/** The marker as the screens draw from it, read from the device the first time it is asked for. */
export function useSupportUpdatesSeen(): SupportUpdatesSeen {
  const seen = useSyncExternalStore(subscribeToSupportUpdatesSeen, readSupportUpdatesSeen, readSupportUpdatesSeen);
  useEffect(() => {
    void loadSupportUpdatesSeen();
  }, []);
  return seen;
}

/**
 * Whether an update is newer than this phone's last look at Updates. While
 * `enabled` it asks when the newest came out (one update's page), at most once
 * a minute and never in the way of what draws it: until the answer lands, and
 * if it fails, there is no dot.
 */
export function useSupportUpdatesUnseen({
  api,
  enabled,
}: {
  api: Pick<MagicbookletApiClient, 'getSupportUpdates'>;
  enabled: boolean;
}): boolean {
  const latest = useQuery({
    queryKey: SUPPORT_UPDATES_LATEST_QUERY_KEY,
    enabled,
    queryFn: async () => (await api.getSupportUpdates({ limit: 1 })).latestAt,
    staleTime: SUPPORT_UPDATES_LATEST_STALE_MS,
    retry: false,
  });
  const seen = useSupportUpdatesSeen();
  return supportHubUnseenUpdates(typeof latest.data === 'string' ? latest.data : null, seen);
}

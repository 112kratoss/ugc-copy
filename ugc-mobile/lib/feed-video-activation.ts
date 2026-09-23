import { createContext, useCallback, useSyncExternalStore } from 'react';

import { sameStringList } from '@/lib/showcase-feed-activation';

/** What a feed tile does with its video: play it, hold it paused and drawn, or show the poster. */
export type FeedVideoActivation = 'visible' | 'prepared' | 'never';

export interface FeedVideoActivationSnapshot {
  activeIds: string[];
  preparedIds: string[];
}

/**
 * Where a feed's playback decisions live, outside React state.
 *
 * Activation used to ride FlashList's `extraData`: every election re-rendered
 * every mounted card so that one tile could flip `active`, and that commit
 * shared its frame with the native video view the election mounted. Here each
 * tile subscribes to its own id, so an election re-renders the tiles it
 * concerns and nothing else, and the screen that owns the list never renders
 * for playback at all.
 *
 * Tiles report back whether their player has drawn (`setReady`), which is what
 * lets the controller start a video while the feed is still moving: starting a
 * drawn player is a resume, starting anything else mounts a native view.
 */
export interface FeedVideoActivationStore {
  activationOf(id: string): FeedVideoActivation;
  snapshot(): FeedVideoActivationSnapshot;
  subscribe(id: string, listener: () => void): () => void;
  /** Applies the lists given; a list left out keeps its value. Notifies only the tiles whose activation changed. */
  publish(next: Partial<FeedVideoActivationSnapshot>): void;
  setReady(id: string, ready: boolean): void;
  isReady(id: string): boolean;
  subscribeReady(listener: (id: string, ready: boolean) => void): () => void;
}

export function createFeedVideoActivationStore(): FeedVideoActivationStore {
  let activeIds: string[] = [];
  let preparedIds: string[] = [];
  const ready = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const readyListeners = new Set<(id: string, ready: boolean) => void>();

  function activationOf(id: string): FeedVideoActivation {
    if (activeIds.includes(id)) return 'visible';
    if (preparedIds.includes(id)) return 'prepared';
    return 'never';
  }

  return {
    activationOf,
    snapshot: () => ({ activeIds, preparedIds }),
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(id);
      };
    },
    publish(next) {
      const nextActive = next.activeIds && !sameStringList(next.activeIds, activeIds) ? next.activeIds : activeIds;
      const nextPrepared = next.preparedIds && !sameStringList(next.preparedIds, preparedIds) ? next.preparedIds : preparedIds;
      if (nextActive === activeIds && nextPrepared === preparedIds) return;
      const before = new Map<string, FeedVideoActivation>();
      for (const id of [...activeIds, ...preparedIds, ...nextActive, ...nextPrepared]) {
        if (!before.has(id)) before.set(id, activationOf(id));
      }
      activeIds = nextActive;
      preparedIds = nextPrepared;
      for (const [id, previous] of before) {
        if (activationOf(id) === previous) continue;
        listeners.get(id)?.forEach((listener) => listener());
      }
    },
    setReady(id, value) {
      if (ready.has(id) === value) return;
      if (value) ready.add(id);
      else ready.delete(id);
      readyListeners.forEach((listener) => listener(id, value));
    },
    isReady: (id) => ready.has(id),
    subscribeReady(listener) {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
  };
}

/** The store of the feed a card is drawn in; null outside one, where nothing plays. */
export const FeedVideoActivationContext = createContext<FeedVideoActivationStore | null>(null);

const noSubscription = () => () => {};

export function useFeedVideoActivation(store: FeedVideoActivationStore | null, id: string): FeedVideoActivation {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(id, listener) : noSubscription()),
    [id, store],
  );
  return useSyncExternalStore(subscribe, () => (store ? store.activationOf(id) : 'never'));
}

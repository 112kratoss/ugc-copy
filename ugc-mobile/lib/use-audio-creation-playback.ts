import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { audioCreationPlayback } from './audio-creation-native-player';

/**
 * One place on screen that draws an audio creation's player.
 *
 * `reachable` is whether a person can get at this player's controls right now:
 * its screen is focused and, in the reel, its slide is the one in view. Sound
 * stops when the creation has no reachable player left, and the native player
 * is released when nothing draws the creation at all. The app leaving the
 * foreground is handled beside the player itself (`audio-creation-native-player`).
 */
export function useAudioCreationPlayback({
  itemId,
  url,
  reachable,
}: {
  itemId: string;
  url: string;
  reachable: boolean;
}) {
  const [presenter] = useState(() => ({}));
  const snapshot = useSyncExternalStore(
    audioCreationPlayback.subscribe,
    () => audioCreationPlayback.getSnapshot(itemId),
    () => audioCreationPlayback.getSnapshot(itemId),
  );

  useEffect(() => {
    audioCreationPlayback.present(itemId, presenter, reachable);
  }, [itemId, presenter, reachable]);
  useEffect(() => () => audioCreationPlayback.withdraw(itemId, presenter), [itemId, presenter]);

  const toggle = useCallback(() => audioCreationPlayback.toggle(itemId, url), [itemId, url]);
  const seek = useCallback((fraction: number) => audioCreationPlayback.seek(itemId, fraction), [itemId]);

  return { snapshot, toggle, seek };
}

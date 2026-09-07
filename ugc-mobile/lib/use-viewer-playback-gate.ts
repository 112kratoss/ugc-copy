import { useEffect, useRef, type RefObject } from 'react';
import { AppState, Platform } from 'react-native';
import type { VideoPlayer } from 'expo-video';

/**
 * Backgrounding revokes autoplay until the viewer explicitly presses Play.
 * `onRevoke` runs with each revoke: a player that has not started yet emits no
 * playingChange when paused, so the caller's badge state needs the decision.
 */
export function useViewerPlaybackGate(player: RefObject<VideoPlayer | null>, onRevoke?: () => void) {
  const allowed = useRef(!AppState.currentState || AppState.currentState === 'active');
  const revoke = useRef(onRevoke);
  revoke.current = onRevoke;
  useEffect(() => {
    const pause = () => {
      allowed.current = false;
      player.current?.pause();
      revoke.current?.();
    };
    const change = AppState.addEventListener('change', state => {
      if (state !== 'active') pause();
      else if (!allowed.current) player.current?.pause();
    });
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', pause) : null;
    return () => { change.remove(); blur?.remove(); };
  }, [player]);
  return allowed;
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * The immersive viewer is the only surface in the app that plays sound: the
 * showcase grid autoplays muted, and tapping a card into the reel is where
 * audio starts. HIG *Going full screen* asks a full-screen media experience to
 * "continue to provide access to essential features and controls so people can
 * complete their task without exiting full-screen mode", and *Playing audio* is
 * written throughout around people controlling their own sound. So the mute
 * state lives here rather than inside one player: every slide the reel mounts
 * reads the same answer, and the choice outlives the slide that made it.
 *
 * One subscription for the process, the same shape `lib/motion` uses for
 * Reduce Motion — a per-player listener would multiply with the reel's window.
 */

const STORAGE_KEY = 'viewer-audio-muted-v1';

let muted = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Restores the stored choice. Fire-and-forget on purpose: the store answers
 * `false` until the read lands, which is the same answer it gave before the
 * preference existed, and a storage failure must not keep the reel silent.
 */
export function hydrateViewerAudioMuted() {
  return AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const stored = raw === 'true';
      if (stored === muted) return;
      muted = stored;
      emit();
    })
    .catch(() => undefined);
}

export function isViewerAudioMuted() {
  return muted;
}

export function setViewerAudioMuted(next: boolean) {
  if (next === muted) return;
  muted = next;
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false').catch(() => undefined);
}

export function toggleViewerAudioMuted() {
  setViewerAudioMuted(!muted);
}

export function subscribeViewerAudioMuted(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useViewerAudioMuted() {
  return useSyncExternalStore(subscribeViewerAudioMuted, isViewerAudioMuted, isViewerAudioMuted);
}

/** Test seam: the module holds process state, so a suite has to be able to reset it. */
export function resetViewerAudioMutedForTests() {
  muted = false;
  listeners.clear();
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo, useSyncExternalStore } from 'react';

import { SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { useNetworkKind } from '@/lib/playback-device';
import type { PlaybackNetwork } from '@/lib/playback-metrics';

/**
 * Whether feed previews play by themselves: Settings → Playback → Autoplay
 * previews, the pattern YouTube and Instagram use. Wi-Fi only is the default.
 *
 * One store for the process, the same shape as `lib/appearance.ts`. The stored
 * choice is read as this module loads, with the feeds that import it, and it
 * answers the default until that read lands: milliseconds, before a feed has
 * a video to play, so nothing holds the splash for it.
 */
export type AutoplayPreference = 'wifi' | 'always' | 'never';

export const AUTOPLAY_PREFERENCES: readonly AutoplayPreference[] = ['wifi', 'always', 'never'];

export const DEFAULT_AUTOPLAY_PREFERENCE: AutoplayPreference = 'wifi';

const STORAGE_KEY = 'autoplay-preference-v1';

export function isAutoplayPreference(value: unknown): value is AutoplayPreference {
  return value === 'wifi' || value === 'always' || value === 'never';
}

export interface AutoplayPolicy {
  preference: AutoplayPreference;
  networkKind: PlaybackNetwork;
  /** False keeps every preview on its poster, as Reduce Motion does. */
  previewsEnabled: boolean;
  /** How many neighbour videos a feed may hold a paused, loaded player for. */
  preparedLimit: number;
  /** Whether a feed hands the playing slot over only once the list rests. */
  electOnlyAtRest: boolean;
}

function previewsEnabledFor(preference: AutoplayPreference) {
  return preference !== 'never';
}

/**
 * What a feed may play and load under a preference on a network.
 *
 * - `always` is the feed as it was: Home prepares a neighbour on either side
 *   and hands the slot over mid-scroll to one that has drawn.
 * - `wifi` is the same off mobile data. On it nothing loads ahead: no
 *   neighbour is prepared, and the card that plays is chosen once the list
 *   rests, so a scroll past ten videos downloads none of them.
 * - `never` keeps every preview on its poster, so there is nothing to prepare.
 *
 * Only a network expo-network calls cellular saves data. An unknown kind (a
 * binary without the module, a first read still out) counts as Wi-Fi, so
 * nothing changes where the kind cannot be read.
 */
export function resolveAutoplayPolicy(preference: AutoplayPreference, networkKind: PlaybackNetwork): AutoplayPolicy {
  const previewsEnabled = previewsEnabledFor(preference);
  // A mid-scroll handoff goes only to a player that is already loaded, so a
  // feed that loads nothing ahead waits for rest as well.
  const loadsAhead = previewsEnabled && !(preference === 'wifi' && networkKind === 'cellular');
  return {
    preference,
    networkKind,
    previewsEnabled,
    preparedLimit: loadsAhead ? SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS : 0,
    electOnlyAtRest: !loadsAhead,
  };
}

let preference: AutoplayPreference = DEFAULT_AUTOPLAY_PREFERENCE;
let hydration: Promise<void> | null = null;
// Counts writes, so a stored value read before a choice cannot undo it.
let writes = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function hydrate() {
  if (hydration) return hydration;
  const writesAtRead = writes;
  hydration = Promise.resolve()
    .then(() => AsyncStorage.getItem(STORAGE_KEY))
    .then((raw) => {
      if (writes !== writesAtRead || !isAutoplayPreference(raw) || raw === preference) return;
      preference = raw;
      emit();
    })
    // A read that fails keeps the default.
    .catch(() => undefined);
  return hydration;
}

// Started here rather than by the first tile to subscribe: a tile subscribes
// after its first commit, which can be after the election that starts its
// player, and a choice of Never must be in place before that.
void hydrate();

/** The stored choice, once it has been read. */
export async function readAutoplayPreference(): Promise<AutoplayPreference> {
  await hydrate();
  return preference;
}

/**
 * Applies a choice in the same call, so every feed on screen follows it in
 * the next frame, and stores it. Resolves once the write has settled; one that
 * fails keeps the choice for this session.
 */
export function writeAutoplayPreference(next: AutoplayPreference): Promise<void> {
  writes += 1;
  if (next !== preference) {
    preference = next;
    emit();
  }
  return Promise.resolve()
    .then(() => AsyncStorage.setItem(STORAGE_KEY, next))
    .catch(() => undefined);
}

export function getAutoplayPreference() {
  return preference;
}

function getAutoplayPreviewsEnabled() {
  return previewsEnabledFor(preference);
}

export function subscribeAutoplayPreference(listener: () => void) {
  listeners.add(listener);
  void hydrate();
  return () => {
    listeners.delete(listener);
  };
}

export function useAutoplayPreference(): AutoplayPreference {
  return useSyncExternalStore(subscribeAutoplayPreference, getAutoplayPreference, getAutoplayPreference);
}

/**
 * Whether previews play at all. A tile asks only this, so a change of network
 * re-renders the screens that choose what plays, not every tile on them.
 */
export function useAutoplayPreviewsEnabled(): boolean {
  return useSyncExternalStore(subscribeAutoplayPreference, getAutoplayPreviewsEnabled, getAutoplayPreviewsEnabled);
}

/** The preference against the network the phone is on right now, for a feed's election and prepared players. */
export function useAutoplayPolicy(): AutoplayPolicy {
  const current = useAutoplayPreference();
  const networkKind = useNetworkKind();
  return useMemo(() => resolveAutoplayPolicy(current, networkKind), [current, networkKind]);
}

/**
 * Test seam: the module holds process state. A preference given counts as
 * already read from storage; none is a fresh launch with the read still to come.
 */
export function resetAutoplayPreferenceForTests(next?: AutoplayPreference) {
  listeners.clear();
  // Counted as a write, so a read still out from before the reset is dropped.
  writes += 1;
  preference = next ?? DEFAULT_AUTOPLAY_PREFERENCE;
  hydration = next ? Promise.resolve() : null;
}

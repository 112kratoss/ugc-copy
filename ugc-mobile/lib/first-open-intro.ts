import AsyncStorage from '@react-native-async-storage/async-storage';

import type { OnboardingStatus } from './types';

/**
 * The first-open intro ("Create / Share / Earn", the dust, the note from the
 * team) plays once per install, for someone new: no account on the device and
 * onboarding never started. Anyone who already has the app — signed in, or who
 * has been through or skipped onboarding — never sees it, including after the
 * update that brings it.
 */
export const FIRST_OPEN_INTRO_STORAGE_KEY = 'magicbooklet.first-open-intro.seen.v1';

export type FirstOpenIntroDecision = 'unknown' | 'show' | 'skip';

export type FirstOpenIntroInput = {
  /** null while the stored flag is still being read. */
  seen: boolean | null;
  onboardingHydrated: boolean;
  /** False when the onboarding store could not be read or written. */
  storageAvailable: boolean;
  authLoading: boolean;
  hasUser: boolean;
  onboardingStatus: OnboardingStatus;
};

export function decideFirstOpenIntro({
  seen,
  onboardingHydrated,
  storageAvailable,
  authLoading,
  hasUser,
  onboardingStatus,
}: FirstOpenIntroInput): FirstOpenIntroDecision {
  if (seen === null || !onboardingHydrated || authLoading) return 'unknown';
  if (seen || hasUser || onboardingStatus !== 'not_started') return 'skip';
  // A store that cannot be written would never remember the intro was seen,
  // and it would play at every launch: better not at all.
  if (!storageAvailable) return 'skip';
  return 'show';
}

/** Read failures count as seen, for the same reason. */
export async function readFirstOpenIntroSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(FIRST_OPEN_INTRO_STORAGE_KEY)) !== null;
  } catch {
    return true;
  }
}

export async function markFirstOpenIntroSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(FIRST_OPEN_INTRO_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Nothing to do: at worst it plays once more on the next launch.
  }
}

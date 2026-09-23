import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useSyncExternalStore } from 'react';
import { Appearance, AppState, type AppStateStatus } from 'react-native';

import type { ColorScheme } from '@/lib/theme';

/**
 * Which scheme the app draws in: the phone's own setting by default, or a
 * choice made under Settings → Appearance that holds whatever the phone says.
 *
 * One store for the process, the same shape as `lib/viewer-audio.ts` and the
 * Reduce Motion store in `lib/motion.ts`. The root layout resolves the scheme
 * here and hands the matching theme down (lib/theme-context.tsx); nothing else
 * subscribes, so a scheme change costs one context update rather than one
 * listener per themed component.
 */
export type AppearancePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_PREFERENCES: readonly AppearancePreference[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'appearance-preference-v1';

type ExpoConfigLike = { userInterfaceStyle?: string } | null | undefined;

/**
 * Light mode ships with the binary that stops pinning the native layer dark
 * (`userInterfaceStyle: "automatic"` in app.json). This JavaScript can only
 * reach a binary whose app.json matches the one it was built with — app.json
 * is a runtime-fingerprint input — so the embedded config is an exact gate:
 * a store build still pinned dark keeps drawing dark, and development builds
 * can preview both schemes before the switch.
 */
export function isAppearanceChoiceAvailable(
  config: ExpoConfigLike = Constants.expoConfig,
  dev: boolean = typeof __DEV__ !== 'undefined' && __DEV__,
) {
  return dev || config?.userInterfaceStyle === 'automatic';
}

export function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The scheme a preference resolves to against what the phone reports. */
export function resolveColorScheme(
  preference: AppearancePreference,
  systemScheme: ColorScheme,
  available: boolean,
): ColorScheme {
  if (!available) return 'dark';
  return preference === 'system' ? systemScheme : preference;
}

/**
 * The phone's scheme as React Native last reported it. No answer at all keeps
 * the app on the look it has always had.
 */
function readSystemScheme(): ColorScheme {
  try {
    return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
  } catch {
    // Focused tests provide a minimal react-native mock without Appearance.
    return 'dark';
  }
}

function currentAppState(): AppStateStatus | undefined {
  try {
    return AppState.currentState;
  } catch {
    return undefined;
  }
}

const available = isAppearanceChoiceAvailable();
let preference: AppearancePreference = 'system';
let systemScheme: ColorScheme = readSystemScheme();
let resolvedScheme: ColorScheme = resolveColorScheme(preference, systemScheme, available);
let hydration: Promise<void> | null = null;
let nativeSubscriptions: Array<{ remove: () => void }> = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** `preferenceChanged` notifies the Settings control even when the scheme it resolves to stays put. */
function recompute(preferenceChanged = false) {
  const next = resolveColorScheme(preference, systemScheme, available);
  const schemeChanged = next !== resolvedScheme;
  resolvedScheme = next;
  if (schemeChanged || preferenceChanged) emit();
}

/**
 * Hands the choice to the native layer too, so the keyboard, alerts, the share
 * sheet and Liquid Glass follow the app rather than the phone. `unspecified`
 * gives the decision back to the phone. Never called for a binary still pinned
 * dark: there the app must not move at all.
 */
function applyNativePreference(next: AppearancePreference) {
  if (!available) return;
  try {
    Appearance.setColorScheme(next === 'system' ? 'unspecified' : next);
  } catch {
    // A missing native module leaves the JavaScript scheme in charge.
  }
}

/**
 * iOS redraws an app that is leaving the foreground in both appearances for
 * the app switcher, and React Native reports each of those trait changes as a
 * scheme change. Acting on them would re-render the whole tree twice every
 * time the app is put away, so changes are only taken while the app is active;
 * coming back re-reads whatever the phone settled on. A switch made from
 * Control Center lands the moment Control Center closes.
 */
function onNativeSchemeChange() {
  if (currentAppState() !== 'active') return;
  systemScheme = readSystemScheme();
  recompute();
}

function onAppStateChange(state: AppStateStatus) {
  if (state !== 'active') return;
  systemScheme = readSystemScheme();
  recompute();
}

function startNativeSubscriptions() {
  if (nativeSubscriptions.length > 0) return;
  try {
    nativeSubscriptions = [
      Appearance.addChangeListener(onNativeSchemeChange),
      AppState.addEventListener('change', onAppStateChange),
    ];
  } catch {
    nativeSubscriptions = [];
  }
  // The phone may have changed while nothing was listening.
  systemScheme = readSystemScheme();
  recompute();
}

function stopNativeSubscriptions() {
  for (const subscription of nativeSubscriptions) subscription.remove();
  nativeSubscriptions = [];
}

export function subscribeColorScheme(listener: () => void) {
  listeners.add(listener);
  startNativeSubscriptions();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopNativeSubscriptions();
  };
}

export function getResolvedColorScheme() {
  return resolvedScheme;
}

export function getAppearancePreference() {
  return preference;
}

/**
 * Restores the stored choice. The root layout holds the splash on this beside
 * the fonts, so an app set to Light on a dark phone draws its first frame
 * light. A read that fails keeps following the phone.
 */
export function hydrateAppearancePreference() {
  if (hydration) return hydration;
  hydration = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!available || !isAppearancePreference(raw) || raw === preference) return;
      preference = raw;
      applyNativePreference(raw);
      recompute(true);
    })
    .catch(() => undefined);
  return hydration;
}

/**
 * Takes effect in the same frame: the scheme is resolved here, not after a
 * round trip through the native layer. Going back to `system` keeps the
 * current scheme until the phone reports its own, a moment later — while an
 * override is on, the phone's scheme cannot be read.
 */
export function setAppearancePreference(next: AppearancePreference) {
  if (!available || next === preference) return;
  preference = next;
  applyNativePreference(next);
  recompute(true);
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
}

export function useResolvedColorScheme() {
  return useSyncExternalStore(subscribeColorScheme, getResolvedColorScheme, getResolvedColorScheme);
}

export function useAppearancePreference() {
  return useSyncExternalStore(subscribeColorScheme, getAppearancePreference, getAppearancePreference);
}

/** Test seam: the module holds process state, so a suite has to be able to reset it. */
export function resetAppearanceForTests(next: { preference?: AppearancePreference; systemScheme?: ColorScheme } = {}) {
  stopNativeSubscriptions();
  listeners.clear();
  hydration = null;
  preference = next.preference ?? 'system';
  systemScheme = next.systemScheme ?? readSystemScheme();
  resolvedScheme = resolveColorScheme(preference, systemScheme, available);
}

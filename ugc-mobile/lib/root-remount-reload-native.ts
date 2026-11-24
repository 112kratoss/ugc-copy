import AsyncStorage from '@react-native-async-storage/async-storage';
import { reloadAppAsync } from 'expo';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { noteRootMount, noteRootUnmount, ROOT_REMOUNT_RELOAD_STORAGE_KEY, type RootRemountReloadDeps } from './root-remount-reload';

/**
 * The platform half of `lib/root-remount-reload.ts` (why, and the evidence, are
 * there).
 *
 * The reload is expo's `reloadAppAsync`, not `Updates.reloadAsync`: on Android
 * it asks the current activity's React delegate to reload its React host
 * (expo-modules-core `CoreModule`, `ReactDelegate.reload` → `ReactHost.reload`),
 * which tears the React instance down and starts a new one — a new Hermes
 * runtime, and with it new worklets and Reanimated modules and UI runtime —
 * from the bundle the host is already running. It works with expo-updates on
 * or off and never switches to a downloaded update, which stays the OTA gate's
 * to apply (`lib/use-ota-update-gate.ts`).
 */
const deps: RootRemountReloadDeps = {
  platform: Platform.OS,
  dev: __DEV__,
  now: () => Date.now(),
  readLastReloadAt: async () => {
    const stored = await AsyncStorage.getItem(ROOT_REMOUNT_RELOAD_STORAGE_KEY);
    const at = stored === null ? null : Number(stored);
    return at !== null && Number.isFinite(at) ? at : null;
  },
  writeLastReloadAt: (at) => AsyncStorage.setItem(ROOT_REMOUNT_RELOAD_STORAGE_KEY, String(at)),
  reload: (reason) => reloadAppAsync(reason),
};

/**
 * Counts this mount of the app's root; on Android, a second one in this runtime
 * reloads the JS once, as soon as it is the only root mounted.
 */
export function useRootRemountReload() {
  useEffect(() => {
    void noteRootMount(deps);
    return () => {
      void noteRootUnmount(deps);
    };
  }, []);
}

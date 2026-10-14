import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { PlaybackNetwork } from '@/lib/playback-metrics';

type NativeNetworkState = { type?: string | null } | null | undefined;

/** The parts of expo-network's native module (`ExpoNetwork`) read here. */
export type NativeNetworkModule = {
  getNetworkStateAsync?: () => Promise<NativeNetworkState>;
  addListener?: (
    eventName: 'onNetworkStateChanged',
    listener: (state: NativeNetworkState) => void,
  ) => { remove: () => void };
};

/** The phone as the metrics describe it: platform, OS version and, on Android, the model. */
export function readPlaybackDevice(): { platform: 'ios' | 'android'; os: string; model: string | null } {
  const constants = Platform.constants as { Brand?: string; Model?: string } | undefined;
  const model = Platform.OS === 'android' && constants?.Model
    ? [constants.Brand, constants.Model].filter(Boolean).join(' ').slice(0, 40)
    : null;
  return {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    os: String(Platform.Version).slice(0, 16),
    model,
  };
}

let networkModule: NativeNetworkModule | null | undefined;

/**
 * expo-network's native module, read optionally: a binary built before it was
 * added answers null instead of throwing, so what reads the network reaches
 * every installed build over the air. `expo` is required on first use, as
 * `lib/system-bars.ts` does, because feed tiles reach this file through the
 * autoplay preference and a tile must not pull anything native into focused
 * tests.
 */
function readNetworkModule(): NativeNetworkModule | null {
  if (networkModule !== undefined) return networkModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    networkModule = requireOptionalNativeModule<NativeNetworkModule>('ExpoNetwork');
  } catch {
    networkModule = null;
  }
  return networkModule;
}

/**
 * The network kind at flush time. A binary without expo-network's native
 * module answers `unknown` instead of throwing, so the metrics reach every
 * installed build over the air.
 */
export async function readPlaybackNetwork(): Promise<PlaybackNetwork> {
  const network = readNetworkModule();
  if (!network?.getNetworkStateAsync) return 'unknown';
  try {
    const state = await network.getNetworkStateAsync();
    return normalizeNetworkType(state?.type);
  } catch {
    return 'unknown';
  }
}

export function normalizeNetworkType(type: string | null | undefined): PlaybackNetwork {
  switch ((type ?? '').toUpperCase()) {
    case 'WIFI':
    case 'ETHERNET':
      return 'wifi';
    case 'CELLULAR':
      return 'cellular';
    case 'NONE':
      return 'none';
    case '':
    case 'UNKNOWN':
      return 'unknown';
    default:
      return 'other';
  }
}

/**
 * The network kind, live: one store for the process (the shape of the Reduce
 * Motion store in `lib/motion.ts`), so the screens that ask share a single
 * native listener. It answers `unknown` until the first read or change lands,
 * and for good on a binary without the module.
 *
 * The native listener stays for the life of the process once added. Removing
 * the last one cancels expo-network's `NWPathMonitor` on iOS, and the module
 * starts that same monitor again for the next listener, which a cancelled
 * monitor ignores: a feed that unmounted and came back would be stuck on the
 * kind it last saw.
 */
export function createNetworkKindStore(readModule: () => NativeNetworkModule | null) {
  let kind: PlaybackNetwork = 'unknown';
  let started = false;
  // Counts change events, so a first read that lands after one is dropped: the event is newer.
  let changes = 0;
  const listeners = new Set<() => void>();

  function publish(next: PlaybackNetwork) {
    if (next === kind) return;
    kind = next;
    for (const listener of listeners) listener();
  }

  function start() {
    if (started) return;
    started = true;
    const network = readModule();
    if (!network) return;
    try {
      network.addListener?.('onNetworkStateChanged', (state) => {
        changes += 1;
        publish(normalizeNetworkType(state?.type));
      });
    } catch {
      // No change events: the first read is all this binary will say.
    }
    // Android registers its callback when the module is created and reports
    // nothing until the network changes, so the current kind is read once.
    const changesAtRead = changes;
    void Promise.resolve()
      .then(() => network.getNetworkStateAsync?.())
      .then((state) => {
        if (changes === changesAtRead) publish(normalizeNetworkType(state?.type));
      })
      .catch(() => undefined);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => kind,
  };
}

const networkKindStore = createNetworkKindStore(readNetworkModule);

/** Wi-Fi, cellular, none, other or unknown, as expo-network reports it right now. */
export function useNetworkKind(): PlaybackNetwork {
  return useSyncExternalStore(networkKindStore.subscribe, networkKindStore.getSnapshot, networkKindStore.getSnapshot);
}

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import type { PlaybackNetwork } from '@/lib/playback-metrics';

type NativeNetworkModule = {
  getNetworkStateAsync?: () => Promise<{ type?: string | null } | null>;
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

/**
 * The network kind at flush time. expo-network's native module is read
 * optionally: a binary built before it was added answers `unknown` instead of
 * throwing, so the metrics reach every installed build over the air.
 */
export async function readPlaybackNetwork(): Promise<PlaybackNetwork> {
  const network = requireOptionalNativeModule<NativeNetworkModule>('ExpoNetwork');
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

import { Platform } from 'react-native';

/**
 * Whether this device runs the reel's native zoom (lib/apple-zoom.ts): iOS 18
 * or later, on the bridgeless runtime Expo Router mounts its zoom views on
 * (`expo-router/build/link/preview/native`). Anywhere else a tile opens the
 * reel as it always did.
 */
export function isAppleZoomAvailable(): boolean {
  if (Platform.OS !== 'ios') return false;
  const major = parseInt(String(Platform.Version), 10);
  if (!Number.isFinite(major) || major < 18) return false;
  return (globalThis as { RN$Bridgeless?: boolean }).RN$Bridgeless === true;
}

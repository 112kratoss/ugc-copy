import { Platform } from 'react-native';

let available: boolean | undefined;

/**
 * Whether this binary carries Expo UI's native module (`ExpoUI`), which draws
 * the native menus (`lib/native-menu.ts`). Store builds from 0.1.8 do; a dev
 * client built before it was added does not, and there a ••• button keeps its
 * sheet rather than crashing on a view the binary cannot create.
 *
 * Read through `requireOptionalNativeModule`, as `lib/system-bars.ts` reads the
 * navigation bar: the package's own components require their views at import.
 */
export function isNativeMenuAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return available;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    available = requireOptionalNativeModule('ExpoUI') != null;
  } catch {
    available = false;
  }
  return available;
}

/**
 * The version line at the foot of Settings: "Version 0.1.4 (52) · update 00b2999e".
 *
 * Everything here is read on the phone; nothing is sent anywhere. The store version
 * alone cannot tell two copies of the app apart, because every OTA update ships under
 * the same "0.1.4". So the line also names the binary's build number and, when one is
 * running, the downloaded update.
 */

import { requireOptionalNativeModule } from 'expo';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

/** The constants expo-application's native module exposes. */
type NativeApplicationConstants = {
  nativeApplicationVersion?: string | null;
  nativeBuildVersion?: string | null;
};

export type AppVersionParts = {
  /** The store version, e.g. "0.1.4". */
  version: string | null;
  /** The native build number: CFBundleVersion on iOS, versionCode on Android. */
  build: string | null;
  /** The running OTA update, or null on the bundle embedded in the binary. */
  update: string | null;
};

/** Enough of a random id to find it by eye in `eas update:list`. */
const UPDATE_CODE_LENGTH = 8;

export function formatAppVersionLabel({ version, build, update }: AppVersionParts): string | null {
  if (!version) return null;
  const buildPart = build ? ` (${build})` : '';
  const updatePart = update ? ` · update ${update.slice(0, UPDATE_CODE_LENGTH)}` : '';
  return `Version ${version}${buildPart}${updatePart}`;
}

/**
 * EAS names an update by its group, the id `eas update:list` and `channel:insights` print.
 * The update's own id is a UUIDv7 that starts with its publish time, so its first characters
 * barely change from one release to the next; it is only the fallback.
 */
function readUpdateGroup(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const metadata = (manifest as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const group = (metadata as { updateGroup?: unknown }).updateGroup;
  return typeof group === 'string' && group ? group : null;
}

export function readAppVersionParts(): AppVersionParts {
  // expo-application is not a direct dependency. Adding it would change package.json, a runtime
  // fingerprint input, and cut this line off from OTA updates. Its native module is linked anyway
  // (expo-notifications and expo-auth-session depend on it); reading it optionally leaves a build
  // without it on the fallbacks instead of throwing.
  const application = requireOptionalNativeModule<NativeApplicationConstants>('ExpoApplication');
  const downloaded = Updates.isEnabled && !Updates.isEmbeddedLaunch;
  return {
    version: application?.nativeApplicationVersion || Constants.expoConfig?.version || null,
    build: application?.nativeBuildVersion || Constants.platform?.ios?.buildNumber || null,
    // The embedded bundle has an id too, but it names no published update.
    update: downloaded ? readUpdateGroup(Updates.manifest) ?? Updates.updateId : null,
  };
}

/**
 * Whether `blurRadius` may be handed to expo-image on this device.
 *
 * On Android, expo-image 55 blurs through glide-transformations' RSBlur, which
 * creates and tears down a RenderScript context for every picture, on Glide's
 * single disk-cache thread. RenderScript is deprecated since API 31, and on
 * 2026-09-18 its teardown (`RenderScript.releaseAllContexts` →
 * `rsContextDestroy` → `pthread_join`) hung on a Galaxy S24 Ultra running
 * Android 16. Every later image that was not already in the memory cache
 * queued behind it until the app was restarted: creations sat on "Taking too
 * long to load", grid tiles on their thumbhash, while avatars (memory cache)
 * and videos (ExoPlayer) kept working. Upstream replaced that blur with a
 * software one in expo-image 56.0.0.
 *
 * So blur is never asked of an Android binary that has not said its expo-image
 * blurs in software: `patches/expo-image+55.0.11.patch` makes the ExpoImage
 * native module advertise `softwareBlurRadius`, and the root layout records
 * that here at startup. A backdrop drawn from a thumbhash needs no blur at all
 * (`components/backdrop-image.tsx`), so most surfaces never reach this
 * question; the rest keep their plain background.
 */

export type NativeImageCapabilities = { softwareBlurRadius?: unknown } | null | undefined;

const capabilities = { softwareBlurRadius: false };

/** Records what the running ExpoImage native module advertised. Called once, by the root layout. */
export function setNativeImageCapabilities(module: NativeImageCapabilities): void {
  capabilities.softwareBlurRadius = module?.softwareBlurRadius === true;
}

export function resetNativeImageCapabilitiesForTests(): void {
  capabilities.softwareBlurRadius = false;
}

/**
 * The blur expo-image may be asked for, or undefined where asking could stall
 * every image loaded after it. iOS blurs through Core Image and is always safe.
 */
export function nativeBlurRadius(radius: number, os: string | undefined = process.env.EXPO_OS): number | undefined {
  if (!(radius > 0)) return undefined;
  if (os !== 'android') return radius;
  return capabilities.softwareBlurRadius ? radius : undefined;
}

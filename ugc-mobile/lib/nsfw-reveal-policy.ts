/**
 * Whether this app build may show a post its creator marked NSFW.
 *
 * iOS follows Apple's rule for mature user content: off by default, turned on
 * from the website, then revealed one post at a time. Google Play allows
 * mature user posts in an app only when the whole app screens out children
 * with a neutral age screen, which Magicbooklet does not have yet. Until it
 * does, Android keeps every NSFW post behind its warning card and never
 * requests the original (Play policy notice, 2026-09-28).
 *
 * Flip Android here once the age screen ships; nothing else checks the platform.
 */
export function canRevealNsfwInApp(platform: string): boolean {
  return platform !== 'android';
}

/**
 * How a mature purchase's media can be shown on this device. The purchase is
 * the entitlement, so the server signs its files whatever the preference says;
 * the app still keeps the rule it keeps for posts, whose reveal the server
 * refuses until the viewer has turned mature content on. Only the website can
 * turn it on (Apple 1.2: hidden by default, enabled on the website).
 *
 * - `show`: the preference is on, so Show draws the media in place.
 * - `website`: it is off, or could not be read; the plate says where to turn it on.
 * - `pending`: it is still being read, and the plate offers nothing yet.
 * - `never`: this platform shows no mature media (`canRevealNsfwInApp`).
 */
export type MatureReveal = 'show' | 'website' | 'pending' | 'never';

/** `showMature` is the viewer's preference, or null until it has been read. */
export function getMatureReveal(platform: string, showMature: boolean | null): MatureReveal {
  if (!canRevealNsfwInApp(platform)) return 'never';
  if (showMature === null) return 'pending';
  return showMature ? 'show' : 'website';
}

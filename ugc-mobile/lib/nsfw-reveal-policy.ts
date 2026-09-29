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
 * Flip Android here once the age screen ships; nothing else gates the reveal.
 */
export function canRevealNsfwInApp(platform: string): boolean {
  return platform !== 'android';
}

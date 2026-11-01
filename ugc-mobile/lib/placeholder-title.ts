/**
 * The names a post arrives with when nobody named it: the feed's "Untitled
 * Creation" and "Untitled Note" (src/lib/showcase-feed.ts), the owner reads'
 * "Untitled post" (src/lib/owner-post-title-fallback.ts) and the app's own
 * "Community post" (lib/showcase-display.ts). Whatever names a post shows its
 * own words in their place: Home's cards, the showcase grid, the reel's
 * caption and a remix's source row.
 */
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  'untitled',
  'untitled creation',
  'untitled note',
  'untitled post',
  'community post',
]);

export function isPlaceholderTitle(value: string) {
  return PLACEHOLDER_TITLES.has(value.replace(/\s+/g, ' ').trim().toLowerCase());
}

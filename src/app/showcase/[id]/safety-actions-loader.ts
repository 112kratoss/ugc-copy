/**
 * Report user and Block user's actions on a post's page (`feed-safety-actions`: with the moderation
 * client, the feeds' copies and Marketplace pages a block clears, 12 KB), loaded with import() at
 * the first reach for either row instead of with the page (2026-11-19). A module of its own, which
 * `report-post-safety-actions-failure.test.tsx` fails as a load fails.
 *
 * What a failed load leaves: Turbopack's runtime asks for the chunk once more by itself, then
 * rejects and forgets it, so a later import() asks the network again (`loadChunkCached` in the
 * runtime of next 16.3). That answers a dropped connection; after a deploy renamed the chunk while
 * the page was open, only a reload, which fetches the chunk names of the deployment live now, can.
 */
export function loadSafetyActions() {
  return import('@/lib/feed-safety-actions');
}

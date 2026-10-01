import type { ShowcaseFeedItem } from './types';

/**
 * What stands between this viewer and remixing a showcase post.
 *
 * - `open`: nothing. The tap goes straight to the editor.
 * - `free-unlock`: the creator put remix behind an unlock that costs nothing.
 *   The tap claims it and carries on, since asking permission to take something
 *   free is only a delay.
 * - `paid-unlock`: the unlock costs credits, so the tap opens its sheet first.
 *   Credits are never spent by a single tap in a feed.
 *
 * `null` means the post has nothing to remix: an upload, a written note, or a
 * mature post still behind its cover.
 *
 * A Remix control is drawn for every non-null answer, so it says what the post
 * can do rather than what this viewer has already unlocked. Hiding it was never
 * the lock: the remix endpoint refuses a locked post by itself.
 */
export type ShowcaseRemixAccess = 'open' | 'free-unlock' | 'paid-unlock';

export function getShowcaseRemixAccess(item: ShowcaseFeedItem): ShowcaseRemixAccess | null {
  // Only a creation made in the app has a prompt and settings to start from.
  if (typeof item.generationId !== 'string' || item.generationId.trim().length === 0) return null;
  if (item.canRemix) return 'open';

  // When the source says why, believe it. When it says nothing (saved media,
  // creator profiles, a page kept from an older build), a locked bundle that
  // includes remix is the only reason a creation is not remixable.
  if (item.remixCapability && item.remixCapability !== 'unlock_required') return null;
  // These remixes open on the web; an unlock would lead nowhere in the app.
  if (item.remixTarget === 'workflow' || item.remixTarget === 'text_template') return null;
  if (!item.asset?.allowRemix) return null;

  return item.asset.accessMode === 'free' ? 'free-unlock' : 'paid-unlock';
}

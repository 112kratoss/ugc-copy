import type { ViewerUnlockItem } from '@/lib/types';

export type UnlockStateBadge = {
  tone: 'kept' | 'updated' | 'none';
  label: string;
} | null;

/**
 * A creator can delist or delete a post after someone unlocked it. Both states
 * are labelled rather than hidden: an unexplained missing item reads as data
 * loss, when in fact the whole point is that the buyer kept it.
 */
export function getUnlockStateBadge(item: ViewerUnlockItem): UnlockStateBadge {
  if (item.tombstoned) {
    return { tone: 'kept', label: 'Creator removed the post — yours to keep' };
  }

  if (item.retired) {
    return { tone: 'kept', label: 'No longer sold — yours to keep' };
  }

  if (item.hasNewerRevision) {
    return { tone: 'updated', label: 'Creator added an update' };
  }

  return null;
}

export function formatUnlockPrice(priceUsdCents: number): string {
  if (priceUsdCents <= 0) {
    return 'Free';
  }

  const usd = (priceUsdCents / 100).toFixed(2);
  return `${priceUsdCents} tokens ($${usd})`;
}

export function formatUnlockDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Opens the unlock, not the feed.
 *
 * The immersive viewer reads `initialId` and normalizes any unrecognised
 * `source` back to the showcase feed, so a `?postId=…&source=unlocks` link
 * silently dropped every buyer into the generic feed. The resource screen is
 * the right destination anyway: it resolves through
 * getMarketplaceResourceDetail, which falls back to the entitlement-aware
 * bundle endpoint and therefore still opens for a delisted or tombstoned post.
 */
export function getUnlockDestination(item: ViewerUnlockItem): string | null {
  if (!item.bundleId) {
    return null;
  }

  const postParam = item.postId ? `?postId=${encodeURIComponent(item.postId)}` : '';
  return `/marketplace/${encodeURIComponent(item.bundleId)}${postParam}`;
}

export function summarizeUnlockCount(total: number): string {
  return `${total} ${total === 1 ? 'unlock' : 'unlocks'} · yours permanently`;
}

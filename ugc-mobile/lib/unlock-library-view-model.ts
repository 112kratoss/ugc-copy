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
 * A tombstoned post has no public page left, so its card must not offer one.
 * The unlock itself still opens from the library.
 */
export function getUnlockDestination(item: ViewerUnlockItem): string | null {
  if (!item.postId) {
    return null;
  }

  return `/viewer?postId=${item.postId}&source=unlocks`;
}

export function summarizeUnlockCount(total: number): string {
  return `${total} ${total === 1 ? 'unlock' : 'unlocks'} · yours permanently`;
}

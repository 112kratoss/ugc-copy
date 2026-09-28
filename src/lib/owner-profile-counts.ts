import type { OwnerProfileStats } from '@/lib/profile';

/**
 * The jsonb `owner_profile_counts(uuid)` returns, as the stats the profile
 * response carries. The function counts with the same rules the profile
 * library lists apply, so a header number and the grid below it agree; see
 * docs/plans/profile-counts-2026-09-28.md for the rules and their fixtures.
 */
export function parseOwnerProfileCounts(data: unknown): OwnerProfileStats {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};

  return {
    creations: nonNegativeInteger(record.creations),
    posts: nonNegativeInteger(record.posts),
    archivedPosts: nonNegativeInteger(record.archivedPosts),
    saved: nonNegativeInteger(record.saved),
  };
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

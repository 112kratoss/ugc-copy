import type { OwnerProfileStats } from '@/lib/profile';

const CREATION_KIND_KEYS = ['images', 'videos', 'audio'] as const;
const POST_VISIBILITY_KEYS = ['public', 'unlisted', 'private'] as const;

/**
 * The jsonb `owner_profile_counts(uuid)` returns, as the stats the profile
 * response carries. The function counts with the same rules the profile
 * library lists apply, so a header number and the grid below it agree; see
 * docs/plans/profile-counts-2026-09-28.md for the rules and their fixtures.
 */
export function parseOwnerProfileCounts(data: unknown): OwnerProfileStats {
  const record = asRecord(data) ?? {};

  const failedCreations = optionalNonNegativeInteger(record.failedCreations);
  const archivedCreations = optionalNonNegativeInteger(record.archivedCreations);
  const creationsByKind = optionalCountGroup(record.creationsByKind, CREATION_KIND_KEYS);
  const postsByVisibility = optionalCountGroup(record.postsByVisibility, POST_VISIBILITY_KEYS);
  return {
    creations: nonNegativeInteger(record.creations),
    // Left out, not 0, while a database without them answers: the app then
    // counts its loaded pages, where a 0 would hide the Failed chip, and
    // Studio draws no number on a filter it cannot count.
    ...(creationsByKind === undefined ? {} : { creationsByKind }),
    ...(failedCreations === undefined ? {} : { failedCreations }),
    ...(archivedCreations === undefined ? {} : { archivedCreations }),
    posts: nonNegativeInteger(record.posts),
    ...(postsByVisibility === undefined ? {} : { postsByVisibility }),
    archivedPosts: nonNegativeInteger(record.archivedPosts),
    saved: nonNegativeInteger(record.saved),
  };
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function optionalNonNegativeInteger(value: unknown) {
  return value === undefined || value === null ? undefined : nonNegativeInteger(value);
}

/**
 * A split the database counts as one (`creationsByKind`, `postsByVisibility`):
 * each of its totals, or nothing unless it sends every one of them, since a
 * total it left out would otherwise read as 0.
 */
function optionalCountGroup<Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, number> | undefined {
  const group = asRecord(value);
  if (!group || keys.some((key) => group[key] === undefined || group[key] === null)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, nonNegativeInteger(group[key])])) as Record<Key, number>;
}

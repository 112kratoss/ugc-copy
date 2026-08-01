import { describe, expect, it } from 'vitest';

import {
  isMissingPostResourceItemsColumnError,
  isMissingPostResourceRetirementColumnError,
  isMissingPostTombstoneColumnError,
} from '@/lib/posts-server';

/**
 * Code can run ahead of schema: a rollback, or a developer pointing a local
 * server at production before its migration lands. Both of the columns added by
 * the bundle-revisions migration were originally requested with no fallback,
 * and each one took down a whole read path when it was absent -- bundle detail
 * 500'd, and the public marketplace list silently returned zero items.
 */
function columnError(message: string) {
  return { code: '42703', message };
}

describe('post resource schema drift fallbacks', () => {
  it('recognises a missing retired_at column', () => {
    expect(isMissingPostResourceRetirementColumnError(
      columnError('column post_resource_bundles.retired_at does not exist'),
    )).toBe(true);
  });

  it('recognises a missing tombstoned_at column', () => {
    expect(isMissingPostTombstoneColumnError(
      columnError('column posts.tombstoned_at does not exist'),
    )).toBe(true);
  });

  it('keeps the three detectors from claiming each other\'s errors', () => {
    const retired = columnError('column post_resource_bundles.retired_at does not exist');
    const tombstoned = columnError('column posts.tombstoned_at does not exist');
    const items = columnError('column post_resource_bundles.resource_items does not exist');

    expect(isMissingPostTombstoneColumnError(retired)).toBe(false);
    expect(isMissingPostResourceItemsColumnError(retired)).toBe(false);

    expect(isMissingPostResourceRetirementColumnError(tombstoned)).toBe(false);
    expect(isMissingPostResourceItemsColumnError(tombstoned)).toBe(false);

    expect(isMissingPostResourceRetirementColumnError(items)).toBe(false);
    expect(isMissingPostTombstoneColumnError(items)).toBe(false);
  });

  it('ignores unrelated database failures', () => {
    // Only an undefined-column error may trigger a narrower re-select; a
    // connection or permission failure must surface, not silently degrade.
    for (const detector of [
      isMissingPostResourceRetirementColumnError,
      isMissingPostTombstoneColumnError,
      isMissingPostResourceItemsColumnError,
    ]) {
      expect(detector({ code: '42501', message: 'permission denied for table posts' })).toBe(false);
      expect(detector({ code: '08006', message: 'connection failure' })).toBe(false);
      expect(detector(null)).toBe(false);
      expect(detector(undefined)).toBe(false);
    }
  });
});

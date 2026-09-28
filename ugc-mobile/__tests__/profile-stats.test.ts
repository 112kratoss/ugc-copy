import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  adjustProfileStats,
  applyProfileStatsDelta,
  invalidateProfileStats,
  profileQueryKey,
} from '@/lib/profile-stats';
import type { ProfileResponse } from '@/lib/types';

function profile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: 'user-1',
    username: 'luna_dreams',
    displayName: 'Luna Dreams',
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: 40,
    stats: { creations: 6, posts: 3, archivedPosts: 1, saved: 2 },
    ...overrides,
  };
}

describe('profile stats deltas', () => {
  it('moves the totals the person just changed, and no other', () => {
    expect(applyProfileStatsDelta(profile(), { posts: -1, archivedPosts: 1 }).stats).toEqual({
      creations: 6, posts: 2, archivedPosts: 2, saved: 2,
    });
  });

  it('never goes below zero, and ignores a delta that is not a number', () => {
    expect(applyProfileStatsDelta(profile(), { saved: -5, creations: Number.NaN }).stats).toEqual({
      creations: 6, posts: 3, archivedPosts: 1, saved: 0,
    });
  });

  it('leaves a profile with no totals alone rather than inventing one', () => {
    const without = profile({ stats: null });
    expect(applyProfileStatsDelta(without, { posts: 1 })).toBe(without);
    expect(applyProfileStatsDelta(undefined, { posts: 1 })).toBeUndefined();
  });

  it('writes into the profile query the header reads, then asks the server for the truth', async () => {
    const client = new QueryClient();
    client.setQueryData(profileQueryKey('user-1'), profile());

    adjustProfileStats(client, 'user-1', { saved: 1 });
    expect(client.getQueryData<ProfileResponse>(profileQueryKey('user-1'))?.stats?.saved).toBe(3);

    await invalidateProfileStats(client, 'user-1');
    expect(client.getQueryState(profileQueryKey('user-1'))?.isInvalidated).toBe(true);
  });

  it('does nothing for a signed-out device', async () => {
    const client = new QueryClient();
    adjustProfileStats(client, null, { saved: 1 });
    await invalidateProfileStats(client, undefined);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

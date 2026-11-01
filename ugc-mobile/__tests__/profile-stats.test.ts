import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  adjustProfileStats,
  applyProfileStatsDelta,
  creationStatsDelta,
  creationStatsKey,
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

  it('leaves a total this server does not send unknown rather than guessing it', () => {
    // A server from before the Failed and Archived creation totals.
    expect(applyProfileStatsDelta(profile(), { failedCreations: -1, archivedCreations: 1, creations: -1 }).stats).toEqual({
      creations: 5, posts: 3, archivedPosts: 1, saved: 2,
    });
  });

  it('writes nothing for an empty delta, which would mark the profile fresh', () => {
    const client = new QueryClient();
    client.setQueryData(profileQueryKey('user-1'), profile());
    const before = client.getQueryState(profileQueryKey('user-1'))?.dataUpdatedAt;
    const data = client.getQueryData(profileQueryKey('user-1'));

    adjustProfileStats(client, 'user-1', {});
    adjustProfileStats(client, 'user-1', { creations: 0 });

    expect(client.getQueryData(profileQueryKey('user-1'))).toBe(data);
    expect(client.getQueryState(profileQueryKey('user-1'))?.dataUpdatedAt).toBe(before);
  });
});

describe('creation totals', () => {
  const made = { availability: 'available' as const, runStatus: 'succeeded', archivedAt: null };
  const gone = { availability: 'source-unavailable' as const, runStatus: 'succeeded', archivedAt: null };
  const failed = { availability: 'failed' as const, runStatus: 'failed', archivedAt: null };
  const archived = '2026-11-01T00:00:00.000Z';

  it('counts each creation where owner_profile_counts does', () => {
    expect(creationStatsKey(made)).toBe('creations');
    expect(creationStatsKey(gone)).toBe('creations');
    expect(creationStatsKey({ ...made, archivedAt: archived })).toBe('archivedCreations');
    expect(creationStatsKey(failed)).toBe('failedCreations');
    // Counted nowhere: an archived failure, a run still rendering, one that made nothing,
    // and a legacy finished state the app reads as failed but the Failed scope leaves out.
    expect(creationStatsKey({ ...failed, archivedAt: archived })).toBeNull();
    expect(creationStatsKey({ availability: 'rendering', runStatus: 'processing', archivedAt: null })).toBeNull();
    expect(creationStatsKey({ availability: 'no-output', runStatus: 'succeeded', archivedAt: null })).toBeNull();
    expect(creationStatsKey({ availability: 'failed', runStatus: 'completed', archivedAt: null })).toBeNull();
  });

  it('moves an archived or restored creation between the totals it leaves and joins', () => {
    expect(creationStatsDelta(made, { ...made, archivedAt: archived })).toEqual({ creations: -1, archivedCreations: 1 });
    expect(creationStatsDelta({ ...made, archivedAt: archived }, made)).toEqual({ creations: 1, archivedCreations: -1 });
    expect(creationStatsDelta(failed, { ...failed, archivedAt: archived })).toEqual({ failedCreations: -1 });
    expect(creationStatsDelta({ ...failed, archivedAt: archived }, failed)).toEqual({ failedCreations: 1 });
    expect(creationStatsDelta(made, made)).toEqual({});
  });

  it('takes a deleted creation out of its total, and one counted nowhere out of none', () => {
    expect(creationStatsDelta(made, null)).toEqual({ creations: -1 });
    expect(creationStatsDelta({ ...made, archivedAt: archived }, null)).toEqual({ archivedCreations: -1 });
    expect(creationStatsDelta(failed, null)).toEqual({ failedCreations: -1 });
    expect(creationStatsDelta({ ...failed, archivedAt: archived }, null)).toEqual({});
  });

  it('moves the profile the chips read when applied', () => {
    const totals = profile({ stats: { creations: 6, failedCreations: 4, archivedCreations: 2, posts: 3, archivedPosts: 1, saved: 2 } });
    expect(applyProfileStatsDelta(totals, creationStatsDelta(made, { ...made, archivedAt: archived })).stats).toMatchObject({
      creations: 5, archivedCreations: 3, failedCreations: 4,
    });
    expect(applyProfileStatsDelta(totals, creationStatsDelta(failed, null)).stats).toMatchObject({
      creations: 6, archivedCreations: 2, failedCreations: 3,
    });
  });
});

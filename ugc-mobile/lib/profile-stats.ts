import type { QueryClient } from '@tanstack/react-query';

import type { ProfileResponse, ProfileStatsResponse } from './types';

/**
 * The profile header's totals come from the server (`stats` on
 * `/api/profile`). Between refreshes they must still move with what the
 * person just did — a post published, a creation archived, a save — or the
 * header contradicts the grid it sits above. Each mutation site applies the
 * delta it knows, then invalidates the profile so the server's number
 * replaces the guess; the 5-minute staleTime and focus refetch cover the rest.
 */
export type ProfileStatsDelta = Partial<Record<keyof ProfileStatsResponse, number>>;

export function profileQueryKey(userId: string | null | undefined) {
  return ['profile', userId] as const;
}

/** Applies the delta to whichever totals are known; a profile with no totals is left alone. */
export function applyProfileStatsDelta<T extends Pick<ProfileResponse, 'stats'> | undefined>(
  profile: T,
  delta: ProfileStatsDelta,
): T {
  if (!profile?.stats) return profile;
  const next = { ...profile.stats };
  for (const [key, change] of Object.entries(delta) as Array<[keyof ProfileStatsResponse, number | undefined]>) {
    if (typeof change !== 'number' || !Number.isFinite(change)) continue;
    next[key] = Math.max(0, next[key] + change);
  }
  return { ...profile, stats: next };
}

export function adjustProfileStats(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  userId: string | null | undefined,
  delta: ProfileStatsDelta,
) {
  if (!userId) return;
  queryClient.setQueryData<ProfileResponse>(profileQueryKey(userId), (current) => applyProfileStatsDelta(current, delta));
}

/** Asks for the server's totals after a change whose size this app cannot know for sure. */
export function invalidateProfileStats(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  userId: string | null | undefined,
) {
  if (!userId) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: profileQueryKey(userId) });
}

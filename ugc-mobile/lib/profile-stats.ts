import type { QueryClient } from '@tanstack/react-query';

import type { CreationAvailability } from './creation-library';
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

/**
 * Applies the delta to whichever totals are known; a profile with no totals is
 * left alone, and so is a total this server does not send, which a guess would
 * turn from unknown into a number.
 */
export function applyProfileStatsDelta<T extends Pick<ProfileResponse, 'stats'> | undefined>(
  profile: T,
  delta: ProfileStatsDelta,
): T {
  if (!profile?.stats) return profile;
  const next = { ...profile.stats };
  for (const [key, change] of Object.entries(delta) as Array<[keyof ProfileStatsResponse, number | undefined]>) {
    if (typeof change !== 'number' || !Number.isFinite(change)) continue;
    const current = next[key];
    if (typeof current !== 'number' || !Number.isFinite(current)) continue;
    next[key] = Math.max(0, current + change);
  }
  return { ...profile, stats: next };
}

type CreationStatsFields = {
  archivedAt?: string | null;
  availability?: CreationAvailability;
  runStatus?: string | null;
};

/**
 * The total a creation counts in, by the rules `owner_profile_counts` applies:
 * a library member in Active or Archived, an unarchived failed run in Failed,
 * and nothing for a run still rendering, one with no output or an archived
 * failure.
 */
export function creationStatsKey(item: CreationStatsFields): 'creations' | 'archivedCreations' | 'failedCreations' | null {
  if (item.availability === 'available' || item.availability === 'source-unavailable') {
    return item.archivedAt ? 'archivedCreations' : 'creations';
  }
  return !item.archivedAt && item.runStatus === 'failed' ? 'failedCreations' : null;
}

/** A creation archived, restored or deleted (`after` null), as the totals it leaves and joins. */
export function creationStatsDelta(before: CreationStatsFields, after: CreationStatsFields | null): ProfileStatsDelta {
  const from = creationStatsKey(before);
  const to = after ? creationStatsKey(after) : null;
  if (from === to) return {};
  return { ...(from ? { [from]: -1 } : {}), ...(to ? { [to]: 1 } : {}) };
}

export function adjustProfileStats(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  userId: string | null | undefined,
  delta: ProfileStatsDelta,
) {
  if (!userId) return;
  // Nothing to move, as for a run counted in no total: writing would still mark the profile fresh.
  if (!Object.values(delta).some((change) => typeof change === 'number' && Number.isFinite(change) && change !== 0)) return;
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

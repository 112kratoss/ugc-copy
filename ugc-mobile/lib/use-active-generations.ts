import { useQuery } from '@tanstack/react-query';

import { activeGenerationsQueryKey } from '@/lib/active-generations';
import { useAuth } from '@/lib/auth';
import { isGenerationInFlight } from '@/lib/generation';

export { activeGenerationsQueryKey, invalidateActiveGenerations } from '@/lib/active-generations';

/**
 * How many of the viewer's runs are still working. Split from the tab bar the
 * same way the Alerts badge is: reaching `useAuth` drags expo-constants and the
 * native chain in behind it, and the focused component tests have no business
 * booting Expo to read a number.
 *
 * Polls only while something is running. A creator watching a render wants the
 * ring to go out promptly, but an idle app has no reason to ask at all — so the
 * interval is a function of the answer rather than a constant.
 *
 * The count falling to zero is also the app's one sign that runs settled while
 * no creator was watching them, and a failed run's settlement returns its
 * credits on the server, so the balance is read again then. Done in the fetch
 * rather than in an effect: the tab bar and Home both read this count, and the
 * fetch is the one place that sees each answer once.
 */
export function useActiveGenerationCount(): number {
  const { identityUserId, api, refreshProfile } = useAuth();

  const query = useQuery({
    queryKey: activeGenerationsQueryKey(identityUserId),
    enabled: Boolean(identityUserId),
    queryFn: async ({ client, queryKey }) => {
      // The status projection: a count needs no signed media or linked posts, and this
      // runs every 10 s beside the creator's own poll.
      const response = await api.listGenerations(false, { limit: 20, detail: 'status' });
      const count = (response?.generations ?? []).filter((generation) => isGenerationInFlight(generation?.status)).length;
      // The cache still holds the previous answer until this one returns.
      if ((client.getQueryData<number>(queryKey) ?? 0) > 0 && count === 0) {
        void refreshProfile().catch(() => undefined);
      }
      return count;
    },
    staleTime: 1000 * 15,
    refetchInterval: (query) => ((query.state.data ?? 0) > 0 ? 1000 * 10 : false),
  });

  return query.data ?? 0;
}

/**
 * Test seam, matching `useTabBarBadge`: the bar renders under a mocked
 * react-query in its focused tests, which swap this rather than reaching into
 * the query client.
 */
export function useTabBarGenerationCount(): number {
  return useActiveGenerationCount();
}

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth';

/**
 * The first part of every payout-state key. Invalidating `[CREATOR_PAYOUTS_QUERY_KEY]`
 * refreshes the figure on every screen at once, since they all read this query.
 */
export const CREATOR_PAYOUTS_QUERY_KEY = 'creator-payouts';

/**
 * The signed-in seller's payout state, `GET /api/creator/payouts`: what can be
 * withdrawn now, the minimum, and any request already filed. The profile's
 * Wallet card, Your Sales and the delete-account warning share this one query,
 * so none of them can show a balance the others have moved past. A guest has
 * no wallet, so nothing is read until there is an account.
 */
export function useCreatorPayoutState() {
  const { api, user } = useAuth();
  return useQuery({
    queryKey: [CREATOR_PAYOUTS_QUERY_KEY, user?.id ?? null],
    enabled: Boolean(user),
    queryFn: api.getCreatorPayoutState,
  });
}

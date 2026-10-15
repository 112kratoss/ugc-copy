import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  api: { getCreatorPayoutState: vi.fn() },
  user: { id: 'seller-1' } as { id: string } | null,
}));

const queryState = vi.hoisted(() => ({
  options: null as null | { queryKey: unknown; enabled: boolean; queryFn: unknown },
  result: { data: undefined as unknown, isError: false, isPending: true },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown; enabled: boolean; queryFn: unknown }) => {
    queryState.options = options;
    return queryState.result;
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

import { CREATOR_PAYOUTS_QUERY_KEY, useCreatorPayoutState } from '../lib/use-creator-payout-state';

/**
 * The profile's Wallet card, Your Sales and the delete-account warning read the
 * payout balance through this one query, and a sale or payout refreshes them all
 * by invalidating `['creator-payouts']`, so its key is the contract.
 */
describe('useCreatorPayoutState', () => {
  beforeEach(() => {
    authState.user = { id: 'seller-1' };
    queryState.options = null;
  });

  it("reads the signed-in seller's own payout state under the shared key", () => {
    useCreatorPayoutState();

    expect(CREATOR_PAYOUTS_QUERY_KEY).toBe('creator-payouts');
    expect(queryState.options).toMatchObject({ queryKey: ['creator-payouts', 'seller-1'], enabled: true });
    expect(queryState.options?.queryFn).toBe(authState.api.getCreatorPayoutState);
  });

  it('reads nothing without an account: a guest has no wallet', () => {
    authState.user = null;
    useCreatorPayoutState();

    expect(queryState.options).toMatchObject({ queryKey: ['creator-payouts', null], enabled: false });
  });

  it("hands back React Query's own result", () => {
    expect(useCreatorPayoutState()).toBe(queryState.result);
  });
});
